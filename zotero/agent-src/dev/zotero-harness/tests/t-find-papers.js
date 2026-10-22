/* global SB, Zotero, IOUtils, PathUtils */
// Spec 002 U2: Find papers. One table merging the library (local search index) and outside results (Discover,
// stubbed here so no network is needed) with no duplicates, a cited summary of the top papers, ticks feeding
// "Chat about these", Add to Zotero, CSV/RIS export, and the search reopening from the history.
// Writes <harness dir>/find-*.png.

function scriptedProvider(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req) {
			state.inputs.push(req.input);
			const markdown = `These papers agree on the main point [@${state.key}], and an outside study adds to it (https://doi.org/10.9999/outside-one).`;
			const text = req.outputSchema ? JSON.stringify({ status: "answered", markdown }) : markdown;
			yield { type: "final", text, json: req.outputSchema ? { status: "answered", markdown } : null, usage: {} };
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

const visible = (node) => node && !node.hidden && !node.closest("[hidden]");

async function run(t) {
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 860);
	await t.waitFor(() => SB.localIndex?.ready, "the built-in search model", 60000).catch(() => null);
	const ai = await SB.ai();

	// a library paper to search for, with a DOI so an outside copy of it can be recognised
	const items = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).filter((i) => i.isRegularItem() && !i.deleted);
	await Zotero.Items.loadDataTypes(items, ["itemData", "creators"]);
	const paper = items.find((i) => i.getField("DOI") && i.getField("abstractNote") && i.getField("title").split(" ").length > 5);
	const title = paper.getField("title");
	const doi = paper.getField("DOI");
	const state = { inputs: [], key: paper.getField("citationKey") || paper.key };
	SB.agent.providers.set("fake", scriptedProvider(state));
	for (const role of ["chat", "ask", "lead", "researcher", "writer"]) await ai.providers.setRole(role, { provider: "fake", model: null });

	// outside results: the same paper again (by DOI, other capitalisation), plus two new ones
	const outside = [
		{ id: "x0", title: title.toUpperCase(), doi: doi.toUpperCase(), authors: ["Someone"], year: 2024, venue: "Journal", abstract: "Same paper.", sources: ["OpenAlex"] },
		{ id: "x1", title: "An outside study of the same question", doi: "10.9999/outside-one", authors: ["Ada Lovelace", "Alan Turing"], year: 2023,
			venue: "Outside Letters", abstract: "We measure the effect. It is large. A third sentence that the table leaves out.", sources: ["OpenAlex", "Semantic Scholar"] },
		{ id: "x2", title: "A preprint nobody has cited yet", doi: null, arxiv: "2401.00001", authors: ["Grace Hopper"], year: 2025, venue: "arXiv",
			abstract: "A short abstract.", sources: ["arXiv"] },
	];
	SB.Discover.prototype.search = async function () {
		const results = await this.mark(outside.map((r) => ({ ...r })));
		results.failed = [];
		return results;
	};
	SB.Discover.prototype.add = function (result) { return this.create({ type: "article", ...result }, []); };

	const view = SB.openChat();
	view.setMode("find");
	await t.check(view.modePick.value === "find" && [...view.modePick.options].some((o) => o.textContent === "Find papers"), "Find papers is a mode in the menu");
	// Spec 005 C2: all four pills show, but Find papers disables (not hides) Notes and Web — the table lists
	// papers, not notes, and doesn't search the web at all (decision 1: disabled there, with the reason as a
	// tooltip).
	const shown = Object.entries(view.sourceButtons).filter(([, b]) => visible(b)).map(([id]) => id);
	await t.check(JSON.stringify(shown) === '["papers","notes","scholarly","web"]', "Find papers shows all four pills", shown);
	const disabled = Object.entries(view.sourceButtons).filter(([, b]) => b.disabled).map(([id]) => id);
	await t.check(JSON.stringify(disabled) === '["notes","web"]', "Find papers disables Notes and Web", disabled);
	await t.check(!!view.sourceButtons.notes.title && !!view.sourceButtons.web.title, "the disabled pills explain why in their tooltip",
		[view.sourceButtons.notes.title, view.sourceButtons.web.title]);
	view.optionsButton.click();
	await t.check(visible(view.scopeKind) && !visible(view.yearFrom) && !visible(view.depthField), "its options panel has the scope, not years or depth", { scope: visible(view.scopeKind), years: visible(view.yearFrom), depthField: visible(view.depthField) });
	await t.check(view.optionsButton.textContent.startsWith("Whole library"), "the options button says what's chosen", view.optionsButton.textContent);
	view.setOptionsOpen(false);
	await snapshot(win, "find-empty.png");

	view.input.value = title;
	await view.submit();
	const rows = [...view.thread.querySelectorAll(".sb-fp-row")];
	const find = view.thread.querySelector(".sb-fp");
	await t.check(rows.length >= 3, "the table has rows", rows.length);
	const titles = [...view.thread.querySelectorAll(".sb-fp-title")].map((n) => SB.normalizeTitle(n.textContent));
	await t.check(new Set(titles).size === titles.length, "no paper shows twice (the outside copy of a library paper merged)", titles.length);
	const own = rows.find((r) => SB.normalizeTitle(r.querySelector(".sb-fp-title").textContent) === SB.normalizeTitle(title));
	await t.check(own?.querySelector(".sb-fp-badge.is-library"), "the library paper is marked In library");
	await t.check(rows.some((r) => r.textContent.includes("An outside study")) && rows.some((r) => r.textContent.includes("A preprint")), "outside papers are in the same table");
	const outsideRow = rows.find((r) => r.textContent.includes("An outside study"));
	await t.check(outsideRow.querySelector(".sb-fp-abstract").textContent === "We measure the effect. It is large.", "the summary column is the abstract's first two sentences",
		outsideRow.querySelector(".sb-fp-abstract").textContent);
	await t.check(find.querySelector(".sb-fp-summary .sb-ai-md")?.textContent.includes("agree on the main point"), "a summary of the top papers sits above the table");
	const asked = JSON.stringify(state.inputs.at(-1) ?? "");
	await t.check(asked.includes(`[@${state.key}]`) && asked.includes("10.9999/outside-one"),
		"the summary was asked over library papers and outside abstracts", asked.slice(0, 300));
	await snapshot(win, "find-results.png");

	const dir = PathUtils.parent(Zotero.DataDirectory.dir);
	const tick = (row) => { const box = row.querySelector(".sb-fp-tick"); box.checked = true; box.dispatchEvent(new win.Event("change")); };
	tick(own);
	tick(outsideRow);
	const actions = find.querySelector(".sb-fp-actions");
	await t.check(actions.textContent.includes("2 ticked") && actions.textContent.includes("Add 1 to Zotero"), "ticking shows what the actions will use", actions.textContent);

	// "Add 1 to Zotero" saves the outside paper and marks it
	const addButton = [...actions.querySelectorAll("button")].find((b) => b.textContent.startsWith("Add 1"));
	addButton.click();
	await t.waitFor(() => [...view.thread.querySelectorAll(".sb-fp-row")].find((r) => r.textContent.includes("An outside study"))?.querySelector(".sb-fp-badge.is-library"),
		"the added paper marked In library", 20000);
	const added = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).find((i) => i.isRegularItem() && i.getField("DOI") === "10.9999/outside-one");
	await t.check(!!added, "the outside paper is now a Zotero item");

	// export CSV and RIS without the file picker
	const saved = await SB.FindView.load(view.findID);
	const exportView = new SB.FindView(view, { saved });
	const csvPath = PathUtils.join(dir, "find-export.csv");
	const risPath = PathUtils.join(dir, "find-export.ris");
	await exportView.writeExport("csv", csvPath);
	await exportView.writeExport("ris", risPath);
	const csv = await IOUtils.readUTF8(csvPath);
	const ris = await IOUtils.readUTF8(risPath);
	await t.check(csv.split("\r\n").filter(Boolean).length === saved.rows.length + 1 && csv.startsWith('"Title","Authors"'), "CSV has a header and one line per paper");
	await t.check((ris.match(/^TY {2}- /gm) ?? []).length === saved.rows.length && ris.includes("DO  - 10.9999/outside-one"), "RIS has one record per paper");

	// Chat about these: the ticked papers become chips in the Chat box
	const rowsNow = [...view.thread.querySelectorAll(".sb-fp-row")];
	for (const r of rowsNow) if (r.textContent.includes("A preprint") || SB.normalizeTitle(r.querySelector(".sb-fp-title").textContent) === SB.normalizeTitle(title)) tick(r);
	const chatButton = [...view.thread.querySelectorAll(".sb-fp-actions button")].find((b) => b.textContent === "Chat about these");
	chatButton.click();
	await t.waitFor(() => view.mode === "chat", "Chat mode");
	// the two ticked before (the library paper and the outside one, now added) stay ticked, plus the preprint
	const kinds = view.attachments.map((a) => a.attachment.kind).sort();
	await t.check(JSON.stringify(kinds) === '["quote","zoteroItem","zoteroItem"]' && visible(view.chips) && view.chips.children.length === 3,
		"Chat about these puts the ticked papers into the box as chips", view.attachments.map((a) => a.label));

	// the search is in the history and reopens as it was
	await view.refreshList();
	const historyRow = view.list.querySelector(".sb-ai-conv.is-find");
	await t.check(historyRow?.querySelector(".sb-ai-conv-title")?.textContent === title, "the search is in the history");
	await view.openFind(historyRow.dataset.id);
	await t.check(view.mode === "find" && view.thread.querySelectorAll(".sb-fp-row").length === saved.rows.length
		&& view.thread.querySelector(".sb-fp-summary .sb-ai-md"), "opening it shows the same table and summary");
	await t.check(historyRow.classList.contains("is-selected") || view.list.querySelector(".sb-ai-conv.is-find.is-selected"), "and marks it in the history");
	await snapshot(win, "find-reopened.png");

	await SB.FindView.remove(historyRow.dataset.id);
	await added?.eraseTx();
	await SB.agent.shutdown();
}
