/* global SB, Zotero, IOUtils, PathUtils */
// Spec 011 U2 in real Zotero: a column comes back with two "not reported" cells, the reply says so and offers one chip,
// and the chip reads those cells again (a stronger text) into V3. Scripted provider, invented papers.

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
				cells: b.cols.map((c) => (!state.second && (b.id === "x:3" || b.id === "x:4")
					? { column: c, status: "not_found", value: null, quotes: [] }
					: { column: c, status: "found", value: `Result for ${b.id}`, quotes: [b.text.split(". ")[0].replace(/\.$/, "")] })),
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
	const state = { turns: [], second: false };
	SB.agent.providers.set("fake", scriptedProvider(state));
	for (const role of ["chat", "ask", "extract"]) await ai.providers.setRole(role, { provider: "fake", model: null });

	const conv = await ai.conversations.create("chat");
	const id = conv.id ?? conv;
	const draft = {
		ref: { id: "R1", version: 1 }, title: "Invented voles", created: new Date().toISOString(), madeBy: "S1", from: [], change: "Found papers",
		kind: "papers", query: "voles", rows: papers(10), columns: [], cells: {}, screening: null, summary: null,
	};
	await ai.sessions.put(id, { kind: "find", query: "voles", sources: { papers: true, notes: false, scholarly: true, web: false }, scope: { kind: "library" } }, draft);

	const view = SB.openChat();
	await view.openConversation(id);
	await t.waitFor(() => view.root.querySelector(".sb-art-card"), "the papers card", 30000);
	view.root.querySelector(".sb-art-card").click();
	await t.waitFor(() => view.root.querySelector(".sb-art .sb-art-body")?.textContent.includes("Invented Study 1"), "the papers panel", 30000);
	const panel = view.root.querySelector(".sb-art");

	panel.querySelector(".sb-art-columns").click();
	await t.waitFor(() => view.doc.documentElement.querySelector(".sb-col-presets .sb-col-row"), "the preset list");
	[...view.root.querySelectorAll(".sb-col-presets .sb-col-row")].find((b) => /Summary/.test(b.textContent)).click();
	(await t.waitFor(() => view.root.querySelector(".sb-col-fill"), "the Fill button")).click();
	await t.waitFor(() => panel.querySelector(".sb-art-version")?.textContent.includes("V2"), "the panel to move to V2", 60000);

	await t.waitFor(() => view.root.textContent.includes("8 of 10 filled, 2 not reported"), "the reply counts 8 of 10 with 2 not reported", 30000);
	await t.check(view.root.textContent.includes("Invented Study 3 of Meadow Life"), "the reply names a paper with no data");
	const chips = [...view.root.querySelectorAll(".sb-ai-followup")];
	await t.check(chips.length === 1 && /Look again/.test(chips[0].textContent), "one follow-up chip offers to look again", chips.map((c) => c.textContent));

	state.second = true;
	chips[0].click();
	await t.waitFor(() => panel.querySelector(".sb-art-version")?.textContent.includes("V3"), "the panel to move to V3", 60000);
	await t.check(panel.querySelector(".sb-art-body").textContent.includes("Result for x:3"), "the cell that had no data now has a value");
	await t.waitFor(() => [...view.root.querySelectorAll(".sb-ai-user-text")].some((e) => e.textContent === "Look again for the cells with no data"), "the gap fill as a user turn", 30000);
	await t.waitFor(() => view.root.textContent.includes("Found a value for 2 of 2 cells that had none"), "the reply says 2 of 2 found", 30000);
	await t.check(!view.root.querySelector(".sb-ai-followup"), "no chip is left: nothing is blank now");
	await t.check(state.turns.map((turn) => turn.rows).join() === "2,8,1,1" && state.turns.every((turn) => turn.tools === 0), "10 papers take two turns, then the stronger read takes one paper a turn for the 2 blank cells; no tools", JSON.stringify(state.turns));

	// ---- the Sources view: every paper with a quote, once, the quotes under it
	panel.querySelector('.sb-art-iconbtn[aria-label="More"]').click();
	const sourcesItem = await t.waitFor(() => [...view.doc.documentElement.querySelectorAll(".sb-art-item")].find((b) => /^Sources \(10\)/.test(b.textContent)), "More lists Sources (10)", 10000);
	sourcesItem.click();
	await t.waitFor(() => view.doc.documentElement.querySelectorAll(".sb-art-source").length === 10, "ten papers in the Sources view", 10000);
	const first = view.doc.documentElement.querySelector(".sb-art-source");
	await t.check(/Invented Study 1 of Meadow Life/.test(first.querySelector(".sb-art-source-title").textContent) && first.querySelectorAll(".sb-art-source-quote").length >= 1 && /Summary: /.test(first.textContent), "a source shows its title and a quote under the column name", first.textContent.slice(0, 160));
}
