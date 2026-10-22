/* global SB, Zotero, IOUtils, PathUtils */
// Spec 007 E8 in real Zotero: a Systematic review through the real local runtime with a scripted provider. The protocol
// card (PICOS, criteria, caps) shows and is approved; screening leaves 3 of 10 papers unclear (more than 10%), so the
// review stops on the unclear-papers card; "Let me look" turns one paper off and Continue finishes with the method
// section counting that override. Writes pictures to <harness dir>/systematic-*.png.

function parsePrompt(input) {
	const out = [];
	const re = /### Paper (\S+)\nTitle: .*\nColumns to fill: (.*)\nText \((.*?)\):\n"""\n([\s\S]*?)\n"""/g;
	let m;
	while ((m = re.exec(input))) out.push({ id: m[1], cols: m[2].split(", "), text: m[4] });
	return out;
}

const cand = (n) => ({
	citekey: null, doi: `10.9999/invented.${n}`, url: null, title: `Invented Trial ${n} of Spaced Practice`, year: 2010 + n, authors: [`A. Author${n}`], venue: "Journal of Invented Learning",
	abstract: `Trial ${n} looks at adults. Adults kept more after spaced practice in trial ${n}. The sample was ${30 + n} adults.`,
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
			if (/^A researcher wants a literature report/.test(input)) { state.clarify.push(input); json = { questions: [] }; }
			else if (/^Plan a literature review/.test(input)) {
				state.plans.push(input);
				json = {
					subQuestions: [{ id: "sq1", question: "Does spaced practice improve adult retention?", strategy: "Search trials", sources: ["papers"] }],
					criteria: [{ text: "Enrolled adults", strict: true }, { text: "Reports a retention outcome", strict: false }],
					columns: [{ name: "Retention", instruction: "The retention result" }],
					assumed: [],
					protocol: { population: "Adult learners", intervention: "Spaced practice", comparison: null, outcomes: "Retention", studyDesigns: ["rct"] },
				};
			} else if (/finding papers for one sub-question/.test(input)) {
				json = { candidates: Array.from({ length: 10 }, (_, i) => cand(i + 1)), searchLog: [{ query: "spaced practice adults", source: "papers", results: 10 }] };
			} else if (/^You extract data/.test(input)) {
				const batch = parsePrompt(input);
				state.extract.push(batch.map((b) => b.id));
				json = { rows: batch.map((b) => {
					const n = Number(b.id.split(".").pop());
					return { row: b.id, cells: b.cols.map((c) => ({ column: c, status: "found", value: c === "criterion_1" ? ([3, 4, 5].includes(n) ? "unclear" : "yes") : c.startsWith("criterion") ? "yes" : `Result for ${b.id}`, quotes: [b.text.split(". ")[1].replace(/\.$/, "")] })) };
				}) };
			} else {
				state.writers += 1;
				json = { title: "Spaced practice in adults", scope: "The whole library", method: "Searched the library.", themes: [{ heading: "Retention", body: "Adults kept more." }], evidence: [], disagreements: "None found.", gaps: "Few studies." };
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
	const state = { clarify: [], plans: [], extract: [], writers: 0 };
	SB.agent.providers.set("fake", scriptedProvider(state));
	for (const role of ["chat", "ask", "lead", "researcher", "writer", "extract"]) await ai.providers.setRole(role, { provider: "fake", model: null });
	await t.check(typeof ai.reviews.screened === "function", "the runtime offers reviews.screened");

	const view = SB.openChat();
	view.setMode("systematic", { fresh: false });
	await t.check([...view.modePick.options].some((o) => o.textContent === "Systematic review"), "the mode menu offers Systematic review");
	await view.startReport("Does spaced practice improve retention in adult learners?");

	// ---- the protocol card
	const plan = await t.waitFor(() => view.root.querySelector(".sb-rp-plan"), "the protocol card", 60000);
	await t.check(/formal systematic review/.test(state.clarify[0]), "the clarify prompt says it is a formal systematic review");
	await t.check(/PICOS protocol/.test(state.plans[0]), "the plan prompt asks for a PICOS protocol");
	const labels = [...view.root.querySelectorAll(".sb-rp-protocol-label")].map((n) => n.textContent);
	await t.check(labels.join("|") === "Population|Intervention|Comparison|Outcomes|Study designs", "five labelled protocol lines", labels.join("|"));
	await t.check(plan.querySelector(".sb-rp-plan-title")?.textContent === "Review protocol", "the card is titled Review protocol");
	const caps = [...view.root.querySelectorAll(".sb-rp-caps-input")].map((i) => i.value);
	await t.check(caps.join() === "300,80", "caps are the systematic ones for a standard review", caps.join());
	await t.check(/Step 3 of 9/.test(view.root.querySelector(".sb-rp-step").textContent), "nine stages");
	await snapshot(win, "systematic-zotero-protocol.png").catch(() => {});
	[...view.root.querySelectorAll(".sb-button.is-primary")].find((b) => /Start review/.test(b.textContent)).click();

	// ---- stops on the unclear papers
	const card = await t.waitFor(() => view.root.querySelector(".sb-rp-unclear"), "the unclear-papers card", 120000);
	await t.check(/3 of 10 papers are unclear/.test(card.querySelector(".sb-rp-unclear-text").textContent), "3 of 10 are unclear", card.textContent.slice(0, 120));
	await t.check(state.extract.flat().length === 10 * 1 && !state.writers, "only screening has run so far (10 papers read once for the criteria)", JSON.stringify(state.extract));
	[...card.querySelectorAll(".sb-button")].find((b) => /Let me look/.test(b.textContent)).click();
	await t.check(card.querySelectorAll(".sb-rp-unclear-row").length === 3 && /Unclear on: Enrolled adults/.test(card.textContent), "Let me look lists the three with the criterion");
	await snapshot(win, "systematic-zotero-unclear.png").catch(() => {});
	card.querySelectorAll(".sb-rp-unclear-toggle")[0].click();
	await t.check(card.querySelectorAll(".sb-rp-unclear-row.is-out").length === 1, "one paper is turned off");
	[...card.querySelectorAll(".sb-button")].find((b) => /Continue/.test(b.textContent)).click();

	// ---- done, with the override in the method
	await t.waitFor(() => view.root.querySelector(".sb-rp-report"), "the finished report", 120000);
	const sub = view.root.querySelector(".sb-rp-sub")?.textContent;
	await t.check(sub === "9 papers included · 10 found", "the subtitle: 9 included of 10 found", sub);
	const list = await ai.reviews.list();
	const mine = list.find((p) => p.systematic);
	await t.check(mine && mine.status.state === "done" && mine.counts.included === 9 && mine.counts.extracted === 9, "reviews.list reports it done, systematic, with counts", JSON.stringify(mine?.counts));
	await snapshot(win, "systematic-zotero-done.png").catch(() => {});
}
