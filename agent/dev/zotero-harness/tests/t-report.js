/* global SB, Zotero, IOUtils, PathUtils */
// Spec 007 E7 in real Zotero: a pipeline-2 Research report through the real local runtime (gecko platform, the chrome
// window's own DOM) with a scripted provider. The clarify card asks two questions and waits; answering both shows the
// plan card with criteria and columns; Start research runs search, screening, extraction and the writer from the table;
// the finished report's evidence claim opens the quotes it rests on. Writes pictures to <harness dir>/report-*.png.

const QUESTIONS = [
	{ id: "route", question: "Which route should I use for this broad investigation?", choices: ["A narrative overview", "A formal systematic review", "A quick scan"], other: true },
	{ id: "when", question: "How far back should I look?", choices: ["2015 onward", "Any year"], other: false },
];

function parsePrompt(input) {
	const out = [];
	const re = /### Paper (\S+)\nTitle: .*\nColumns to fill: (.*)\nText \((.*?)\):\n"""\n([\s\S]*?)\n"""/g;
	let m;
	while ((m = re.exec(input))) out.push({ id: m[1], cols: m[2].split(", "), text: m[4] });
	return out;
}

const cand = (n) => ({
	citekey: null, doi: `10.9999/invented.${n}`, url: null, title: `Invented Study ${n} of Meadow Life`, year: 2016 + n, authors: [`A. Author${n}`], venue: "Journal of Invented Zoology",
	abstract: `Study ${n} looks at voles in winter. Voles ate mostly bark in study ${n}. The sample was ${20 + n} animals.`,
});

function scriptedProvider(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req) {
			const input = req.input;
			let json;
			if (/^A researcher wants a literature report/.test(input)) { state.clarify += 1; json = { questions: QUESTIONS }; }
			else if (/^Plan a literature review/.test(input)) {
				state.plans.push(input);
				json = {
					subQuestions: [{ id: "sq1", question: "What do voles eat in winter?", strategy: "Search foraging studies", sources: ["papers"] }],
					criteria: [{ text: "Reports a field study", strict: false }],
					columns: [{ name: "Main findings", instruction: "The main findings" }, { name: "Sample size", instruction: "How many animals" }],
					assumed: ["Assumed: 2015 onward"],
				};
			} else if (/finding papers for one sub-question/.test(input)) {
				state.searches += 1;
				json = { candidates: [1, 2, 3, 4, 5].map(cand), searchLog: [{ query: "voles winter diet", source: "papers", results: 5 }] };
			} else if (/^You extract data/.test(input)) {
				const batch = parsePrompt(input);
				state.extract.push({ rows: batch.length, tools: req.tools?.specs?.length ?? 0 });
				json = { rows: batch.map((b) => ({ row: b.id, cells: b.cols.map((c) => ({ column: c, status: "found", value: c.startsWith("criterion") ? "yes" : `Result for ${b.id}`, quotes: [b.text.split(". ")[1].replace(/\.$/, "")] })) })) };
			} else {
				state.writers += 1;
				const ids = [...input.matchAll(/"id":"(doi:[^"]+)"/g)].map((m) => m[1]);
				json = {
					title: "Winter diets of voles", scope: "The whole library", method: "Searched the library.", themes: [{ heading: "Diet", body: "Voles eat bark." }],
					evidence: [{ claim: "Voles eat mostly bark in winter", sources: [], strength: "strong", cells: [{ row: ids[0], column: "sample_size" }, { row: "doi:nope", column: "sample_size" }, { row: ids[0], column: "main_findings" }] }],
					disagreements: "None found.", gaps: "Few studies.",
				};
			}
			yield { type: "final", text: JSON.stringify(json), json, usage: {} };
		},
	};
}

