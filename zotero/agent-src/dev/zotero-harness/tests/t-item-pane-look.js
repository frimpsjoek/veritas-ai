/* global SB, Zotero, Services, IOUtils, PathUtils */
// Spec 005 D3 + D4: the item pane, the paper-note tab header, the toolbar search dropdown and (last, if the Settings
// window opens) the model state in Settings -> Second Brain, all drawn with the shared UI in the real Zotero chrome.
// Checks: the pane section shows "Cited in your notes" / "Related notes" / "Similar papers in your library" as shared
// Section + Row (closeness bar and label, transparent on the pane colour, tokens resolve), in light and dark (pictures);
// a click on a paper row selects that paper in the library and a note row asks for an Obsidian URL; the paper-note tab
// header is the shared PaperCard; the toolbar dropdown takes typing, arrows, Enter and the source chips; Settings shows
// the model state as a compact StatusPanel in absent / downloading / indexing / ready / error without the row jumping.
// SB.api (only /related and /paper-note), SB.searchAll, SB.open and SB.openURL are stubbed: no server or Obsidian is
// touched, nothing is launched. Pair it with t-focus-steady (it must still pass) on the same fresh profile.
// Writes <harness dir>/pane-*.png, notetab-*.png, settings-*.png.
//
// Zotero chrome windows have no bare queueMicrotask / AbortController / structuredClone: use win.X, not bare globals.

