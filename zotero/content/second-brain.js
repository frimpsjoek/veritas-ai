/* global Zotero, Services, IOUtils, TextDecoder */
// Loaded into bootstrap.js's scope. Everything the plugin does lives here.

SecondBrain = {
	id: null,
	version: null,
	rootURI: null,
	online: false, // the Second Brain server (Obsidian index) answered recently; everything else works without it
	paneID: null,
	menuIDs: [],
	columnKey: null,
	indexState: {}, // Zotero key -> { state, full_text }, from /zotero/status
	statusTimer: null,
	fixing: null, // { stop } while "Fix missing PDFs" runs
	editors: new Set(), // open paper-note editors (item pane and tabs)
	noteTabs: new Map(), // Zotero key -> tab id of the paper's note tab

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.registerSection();
		this.registerMenus();
		this.registerColumn();
		this.autoQuote = Zotero.Prefs.get("extensions.secondbrain.autoQuote", true) ?? true;
		this.focusMode = Zotero.Prefs.get("extensions.secondbrain.focus", true) ?? false;
		Zotero.SecondBrain = this; // for Zotero's Run JavaScript window and tests
		this.local = new this.LocalStore(this);
		this.obsidian = new this.ObsidianStore(this);
		this.localIndex = new this.LocalIndex(this);
		this.agent = new this.AgentHost(this);
		this.updater = new this.Updater(this);
		Zotero.uiReadyPromise.then(() => { this.localIndex.start(); this.updater.start(); });
		this.prefObservers = ["color.background", "color.text", "color.accent", "color.highlight"].map((name) =>
			Zotero.Prefs.registerObserver(`extensions.secondbrain.${name}`, () => {
				for (const editor of this.editors) editor.applyColors();
			}, true));
		Zotero.PreferencePanes.register({
			pluginID: this.id, src: "chrome://second-brain/content/preferences.xhtml", scripts: ["chrome://second-brain/content/preferences.js"],
			label: "Second Brain", image: rootURI + "content/icon20.svg",
		}).then((id) => { this.prefPaneID = id; }).catch((error) => Zotero.logError(error));
		this.notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids) => this.zoteroChanged(event, ids),
		}, ["item"], "second-brain");
		this.refreshIndexState();
		this.statusTimer = setInterval(() => this.refreshIndexState(), 60000);
		this.editsTimer = setInterval(() => this.applyObsidianEdits(), 5000);
		this.pendingAdds = new SecondBrain.PendingAdds(this);
		this.pendingAdds.start();
	},

	shutdown() {
		for (const id of this.prefObservers ?? []) Zotero.Prefs.unregisterObserver(id);
		this.localIndex?.close();
		this.agent?.shutdown();
		this.updater?.stop();
		delete Zotero.SecondBrain;
		clearInterval(this.statusTimer);
		clearInterval(this.editsTimer);
		this.pendingAdds?.stop();
		if (this.notifierID) Zotero.Notifier.unregisterObserver(this.notifierID);
		// the flush below is async and may not finish before Zotero quits; keep unsaved text to restore next time
		const drafts = this.drafts();
		for (const editor of this.editors) if (editor.cm && (editor.dirty || editor.saving)) drafts[editor.key] = { text: editor.cm.getText(), hash: editor.hash };
		this.saveDrafts(drafts);
		for (const editor of this.editors) editor.flush().finally(() => editor.destroy());
		const tabs = Zotero.getMainWindow()?.Zotero_Tabs;
		for (const id of this.noteTabs.values()) tabs?.close(id);
		if (this.chatTab) tabs?.close(this.chatTab.tabID);
		if (this.homeTab) tabs?.close(this.homeTab.tabID);
		if (this.fixing) this.fixing.stop = true;
		if (this.columnKey) Zotero.ItemTreeManager.unregisterColumn(this.columnKey);
		if (this.paneID) Zotero.ItemPaneManager.unregisterSection(this.paneID);
		for (const menuID of this.menuIDs) Zotero.MenuManager.unregisterMenu(menuID);
		for (const win of Zotero.getMainWindows()) this.removeFromWindow(win);
	},

	addToWindow(window) {
		window.MozXULElement.insertFTLIfNeeded("second-brain.ftl");
		this.addToolbarSearch(window);
		this.ChatTab.addToolbarButton(this, window);
		this.HomeTab.addToolbarButton(this, window);
		this.ChatSidebar.addToWindow(this, window);
	},

	removeFromWindow(window) {
		const doc = window.document;
		doc.querySelector('[href="second-brain.ftl"]')?.remove();
		for (const id of ["second-brain-tb-search", "second-brain-tb-results", "second-brain-style", "second-brain-tb-ai", "second-brain-tb-home", "second-brain-home-style", "second-brain-ai-style", "second-brain-report-style", "second-brain-find-style", "second-brain-routines-style", "second-brain-skills-style", "second-brain-scope-tree-style"]) doc.getElementById(id)?.remove();
		for (const details of doc.querySelectorAll("item-details")) details.classList.remove("sb-focus");
		this.ChatSidebar.removeFromWindow(this, window);
	},

	// ------------------------------------------------------------------ server

	/** Obsidian vault name, for obsidian://open links (settings). */
	get vault() {
		return Zotero.Prefs.get("extensions.secondbrain.vault", true) || "Second-Brain";
	},

	get server() {
		return (Zotero.Prefs.get("extensions.secondbrain.server", true) || "http://127.0.0.1:27182").replace(/\/+$/, "");
	},

	/** Notes go to the Obsidian vault while the Second Brain server runs, otherwise to the local folder. Until
	 *  the server has been seen to be down, try it: at startup the first note opens before any check has
	 *  answered, and guessing "down" there opened the empty local copy instead of the vault note. An editor
	 *  that can't reach the server falls back to the local folder by itself. */
	store() {
		const where = Zotero.Prefs.get("extensions.secondbrain.notesIn", true) || "auto";
		return where === "local" || (this.checkedOnce && !this.online) ? this.local : this.obsidian;
	},

	isOffline(error) {
		return !error?.status || error.status === 0 || /ECONNREFUSED|NS_ERROR|timed out/i.test(String(error?.message ?? error));
	},

	setOnline(on) {
		if (this.online === on) return;
		this.online = on;
		if (!on) this.localIndex?.serverGone();
		Zotero.ItemTreeManager.refreshColumns?.();
	},

	openSettings() {
		Zotero.Utilities.Internal.openPreferences(this.prefPaneID);
	},

	/** Papers cited as [@citekey] in a note's text, for its reference list. */
	async references(text) {
		const keys = new Set();
		for (const group of text.matchAll(/(?<!\[)\[[^\[\]\n]*@[^\]\n]*\]/g)) {
			for (const key of group[0].matchAll(/@([\w:.#$%&+?<>~/-]+)/g)) keys.add(key[1].replace(/[.,;:]+$/, ""));
		}
		return Promise.all([...keys].map(async (citekey) => {
			const item = await this.itemByCitekey(citekey);
			return item ? { citekey, key: item.key, label: this.shortLabel(item), title: item.getField("title") } : { citekey };
		}));
	},

	/** Search over the index when it runs; otherwise Zotero's own search of the library. */
	async searchAll(query, limit, source = "", exclude = "") {
		if (this.online || !this.checkedOnce) {
			try {
				const params = new URLSearchParams({ q: query, limit: String(limit) });
				if (source) params.set("source", source);
				if (exclude) params.set("exclude_source", exclude);
				const hits = await this.api(`/search?${params}`);
				this.setOnline(true);
				return hits;
			} catch (error) {
				if (!this.isOffline(error)) throw error;
				this.setOnline(false);
			}
		}
		// Without the server only Zotero papers can be searched: a search for notes, PDFs or images has nothing to look in.
		if (exclude || (source && source !== "zotero")) throw new Error("Notes need the Second Brain server");
		return (await this.searchLocally(query, limit)).map((item) => ({
			path: "zotero/" + item.key, title: item.getField("title"),
			zotero: { authors: item.getCreators().map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")), year: item.getField("year"), venue: item.getField("publicationTitle") },
		}));
	},

	/** Papers for a query without the server: the built-in model by meaning, plus Zotero's own word search.
	 *  `words` picks Zotero's quick-search mode; `within` (a Set of item keys) limits the results to a scope. */
	async searchLocally(query, limit, { words = "quicksearch-titleCreatorYearNote", within = null } = {}) {
		const search = new Zotero.Search();
		search.libraryID = Zotero.Libraries.userLibraryID;
		search.addCondition(words, "contains", query);
		const ids = (await search.search()).slice(0, 400);
		const items = Zotero.Items.get(ids).map((item) => (item.isRegularItem() ? item : item.parentItem)).filter((item) => item?.isRegularItem());
		const keyword = [...new Map(items.map((item) => [item.key, item])).keys()];
		let keys = keyword;
		if (this.localIndex.ready) {
			// meaning first; papers that also contain the words move up a little
			const exact = new Set(keyword);
			// a scope can be small, so rank the whole library before keeping the papers inside it
			const ranked = (await this.localIndex.search(query, within ? this.localIndex.keys.length : 2 * limit)).map((hit) => ({ ...hit, score: hit.score + (exact.has(hit.key) ? 0.03 : 0) }));
			ranked.sort((a, b) => b.score - a.score);
			keys = [...new Set([...ranked.map((hit) => hit.key), ...keyword])];
		}
		if (within) keys = keys.filter((key) => within.has(key));
		const found = keys.slice(0, limit).map((key) => Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key)).filter(Boolean);
		await Zotero.Items.loadDataTypes(found);
		return found;
	},

	async api(path) {
		const response = await Zotero.HTTP.request("GET", this.server + path, {
			responseType: "json", timeout: 15000, successCodes: false,
		});
		if (response.status >= 400 || !response.response) {
			throw new Error(response.response?.error ?? `HTTP ${response.status}`);
		}
		return response.response;
	},

	unreachable(error) {
		return this.isOffline(error)
			? "Second Brain isn't running, so this needs it. Notes, highlights and citations still work without it."
			: `Couldn't reach Second Brain: ${error?.message ?? error}`;
	},

	// ------------------------------------------------------------------ opening results

	/** Zotero items are selected in the library; notes, PDFs and images open in Obsidian; files of a listed folder
	 *  ("papers:/review.md", server spec 018) are not in the vault, so they open in the web app's reader. */
	open(path) {
		if (path.startsWith("zotero/")) {
			const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, path.slice(7));
			if (item) Zotero.getActiveZoteroPane()?.selectItem(item.id);
			return;
		}
		if (/^[a-z0-9][a-z0-9-]{0,31}:\//.test(path)) {
			this.openURL(/\.(pdf|png|jpe?g|webp|heic|gif|tiff?|bmp)$/i.test(path)
				? `${this.server}/folder-file?path=${encodeURIComponent(path)}`
				: `${this.server}/app/#/note/${path.split("/").map(encodeURIComponent).join("/")}`);
			return;
		}
		this.openURL(`obsidian://open?vault=${encodeURIComponent(this.vault)}&file=${encodeURIComponent(path.replace(/\.md$/, ""))}`);
	},

	/** Follow a link from a note without Zotero's "open this link?" prompt: zotero:// links are handled here,
	 *  obsidian:// and web links go to macOS directly (Zotero's own launcher asks every time). */
	openURL(href) {
		// A single Zotero item key selects it the plain, unchanged way. Several tokens (comma-separated 8-char
		// keys or citekeys, from the Obsidian side's "Show cited papers in Zotero") go through the same
		// advanced-search filter as showPapersInLibrary; itemByCitekey already accepts either form.
		const select = /^zotero:\/\/select\/library\/items\/([^/?]+)$/.exec(href);
		if (select) {
			const tokens = select[1].split(",").filter(Boolean).map((t) => decodeURIComponent(t));
			if (tokens.length === 1 && /^[A-Z0-9]{8}$/.test(tokens[0])) {
				return Zotero.getActiveZoteroPane()?.selectItem(Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, tokens[0])?.id);
			}
			return Promise.all(tokens.map((t) => this.itemByCitekey(t))).then((items) => this.showPapersInLibrary(items.filter(Boolean).map((i) => i.key)));
		}
		const zotero = /^zotero:\/\/(open-pdf)\/library\/items\/([A-Z0-9]{8})(?:\?(.*))?$/.exec(href);
		if (zotero) {
			const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, zotero[2]);
			if (!item) return;
			const params = new URLSearchParams(zotero[3] ?? "");
			const location = params.get("annotation") ? { annotationID: params.get("annotation") }
				: params.get("page") ? { pageIndex: Number(params.get("page")) - 1 } : undefined;
			return Zotero.Reader.open(item.id, location);
		}
		if (!/^(obsidian|https?|mailto):/i.test(href)) return;
		if (Zotero.isMac) Zotero.Utilities.Internal.exec("/usr/bin/open", [href]);
		else Zotero.launchURL(href);
	},

	// ------------------------------------------------------------------ item pane section

	registerSection() {
		this.paneID = Zotero.ItemPaneManager.registerSection({
			paneID: "second-brain",
			pluginID: this.id,
			header: { l10nID: "second-brain-pane-header", icon: this.rootURI + "content/icon.svg" },
			sidenav: { l10nID: "second-brain-pane-sidenav", icon: this.rootURI + "content/icon20.svg" },
			bodyXHTML: '<html:div class="sb-body" xmlns:html="http://www.w3.org/1999/xhtml"></html:div>',
			onItemChange: ({ item, setEnabled }) => {
				setEnabled(!!item?.isRegularItem());
				return true;
			},
			// Zotero calls onRender on every item change but onAsyncRender only when it sees the section scroll into
			// view, and it can miss that; so the section starts itself from onRender, once per item. Re-renders for
			// the same item (scrolling back into view) leave the open note alone.
			onRender: ({ body, item, setSectionSummary }) => this.renderOnce(body, item, setSectionSummary),
			onAsyncRender: ({ body, item, setSectionSummary }) => this.renderOnce(body, item, setSectionSummary),
			sectionButtons: [{
				type: "search",
				icon: "chrome://zotero/skin/16/universal/magnifier.svg",
				l10nID: "second-brain-section-search",
				onClick: ({ item }) => this.openSearch(item?.getField("title") ?? ""),
			}, {
				type: "discover",
				icon: "chrome://zotero/skin/16/universal/globe.svg",
				l10nID: "second-brain-section-discover",
				onClick: ({ item }) => this.findRelatedOnline(item),
			}],
		});
	},

	renderOnce(body, item, setSectionSummary) {
		const box = body.querySelector(".sb-body");
		if (!box || !item || box.dataset.key === item.key) return;
		this.pinOnce(body);
		box.dataset.key = item.key;
		this.addUiStyles(body.ownerDocument, this.rootURI);
		box.replaceChildren(this.stateLine(body.ownerDocument, "loading", "Looking in your notes…"));
		this.renderSection(body, item, setSectionSummary).catch((error) => {
			Zotero.logError(error);
			delete box.dataset.key; // try again on the next render
		});
	},

	/** With Focus off the note sits below Zotero's own sections. Pin it once (Zotero's "Pin Section"), so picking
	 *  a paper scrolls to the note; if the user unpins it or pins something else, that choice stays. */
	pinOnce(body) {
		if (Zotero.Prefs.get("extensions.secondbrain.pinnedOnce", true)) return;
		const details = body.closest("item-details");
		if (!details || details.closest("#zotero-context-pane")) return;
		Zotero.Prefs.set("extensions.secondbrain.pinnedOnce", true, true);
		if (!details.pinnedPane) details.pinnedPane = this.paneID;
	},

	/** Search snippets from notes without their Markdown: images, embeds, comments, quote marks and link targets. */
	plainSnippet(text) {
		return text.replace(/%%[\s\S]*?%%/g, " ").replace(/!\[\[[^\]]*\]\]/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (m, a, b) => b || a)
			.replace(/(^|\s)(>|-|\*)\s/g, " ").replace(/[\u{1F7E5}-\u{1F7EB}\u{2B1B}\u{2B1C}]/gu, "")
			.replace(/\*\*|__|`|==/g, "").replace(/\s+/g, " ").trim();
	},

	async renderSection(body, item, setSectionSummary) {
		const doc = body.ownerDocument;
		const box = body.querySelector(".sb-body");
		this.style(doc);
		this.addUiStyles(doc, this.rootURI);
		this.applyFocus(doc);
		if (item.isFeedItem) {
			box.replaceChildren(this.stateLine(doc, "info", "Feed articles aren't indexed. Add this one to My Library to see related notes."));
			setSectionSummary?.("");
			return;
		}
		const path = "zotero/" + item.key;
		box.replaceChildren(this.noteEditor(doc, item));
		let related, note;
		try {
			[related, note] = await Promise.all([
				this.api(`/related?path=${encodeURIComponent(path)}&limit=10`).catch((error) => {
					if (error?.message?.includes("no Zotero item")) return null;
					throw error;
				}),
				this.api(`/paper-note?key=${item.key}`),
			]);
			this.setOnline(true);
		} catch (error) {
			if (box.dataset.key !== item.key) return;
			if (!this.isOffline(error)) Zotero.logError(error);
			this.setOnline(false);
			this.relatedInZotero(box, item);
			this.similarLocally(box, item);
			setSectionSummary?.("");
			return;
		}
		if (box.dataset.key !== item.key) return;
		if (!related) {
			box.append(this.stateLine(doc, "info", "This paper isn't in the index yet. New papers are added within a few minutes."));
			return;
		}
		const refs = related.refs ?? {};
		const notePath = note?.path;
		const citing = (related.linked_from ?? []).filter((p) => p !== notePath)
			.map((p) => refs[p] ?? { path: p, title: p.split("/").pop().replace(/\.md$/, "") });
		const junk = (s) => !s.title || /^(no title|untitled)$/i.test(s.title.trim());
		const notes = (related.similar ?? []).filter((s) => !s.path.startsWith("zotero/") && s.path !== notePath && !junk(s));
		const papers = (related.similar ?? []).filter((s) => s.path.startsWith("zotero/") && !junk(s));
		setSectionSummary?.(note?.path ? "Has a note" : citing.length ? `Cited in ${citing.length}` : "");
		const cite = item.getField("citationKey") || "citekey";
		const more = this.related_(doc);
		box.append(more);
		this.list(more, "Cited in your notes", citing, `No other notes cite this paper. Cite it anywhere as [@${cite}].`);
		this.list(more, "Related notes", notes, "Nothing close in your notes.");
		this.list(more, "Similar papers in your library", papers, "No similar papers found.");
	},

	/** Without the index: the paper's related items as Zotero knows them. */
	relatedInZotero(box, item) {
		const doc = box.ownerDocument;
		const more = this.related_(doc);
		box.append(more);
		const rows = item.relatedItems.map((key) => Zotero.Items.getByLibraryAndKey(item.libraryID, key))
			.filter((other) => other?.isRegularItem())
			.map((other) => ({ path: "zotero/" + other.key, title: other.getField("title"),
				zotero: { authors: other.getCreators().map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")), year: other.getField("year"), venue: other.getField("publicationTitle") } }));
		this.list(more, "Related in Zotero", rows, "No related items.");
	},

	/** Without the index server: similar papers from the search model running in Zotero, if it's downloaded. */
	similarLocally(box, item) {
		const doc = box.ownerDocument;
		const more = box.querySelector(".sb-related") ?? box.appendChild(this.related_(doc));
		const index = this.localIndex;
		if (!index.ready) {
			const hint = this.stateLine(doc, "info", index.state === "absent"
				? "For similar papers without Obsidian, download the search model in Second Brain settings (⚙)."
				: "The search model is still reading your library; similar papers show here when it's done.");
			more.append(hint);
			return;
		}
		const rows = index.similar(item.key, 8).map(({ key, score }) => {
			const other = Zotero.Items.getByLibraryAndKey(item.libraryID, key);
			return other && { path: "zotero/" + key, title: other.getField("title"), score, calibration: index.calibration,
				zotero: { authors: other.getCreators().map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")), year: other.getField("year"), venue: other.getField("publicationTitle") } };
		}).filter(Boolean);
		this.list(more, "Similar papers in your library", rows, "No similar papers found.");
	},

	/** "My notes" of the paper's Obsidian note, editable right here. */
	noteEditor(doc, item) {
		const card = this.el(doc, "div", "sb-note-card");
		const host = this.el(doc, "div");
		card.append(host);
		for (const old of this.editors) if (!old.tab && !old.root.isConnected) this.closeEditor(old);
		this.editors.add(new this.Editor(doc, host, item));
		return card;
	},

	/** Focus: hide every other item pane section and the related lists, so the note gets the whole pane's height.
	 *  The pane keeps its width. */
	setFocus(on) {
		this.focusMode = on;
		Zotero.Prefs.set("extensions.secondbrain.focus", on, true);
		for (const win of Zotero.getMainWindows()) this.applyFocus(win.document);
		for (const editor of this.editors) editor.showFocus();
	},

	applyFocus(doc) {
		for (const details of doc.querySelectorAll("item-details")) {
			details.classList.toggle("sb-focus", this.focusMode);
			if (this.focusMode) details.querySelector(".zotero-view-item")?.scrollTo(0, 0);
		}
		this.restoreLayout(doc);
	},

	/** Focus used to widen the note: it folded the collections pane away and set the item pane and the pane beside
	 *  an open PDF to half the window, saving the old layout in a pref. Focus no longer changes any size (the note
	 *  jumping wider and back was jarring), so a layout saved by that version is put back once and forgotten. */
	restoreLayout(doc) {
		const saved = Zotero.Prefs.get("extensions.secondbrain.focusLayout", true);
		const win = doc.defaultView;
		const splitter = doc.getElementById("zotero-collections-splitter");
		if (!saved || !splitter || !win.ZoteroPane) return;
		const layout = JSON.parse(saved);
		if (!layout.collapsed) splitter.setAttribute("state", "open");
		const widths = layout.widths ?? { "zotero-item-pane": layout.width ?? "" };
		for (const [id, width] of Object.entries(widths)) {
			const pane = doc.getElementById(id);
			if (!pane) continue;
			if (width) pane.setAttribute("width", width);
			else pane.removeAttribute("width");
			pane.style.width = width ? `${width}px` : "";
		}
		Zotero.Prefs.clear("extensions.secondbrain.focusLayout", true);
		win.ZoteroPane.updateLayoutConstraints?.();
	},

	closeEditor(editor) {
		editor.flush().finally(() => editor.destroy());
		this.editors.delete(editor);
	},

	/** Something changed in Zotero (a highlight, a comment, a note): show it in the open notes now, and copy it
	 *  into the Obsidian file a moment later, once the burst of changes has settled. */
	zoteroChanged(event, ids = []) {
		this.added ??= new Set();
		this.touched ??= new Set();
		if (event === "add") for (const id of ids) this.added.add(id);
		// deleted items can no longer be traced to their paper
		if (event === "delete") this.touchedAll = true;
		else for (const id of ids) this.touched.add(this.paperKeyOf(id));
		if (event !== "refresh") this.localIndex?.updateSoon();
		clearTimeout(this.zoteroTimer);
		this.zoteroTimer = setTimeout(() => {
			const added = [...this.added];
			const touched = new Set(this.touched);
			const all = this.touchedAll;
			this.added.clear();
			this.touched.clear();
			this.touchedAll = false;
			for (const editor of this.editors) {
				if (!all && !touched.has(editor.key)) continue;
				if (editor.root.isConnected && editor.renderFromZotero() && editor.path) this.refreshNoteSoon(editor.key);
			}
			if (this.autoQuote) this.quoteNewHighlights(added);
		}, 250);
	},

	/** The paper an item belongs to: an annotation's attachment's parent, a child note's parent, or the item itself. */
	paperKeyOf(id) {
		let item = Zotero.Items.get(id);
		while (item?.parentItem) item = item.parentItem;
		return item?.key;
	},

	drafts() {
		try {
			return JSON.parse(Zotero.Prefs.get("extensions.secondbrain.drafts", true) || "{}");
		} catch {
			return {};
		}
	},

	saveDrafts(drafts) {
		Zotero.Prefs.set("extensions.secondbrain.drafts", JSON.stringify(drafts), true);
	},

	/** A highlight was just made on a paper whose note is open: add it to the note as a linked quote. */
	quoteNewHighlights(ids) {
		for (const id of ids) {
			const annotation = Zotero.Items.get(id);
			if (!annotation?.isAnnotation?.() || annotation.annotationType === "ink") continue;
			// only highlights made just now, not ones arriving from another device through sync
			if (Date.now() - Zotero.Date.sqlToDate(annotation.dateAdded, true).getTime() > 60000) continue;
			const attachment = annotation.parentItem;
			const paper = attachment?.parentItem;
			if (!paper) continue;
			// one editor per paper does it (a tab is preferred over the side pane)
			const open = [...this.editors].filter((e) => e.key === paper.key && e.root.isConnected);
			const editor = open.find((e) => e.tab) ?? open[0];
			editor?.quote(attachment, annotation);
		}
	},

	/** Highlight comments and Zotero notes edited in the paper's Obsidian note: write them into Zotero. */
	async applyObsidianEdits() {
		if (this.applyingEdits) return;
		this.applyingEdits = true;
		try {
			let edits;
			try {
				edits = await this.api("/zotero/edits");
				this.setOnline(true);
			} catch (error) {
				if (this.isOffline(error)) this.setOnline(false);
				return;
			}
			if (!edits.length) return;
			const done = [];
			const library = Zotero.Libraries.userLibraryID;
			for (const edit of edits) {
				const item = Zotero.Items.getByLibraryAndKey(library, edit.key);
				try {
					if (edit.kind === "comment" && item?.isAnnotation()) {
						if ((item.annotationComment || "") !== edit.value) {
							item.annotationComment = edit.value;
							await item.saveTx();
						}
					} else if (edit.kind === "note" && item?.isNote()) {
						item.setNote(`<div data-schema-version="9">${this.cleanNoteHTML(edit.html)}</div>`);
						await item.saveTx();
					}
					done.push(edit.id); // also when the item is gone: nothing left to apply it to
				} catch (error) {
					Zotero.logError(error);
				}
			}
			if (done.length) await this.post("/zotero/edits/done", { ids: done });
		} catch (error) {
			/* server not running; try again next time */
		} finally {
			this.applyingEdits = false;
		}
	},

	setAutoQuote(on) {
		this.autoQuote = on;
		Zotero.Prefs.set("extensions.secondbrain.autoQuote", on, true);
		for (const editor of this.editors) editor.showAutoQuote?.();
	},

	shortLabel(item) {
		return [item.getField("firstCreator"), item.getField("year")].filter(Boolean).join(" ");
	},

	/** "Hou et al. 2024" for a citekey, looked up once in the library; onReady redraws when it arrives. */
	citeLabel(key, onReady) {
		this.citeCache ??= new Map();
		if (this.citeCache.has(key)) return this.citeCache.get(key);
		this.citeCache.set(key, null);
		this.itemByCitekey(key).then((item) => {
			if (!item) return;
			this.citeCache.set(key, { label: this.shortLabel(item) || key, title: item.getField("title"), id: item.id });
			onReady?.();
		});
		return null;
	},

	async itemByCitekey(key) {
		const library = Zotero.Libraries.userLibraryID;
		if (/^[A-Z0-9]{8}$/.test(key)) {
			const byKey = Zotero.Items.getByLibraryAndKey(library, key);
			if (byKey?.isRegularItem()) return byKey;
		}
		const search = new Zotero.Search();
		search.libraryID = library;
		search.addCondition("citationKey", "is", key);
		const ids = await search.search().catch(() => []);
		return ids.length ? Zotero.Items.get(ids[0]) : null;
	},

	async selectByCitekey(key) {
		const item = await this.itemByCitekey(key);
		if (item) Zotero.getActiveZoteroPane()?.selectItem(item.id);
	},

	/** "Hou et al. 2024" for a citekey, written into `node` now (from cache or the key itself) and again once the
	 *  lookup answers. Shared by the chat views and the toolbar/window search so a citation looks the same everywhere. */
	paperLabel(node, citekey) {
		const cached = this.citeLabel(citekey);
		node.textContent = cached?.label ?? citekey;
		if (!cached) this.itemByCitekey(citekey).then((item) => { if (item) node.textContent = this.shortLabel(item) || citekey; });
	},

	/** Click a citation: select the paper in the library, or (⌘/Ctrl-click) open its note. */
	async openPaper(citekey, openNote) {
		const item = await this.itemByCitekey(citekey);
		if (!item) return;
		const win = Zotero.getMainWindow();
		win?.focus();
		if (openNote) return this.openNoteTab(item);
		win?.Zotero_Tabs.select("zotero-pane");
		Zotero.getActiveZoteroPane()?.selectItem(item.id);
	},

	/** Citekeys to Zotero item keys, dropping any this library doesn't have. */
	async keysForCitekeys(citekeys) {
		const items = await Promise.all(citekeys.map((key) => this.itemByCitekey(key)));
		return items.filter(Boolean).map((item) => item.key);
	},

	/** Filters the library's item list to exactly these papers (by Zotero item key), using the temporary advanced
	 *  search Zotero's own Advanced Search pane builds, so the filter is real and the user can clear it with
	 *  Zotero's own close button in the search box. Zotero 7/8, which don't have the pane's deck, fall back to a plain selection. */
	async showPapersInLibrary(keys) {
		if (!keys.length) return;
		const win = Zotero.getMainWindow();
		if (!win) return;
		win.Zotero_Tabs.select("zotero-pane");
		const deckHost = win.document.getElementById("zotero-advanced-search-pane-deck");
		if (deckHost?.pane && typeof deckHost.pane.submit === "function") {
			const search = new Zotero.Search();
			search.libraryID = Zotero.Libraries.userLibraryID;
			for (const key of keys) search.addCondition("key", "is", key);
			search.addCondition("joinMode", "any");
			deckHost.selectedSearchType = "temporary";
			deckHost.pane.search = search;
			deckHost.state = "open";
			await deckHost.pane.submit();
			// collapsed keeps the filter but hides the editor's one-row-per-paper conditions; the search box then reads
			// "Advanced Search" with Zotero's own expand and close buttons
			await win.ZoteroPane.setAdvancedSearchState?.("collapsed");
		} else {
			const items = keys.map((key) => Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key)).filter(Boolean);
			Zotero.getActiveZoteroPane()?.selectItems(items.map((item) => item.id));
		}
	},

	refreshNoteSoon(key) {
		this.refreshTimers ??= new Map();
		clearTimeout(this.refreshTimers.get(key));
		this.refreshTimers.set(key, setTimeout(() => {
			this.refreshTimers.delete(key);
			if (this.store().kind !== "obsidian") return;
			this.post("/paper-note/refresh", { key }).catch((error) => { if (!this.isOffline(error)) Zotero.logError(error); });
		}, 2500));
	},

	/** Another editor saved this paper's note: let the others pick it up now rather than at the next poll. */
	notesChanged(key) {
		for (const editor of this.editors) if (editor.key === key && !editor.dirty) editor.checkForChanges();
	},

	/** The paper's note in its own Zotero tab: editor on the left, preview on the right. */
	openNoteTab(item) {
		const win = Zotero.getMainWindow();
		const tabs = win.Zotero_Tabs;
		const existing = this.noteTabs.get(item.key);
		if (existing && tabs._getTab(existing)?.tab) return tabs.select(existing);
		const title = item.getField("title") || "Paper note";
		let editor;
		const { id, container } = tabs.add({
			type: "second-brain-note", title: `Note · ${title}`, data: { itemID: item.id }, select: true,
			onClose: () => { if (editor) this.closeEditor(editor); this.noteTabs.delete(item.key); },
		});
		this.noteTabs.set(item.key, id);
		this.style(win.document);
		const scroller = this.el(win.document, "div", "sb-note-scroll");
		const page = this.el(win.document, "div", "sb-note-page");
		scroller.append(page);
		this.addUiStyles(win.document, this.rootURI);
		const meta = [item.getField("firstCreator"), item.getField("year"), item.getField("publicationTitle")].filter(Boolean).join(" · ");
		const head = this.el(win.document, "div", "sb-note-head sb-p is-flat");
		head.append(SecondBrainUI.PaperCard(win.document, { kicker: "Paper note", title, venue: meta }).el);
		const host = this.el(win.document, "div", "sb-note-editor");
		page.append(head, host);
		container.append(scroller);
		editor = new this.Editor(win.document, host, item, { tab: true });
		this.editors.add(editor);
		editor.ready.then(() => editor.cm?.focus());
	},

	/** The related-lists container: a shared-UI panel (ui-src) inside the item pane, flat on the pane's own background. */
	related_(doc) {
		return this.el(doc, "div", "sb-related sb-p is-flat");
	},

	/** One quiet status line (shared StateLine). */
	stateLine(doc, kind, text) {
		const line = SecondBrainUI.StateLine(doc, kind, text);
		line.classList.add("sb-p", "is-flat");
		return line;
	},

	/** A titled list of papers and notes as shared Section + Row; a similar paper or note carries its closeness. */
	list(box, label, rows, empty) {
		const U = SecondBrainUI;
		const doc = box.ownerDocument;
		const section = U.Section(doc, { title: label, count: rows.length, empty });
		for (const row of rows) {
			const isPaper = row.path.startsWith("zotero/");
			const line = U.Row(doc, {
				path: row.path, title: row.title, meta: U.metaOf(row) || undefined,
				// the model in Zotero reads title + abstract only, so its scores are graded against its own library-wide spread
				score: typeof row.score === "number" ? U.closeness(row.score, row.calibration) : null,
				tip: isPaper ? "Show this paper in your library" : `Open in Obsidian: ${row.path}`,
				onOpen: () => this.open(row.path),
			});
			section.body.append(line.el);
		}
		box.append(section.el);
	},

	async post(path, body) {
		const response = await Zotero.HTTP.request("POST", this.server + path, {
			body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
			responseType: "json", timeout: 30000, successCodes: false,
		});
		if (response.status >= 400 || !response.response) {
			const error = new Error(response.response?.error ?? `HTTP ${response.status}`);
			error.status = response.status;
			error.body = response.response;
			throw error;
		}
		return response.response;
	},

	// ------------------------------------------------------------------ menus

	registerMenus() {
		const related = Zotero.MenuManager.registerMenu({
			menuID: "second-brain-item-related",
			pluginID: this.id,
			target: "main/library/item",
			menus: [{
				menuType: "menuitem",
				l10nID: "second-brain-menu-related",
				icon: this.rootURI + "content/icon.svg",
				onShowing: (event, context) => {
					const ok = context.items?.length === 1 && context.items[0].isRegularItem();
					context.setVisible?.(ok);
				},
				onCommand: (event, context) => {
					const item = context.items?.[0];
					if (item) this.openSearch(item.getField("title"));
				},
			}],
		});
		const discover = Zotero.MenuManager.registerMenu({
			menuID: "second-brain-item-discover",
			pluginID: this.id,
			target: "main/library/item",
			menus: [{
				menuType: "menuitem",
				l10nID: "second-brain-menu-discover",
				onShowing: (event, context) => context.setVisible?.(context.items?.length === 1 && context.items[0].isRegularItem()),
				onCommand: (event, context) => this.findRelatedOnline(context.items?.[0]),
			}],
		});
		const findNew = Zotero.MenuManager.registerMenu({
			menuID: "second-brain-tools-discover",
			pluginID: this.id,
			target: "main/menubar/tools",
			menus: [{
				menuType: "menuitem",
				l10nID: "second-brain-menu-find-new",
				onCommand: () => this.openSearch("", null, "online"),
			}],
		});
		const findPDF = Zotero.MenuManager.registerMenu({
			menuID: "second-brain-item-find-pdf",
			pluginID: this.id,
			target: "main/library/item",
			menus: [{
				menuType: "menuitem",
				l10nID: "second-brain-menu-find-pdf",
				onShowing: (event, context) => context.setVisible?.(!!context.items?.some((item) => item.isRegularItem())),
				onCommand: (event, context) => this.findPDFsFor((context.items ?? []).filter((item) => item.isRegularItem()))
					.catch((error) => Zotero.logError(error)),
			}],
		});
		const search = Zotero.MenuManager.registerMenu({
			menuID: "second-brain-tools-search",
			pluginID: this.id,
			target: "main/menubar/tools",
			menus: [{
				menuType: "menuitem",
				l10nID: "second-brain-menu-search",
				icon: this.rootURI + "content/icon.svg",
				onCommand: () => this.openSearch(""),
			}],
		});
		const fix = Zotero.MenuManager.registerMenu({
			menuID: "second-brain-tools-fix",
			pluginID: this.id,
			target: "main/menubar/tools",
			menus: [{
				menuType: "menuitem",
				l10nID: "second-brain-menu-fix",
				onCommand: () => this.fixMissingPDFs().catch((error) => Zotero.logError(error)),
			}],
		});
		const regular = (context) => (context.items ?? []).filter((item) => item.isRegularItem());
		const startFrom = (start) => (event, context) => this.openChat({ start, items: regular(context) });
		const ask = Zotero.MenuManager.registerMenu({
			menuID: "second-brain-item-ask",
			pluginID: this.id,
			target: "main/library/item",
			menus: [{
				menuType: "submenu",
				l10nID: "second-brain-menu-ai",
				icon: this.rootURI + "content/icon.svg",
				onShowing: (event, context) => context.setVisible?.(regular(context).length > 0),
				menus: [
					{ menuType: "menuitem", l10nID: "second-brain-menu-ask", onCommand: (event, context) => this.openChat({ attach: regular(context) }) },
					{ menuType: "menuitem", l10nID: "second-brain-menu-chat-with", onCommand: startFrom("papers") },
					{ menuType: "menuitem", l10nID: "second-brain-menu-extract", onCommand: startFrom("extract") },
					{ menuType: "menuitem", l10nID: "second-brain-menu-report", onCommand: startFrom("report") },
				],
			}],
		});
		const ai = Zotero.MenuManager.registerMenu({
			menuID: "second-brain-tools-ai",
			pluginID: this.id,
			target: "main/menubar/tools",
			menus: [{ menuType: "menuitem", l10nID: "second-brain-menu-ai", onCommand: () => this.openChat() }],
		});
		const home = Zotero.MenuManager.registerMenu({
			menuID: "second-brain-tools-home",
			pluginID: this.id,
			target: "main/menubar/tools",
			menus: [{ menuType: "menuitem", l10nID: "second-brain-menu-home", onCommand: () => this.HomeTab.open(this) }],
		});
		const review = Zotero.MenuManager.registerMenu({
			menuID: "second-brain-tools-review",
			pluginID: this.id,
			target: "main/menubar/tools",
			menus: [{ menuType: "menuitem", l10nID: "second-brain-menu-review", onCommand: () => this.openReview() }],
		});
		this.menuIDs = [related, discover, findNew, findPDF, search, fix, ask, ai, home, review].filter(Boolean);
	},

	// ------------------------------------------------------------------ AI

	/** The AgentService to use now: the Second Brain server's while it runs, otherwise the one inside Zotero. */
	ai() {
		return this.agent.ai();
	},

	openChat(options = {}) {
		return this.ChatTab.open(this, options);
	},

	/** T6.3: the Settings pane's own scope can't see the bare `SecondBrainAgent` global agent.js defines
	 *  (loaded into this file's scope by bootstrap.js, not the prefpane's), so it reads the catalog from here
	 *  instead, the same way it already reaches everything else through Zotero.SecondBrain. */
	get mcpCatalog() {
		return SecondBrainAgent.MCP_CATALOG;
	},

	/** The Tools menu's Research Report item: the chat, in Research report mode. */
	openReview() {
		return this.ChatTab.open(this, { mode: "report" });
	},

	openSearch(query, related = null, mode = null) {
		const win = Zotero.getMainWindow();
		const existing = Services.wm.getMostRecentWindow("second-brain:search");
		if (existing) {
			if (related) existing.SecondBrainSearch?.showRelated(related);
			else if (mode) existing.SecondBrainSearch?.setMode(mode);
			else existing.SecondBrainSearch?.setQuery(query);
			existing.focus();
			return;
		}
		win.openDialog("chrome://second-brain/content/search.xhtml", "second-brain-search",
			"chrome,resizable,centerscreen,width=720,height=820", { query, related, mode, SecondBrain: this });
	},

	/** Papers related to this one that you don't have yet (and the ones you do), from OpenAlex. */
	findRelatedOnline(item) {
		if (item?.isRegularItem()) this.openSearch("", item.key);
	},

	// ------------------------------------------------------------------ index status column

	/** "Second Brain" column in the item list: whether each paper is in the index and with what. */
	registerColumn() {
		this.columnKey = Zotero.ItemTreeManager.registerColumn({
			dataKey: "second-brain-index",
			label: "Second Brain",
			pluginID: this.id,
			width: "110",
			dataProvider: (item) => this.indexLabel(item),
		});
	},

	indexLabel(item) {
		if (!item.isRegularItem() || item.libraryID !== Zotero.Libraries.userLibraryID) return "";
		if (!this.online) return "";
		const s = this.indexState[item.key];
		if (!s) return "Not indexed";
		const what = s.full_text ? "Full text" : "Details only";
		return s.state === "meaning" ? what : `${what} (keywords)`;
	},

	async refreshIndexState() {
		try {
			this.indexState = (await this.api("/zotero/status")).items ?? {};
			this.online = true;
			Zotero.ItemTreeManager.refreshColumns?.();
		} catch (error) {
			if (this.isOffline(error)) this.setOnline(false);
		} finally {
			this.checkedOnce = true;
		}
	},

	// ------------------------------------------------------------------ toolbar search

	SEARCH_FILTERS: [
		["", "All"], ["zotero", "Papers"], ["personal", "My notes"], ["Notion", "Notion"],
		["pdf", "PDFs"], ["image", "Images"], ["ai_notes", "AI notes"],
	],

	/** Citekeys (`[@key]` / `[@a; @b]`) inside an already-plain-text snippet, turned into clickable citation chips
	 *  (same lookup and click behavior as the chat's own citations): a paper chip selects it in the library,
	 *  ⌘/Ctrl-click opens its note. Everything else stays plain text; no innerHTML. */
	renderSnippet(doc, rawSnippet) {
		const text = this.plainSnippet(rawSnippet);
		const frag = doc.createDocumentFragment();
		let last = 0;
		for (const m of text.matchAll(/\[(@[^\]]+)\]/g)) {
			if (m.index > last) frag.append(text.slice(last, m.index));
			last = m.index + m[0].length;
			const keys = m[1].split(/[;,]\s*/).map((k) => k.trim().replace(/^@/, "")).filter(Boolean);
			frag.append("(");
			keys.forEach((key, n) => {
				if (n) frag.append("; ");
				const chip = this.el(doc, "span", "sb-cite-chip");
				this.paperLabel(chip, key);
				chip.title = "Click to show in your library, ⌘-click to open its note";
				chip.addEventListener("mousedown", (event) => event.stopPropagation());
				chip.addEventListener("click", (event) => { event.stopPropagation(); this.openPaper(key, event.metaKey || event.ctrlKey); });
				frag.append(chip);
			});
			frag.append(")");
		}
		if (last < text.length) frag.append(text.slice(last));
		return frag;
	},

	/** The Zotero item keys a set of search hits point to: the papers themselves, plus any papers cited (by
	 *  citekey) in the visible snippet of a note or other hit. Only what's shown, not a hit's full unfetched text. */
	async papersInHits(hits) {
		const keys = new Set();
		const citekeys = new Set();
		for (const hit of hits) {
			if (hit.path.startsWith("zotero/")) keys.add(hit.path.slice(7));
			for (const passage of hit.passages ?? []) for (const m of (passage.snippet ?? "").matchAll(/@([\w:.#$%&+?<>~/-]+)/g)) citekeys.add(m[1].replace(/[.,;:]+$/, ""));
		}
		for (const key of await this.keysForCitekeys([...citekeys])) keys.add(key);
		return [...keys];
	},

	/** A search field next to Zotero's own, over notes, PDFs, images and papers; results drop down under it. */
	addToolbarSearch(window) {
		const doc = window.document;
		const anchor = doc.getElementById("zotero-tb-search");
		if (!anchor || doc.getElementById("second-brain-tb-search")) return;
		this.style(doc);
		this.addUiStyles(doc, this.rootURI);
		const input = this.el(doc, "input", "sb-tb-input");
		input.id = "second-brain-tb-search";
		input.type = "search";
		input.placeholder = "Search Second Brain…";
		input.title = "Search your notes, PDFs and papers by meaning";
		anchor.after(input);

		const panel = doc.createXULElement("panel");
		panel.id = "second-brain-tb-results";
		panel.setAttribute("noautofocus", "true");
		panel.setAttribute("consumeoutsideclicks", "false");
		let source = Zotero.Prefs.get("extensions.secondbrain.searchSource", true) || "";
		const chips = this.el(doc, "div", "sb-tb-chips sb-p-pill-row");
		for (const [value, label] of this.SEARCH_FILTERS) {
			const chip = this.el(doc, "button", "sb-p-pill", label);
			chip.classList.toggle("is-on", value === source);
			chip.addEventListener("mousedown", (event) => event.preventDefault()); // don't blur the input or close the panel
			chip.addEventListener("click", () => {
				source = value;
				Zotero.Prefs.set("extensions.secondbrain.searchSource", value, true);
				for (const other of chips.children) other.classList.toggle("is-on", other === chip);
				run();
			});
			chips.append(chip);
		}
		const list = this.el(doc, "div", "sb-tb-list");
		const footer = this.el(doc, "div", "sb-tb-cited");
		const shell = this.el(doc, "div", "sb-tb-shell sb-p is-flat");
		shell.append(chips, list, footer);
		panel.append(shell);
		(doc.getElementById("mainPopupSet") ?? doc.documentElement).append(panel);

		let timer = null, seq = 0, hits = [], active = 0;
		const show = () => {
			if (panel.state !== "open" && panel.state !== "showing") panel.openPopup(input, "after_start", 0, 3, false, false);
		};
		const select = (i) => {
			active = Math.max(0, Math.min(hits.length - 1, i));
			list.querySelectorAll(".sb-p-row").forEach((row, n) => row.classList.toggle("is-selected", n === active));
			list.querySelectorAll(".sb-p-row")[active]?.scrollIntoView({ block: "nearest" });
		};
		const openHit = (hit) => { panel.hidePopup(); this.open(hit.path); };
		const run = async () => {
			const query = input.value.trim();
			const mine = ++seq;
			if (!query) { panel.hidePopup(); return; }
			list.replaceChildren(this.stateLine(doc, "loading", "Searching…"));
			footer.replaceChildren();
			show();
			try {
				const result = await this.searchAll(query, 15, source);
				if (mine !== seq) return;
				hits = result;
			} catch (error) {
				if (mine === seq) list.replaceChildren(this.stateLine(doc, "error", this.unreachable(error)));
				return;
			}
			list.replaceChildren();
			if (!hits.length) list.append(this.stateLine(doc, "empty", "No matches."));
			hits.forEach((hit, n) => {
				const snippet = hit.passages?.[0]?.snippet;
				const { el: row } = SecondBrainUI.Row(doc, { path: hit.path, title: hit.title, meta: SecondBrainUI.metaOf(hit) || undefined, snippet: snippet ? this.renderSnippet(doc, snippet) : undefined });
				row.classList.add("sb-tb-row");
				row.addEventListener("mousedown", (event) => { event.preventDefault(); openHit(hit); });
				row.addEventListener("mousemove", () => { if (active !== n) select(n); });
				list.append(row);
			});
			list.append(this.stateLine(doc, "info", this.online ? "↑↓ move · Enter open · papers open here, notes in Obsidian"
				: this.localIndex.ready ? "↑↓ move · Enter open · searching your library by meaning, on this computer"
				: "↑↓ move · Enter open · searching titles, authors and notes (download the search model in settings to search by meaning)"));
			select(0);
			this.papersInHits(hits).then((keys) => {
				if (mine !== seq || !keys.length) return;
				footer.replaceChildren(SecondBrainUI.Button(doc, keys.length === 1 ? "Show paper in library" : `Show ${keys.length} papers in library`, () => this.showPapersInLibrary(keys)));
			});
		};
		input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 180); });
		input.addEventListener("focus", () => { if (input.value.trim() && hits.length) show(); });
		input.addEventListener("blur", () => setTimeout(() => panel.hidePopup(), 150));
		input.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown") { event.preventDefault(); show(); select(active + 1); }
			else if (event.key === "ArrowUp") { event.preventDefault(); select(active - 1); }
			else if (event.key === "Enter" && hits[active]) { event.preventDefault(); openHit(hits[active]); }
			else if (event.key === "Escape") { panel.hidePopup(); }
		});
	},

	// ------------------------------------------------------------------ fixing missing PDFs

	/** Relink PDFs found on the drives, then download the rest with Zotero's own Find Full Text. */
	async fixMissingPDFs() {
		const win = Zotero.getMainWindow();
		const prompts = Services.prompt;
		if (this.fixing) {
			if (prompts.confirm(win, "Second Brain", "Finding PDFs is still running. Stop it?")) this.fixing.stop = true;
			return;
		}
		const job = (this.fixing = { stop: false });
		try {
			await this.runFix(win, prompts, job);
		} finally {
			this.fixing = null;
		}
	},

	/** Without Second Brain there's no drive search, but papers with no PDF can still be found online. */
	async planWithoutServer() {
		const items = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).filter((item) => item.isRegularItem());
		let ok = 0;
		const missing = [];
		for (const item of items) (await this.hasWorkingPDF(item)) ? ok++ : missing.push(item.key);
		return { counts: { ok, pdf_attachments: items.length, ok_after_base: 0 }, relink: [], find_online: missing, local: true };
	},

	async runFix(win, prompts, job) {
		const progress = new Zotero.ProgressWindow({ closeOnClick: false });
		progress.changeHeadline("Second Brain: checking PDF attachments");
		const line = new progress.ItemProgress(this.rootURI + "content/icon.svg", "Looking for missing files on your drives…");
		progress.show();
		let plan;
		try {
			for (let first = true; ; first = false) {
				const reply = await this.api(`/zotero/files${first ? "?refresh=1" : ""}`);
				if (reply.ready) { plan = reply.plan; break; }
				if (reply.error) throw new Error(reply.error);
				if (reply.total) {
					line.setText(`Checking attachments… ${reply.done} of ${reply.total}`);
					line.setProgress(Math.round((reply.done / reply.total) * 100));
				}
				await Zotero.Promise.delay(1500);
			}
		} catch (error) {
			if (!this.isOffline(error)) {
				line.setError();
				line.setText(this.unreachable(error));
				progress.startCloseTimer(8000);
				return;
			}
			line.setText("Finding papers without a PDF…");
			plan = await this.planWithoutServer();
		}
		progress.close();

		const c = plan.counts;
		const baseChange = plan.base && Zotero.Prefs.get("baseAttachmentPath") !== plan.base;
		const text = [
			plan.local ? `${c.ok} of ${c.pdf_attachments} papers have a PDF that opens. (Start Second Brain to also search your drives for lost files.)`
				: `${c.ok} of ${c.pdf_attachments} PDF attachments open today.`,
			baseChange ? `• ${c.ok_after_base} more open once linked files are read from ${plan.base}.` : "",
			plan.local ? "" : `• ${plan.relink.length} were found elsewhere on your drives (checked against each paper's title or DOI) and will be relinked.`,
			`• ${plan.find_online.length} papers still have no PDF; Zotero will look for open-access copies online, then Unpaywall (with your email), arXiv, OpenAlex, Semantic Scholar and Europe PMC (this runs in the background and can take a while).`,
			"",
			"Nothing is deleted. Continue?",
		].filter((t) => t !== "").join("\n");
		if (!prompts.confirm(win, "Fix missing PDFs", text)) return;

		if (baseChange) Zotero.Prefs.set("baseAttachmentPath", plan.base);
		const relinked = await this.relink(plan.relink, job);
		await this.findOnline(plan.find_online, job);
		if (relinked.length) Zotero.FullText.indexItems(relinked).catch(() => {});
	},

	async relink(entries, job) {
		const progress = new Zotero.ProgressWindow({ closeOnClick: false });
		progress.changeHeadline("Second Brain: relinking PDFs");
		const line = new progress.ItemProgress(this.rootURI + "content/icon.svg", "");
		progress.show();
		const done = [];
		let failed = 0;
		for (const [n, entry] of entries.entries()) {
			if (job.stop) break;
			line.setText(`Relinking ${n + 1} of ${entries.length}`);
			line.setProgress(Math.round(((n + 1) / entries.length) * 100));
			const attachment = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, entry.attachment);
			try {
				if (attachment && !(await attachment.fileExists())) {
					await attachment.relinkAttachmentFile(entry.path);
					done.push(attachment.id);
				}
			} catch (error) {
				failed++;
				Zotero.logError(error);
			}
		}
		line.setText(`Relinked ${done.length} PDFs${failed ? `, ${failed} failed` : ""}${job.stop ? " (stopped)" : ""}`);
		progress.startCloseTimer(6000);
		return done;
	},

	/** Papers with no PDF at all go to Zotero's Find Full Text queue. Papers whose only PDFs are broken are
	 *  skipped by that queue, so those are fetched one by one with the same resolvers; when a copy arrives,
	 *  broken attachments without highlights move to the Trash (restorable). */
	async findOnline(keys, job) {
		const items = keys.map((key) => Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key)).filter(Boolean);
		const fresh = items.filter((item) => Zotero.Attachments.canFindFileForItem(item));
		// Zotero's resolvers (DOI, URL, Unpaywall open access) first; it shows its own progress
		const zoteroPass = fresh.length ? Zotero.Attachments.addAvailableFiles(fresh).catch((e) => Zotero.logError(e)) : null;
		const broken = items.filter((item) => !fresh.includes(item) &&
			(item.getField("DOI") || item.getField("url") || item.getExtraField?.("DOI")));
		if (!broken.length) {
			await zoteroPass;
			return this.findOnArxiv(items, job);
		}
		const progress = new Zotero.ProgressWindow({ closeOnClick: false });
		progress.changeHeadline("Second Brain: downloading PDFs for broken links");
		const line = new progress.ItemProgress(this.rootURI + "content/icon.svg", "");
		progress.show();
		let found = 0;
		for (const [n, item] of broken.entries()) {
			if (job.stop) break;
			line.setText(`${n + 1} of ${broken.length} · ${found} found`);
			line.setProgress(Math.round(((n + 1) / broken.length) * 100));
			try {
				const added = await Zotero.Attachments.addFileFromURLs(item, Zotero.Attachments.getFileResolvers(item));
				if (!added) continue;
				found++;
			} catch (error) {
				Zotero.logError(error);
			}
		}
		line.setText(`Downloaded ${found} of ${broken.length} PDFs${job.stop ? " (stopped)" : ""}`);
		progress.startCloseTimer(10000);
		await zoteroPass;
		await this.findOnArxiv(items, job);
	},

	// ------------------------------------------------------------------ arXiv

	async hasWorkingPDF(item) {
		for (const id of item.getAttachments()) {
			const attachment = Zotero.Items.get(id);
			if (attachment?.isPDFAttachment?.() && !attachment.deleted && await attachment.fileExists()) return true;
		}
		return false;
	},

	/** The arXiv id a paper already names: its URL, a 10.48550/arXiv DOI, or "arXiv:" in Extra. */
	arxivID(item) {
		const fields = [item.getField("url"), item.getField("DOI"), item.getField("extra"), item.getField("archiveID"),
			item.getField("publicationTitle")].join(" ");
		const m = /arxiv\.org\/(?:abs|pdf)\/([\w.\/-]+?)(?:v\d+)?(?:\.pdf)?(?:[\s?#]|$)/i.exec(fields)
			|| /10\.48550\/arxiv\.([\d.]+)/i.exec(fields)
			|| /arxiv:\s*([\d]{4}\.[\d]{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})/i.exec(fields);
		return m ? m[1] : null;
	},

	normalizeTitle(title) {
		return (title || "").toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, " ").trim();
	},

	/** Search arXiv by title; accept only a near-identical title (so a wrong paper is never attached). */
	async searchArxiv(item) {
		const title = this.normalizeTitle(item.getField("title"));
		if (title.split(" ").length < 3) return null;
		const query = `ti:"${title.split(" ").slice(0, 14).join(" ")}"`;
		const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=5`;
		const response = await Zotero.HTTP.request("GET", url, { responseType: "text", timeout: 30000, successCodes: false });
		if (response.status !== 200) return null;
		const xml = new (Zotero.getMainWindow().DOMParser)().parseFromString(response.response, "application/xml");
		const want = new Set(title.split(" "));
		for (const entry of xml.getElementsByTagName("entry")) {
			const found = this.normalizeTitle(entry.getElementsByTagName("title")[0]?.textContent);
			const words = new Set(found.split(" "));
			const shared = [...want].filter((w) => words.has(w)).length;
			const similarity = shared / Math.max(want.size, words.size);
			if (found === title || similarity >= 0.9) {
				const id = entry.getElementsByTagName("id")[0]?.textContent ?? "";
				const m = /arxiv\.org\/abs\/(.+?)(?:v\d+)?$/.exec(id.trim());
				if (m) return m[1];
			}
		}
		return null;
	},

	// ------------------------------------------------------------------ open-access sources

	async json(url, onStatus) {
		const headers = {};
		const s2 = Zotero.Prefs.get("extensions.secondbrain.semanticScholarKey", true);
		if (s2 && url.startsWith("https://api.semanticscholar.org/")) headers["x-api-key"] = s2;
		const response = await Zotero.HTTP.request("GET", url, { responseType: "json", timeout: 30000, successCodes: false, headers });
		onStatus?.(response);
		return response.status === 200 ? response.response : null;
	},

	/** A free PDF for the paper from OpenAlex (which aggregates repositories), or null. */
	async openAlex(item) {
		const doi = (item.getField("DOI") || item.getExtraField?.("DOI") || "").replace(/^https?:\/\/doi\.org\//i, "");
		const url = doi ? `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`
			: `https://api.openalex.org/works?filter=title.search:${encodeURIComponent(this.normalizeTitle(item.getField("title")))}&per_page=1`;
		this.openAlexGuard(null);
		const data = await this.json(url + this.openAlexAuth(url.includes("?") ? "&" : "?"), (response) => this.openAlexGuard(response));
		const work = data?.results ? data.results[0] : data;
		if (!work) return null;
		if (!doi && this.titlesDiffer(item, work.display_name)) return null;
		const locations = [work.best_oa_location, work.primary_location, ...(work.locations ?? [])];
		return locations.find((l) => l?.pdf_url)?.pdf_url ?? null;
	},

	/** OpenAlex answers 429 once the shared free daily budget is spent. Remembered, so later calls fail without a request
	 *  (same sentence as the engine's OpenAlexLimit in agent-src/src/openalex.js). Pass the Zotero.HTTP response, or null to just check. */
	openAlexGuard(response) {
		const now = Date.now();
		if (response?.status === 429) {
			const retry = Number(response.getResponseHeader?.("retry-after"));
			const midnight = new Date(now); midnight.setUTCHours(24, 0, 0, 0);
			this.openAlexBlock = { until: retry > 0 ? now + retry * 1000 : midnight.getTime(), keyed: Boolean(Zotero.Prefs.get("extensions.secondbrain.openalexKey", true)) };
		}
		const block = this.openAlexBlock;
		if (!block || now >= block.until || block.keyed !== Boolean(Zotero.Prefs.get("extensions.secondbrain.openalexKey", true))) return;
		const when = new Date(block.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
		throw new Error(`OpenAlex's free daily limit is used up (resets ${when}). Add your free OpenAlex API key in Settings.`);
	},

	/** Your email (settings) puts OpenAlex requests in its faster "polite pool"; an API key lifts the daily cap. */
	openAlexAuth(join) {
		const params = new URLSearchParams();
		const email = Zotero.Prefs.get("extensions.secondbrain.email", true);
		const key = Zotero.Prefs.get("extensions.secondbrain.openalexKey", true);
		if (email) params.set("mailto", email);
		if (key) params.set("api_key", key);
		return params.size ? join + params : "";
	},

	/** Unpaywall takes its own API key, or an email address when there's no key. */
	unpaywallAuth() {
		const params = new URLSearchParams();
		const key = Zotero.Prefs.get("extensions.secondbrain.unpaywallKey", true);
		const email = Zotero.Prefs.get("extensions.secondbrain.email", true);
		if (key) params.set("api_key", key);
		if (email) params.set("email", email);
		return params.size ? String(params) : "";
	},

	/** Unpaywall's best open-access PDF for a DOI. Unpaywall needs an email with each request, so it's used only
	 *  once one is set in the settings. */
	async unpaywall(item) {
		const doi = (item.getField("DOI") || item.getExtraField?.("DOI") || "").replace(/^https?:\/\/doi\.org\//i, "");
		const auth = this.unpaywallAuth();
		if (!auth || !doi) return null;
		const data = await this.json(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?${auth}`);
		const locations = [data?.best_oa_location, ...(data?.oa_locations ?? [])];
		return locations.find((l) => l?.url_for_pdf)?.url_for_pdf ?? null;
	},

	/** Semantic Scholar's open-access copy, or null. */
	async semanticScholar(item) {
		const doi = (item.getField("DOI") || "").replace(/^https?:\/\/doi\.org\//i, "");
		const url = doi
			? `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=title,openAccessPdf`
			: `https://api.semanticscholar.org/graph/v1/paper/search?limit=1&fields=title,openAccessPdf&query=${encodeURIComponent(item.getField("title"))}`;
		const data = await this.json(url);
		const paper = data?.data ? data.data[0] : data;
		if (!paper || (!doi && this.titlesDiffer(item, paper.title))) return null;
		return paper.openAccessPdf?.url ?? null;
	},

	/** Europe PMC (life sciences), or null. */
	async europePMC(item) {
		const doi = (item.getField("DOI") || "").replace(/^https?:\/\/doi\.org\//i, "");
		if (!doi) return null;
		const data = await this.json(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:%22${encodeURIComponent(doi)}%22&format=json&resultType=core`);
		const hit = data?.resultList?.result?.[0];
		return hit?.pmcid && hit?.isOpenAccess === "Y" ? `https://europepmc.org/articles/${hit.pmcid}?pdf=render` : null;
	},

	titlesDiffer(item, other) {
		const want = new Set(this.normalizeTitle(item.getField("title")).split(" "));
		const found = new Set(this.normalizeTitle(other).split(" "));
		if (!want.size || !found.size) return true;
		const shared = [...want].filter((w) => found.has(w)).length;
		return shared / Math.max(want.size, found.size) < 0.85;
	},

	/** Save a PDF onto the paper, and undo it if what arrived isn't really a PDF. */
	async attachPDF(item, url, title) {
		const attachment = await Zotero.Attachments.importFromURL({
			libraryID: item.libraryID, parentItemID: item.id, url, title, contentType: "application/pdf",
		});
		const path = attachment && await attachment.getFilePathAsync();
		const head = path && (await IOUtils.read(path, { maxBytes: 5 }));
		if (head && new TextDecoder().decode(head) === "%PDF-") return true;
		if (attachment) await attachment.eraseTx(); // a login page or an error page, not the paper
		return false;
	},

	/** Papers still without a PDF after Zotero's own search: try the free sources, one paper at a time. */
	async findOnArxiv(items, job) {
		const missing = [];
		for (const item of items) if (!(await this.hasWorkingPDF(item))) missing.push(item);
		if (!missing.length) return;
		const progress = new Zotero.ProgressWindow({ closeOnClick: false });
		progress.changeHeadline("Second Brain: looking for free copies");
		const line = new progress.ItemProgress(this.rootURI + "content/icon.svg", "");
		progress.show();
		const found = { Unpaywall: 0, arXiv: 0, OpenAlex: 0, "Semantic Scholar": 0, "Europe PMC": 0 };
		for (const [n, item] of missing.entries()) {
			if (job.stop) break;
			const total = Object.values(found).reduce((a, b) => a + b, 0);
			line.setText(`${n + 1} of ${missing.length} · ${total} found`);
			line.setProgress(Math.round(((n + 1) / missing.length) * 100));
			const sources = [
				["Unpaywall", () => this.unpaywall(item)],
				["arXiv", async () => {
					let id = this.arxivID(item);
					if (!id) {
						id = await this.searchArxiv(item);
						await Zotero.Promise.delay(3000); // arXiv asks for one search every 3 seconds
					}
					return id ? `https://arxiv.org/pdf/${id}` : null;
				}],
				["OpenAlex", () => this.openAlex(item)],
				["Semantic Scholar", () => this.semanticScholar(item)],
				["Europe PMC", () => this.europePMC(item)],
			];
			for (const [name, find] of sources) {
				if (job.stop) break;
				try {
					const url = await find();
					await Zotero.Promise.delay(1000); // gentle on the free APIs
					if (!url) continue;
					if (await this.attachPDF(item, url, `${name} Full Text PDF`)) {
						found[name]++;
						break;
					}
				} catch (error) {
					Zotero.logError(error);
				}
			}
		}
		const summary = Object.entries(found).filter(([, n]) => n).map(([name, n]) => `${name} ${n}`).join(", ");
		line.setText(`Found ${Object.values(found).reduce((a, b) => a + b, 0)} of ${missing.length}${summary ? ` (${summary})` : ""}${job.stop ? " · stopped" : ""}`);
		progress.startCloseTimer(15000);
	},

	/** Right-click: find PDFs for the selected papers (Zotero's resolvers, then arXiv). */
	async findPDFsFor(items) {
		if (this.fixing) return;
		const job = (this.fixing = { stop: false });
		try {
			await this.findOnline(items.map((item) => item.key), job);
		} finally {
			this.fixing = null;
		}
	},

	// ------------------------------------------------------------------ helpers

	/** Obsidian text becomes Zotero note HTML: keep formatting tags and web/zotero links, drop everything else. */
	cleanNoteHTML(html) {
		const keep = new Set(["P", "BR", "HR", "STRONG", "B", "EM", "I", "U", "S", "DEL", "MARK", "SUB", "SUP", "CODE", "PRE",
			"BLOCKQUOTE", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "A", "SPAN", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);
		const drop = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "SVG", "MATH", "FORM", "LINK", "META", "BASE"]);
		const doc = new (Zotero.getMainWindow().DOMParser)().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, "text/html");
		const clean = (node) => {
			for (const child of [...node.children]) {
				const tag = child.tagName.toUpperCase();
				if (drop.has(tag)) { child.remove(); continue; }
				clean(child);
				if (!keep.has(tag)) { child.replaceWith(...child.childNodes); continue; }
				for (const { name } of [...child.attributes]) {
					if (!(tag === "A" && name === "href" && /^(https?|zotero):/i.test(child.getAttribute("href").trim()))) child.removeAttribute(name);
				}
			}
		};
		clean(doc.body);
		return doc.body.innerHTML;
	},

	el(doc, tag, cls, text) {
		const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
		if (cls) node.className = cls;
		if (text !== undefined) node.textContent = text;
		return node;
	},

	style(doc) {
		if (doc.getElementById("second-brain-style")) return;
		const style = this.el(doc, "style");
		style.id = "second-brain-style";
		style.textContent = `
			/* contain: inline-size keeps long titles from widening the pane; they get an ellipsis instead */
			.sb-body { display: flex; flex-direction: column; gap: 2px; padding-bottom: 4px; width: 100%; contain: inline-size; }
			.sb-body > * { min-width: 0; }
			.sb-muted { color: var(--fill-secondary); font-size: 12px; padding: 2px 0; }
			.sb-count { margin-inline-start: 6px; font-weight: 500; color: var(--fill-tertiary); }
			.sb-button { font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 5px; cursor: pointer;
				border: 1px solid var(--fill-quinary); background: var(--material-button, var(--fill-quinary)); color: inherit; }
			.sb-button:hover { background: var(--fill-quarternary, var(--fill-quinary)); }
			.sb-button.is-primary { align-self: flex-start; background: var(--accent-blue); border-color: transparent; color: #fff; font-weight: 500; padding: 5px 12px; }
			.sb-button:disabled { opacity: .6; cursor: default; }
			.sb-ed { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
			.sb-ed [hidden] { display: none !important; }
			.sb-ed-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
			.sb-ed-tools { display: flex; flex-wrap: wrap; gap: 2px; padding: 3px; border-radius: 9px; background: var(--fill-quinary); }
			.sb-tool { min-width: 32px; height: 30px; padding: 0 7px; border: none; border-radius: 6px; background: transparent;
				color: var(--fill-secondary); font: 15px -apple-system, system-ui, sans-serif; cursor: pointer; }
			.sb-tool:hover { background: var(--material-background); color: inherit; }
			.sb-tool.is-bold { font-weight: 700; } .sb-tool.is-italic { font-style: italic; font-family: Georgia, serif; }
			.sb-tool.is-heading { font-weight: 700; } .sb-tool.is-cite { color: var(--accent-blue); font-weight: 600; }
			.sb-ed:not(.is-tab) .sb-tool { min-width: 27px; height: 27px; padding: 0 5px; font-size: 14px; }
			.sb-ed-status { font-size: 12px; color: var(--fill-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
			.sb-ed-status.is-error { color: var(--accent-red, #d33); }
			.sb-ed-spacer { flex: 1; }
			.sb-ed-bar .sb-button { flex: none; padding: 4px 10px; font-size: 12.5px; border-color: transparent; background: transparent; color: var(--fill-secondary); }
			.sb-ed-bar .sb-button:hover { background: var(--fill-quinary); color: inherit; }
			.sb-ed-bar .sb-button.is-icon { font-size: 17px; padding: 2px 8px; }
			.sb-ed-toggle.is-on { color: var(--accent-green, #3a9d4a) !important; }

			/* the note: CodeMirror in its own frame (note-frame.html/.css) */
			.sb-ed-surface { min-width: 0; padding: 4px 16px 0; }
			.sb-ed-frame { display: block; width: 100%; height: 440px; border: 0; background: transparent; }

			/* the writing space: a sheet of its own, so it reads as the place to write */
			.sb-ed-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
			.sb-ed-heading { display: flex; flex-direction: column; min-width: 0; flex: 1; }
			.sb-ed-heading b { font-size: 15px; font-weight: 650; }
			.sb-ed-heading span { font-size: 11.5px; color: var(--fill-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.sb-ed-head .sb-button { flex: none; padding: 5px 12px; font-size: 12.5px; }
			.sb-ed-head .sb-button.is-on { background: var(--fill-quinary); color: inherit; }
			.sb-ed-head .sb-button.is-icon { font-size: 15px; padding: 3px 8px; border-color: transparent; background: transparent; }
			.sb-ed-sheet { display: flex; flex-direction: column; min-width: 0; border-radius: 8px; overflow: hidden;
				border: 1px solid var(--fill-quinary); background: var(--ed-sheet-bg, var(--material-background)); }
			.sb-ed-sheet:focus-within { border-color: var(--ed-accent, var(--color-accent)); }
			.sb-ed-sheet > .sb-ed-bar { padding: 6px 8px; border-bottom: 1px solid var(--fill-quinary); }
			.sb-ed-sheet > .sb-cite, .sb-ed-sheet > .sb-ed-conflict { margin: 8px 8px 0; }
			.sb-ed.is-tab .sb-ed-sheet { border-radius: 12px; }

			/* focus: only the note is left in the item pane */
			item-details.sb-focus .zotero-view-item > [data-pane]:not([data-pane=${doc.defaultView.CSS.escape(this.paneID)}]) { display: none !important; }
			item-details.sb-focus .sb-related { display: none; }

			.sb-hl-image img { max-width: 100%; border-radius: 4px; display: block; }
			.sb-hl.is-quoted .sb-hl-quote { opacity: 1; color: var(--accent-green, #3a9d4a); }

			/* rendered Markdown, close to Obsidian's reading view */
			.sb-md { font-size: 13.5px; line-height: 1.6; overflow-wrap: anywhere; min-width: 0; }
			.sb-md > :first-child { margin-top: 0; }
			.sb-md > :last-child { margin-bottom: 0; }
			.sb-md p { margin: 0 0 .6em; }
			.sb-md h1, .sb-md h2, .sb-md h3, .sb-md h4 { margin: .9em 0 .35em; line-height: 1.3; font-weight: 600; }
			.sb-md h1 { font-size: 1.3em; } .sb-md h2 { font-size: 1.15em; } .sb-md h3, .sb-md h4 { font-size: 1em; }
			.sb-md ul, .sb-md ol { margin: 0 0 .6em; padding-inline-start: 1.4em; }
			.sb-md li { margin: .15em 0; }
			.sb-md blockquote { margin: 0 0 .6em; padding-left: 10px; border-left: 3px solid var(--fill-quinary); color: var(--fill-secondary); }
			.sb-md code { font: 12px ui-monospace, Menlo, monospace; padding: 1px 4px; border-radius: 4px; background: var(--fill-quinary); }
			.sb-md pre { padding: 8px 10px; border-radius: 6px; background: var(--fill-quinary); overflow-x: auto; }
			.sb-md pre code { padding: 0; background: none; }
			.sb-md table { border-collapse: collapse; margin: 0 0 .6em; }
			.sb-md th, .sb-md td { border: 1px solid var(--fill-quinary); padding: 3px 7px; }
			.sb-md a, .sb-md .cite { color: var(--accent-blue); cursor: pointer; text-decoration: none; }
			.sb-md a:hover, .sb-md .cite:hover { text-decoration: underline; }
			.sb-md .cite.missing { color: var(--accent-red, #d33); cursor: default; text-decoration: none; }
			.sb-md .wikilink { color: var(--accent-purple, #8a63d2); }
			.sb-md-empty { color: var(--fill-tertiary); font-style: italic; }

			/* citation search and "[@" suggestions share one row design */
			.sb-cite { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 8px;
				border: 1px solid var(--fill-quinary); background: var(--material-background); box-shadow: 0 4px 14px rgba(0,0,0,.18); }
			.sb-cite-input { font: inherit; font-size: 13px; padding: 5px 8px; border-radius: 5px; border: 1px solid var(--fill-quinary);
				background: transparent; color: inherit; }
			.sb-cite-input:focus { outline: 2px solid var(--color-accent); outline-offset: -1px; }
			.sb-cite-list { display: flex; flex-direction: column; max-height: 240px; overflow-y: auto; }
			.sb-pick { display: flex; align-items: center; gap: 8px; padding: 5px 7px; border-radius: 5px; cursor: pointer; min-width: 0; }
			.sb-pick.is-active { background: var(--fill-quinary); }
			.sb-pick-main { flex: 1; min-width: 0; }
			.sb-pick-title { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.sb-pick-meta { font-size: 11px; color: var(--fill-secondary); }
			.sb-pick-key { flex: none; font: 10px ui-monospace, Menlo, monospace; color: var(--fill-tertiary); }
			.sb-pick-hint { font-size: 11px; color: var(--fill-tertiary); padding: 4px 7px; }

			.sb-ed-conflict { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px; border-radius: 6px;
				font-size: 12px; background: color-mix(in srgb, var(--accent-orange, orange) 18%, transparent); }
			.sb-note-card { padding: 2px 0 4px; }
			.sb-doc-section:empty { display: none; }
			.sb-doc-section { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid var(--fill-quinary); }
			.sb-doc-head { display: flex; align-items: baseline; font-size: 11px; font-weight: 600; text-transform: uppercase;
				letter-spacing: .04em; color: var(--fill-secondary); }
			.sb-hl { position: relative; padding: 6px 10px 5px 12px; border-radius: 6px; cursor: pointer;
				background: color-mix(in srgb, var(--hl) 13%, transparent); box-shadow: inset 3px 0 0 var(--hl); }
			.sb-hl:hover { background: color-mix(in srgb, var(--hl) 22%, transparent); }
			.sb-hl-text { font-size: 12.5px; line-height: 1.5; }
			.sb-hl-text.is-image { font-style: italic; color: var(--fill-secondary); }
			.sb-hl-comment { margin-top: 4px; font-size: 12px; color: var(--fill-secondary); }
			.sb-hl-comment::before { content: "💬 "; }
			.sb-hl-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 3px; font-size: 10.5px; color: var(--fill-tertiary); }
			.sb-hl-quote { font: inherit; border: none; background: none; color: var(--accent-blue); cursor: pointer; padding: 0; opacity: 0; }
			.sb-hl:hover .sb-hl-quote { opacity: 1; }
			.sb-znote { padding: 6px 10px; border-radius: 6px; background: color-mix(in srgb, var(--fill-quinary) 60%, transparent); font-size: 12.5px; }
			.sb-ref { display: flex; gap: 8px; align-items: baseline; padding: 3px 4px; border-radius: 5px; cursor: pointer; min-width: 0; }
			.sb-ref:hover { background: var(--fill-quinary); }
			.sb-ref-label { flex: none; font-size: 12px; color: var(--accent-blue); }
			.sb-ref-title { font-size: 12px; color: var(--fill-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.sb-ref.is-missing .sb-ref-label { color: var(--accent-red, #d33); }
			.sb-ref.is-missing { cursor: default; }

			/* the note tab: one centred column, like a document */
			tab-content:has(> .sb-note-scroll) { display: flex; }
			.sb-note-scroll { flex: 1; overflow-y: auto; height: 100%; background: var(--material-background); color: var(--fill-primary); }
			.sb-note-page { max-width: 760px; margin: 0 auto; padding: 32px 36px 80px; display: flex; flex-direction: column; gap: 16px; }
			.sb-ed.is-tab { gap: 12px; }
			.sb-ed.is-tab .sb-hl-text { font-size: 14px; }
			.sb-tb-input { width: 220px; margin-inline: 6px 2px; padding: 3px 8px; border-radius: 5px;
				border: 1px solid var(--fill-quinary); background: var(--material-background); color: inherit; font: inherit; }
			.sb-tb-input:focus { outline: 2px solid var(--color-accent); outline-offset: -1px; }
			#second-brain-tb-results { --panel-padding: 4px; }
			.sb-tb-list { width: 460px; max-height: 480px; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
			.sb-tb-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 4px 8px; border-bottom: 1px solid var(--fill-quinary); margin-bottom: 4px; }
			.sb-tb-cited:empty { display: none; }
			.sb-tb-cited { padding: 4px 6px 2px; border-top: 1px solid var(--fill-quinary); }
			.sb-cite-chip { display: inline; color: var(--color-accent); cursor: pointer; }
			.sb-cite-chip:hover { text-decoration: underline; }
		`;
		doc.documentElement.append(style);
	},
};