async function snapshot(win, name) {
	const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
	canvas.width = win.innerWidth;
	canvas.height = win.innerHeight;
	canvas.getContext("2d").drawWindow(win, 0, 0, canvas.width, canvas.height, "white");
	const base64 = canvas.toDataURL("image/png").split(",")[1];
	await IOUtils.write(PathUtils.join(PathUtils.parent(Zotero.DataDirectory.dir), name), Uint8Array.from(win.atob(base64), (c) => c.charCodeAt(0)));
}

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 900);
	const ai = await SB.ai();
	const state = { clarify: 0, plans: [], searches: 0, extract: [], writers: 0 };
	SB.agent.providers.set("fake", scriptedProvider(state));
	for (const role of ["chat", "ask", "lead", "researcher", "writer", "extract"]) await ai.providers.setRole(role, { provider: "fake", model: null });
	await t.check(typeof ai.reviews.answer === "function", "the runtime offers reviews.answer");

	const view = SB.openChat();
	await view.startReport("What do voles eat in winter?");

	// ---- clarify card
	const card = await t.waitFor(() => view.root.querySelector(".sb-rp-clarify"), "the clarify card", 60000);
	const texts = [...card.querySelectorAll(".sb-rp-clarify-text")].map((n) => n.textContent);
	await t.check(texts.length === 2 && card.querySelector(".sb-rp-clarify-head")?.textContent === "Question", "the card shows a Question header and both questions", JSON.stringify(texts));
	await t.check(card.querySelectorAll(".sb-rp-clarify-other").length === 1 && card.querySelector(".sb-rp-clarify-decide")?.textContent === "You decide", "Other… only where allowed, and You decide");
	const white = win.getComputedStyle(card.querySelector(".sb-rp-clarify-choice")).whiteSpace;
	await t.check(white === "normal", "a choice wraps (white-space: normal, not the host button's nowrap)", white);
	await snapshot(win, "report-zotero-clarify.png").catch(() => {});
	card.querySelectorAll(".sb-rp-clarify-q")[0].querySelectorAll(".sb-rp-clarify-choice")[1].click();
	await new Promise((r) => win.setTimeout(r, 150));
	await t.check(view.root.querySelector(".sb-rp-clarify") && !view.root.querySelector(".sb-rp-plan"), "one answer waits for the other");
	card.querySelectorAll(".sb-rp-clarify-q")[1].querySelectorAll(".sb-rp-clarify-choice")[0].click();

	// ---- plan card
	const plan = await t.waitFor(() => view.root.querySelector(".sb-rp-plan"), "the plan card", 60000);
	const chips = [...view.root.querySelectorAll(".sb-rp-chip-name")].map((n) => n.textContent);
	await t.check(chips.join("|") === "Main findings|Sample size", "the plan lists the columns to extract", chips.join("|"));
	await t.check(view.root.querySelector(".sb-rp-criterion-text")?.textContent === "Reports a field study" && view.root.querySelector(".sb-rp-assumed")?.textContent === "Assumed: 2015 onward", "criteria and the assumed line show");
	await t.check(/formal systematic review/i.test(state.plans[0]) && /2015 onward/.test(state.plans[0]), "the plan turn saw both answers", state.plans[0].slice(-400));
	await t.check(view.root.querySelector(".sb-rp-line")?.textContent.includes("Clarified the scope"), "the finished clarify stage is a quiet line");
	await snapshot(win, "report-zotero-plan.png").catch(() => {});
	view.root.querySelector(".sb-rp-chip-x").click(); // drop Main findings
	[...view.root.querySelectorAll(".sb-button.is-primary")].find((b) => /Start research/.test(b.textContent)).click();

	// ---- the finished report
	await t.waitFor(() => view.root.querySelector(".sb-rp-report"), "the finished report", 120000);
	const sub = view.root.querySelector(".sb-rp-sub")?.textContent;
	await t.check(sub === "5 papers included · 5 found", "the subtitle counts what the files say", sub);
	const claims = view.root.querySelectorAll(".sb-rp-evidence tr.is-linked");
	await t.check(claims.length === 1, "the evidence claim is a link (its dropped cell is not shown)", claims.length);
	claims[0].click();
	const cells = await t.waitFor(() => view.root.querySelector(".sb-rp-evidence-cells"), "the claim's cells");
	await t.check(!cells.querySelector(".sb-rp-cell-value")?.textContent.includes("nope") && cells.querySelectorAll(".sb-rp-cell").length === 1, "one real cell: the invented row and the removed column were dropped by the engine");
	await t.check(cells.querySelector(".sb-rp-quote.is-unverified"), "an outside paper's quote says its abstract was not checked against the library");
	await snapshot(win, "report-zotero-done.png").catch(() => {});

	// ---- what the engine did
	await t.check(state.clarify === 1 && state.searches === 1 && state.writers === 1, "one clarify turn, one researcher, one writer", JSON.stringify({ c: state.clarify, s: state.searches, w: state.writers }));
	await t.check(state.extract.every((x) => x.tools === 0), "extraction turns had no tools", JSON.stringify(state.extract));
	await t.check(state.extract.reduce((n, x) => n + x.rows, 0) === 10, "5 papers were read once for the criterion and once for the columns", JSON.stringify(state.extract));
	const list = await ai.reviews.list();
	const mine = list.find((p) => p.question === "What do voles eat in winter?");
	await t.check(mine && mine.status.state === "done" && mine.counts.included === 5, "reviews.list reports it done with counts", JSON.stringify(mine?.counts));
}