async function snapshot(win, name) {
	const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
	canvas.width = win.innerWidth;
	canvas.height = win.innerHeight;
	canvas.getContext("2d").drawWindow(win, 0, 0, canvas.width, canvas.height, "white");
	const base64 = canvas.toDataURL("image/png").split(",")[1];
	await IOUtils.write(PathUtils.join(PathUtils.parent(Zotero.DataDirectory.dir), name), Uint8Array.from(win.atob(base64), (c) => c.charCodeAt(0)));
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unresolved = (win, node, names) => names.map((name) => [name, win.getComputedStyle(node).getPropertyValue(name).trim()]).filter(([, value]) => !value || value.includes("var("));

async function run(t) {
	const win = Zotero.getMainWindow();
	const doc = win.document;
	const ZP = win.ZoteroPane;
	win.resizeTo(1400, 900);
	await t.waitFor(() => win.innerWidth >= 1300, "the window at 1400 px");
	win.Zotero_Tabs.select("zotero-pane");
	SB.setFocus(false);

	const regular = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).filter((i) => i.isRegularItem() && !i.deleted);
	await Zotero.Items.loadDataTypes(regular, ["itemData", "creators"]);
	const paper = regular[0];
	const other = regular.find((i) => i !== paper && i.getField("title"));
	if (!paper || !other) throw new Error("the library needs two papers");
	const otherTitle = other.getField("title");
	const title = paper.getField("title") || "Untitled";

	// ---- stubs (restored in finally)
	const original = { api: SB.api, searchAll: SB.searchAll, open: SB.open, openURL: SB.openURL, online: SB.online };
	const calls = { opened: [], urls: [], searches: [] };
	const NOTE = { path: "Notes/Zebra finch notes.md", title: "Zebra finch notes", score: 0.93 };
	SB.api = async function (path, ...rest) {
		if (path.startsWith("/related")) {
			return {
				similar: [NOTE, { path: "zotero/" + other.key, title: otherTitle, score: 0.82,
					zotero: { authors: ["Ada Lovelace"], year: "2020", venue: "Journal of Tests" } }],
				linked_from: ["Notes/Cites this paper.md"],
				refs: { "Notes/Cites this paper.md": { path: "Notes/Cites this paper.md", title: "Cites this paper" } },
			};
		}
		if (path.startsWith("/paper-note?")) return {};
		return original.api.call(this, path, ...rest);
	};
	SB.open = function (path) { calls.opened.push(path); original.open.call(SB, path); }; // notes reach the stubbed openURL
	SB.openURL = function (href) { calls.urls.push(href); };
	const TB_HITS = [
		{ path: "zotero/" + paper.key, title, zotero: { authors: ["Ada Lovelace"], year: "2021", venue: "Journal of Tests" }, passages: [{ heading: "", snippet: "First passage." }] },
		{ path: "Notes/Zebra finch notes.md", title: "Zebra finch notes", modified: "2026-10-01", passages: [{ heading: "", snippet: "A note." }] },
		{ path: "zotero/" + other.key, title: otherTitle, zotero: { authors: ["Alan Turing"], year: "2019", venue: "Another Journal" } },
	];
	SB.searchAll = async function (query, limit, source = "", exclude = "") {
		calls.searches.push({ query, limit, source, exclude });
		return source === "zotero" ? TB_HITS.filter((h) => h.path.startsWith("zotero/")) : TB_HITS;
	};

	try {
		// ================================================================== item pane section
		await ZP.selectItem(paper.id);
		const section = await t.waitFor(() => {
			const s = doc.querySelector("#zotero-item-pane .sb-related");
			return s && s.querySelectorAll(".sb-p-section").length === 3 && s.getBoundingClientRect().height > 0 ? s : null;
		}, "the related lists in the item pane", 30000);
		section.scrollIntoView({ block: "nearest" });
		await pause(600);
		const sections = () => [...doc.querySelectorAll("#zotero-item-pane .sb-related .sb-p-section")];
		const label = (s) => s.querySelector(".sb-p-section-label")?.textContent;
		await t.check(sections().map(label).join("|") === "Cited in your notes|Related notes|Similar papers in your library", "the three lists are shared Sections, in order", sections().map(label));
		await t.check(sections().every((s) => s.querySelector(".sb-p-count")?.textContent === "1"), "each section shows its count (1)", sections().map((s) => s.querySelector(".sb-p-count")?.textContent));
		const rows = () => [...doc.querySelectorAll("#zotero-item-pane .sb-related .sb-p-row")];
		await t.check(rows().length === 3 && rows().every((r) => r.querySelector(".sb-p-row-title")), "each section draws a shared Row", rows().length);
		const labels = rows().map((r) => r.querySelector(".sb-p-score-label")?.textContent ?? null);
		await t.check(labels[0] === null && labels[1] === "Very close" && labels[2] === "Loosely related", "closeness is a bar plus a label (score .93 = Very close, .82 = Loosely related), none on a citing note", labels);
		await t.check(rows().filter((r) => r.querySelector(".sb-p-score-bar .sb-p-score-fill")).length === 2, "a closeness bar on the two scored rows");

		const related = doc.querySelector("#zotero-item-pane .sb-related");
		const bad = unresolved(win, related, ["--sb-ui-bg", "--sb-ui-text", "--sb-ui-muted", "--sb-ui-line", "--sb-ui-accent"]);
		await t.check(!bad.length, "the --sb-ui-* tokens resolve inside the item pane", bad);
		await t.check(win.getComputedStyle(related).backgroundColor === "rgba(0, 0, 0, 0)", "the panel is transparent on the pane colour (is-flat)", win.getComputedStyle(related).backgroundColor);
		const box = related.getBoundingClientRect();
		await t.check(rows().every((r) => r.getBoundingClientRect().right <= box.right + 1) && related.scrollWidth <= related.clientWidth + 1, "nothing sticks out of the pane", { scroll: related.scrollWidth, client: related.clientWidth, wide: [...related.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > box.right + 1).slice(0, 6).map((el) => el.tagName + "." + String(el.className).slice(0, 40) + ":" + Math.round(el.getBoundingClientRect().right - box.right)) });
		await t.check(doc.querySelectorAll('link[href*="sb-ui.css"]').length === 1, "the shared stylesheet is linked once in the main window");

		// light and dark pictures; the row text colour must follow
		const text = {};
		for (const theme of ["light", "dark"]) {
			Services.prefs.setIntPref("ui.systemUsesDarkTheme", theme === "dark" ? 1 : 0);
			await pause(600);
			text[theme] = win.getComputedStyle(rows()[1].querySelector(".sb-p-row-title")).color;
			await snapshot(win, `pane-${theme}.png`);
		}
		Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
		await pause(300);
		await t.check(text.light !== text.dark, "the row text colour differs in light and dark (Zotero's own switch)", text);

		// a note row asks for an Obsidian URL (stubbed, nothing launches)
		rows()[1].click();
		await t.check(calls.opened.at(-1) === NOTE.path && /^obsidian:\/\/open/.test(calls.urls.at(-1) ?? ""), "clicking a note row opens it in Obsidian (URL recorded, not launched)", { opened: calls.opened, urls: calls.urls });

		// a paper row selects that paper in the library
		const paperRow = rows().find((r) => r.querySelector(".sb-p-row-title")?.textContent.includes(otherTitle));
		await t.check(!!paperRow, "the similar paper's row is there", otherTitle);
		paperRow.click();
		await t.waitFor(() => ZP.getSelectedItems()[0]?.id === other.id, "the library selecting the paper", 10000);
		await t.check(ZP.getSelectedItems()[0].id === other.id, "clicking a paper row selects that paper in the library");
		await t.waitFor(() => doc.querySelector("#zotero-item-pane .sb-related .sb-p-section"), "the pane for the new paper", 20000);

		// ================================================================== paper-note tab header
		await ZP.selectItem(paper.id);
		SB.openNoteTab(paper);
		const head = await t.waitFor(() => doc.querySelector(".sb-note-head .sb-p-paper"), "the paper-note tab header", 20000);
		await pause(800);
		const headBox = head.closest(".sb-note-head");
		await t.check(head.querySelector(".sb-p-kicker")?.textContent === "Paper note", "the header's kicker is Paper note", head.querySelector(".sb-p-kicker")?.textContent);
		await t.check(head.querySelector(".sb-p-paper-title")?.textContent === title, "the header's title is the paper's title", head.querySelector(".sb-p-paper-title")?.textContent);
		await t.check(win.getComputedStyle(head.querySelector(".sb-p-paper-title")).fontSize === "20px", "the title is 20 px", win.getComputedStyle(head.querySelector(".sb-p-paper-title")).fontSize);
		await t.check(headBox.classList.contains("sb-p") && headBox.classList.contains("is-flat") && win.getComputedStyle(headBox).backgroundColor === "rgba(0, 0, 0, 0)", "the header is flat on the tab's own colour", win.getComputedStyle(headBox).backgroundColor);
		const headBad = unresolved(win, headBox, ["--sb-ui-text", "--sb-ui-muted", "--sb-ui-accent"]);
		await t.check(!headBad.length, "tokens resolve in the paper-note tab", headBad);
		await t.check(headBox.getBoundingClientRect().height > 0 && headBox.scrollWidth <= headBox.clientWidth + 1, "the header is visible and does not overflow");
		const tabTitle = win.Zotero_Tabs._tabs?.find((tab) => tab.id === SB.noteTabs.get(paper.key))?.title;
		await t.check(tabTitle === `Note · ${title}`, "the tab is titled Note · <paper>", tabTitle);
		for (const theme of ["light", "dark"]) {
			Services.prefs.setIntPref("ui.systemUsesDarkTheme", theme === "dark" ? 1 : 0);
			await pause(600);
			await snapshot(win, `notetab-${theme}.png`);
		}
		Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
		win.Zotero_Tabs.close(SB.noteTabs.get(paper.key));
		win.Zotero_Tabs.select("zotero-pane");
		await pause(500);

		// ================================================================== toolbar search dropdown
		if (!doc.getElementById("second-brain-tb-search")) SB.addToolbarSearch(win);
		const input = doc.getElementById("second-brain-tb-search");
		const popup = doc.getElementById("second-brain-tb-results");
		await t.check(!!input && !!popup, "the toolbar search box and its dropdown exist");
		const tbRows = () => [...popup.querySelectorAll(".sb-tb-list .sb-p-row")];
		const press = (k) => input.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
		const before = calls.searches.length;
		input.focus();
		input.value = "finch";
		input.dispatchEvent(new win.Event("input", { bubbles: true }));
		await t.waitFor(() => tbRows().length === 3, "three dropdown rows", 10000);
		await t.check(calls.searches.length > before && calls.searches.at(-1).query === "finch" && calls.searches.at(-1).limit === 15, "typing searches after a short pause", calls.searches.at(-1));
		await t.log(`dropdown popup state after typing: ${popup.state}`);
		await t.check(popup.querySelector(".sb-tb-shell")?.classList.contains("sb-p") && popup.querySelector(".sb-tb-shell").classList.contains("is-flat"), "the dropdown is a shared panel (sb-p is-flat)");
		await t.check(tbRows().every((r) => r.querySelector(".sb-p-row-title")), "its rows are shared Rows");
		await t.check(!!popup.querySelector(".sb-tb-list .sb-p-state.is-info"), "one quiet hint line sits under the rows", popup.querySelector(".sb-tb-list .sb-p-state")?.textContent);
		const selected = () => tbRows().findIndex((r) => r.classList.contains("is-selected"));
		await t.check(selected() === 0, "the first row is selected");
		press("ArrowDown");
		await t.check(selected() === 1, "ArrowDown moves to the next row", selected());
		press("ArrowUp");
		await t.check(selected() === 0, "ArrowUp moves back", selected());
		press("ArrowDown");
		press("ArrowDown");
		await t.check(selected() === 2, "the selection follows two ArrowDowns", selected());
		await t.waitFor(() => popup.querySelector(".sb-tb-cited button"), "Show papers in library", 10000);
		await t.check(/Show 2 papers in library/.test(popup.querySelector(".sb-tb-cited button").textContent), "the footer offers Show 2 papers in library", popup.querySelector(".sb-tb-cited button").textContent);
		press("Enter");
		await t.check(calls.opened.at(-1) === "zotero/" + other.key, "Enter opens the selected hit", calls.opened.at(-1));
		await pause(300);
		await t.check(popup.state !== "open", "Enter closes the dropdown", popup.state);
		await t.waitFor(() => ZP.getSelectedItems()[0]?.id === other.id, "the library showing the opened paper", 10000);

		// the chips: All | Papers | My notes | ... ; the chosen one is remembered and the search reruns
		const chips = () => [...popup.querySelectorAll(".sb-tb-chips .sb-p-pill")];
		await t.check(chips().map((c) => c.textContent.trim()).join("|") === "All|Papers|My notes|Notion|PDFs|Images|AI notes", "the chips list the sources", chips().map((c) => c.textContent.trim()));
		const beforeChip = calls.searches.length;
		chips().find((c) => c.textContent.trim() === "Papers").click();
		await t.waitFor(() => calls.searches.length > beforeChip, "the search rerunning for the chip", 10000);
		await t.check(calls.searches.at(-1).source === "zotero" && Zotero.Prefs.get("extensions.secondbrain.searchSource", true) === "zotero", "the Papers chip searches source=zotero and is remembered", calls.searches.at(-1));
		await t.check(chips().filter((c) => c.classList.contains("is-on")).map((c) => c.textContent.trim()).join() === "Papers", "only the chosen chip is on");
		await t.waitFor(() => tbRows().length === 2, "only the papers listed", 10000);
		chips()[0].click(); // All
		await t.waitFor(() => tbRows().length === 3, "all three rows again", 10000);
		press("Escape");
		await pause(300);
		await t.check(popup.state !== "open", "Escape closes the dropdown", popup.state);
		input.value = "";

		// ================================================================== Settings: the model state (if the window opens)
		await settingsChecks(t);
	} finally {
		Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
		Zotero.Prefs.clear("extensions.secondbrain.searchSource", true);
		SB.api = original.api;
		SB.searchAll = original.searchAll;
		SB.open = original.open;
		SB.openURL = original.openURL;
		SB.online = original.online;
	}
}

