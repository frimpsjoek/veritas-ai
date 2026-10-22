/* global SB, Zotero, IOUtils, PathUtils */
// Spec 007 E4 in real Zotero: a 30-paper set in a session gets a Summary column through the Columns popover. The
// real engine runs the extraction steps (local runtime, gecko platform) with a scripted provider that answers what
// each batch prompt asks; the panel shows skeleton cells that fill, then V2. Then "Filters" narrows the rows and
// "Keep these" writes a narrow result. Writes pictures to <harness dir>/columns-*.png.

function parsePrompt(input) {
	const out = [];
	const re = /### Paper (\S+)\nTitle: .*\nColumns to fill: (.*)\nText \((.*?)\):\n"""\n([\s\S]*?)\n"""/g;
	let m;
	while ((m = re.exec(input))) out.push({ id: m[1], cols: m[2].split(", "), text: m[4] });
	return out;
}

function scriptedProvider(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req) {
			const batch = parsePrompt(req.input);
			state.turns.push({ rows: batch.length, tools: req.tools?.specs?.length ?? 0 });
			const rows = batch.map((b) => ({
				row: b.id,
				cells: b.cols.map((c) => ({ column: c, status: "found", value: `Result for ${b.id}`, quotes: [b.text.split(". ")[0].replace(/\.$/, "")] })),
			}));
			yield { type: "final", text: JSON.stringify({ rows }), json: { rows }, usage: {} };
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

const papers = (n) => Array.from({ length: n }, (_, i) => ({
	id: `x:${i + 1}`, ref: { kind: "web", url: `https://doi.org/10.9999/invented.${i + 1}`, title: `Invented Study ${i + 1}` }, inLibrary: false,
	title: `Invented Study ${i + 1} of Meadow Life`, authors: [`A. Author${i + 1}`], year: 2015 + (i % 10), venue: "Journal of Invented Zoology",
	doi: `10.9999/invented.${i + 1}`, url: null,
	abstract: `Study ${i + 1} looks at voles. It found that burrow depth matters. The sample was ${20 + i} animals.`,
	citations: i, fullText: i % 2 === 0, pdfUrl: null, studyType: i % 5 === 0 ? "review" : null, foundBy: ["OpenAlex"],
}));

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 900);
	const ai = await SB.ai();
	const state = { turns: [] };
	SB.agent.providers.set("fake", scriptedProvider(state));
	for (const role of ["chat", "ask", "extract"]) await ai.providers.setRole(role, { provider: "fake", model: null });

	// ---- a session holding a 30-paper set
	const conv = await ai.conversations.create("chat");
	const id = conv.id ?? conv;
	const rows = papers(30);
	const draft = {
		ref: { id: "R1", version: 1 }, title: "Invented voles", created: new Date().toISOString(), madeBy: "S1", from: [], change: "Found papers",
		kind: "papers", query: "voles", rows, columns: [], cells: {}, screening: null, summary: null,
	};
	await ai.sessions.put(id, { kind: "find", query: "voles", sources: { papers: true, notes: false, scholarly: true, web: false }, scope: { kind: "library" } }, draft);

	const view = SB.openChat();
	await view.openConversation(id);
	await t.waitFor(() => view.root.querySelector(".sb-art-card"), "the papers card", 30000);
	view.root.querySelector(".sb-art-card").click();
	await t.waitFor(() => view.root.querySelector(".sb-art .sb-art-body")?.textContent.includes("Invented Study 1"), "the papers panel", 30000);
	const panel = view.root.querySelector(".sb-art");

	// ---- Columns popover -> Summary preset -> fill
	const before = panel.querySelector(".sb-art-version")?.textContent ?? "";
	await t.check(before.includes("V1"), "the set starts at V1", before);
	panel.querySelector(".sb-art-columns").click();
	await t.waitFor(() => view.doc.documentElement.querySelector(".sb-col-presets .sb-col-row"), "the preset list");
	const preset = [...view.root.querySelectorAll(".sb-col-presets .sb-col-row")].find((b) => /Summary/.test(b.textContent));
	await t.check(preset, "the Summary preset is offered");
	preset.click();
	const fill = await t.waitFor(() => view.root.querySelector(".sb-col-fill"), "the Fill button");
	await snapshot(win, "columns-zotero-popover.png").catch(() => {});
	fill.click();

	// 30 rows x 1 column is under the ask-first threshold: it runs straight away and shows a progress line.
	await t.waitFor(() => panel.querySelector(".sb-art-body")?.textContent.includes("Result for x:1"), "the first cells to fill in", 60000);
	await snapshot(win, "columns-zotero-filling.png").catch(() => {});
	await t.waitFor(() => panel.querySelector(".sb-art-version")?.textContent.includes("V2"), "the panel to move to V2", 60000);
	// spec 011 U2: the change is a turn in the thread, with a reply that says how it went
	await t.waitFor(() => [...view.root.querySelectorAll(".sb-ai-user-text")].some((e) => /^Add the column .Summary./.test(e.textContent)), "the column change as a user turn in the thread", 30000);
	await t.waitFor(() => view.root.textContent.includes("Summary” : 30 of 30 filled".replace(" :", ":")), "the reply says 30 of 30 filled", 30000);
	const body = panel.querySelector(".sb-art-body").textContent;
	const filled = (body.match(/Result for x:\d+/g) ?? []).length;
	await t.check(filled === 30, "all 30 cells are filled", filled);
	await t.check(state.turns.length === 4 && state.turns.every((turn) => turn.tools === 0), "abstract mode batches 8 papers a turn, with no tools", JSON.stringify(state.turns));
	await t.check(!panel.querySelector(".sb-art-body .is-unverified, .sb-art-body [data-unverified]"), "every quote was verified against the abstract");
	await snapshot(win, "columns-zotero-done.png").catch(() => {});

	// ---- what the engine wrote
	const sv = await ai.sessions.view(id);
	const r1 = sv.results.find((r) => r.ref.id === "R1");
	await t.check(r1 && r1.versions === 2 && r1.columns.includes("Summary"), "sessions.view reports R1 at V2 with the Summary column", JSON.stringify(sv.results));
	const v1 = await ai.sessions.read(id, { id: "R1", version: 1 });
	await t.check(v1.columns.length === 0 && Object.keys(v1.cells).length === 0, "V1 is untouched");

	// ---- Filters: Has a PDF or full text -> Keep these
	panel.querySelector(".sb-art-filters").click();
	await t.waitFor(() => view.doc.documentElement.querySelector(".sb-flt-btn.is-primary"), "the Apply button");
	const box = [...view.root.querySelectorAll("input[type=checkbox]")].find((c) => /PDF|full text/i.test(c.closest("label")?.textContent ?? ""));
	await t.check(box, "the Has a PDF filter is offered because rows carry the data");
	box.click();
	view.doc.documentElement.querySelector(".sb-flt-btn.is-primary").click();
	await t.waitFor(() => /Showing 15 of 30/.test(panel.textContent), "Showing 15 of 30", 15000);
	await snapshot(win, "columns-zotero-filtered.png").catch(() => {});
}
