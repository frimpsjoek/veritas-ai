/* global SB, Zotero, Services, IOUtils, PathUtils */
// Spec 005 D2: the Second Brain search window in the real Zotero chrome. content/search.xhtml loads the shared UI
// (SecondBrainUI from sb-ui.js, the Zotero token map and sb-ui.css) and content/search.js draws SearchPanel with it.
// The Playwright harness stubs the chrome globals; only this test proves they exist in the real XUL window.
// Checks: SecondBrainUI loads and the --sb-ui-* tokens resolve (getComputedStyle, light and dark); a query lists rows;
// the Papers pill searches source=zotero (and Notes alone exclude_source=zotero); a hit opens (click and Enter);
// "Find new papers" lists outside papers; Add saves one and the button turns into "Added"; Escape closes the More
// menu first and then the window. SB.searchAll / SB.open / SB.Discover are stubbed, so no server, network or Obsidian
// is touched. Writes <harness dir>/search-*.png.
//
// Zotero chrome windows have no bare queueMicrotask / AbortController / structuredClone: this file uses none, and
// events are built from the search window's own constructors (sw.KeyboardEvent, sw.Event).

async function snapshot(win, name) {
	const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
	canvas.width = win.innerWidth;
	canvas.height = win.innerHeight;
	canvas.getContext("2d").drawWindow(win, 0, 0, canvas.width, canvas.height, "white");
	const base64 = canvas.toDataURL("image/png").split(",")[1];
	await IOUtils.write(PathUtils.join(PathUtils.parent(Zotero.DataDirectory.dir), name), Uint8Array.from(win.atob(base64), (c) => c.charCodeAt(0)));
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(t) {
	const main = Zotero.getMainWindow();
	main.resizeTo(1280, 860);

	// ---- fixtures: two real library papers (a hit and an "already owned" outside result) and one Obsidian note
	const items = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).filter((i) => i.isRegularItem() && !i.deleted);
	await Zotero.Items.loadDataTypes(items, ["itemData", "creators"]);
	const paper = items.find((i) => i.getField("DOI") && i.getField("title").split(" ").length > 4);
	if (!paper) throw new Error("the library needs a paper with a DOI and a title of five words or more");
	const title = paper.getField("title");
	const doi = paper.getField("DOI");
	const hits = [
		{ path: "zotero/" + paper.key, title, zotero: { authors: ["Ada Lovelace"], year: "2021", venue: "Journal of Tests" },
			passages: [{ heading: "Methods", snippet: "Searched for the effect in the library." }] },
		{ path: "Notes/Search window note.md", title: "Search window note", modified: "2026-10-01", passages: [{ heading: "", snippet: "A note about the same topic." }] },
	];
	const outside = [
		{ id: "x0", title: title.toUpperCase(), doi: doi.toUpperCase(), authors: ["Someone Else"], year: 2024, venue: "Journal", abstract: "Same paper.", sources: ["OpenAlex"] },
		{ id: "x1", title: "A search-window test paper that is not in the library", doi: "10.9999/search-window-one", authors: ["Grace Hopper", "Alan Turing"], year: 2023,
			venue: "Outside Letters", abstract: "We measure the effect. It is large.", sources: ["OpenAlex"] },
	];

	// ---- stubs (restored at the end)
	const original = { searchAll: SB.searchAll, open: SB.open, search: SB.Discover.prototype.search, add: SB.Discover.prototype.add };
	const calls = { searches: [], opened: [] };
	SB.searchAll = async function (query, limit, source = "", exclude = "") {
		calls.searches.push({ query, limit, source, exclude });
		if (source === "zotero") return hits.slice(0, 1);
		if (exclude === "zotero") return hits.slice(1);
		return hits;
	};
	SB.open = function (path) { calls.opened.push(path); };
	SB.Discover.prototype.search = async function () {
		const results = await this.mark(outside.map((r) => ({ ...r })));
		results.failed = [];
		return results;
	};
	SB.Discover.prototype.add = function (result) { return this.create({ type: "article", ...result }, []); };
	let added = null;
	let sw = null;
	try {
		// ---- open the window the way the toolbar does
		SB.openSearch("");
		sw = await t.waitFor(() => {
			const w = Services.wm.getMostRecentWindow("second-brain:search");
			return w && w.document.readyState === "complete" && w.SecondBrainSearch?.panel ? w : null;
		}, "the search window", 30000);
		const doc = sw.document;
		const S = () => sw.SecondBrainSearch;
		const pills = () => [...doc.querySelectorAll(".sb-p-pill")];
		const rows = () => [...doc.querySelectorAll(".sb-p-results .sb-p-row")];
		const key = (target, k, extra = {}) => target.dispatchEvent(new sw.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
		const search = async (text) => {
			S().panel.input.value = text;
			key(S().panel.input, "Enter");
		};

		// ---- the shared UI loaded in the XUL window and its tokens resolve
		await t.check(typeof sw.SecondBrainUI === "object" && typeof sw.SecondBrainUI.SearchPanel === "function", "SecondBrainUI (sb-ui.js) loads in the search window");
		await t.check(!!doc.querySelector("#app .sb-p.sb-p-search"), "the search panel is drawn inside #app");
		await t.check(doc.querySelectorAll('link[href*="sb-ui-zotero-tokens.css"], link[href*="sb-ui.css"]').length === 2, "the token map and the component sheet are linked");
		const root = doc.querySelector(".sb-p-search");
		const tokens = ["--sb-ui-bg", "--sb-ui-text", "--sb-ui-muted", "--sb-ui-line", "--sb-ui-accent", "--sb-ui-control"];
		const resolved = (win) => tokens.map((name) => [name, win.getComputedStyle(win.document.querySelector(".sb-p-search")).getPropertyValue(name).trim()]);
		const unresolved = resolved(sw).filter(([, value]) => !value || value.includes("var("));
		await t.check(!unresolved.length, "the --sb-ui-* tokens resolve to real values (getComputedStyle)", unresolved.length ? unresolved : resolved(sw));
		const rootStyle = sw.getComputedStyle(root);
		await t.check(rootStyle.backgroundColor !== "rgba(0, 0, 0, 0)" && rootStyle.color !== rootStyle.backgroundColor, "the panel root has a background and a different text colour", [rootStyle.backgroundColor, rootStyle.color]);
		const pillStyle = sw.getComputedStyle(pills()[0]);
		await t.check(pills().length === 2 && parseFloat(pillStyle.borderTopLeftRadius) > 8 && ["inline-flex", "flex"].includes(pillStyle.display), "sb-ui.css styles the pills (round, flex; a flex item computes inline-flex to flex)", [pillStyle.borderTopLeftRadius, pillStyle.display]);

		// light and dark: the panel background follows Zotero's own switch
		const colours = {};
		for (const theme of ["light", "dark"]) {
			Services.prefs.setIntPref("ui.systemUsesDarkTheme", theme === "dark" ? 1 : 0);
			await pause(500);
			colours[theme] = sw.getComputedStyle(doc.querySelector(".sb-p-search")).backgroundColor;
			await snapshot(sw, `search-empty-${theme}.png`);
		}
		Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
		await pause(300);
		await t.check(colours.light !== colours.dark, "the panel background differs in light and dark (no dark-mode rule of our own)", colours);

		// ---- a query lists rows
		await search("effect");
		await t.waitFor(() => rows().length === 2, "two result rows", 10000);
		await t.check(calls.searches.at(-1).query === "effect" && calls.searches.at(-1).source === "" && calls.searches.at(-1).exclude === "", "a query searches everything", calls.searches.at(-1));
		await t.check(rows()[0].querySelector(".sb-p-row-title")?.textContent.includes(title) && rows()[1].querySelector(".sb-p-row-title")?.textContent.includes("Search window note"), "the rows show the paper and the note", rows().map((r) => r.querySelector(".sb-p-row-title")?.textContent));
		await t.check(rows()[0].classList.contains("is-selected"), "the first row is selected");
		await t.check(/2 results/.test(S().panel.statusEl.textContent), "the status line counts the results", S().panel.statusEl.textContent);
		await t.waitFor(() => doc.querySelector(".sb-p-search-footer button"), "the Show paper in library button", 10000);
		await snapshot(sw, "search-results.png");

		// ---- the Papers / Notes pills (pill 0 = Papers, 1 = Notes; they are redrawn on every click)
		const before = calls.searches.length;
		pills()[1].click(); // Notes off -> Papers only
		await t.waitFor(() => calls.searches.length > before, "the Papers-only search", 10000);
		await t.check(calls.searches.at(-1).source === "zotero", "Papers alone searches source=zotero", calls.searches.at(-1));
		await t.waitFor(() => rows().length === 1, "one paper row", 10000);
		await t.check(pills()[0].classList.contains("is-on") && !pills()[1].classList.contains("is-on"), "the Papers pill is on and Notes is off");
		pills()[1].click(); // back to both
		await t.waitFor(() => rows().length === 2, "both rows again", 10000);
		const beforeNotes = calls.searches.length;
		pills()[0].click(); // Papers off -> Notes only
		await t.waitFor(() => calls.searches.length > beforeNotes, "the Notes-only search", 10000);
		await t.check(calls.searches.at(-1).exclude === "zotero" && calls.searches.at(-1).source === "", "Notes alone excludes Zotero", calls.searches.at(-1));
		pills()[0].click(); // back to both
		await t.waitFor(() => rows().length === 2, "both rows after reset", 10000);

		// ---- opening a hit: a click, then Enter on the selected row
		rows()[0].querySelector(".sb-p-row-title").click();
		await t.check(calls.opened.at(-1) === "zotero/" + paper.key, "clicking a paper hit opens its path", calls.opened);
		S().panel.input.focus();
		key(S().panel.input, "ArrowDown");
		await t.check(rows()[1].classList.contains("is-selected"), "the arrow key moves the selection");
		key(S().panel.input, "Enter");
		await t.check(calls.opened.at(-1) === "Notes/Search window note.md", "Enter opens the selected hit", calls.opened);
		await t.check(!sw.closed, "opening a hit leaves the window open");

		// ---- Find new papers
		const tab = [...doc.querySelectorAll(".sb-win-modes .sb-p-tab")].find((b) => b.textContent.includes("Find new papers"));
		await t.check(!!tab, "the Find new papers tab is there");
		tab.click();
		await t.waitFor(() => S().mode === "online", "online mode", 5000);
		await t.check(pills().length === 0, "the Papers / Notes pills are hidden when finding new papers");
		await t.check(!!doc.querySelector(".sb-p-checks input[data-source]"), "the service checkboxes (Search in:) appear");
		await search("effect");
		await t.waitFor(() => rows().length === 2, "the outside rows", 15000);
		await t.waitFor(() => /2 papers/.test(S().panel.statusEl.textContent), "the status line counts the papers", 10000);
		await t.check(/2 papers/.test(S().panel.statusEl.textContent), "the status line counts the papers", S().panel.statusEl.textContent);
		const buttons = (row) => [...row.querySelectorAll("button")].map((b) => b.textContent.trim());
		await t.check(buttons(rows()[0]).includes("In your library"), "a paper already in the library says In your library (matched by DOI)", buttons(rows()[0]));
		const addButton = [...rows()[1].querySelectorAll("button")].find((b) => b.textContent.trim() === "Add");
		await t.check(!!addButton, "a new paper has an Add button", buttons(rows()[1]));
		await snapshot(sw, "search-online.png");

		// ---- Add
		const count = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).filter((i) => i.isRegularItem() && !i.deleted).length;
		addButton.click();
		await t.waitFor(() => buttons(rows()[1]).includes("Added"), "the Added button", 20000);
		await t.check(!buttons(rows()[1]).includes("Add"), "Add is replaced, not duplicated", buttons(rows()[1]));
		const all = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).filter((i) => i.isRegularItem() && !i.deleted);
		added = all.find((i) => i.getField("title") === outside[1].title) ?? null;
		await t.check(!!added && all.length === count + 1, "the paper is now in the Zotero library (one more item)", { before: count, after: all.length, key: added && added.key });
		await t.check(rows().length === 2 && buttons(rows()[1]).filter((b) => b === "Added").length === 1, "exactly one Added button, rows unchanged");

		// ---- Escape: the More menu first, then the window
		const library = [...doc.querySelectorAll(".sb-win-modes .sb-p-tab")].find((b) => b.textContent.includes("My library"));
		library.click();
		await t.waitFor(() => S().mode === "library" && pills().length === 2, "library mode again", 5000);
		const more = doc.querySelector(".sb-p-more");
		await t.check(!!more, "the More button is there");
		more.click();
		const pop = await t.waitFor(() => doc.querySelector(".sb-p-pop"), "the More menu", 5000);
		await t.check([...pop.querySelectorAll(".sb-p-pop-item")].map((b) => b.textContent.trim()).join("|") === "Any source|Zotero|My notes|Notion|PDFs|Images|AI notes",
			"More lists Any source, Zotero, My notes, Notion, PDFs, Images, AI notes");
		key(pop.querySelector(".sb-p-pop-item"), "Escape");
		await pause(200);
		await t.check(!doc.querySelector(".sb-p-pop") && !sw.closed, "Escape closes the More menu and not the window");
		key(S().panel.input, "Escape");
		await t.waitFor(() => sw.closed, "the window closing", 5000);
		await t.check(sw.closed, "a second Escape closes the window");
		sw = null;
	} finally {
		if (sw && !sw.closed) sw.close();
		Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
		SB.searchAll = original.searchAll;
		SB.open = original.open;
		SB.Discover.prototype.search = original.search;
		SB.Discover.prototype.add = original.add;
		await added?.eraseTx();
	}
}