async function settingsChecks(t) {
	const index = SB.localIndex;
	const prev = { state: index.state, detail: index.detail };
	let pw = null;
	try {
		SB.openSettings();
		pw = await t.waitFor(() => {
			const w = Services.wm.getMostRecentWindow("zotero:pref");
			return w && w.document.getElementById("sb-model-state")?.querySelector(".sb-p-status") ? w : null;
		}, "the Second Brain settings pane", 25000).catch(() => null);
		if (!pw) { await t.log("SKIP settings: the preferences window did not show the Second Brain pane in 25 s (headless Zotero may not open it); check the model state by hand, see real-app-checks.md"); return; }
		const pd = pw.document;
		const state = pd.getElementById("sb-model-state");
		const download = pd.getElementById("sb-model-download");
		const remove = pd.getElementById("sb-model-remove");
		const rowOf = () => state.closest(".sb-pref-row") ?? state.parentElement;
		const panel = () => state.querySelector(".sb-p-status");
		const shown = (name, detail) => { index.setState(name, detail); return pause(250); };
		const heights = {};

		await t.check(state.classList.contains("sb-p") && state.classList.contains("is-flat") && !!panel(), "the model state is a shared StatusPanel (sb-p is-flat)");
		const bad = unresolved(pw, state, ["--sb-ui-text", "--sb-ui-muted", "--sb-ui-accent"]);
		await t.check(!bad.length, "tokens resolve inside the settings window", bad);
		await t.check(pd.querySelectorAll('link[href*="sb-ui.css"]').length >= 1, "the settings window links the shared stylesheet");

		await shown("absent", "");
		heights.absent = rowOf().getBoundingClientRect().height;
		await t.check(panel().querySelector(".sb-p-status-label")?.textContent === "Not downloaded" && panel().querySelector(".sb-p-dot.is-off") && !panel().querySelector(".sb-p-progress"), "absent: one line, grey dot, no bar");
		await t.check(!download.hidden && remove.hidden && download.label === "Download", "absent: Download shows, Remove hides", { download: download.hidden, remove: remove.hidden, label: download.label });
		await snapshot(pw, "settings-absent.png");

		await shown("downloading", "12 MB of 45 MB");
		await t.check(/^Downloading/.test(panel().querySelector(".sb-p-status-label")?.textContent) && panel().querySelector(".sb-p-dot.is-running") && panel().querySelector(".sb-p-progress.is-indeterminate"), "downloading: running dot and an indeterminate bar");
		await t.check(download.hidden && remove.hidden, "downloading: both buttons hide");
		await snapshot(pw, "settings-downloading.png");

		await shown("indexing", "120 of 3,400");
		await t.check(/^Reading your library/.test(panel().querySelector(".sb-p-status-label")?.textContent) && panel().querySelector(".sb-p-dot.is-running") && panel().querySelector(".sb-p-progress"), "indexing: running dot and a bar");

		await shown("ready", "3,400 papers");
		heights.ready = rowOf().getBoundingClientRect().height;
		await t.check(panel().querySelector(".sb-p-status-label")?.textContent === "Ready · 3,400 papers" && panel().querySelector(".sb-p-dot.is-idle") && !panel().querySelector(".sb-p-progress"), "ready: green-dot line, no bar");
		await t.check(download.hidden && !remove.hidden, "ready: Remove shows, Download hides", { download: download.hidden, remove: remove.hidden });
		await snapshot(pw, "settings-ready.png");

		await shown("error", "no space left");
		heights.error = rowOf().getBoundingClientRect().height;
		await t.check(/^Didn't work/.test(panel().querySelector(".sb-p-status-label")?.textContent) && panel().querySelector(".sb-p-dot.is-error") && !download.hidden && download.label === "Try again", "error: red dot, Try again shows");
		await snapshot(pw, "settings-error.png");

		const values = Object.values(heights);
		await t.check(Math.max(...values) - Math.min(...values) <= 6, "the row keeps its height as the Download / Remove button swaps (no layout jump)", heights);
		const compact = pw.getComputedStyle(panel());
		await t.check(compact.backgroundColor === "rgba(0, 0, 0, 0)" && compact.borderTopWidth === "0px", "the compact panel is transparent and unframed", [compact.backgroundColor, compact.borderTopWidth]);
	} finally {
		index.setState(prev.state, prev.detail);
		if (pw && !pw.closed) pw.close();
	}
}
