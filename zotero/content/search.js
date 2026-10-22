/* The Second Brain search window: one search over notes, Zotero papers, PDFs and images. The box, pills, status line and
   result rows are the shared SearchPanel (ui-src, sb-ui.js); this file supplies Zotero's data and the two online modes. */
var SecondBrainSearch = {
	sb: null,
	mode: "library", // library | online | related
	HINT: "Papers open in Zotero; notes, PDFs and images open in Obsidian.",
	LIBRARY_PLACEHOLDER: "Search notes, papers, PDFs and images by words or meaning…",
	ONLINE_PLACEHOLDER: "Describe what you need, or search by title or author (all published papers, via OpenAlex)…",
	SOURCES: [["", "Any source"], ["zotero", "Zotero"], ["personal", "My notes"], ["Notion", "Notion"], ["pdf", "PDFs"], ["image", "Images"], ["ai_notes", "AI notes"]],

	init() {
		const args = window.arguments?.[0] ?? {};
		this.sb = args.SecondBrain;
		this.U = SecondBrainUI;
		this.discover = new this.sb.Discover(this.sb);
		const U = this.U;
		const app = document.getElementById("app");
		this.tabsHost = U.h(document, "div", "sb-win-modes");
		this.panel = new U.SearchPanel(document, {
			placeholder: this.LIBRARY_PLACEHOLDER, hint: this.HINT, limit: 30, options: this.SOURCES, selectFirst: true, enterOpens: true,
			adapter: {
				search: (query, scope, limit) => this.sb.searchAll(query, limit, scope.source, scope.exclude),
				open: (hit) => this.open(hit),
				snippet: (doc, snippet) => this.sb.renderSnippet(doc, snippet),
				unreachable: (error) => this.sb.unreachable(error),
				statusText: (hits) => `${hits.length} results · ↑↓ to move, Enter to open`,
				after: (hits, seq, panel) => {
					this.sb.papersInHits(hits).then((keys) => {
						if (!panel.isCurrent(seq) || !keys.length) return;
						panel.footer.replaceChildren(U.Button(document, keys.length === 1 ? "Show paper in library" : `Show ${keys.length} papers in library`, () => this.sb.showPapersInLibrary(keys)));
					});
				},
			},
		});
		app.append(this.tabsHost, this.panel.root);
		this.buildSources();
		window.addEventListener("keydown", (e) => { if (e.key === "Escape") window.close(); });
		this.drawTabs();
		if (args.related) this.showRelated(args.related);
		else if (args.mode) this.setMode(args.mode, false);
		else if (args.query) this.setQuery(args.query);
		this.panel.focus();
	},

	drawTabs() {
		const tabs = this.U.Tabs(document, [{ id: "library", label: "My library" }, { id: "online", label: "Find new papers" }], this.mode === "library" ? "library" : "online", (id) => this.setMode(id));
		this.tabsHost.replaceChildren(tabs);
	},

	setQuery(query) {
		if (this.mode === "related") this.setMode("library", false);
		this.panel.setQuery(query);
	},

	/** A checkbox per service (remembered), and Google Scholar as a link: it has no API to search from here. */
	buildSources() {
		const U = this.U;
		const box = U.h(document, "div", "sb-p-checks");
		this.checks = box;
		const chosen = new Set(this.discover.chosenSources());
		box.append(U.h(document, "span", "", "Search in:"));
		for (const source of this.sb.Discover.SOURCES) {
			const label = U.h(document, "label");
			const check = U.h(document, "input");
			check.type = "checkbox";
			check.checked = chosen.has(source.id);
			check.dataset.source = source.id;
			check.addEventListener("change", () => {
				const ids = [...box.querySelectorAll("input[data-source]")].filter((c) => c.checked).map((c) => c.dataset.source);
				if (!ids.length) { check.checked = true; return; }
				Zotero.Prefs.set("extensions.secondbrain.sources", JSON.stringify(ids), true);
				if (this.panel.input.value.trim()) this.panel.run();
			});
			label.append(check, source.label);
			box.append(label);
		}
		const scholar = U.Button(document, "Google Scholar ↗", () => Zotero.launchURL(`https://scholar.google.com/scholar?q=${encodeURIComponent(this.panel.input.value.trim())}`),
			{ title: "Google Scholar has no API; this opens the same search in your browser" });
		box.append(scholar);
	},

	setMode(mode, run = true) {
		this.mode = mode;
		const library = mode === "library";
		this.drawTabs();
		this.panel.extra.replaceChildren(...(mode === "online" ? [this.checks] : []));
		this.panel.bar.showPills(library);
		this.panel.input.placeholder = library ? this.LIBRARY_PLACEHOLDER : this.ONLINE_PLACEHOLDER;
		this.panel.handler = library ? null : (query, seq) => this.searchOnline(query, seq);
		this.panel.clear();
		this.panel.setStatus(this.HINT);
		if (run) this.panel.run();
		this.panel.focus();
	},

	/** Everything related to a paper in the library that isn't in it yet (or is): OpenAlex's related works,
	 *  papers citing it, and its references. */
	async showRelated(key) {
		const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
		if (!item) return;
		this.setMode("related", false);
		this.panel.input.value = "";
		const seq = ++this.panel.seq;
		this.panel.setStatus(`Finding papers related to “${item.getField("title")}”…`, "loading");
		try {
			const found = await this.discover.related(item);
			if (seq !== this.panel.seq) return;
			if (!found) {
				this.panel.setStatus("OpenAlex doesn't know this paper, so there's nothing related to show. Try searching by topic above.", "empty");
				return;
			}
			const total = found.groups.reduce((n, [, list]) => n + list.length, 0);
			this.panel.setStatus(`${total} papers related to “${found.work.title}” · Add saves one to your library (and the selected collection)`);
			this.renderPapers(found.groups);
		} catch (error) {
			if (seq === this.panel.seq) this.panel.setStatus(`Couldn't reach OpenAlex: ${error.message}`, "error");
		}
	},

	async searchOnline(query, seq) {
		if (!query) { this.panel.clear(); this.panel.setStatus(this.HINT); return; }
		this.panel.setStatus("Searching published papers…", "loading");
		try {
			const results = await this.discover.search(query);
			if (seq !== this.panel.seq) return;
			const missed = results.failed.length ? ` · ${results.failed.join(", ")} didn't answer` : "";
			this.panel.setStatus((results.length ? `${results.length} papers · Add saves one to your library (and the selected collection)` : "No papers found.") + missed, results.length ? "info" : "empty");
			this.renderPapers([["", results]]);
		} catch (error) {
			if (seq === this.panel.seq) this.panel.setStatus(`Couldn't search: ${error.message}`, "error");
		}
	},

	renderPapers(groups) {
		const nodes = [];
		for (const [label, papers] of groups) {
			const rows = papers.map((paper) => this.paperRow(paper));
			if (!label) { nodes.push(...rows); continue; }
			const section = this.U.Section(document, { title: label, count: papers.length });
			section.body.append(...rows);
			nodes.push(section.el);
		}
		this.panel.setRows(nodes);
	},

	paperRow(paper) {
		const U = this.U;
		const who = U.shortAuthors(paper.authors);
		const meta = [who, paper.year, paper.venue, paper.cites ? `cited ${paper.cites}×` : "", paper.pdf ? "free PDF" : "", paper.sources?.length ? `found in ${paper.sources.join(", ")}` : ""].filter(Boolean).join(" · ");
		const trailing = U.h(document, "span", "sb-p-trailing");
		const have = (key) => {
			const button = U.Button(document, "In your library", () => this.sb.open("zotero/" + key), { icon: "check", title: "Show it in the library" });
			button.classList.add("sb-p-ok");
			return button;
		};
		if (paper.key) trailing.append(have(paper.key));
		else {
			const add = U.Button(document, "Add", async () => {
				add.disabled = true;
				add.lastChild.textContent = "Adding…";
				try {
					const item = await this.discover.add(paper);
					paper.key = item.key;
					const done = have(item.key);
					done.lastChild.textContent = "Added";
					add.replaceWith(done);
				} catch (error) {
					Zotero.logError(error);
					add.disabled = false;
					add.lastChild.textContent = "Try again";
					add.title = `Couldn't add: ${error.message}`;
				}
			}, { icon: "plus", title: paper.doi ? `Add to Zotero (looked up by DOI ${paper.doi})` : "Add to Zotero" });
			trailing.append(add);
		}
		return U.Row(document, { icon: "paper", title: paper.title, meta, snippet: paper.abstract || undefined, trailing }).el;
	},

	open(hit) {
		this.sb.open(hit.path);
		if (hit.path.startsWith("zotero/")) Zotero.getMainWindow()?.focus();
	},
};

// Zotero 8+ no longer offers the Zotero object as an XPCOM service; take it from the window that opened this one.
var Zotero = window.opener?.Zotero ?? Services.wm.getMostRecentWindow("navigator:browser")?.Zotero;
window.addEventListener("load", () => SecondBrainSearch.init());
