/* global Zotero, Services, IOUtils, PathUtils, ChromeUtils, SecondBrain, SecondBrainUI */
// content/ui-host-zotero.js. The Zotero UiHost (ui-src/src/host.d.ts) for the shared chat (spec 005 C1).
// createZoteroHost(sb, win, opts) makes ONE UiHost per ChatView placement: ChatTab makes a "tab" host, each
// ChatSidebar dock makes a "sidebar" host with its own paperContext/openInTab. Both talk to the same `sb`
// (content/second-brain.js) underneath, which is why prefs shared across placements (chatMode, chatSources)
// read/write the same key regardless of which host asks, while placement-specific ones (historyCollapsed) don't.

/** Adds Zotero's --sb-ui-* token map and the shared component sheet to a chrome document, once. Every shared view
 *  styles itself with those tokens only, so without this every colour, border and background is unset. */
SecondBrain.addUiStyles = function addUiStyles(doc, rootURI) {
	for (const [id, file] of [["sb-ui-zotero-tokens", "sb-ui-zotero-tokens.css"], ["sb-ui-components", "sb-ui.css"]]) {
		if (doc.getElementById(id)) continue;
		const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
		link.id = id;
		link.rel = "stylesheet";
		link.href = rootURI + "content/" + file;
		doc.documentElement.append(link);
	}
};

/** The shared component set, for windows that don't see the bootstrap scope (the settings pane builds a StatusPanel with it). */
SecondBrain.UI = SecondBrainUI;

SecondBrain.createZoteroHost = function createZoteroHost(sb, win, opts = {}) {
	const PREFIX = "extensions.secondbrain.";
	const historyPref = opts.historyPref; // "chatHistoryCollapsed" | "sidebarHistoryCollapsed"
	const historyDefault = opts.historyDefault ?? false;

	function dataDir() {
		return PathUtils.join(Zotero.DataDirectory.dir, "second-brain");
	}

	/** PathUtils.join rejects a segment that itself contains "/" (NS_ERROR_FILE_UNRECOGNIZED_PATH); host.files'
	 *  paths are "dir/name.json" (UiHost, spec 005), so every segment is split before joining. */
	function filePath(relPath) {
		return PathUtils.join(dataDir(), ...relPath.split("/"));
	}

	/** A Zotero item, discover.js-shaped, into the host's richer LibraryPaperRow (host.d.ts). */
	async function libraryPaperRow(item) {
		const discover = new SecondBrain.Discover(sb);
		const year = parseInt(item.getField("year"), 10);
		return {
			ref: { kind: "paper", citekey: item.getField("citationKey") || item.key },
			title: item.getField("title"),
			authors: item.getCreators().map((c) => c.lastName || c.name || "").filter(Boolean),
			year: Number.isFinite(year) ? year : null,
			venue: item.getField("publicationTitle") || item.getField("proceedingsTitle") || "",
			doi: discover.doiOf(item),
			abstract: (item.getField("abstractNote") || "").slice(0, 1500),
			key: item.key,
			// spec 007 E4 extras (LibraryPaperRow in host.d.ts doesn't list them yet)
			fullText: await hasFullText(item), studyType: libraryStudyType(item), pdfUrl: null, citations: null,
		};
	}

	/** True when a PDF/HTML/text attachment file is actually on disk (what read_source can open). */
	async function hasFullText(item) {
		try {
			for (const att of Zotero.Items.get(item.getAttachments())) {
				if (!att?.isFileAttachment?.() || !/^(application\/pdf|text\/)/.test(att.attachmentContentType ?? "")) continue;
				if (await att.fileExists()) return true;
			}
		} catch (error) { /* unreadable attachments: treat as no full text */ }
		return false;
	}

	/** Only what the user's own metadata says: tags and "Publication Type:" / "Study Type:" lines in Extra;
	 *  conflicting labels give null. Zotero's item types don't distinguish study designs, so they're not used. */
	function libraryStudyType(item) {
		const labels = item.getTags().map((t) => t.tag);
		for (const line of (item.getField("extra") || "").split("\n")) {
			const m = /^(?:publication|study)\s*type\s*:\s*(.+)$/i.exec(line.trim());
			if (m) labels.push(...m[1].split(/[;,]/));
		}
		return SecondBrain.Discover.studyTypeOfLabels(labels, { strict: true });
	}

	async function fileList(dir) {
		const folder = PathUtils.join(dataDir(), ...dir.split("/"));
		if (!(await IOUtils.exists(folder))) return [];
		return (await IOUtils.getChildren(folder)).map((path) => `${dir}/${PathUtils.filename(path)}`);
	}

	const host = {
		kind: "zotero",
		placement: opts.placement,
		// Not part of UiHost (host.d.ts): the pre-005 Zotero harness tests (t-chat-scope.js) monkeypatch
		// `view.sb.ai` directly to inject a fake AgentService, bypassing the host entirely. `host.ai()` reads
		// `sb.ai()` fresh on every call from this same `sb` reference, so patching it here still works; ChatView's
		// constructor exposes it back as `view.sb` for exactly this reason and nothing else.
		_sb: sb,
		can: {
			scopes: true,
			addToLibrary: true,
			openInTab: !!opts.openInTab,
			notesWithoutServer: false,
			linksInside: false, // spec 015: links stay in the system browser in Zotero
		},

		// ---------- engine and connection
		async ai() { return sb.ai(); },
		where() {
			if (sb.agent.current) return sb.agent.current.where === "server" ? "server" : "local";
			return sb.checkedOnce && !sb.online ? "local" : "server";
		},
		onWhereChange(listener) { return sb.agent.onSwitch(listener); },
		json(path, method = "GET", body) {
			if (method === "GET") return sb.api(path);
			if (method === "POST") return sb.post(path, body ?? {});
			return Promise.reject(new Error(`${method} ${path}: not supported in Zotero`));
		},

		// ---------- remembered state
		prefs: {
			get(key) {
				if (key === "historyCollapsed") return Zotero.Prefs.get(`${PREFIX}${historyPref}`, true) ?? historyDefault;
				const raw = Zotero.Prefs.get(`${PREFIX}${key}`, true);
				if (raw === undefined || raw === "" || raw === null) return undefined;
				if (key === "chatSources") {
					try { return JSON.parse(raw); } catch (error) { return undefined; }
				}
				return raw;
			},
			set(key, value) {
				const prefKey = key === "historyCollapsed" ? historyPref : key;
				// Zotero.Prefs.set throws on null/undefined; clearing is how a pref goes back to unset
				if (value === undefined || value === null) { Zotero.Prefs.clear(`${PREFIX}${prefKey}`, true); return; }
				Zotero.Prefs.set(`${PREFIX}${prefKey}`, typeof value === "object" && value !== null ? JSON.stringify(value) : value, true);
			},
		},
		files: {
			list: (dir) => fileList(dir),
			async read(path) {
				const full = filePath(path);
				return (await IOUtils.exists(full)) ? IOUtils.readUTF8(full) : null;
			},
			async write(path, text) {
				const full = filePath(path);
				await IOUtils.makeDirectory(PathUtils.parent(full), { createAncestors: true });
				await IOUtils.writeUTF8(full, text);
			},
			async remove(path) {
				await IOUtils.remove(filePath(path), { ignoreAbsent: true });
			},
		},

		// ---------- what the user is looking at
		async context() {
			const items = (opts.paperContext?.() ?? []).filter((item) => item?.isRegularItem?.()).slice(0, 5);
			const reading = opts.reading?.() ?? false;
			return items.map((item) => ({
				attachment: { kind: "zoteroItem", citekey: item.getField("citationKey") || item.key },
				label: sb.shortLabel(item) || item.getField("title"),
				why: reading ? "reading" : "selected",
			}));
		},
		onContextChange(listener) {
			if (!opts.autoContext) return () => {};
			// Selecting another paper or switching PDFs doesn't tell us; a cheap poll while the chat is open keeps
			// the context current (the same interval chat-sidebar.js already used before this move).
			const id = win.setInterval(() => { if (opts.isOpen?.() ?? true) listener(); }, 700);
			return () => win.clearInterval(id);
		},
		/** Spec 008 C3 / follow-up: every paper and collection in the user library, in the shape the Obsidian host
	 *  returns; the picker's fuzzy ranking (fuzzy.js) does the matching on what the user types. */
		async contextCandidates() {
			const libraryID = Zotero.Libraries.userLibraryID;
			const candidates = [];
			for (const item of await Zotero.Items.getAll(libraryID, true)) {
				if (!item.isRegularItem() || item.deleted) continue;
				const title = item.getField("title");
				if (!title) continue;
				const short = sb.shortLabel(item);
				candidates.push({
					category: "paper", label: title, detail: short && short !== title ? short : undefined,
					attachment: { kind: "zoteroItem", citekey: item.getField("citationKey") || item.key },
				});
			}
			for (const collection of Zotero.Collections.getByLibrary(libraryID, true)) {
				candidates.push({ category: "collection", label: collection.name, attachment: { kind: "collection", name: collection.name } });
			}
			return candidates;
		},
		async pickPapers() {
			const io = { dataIn: null, dataOut: null, singleSelection: false };
			win.openDialog("chrome://zotero/content/selectItemsDialog.xhtml", "", "chrome,dialog=no,modal,centerscreen,resizable=yes", io);
			if (!io.dataOut || !io.dataOut.length) return [];
			return Zotero.Items.get(io.dataOut).filter((item) => item?.isRegularItem?.())
				.map((item) => ({ attachment: { kind: "zoteroItem", citekey: item.getField("citationKey") || item.key }, label: sb.shortLabel(item) || item.getField("title"), why: "selected" }));
		},
		// Typed as returning a Promise (host.d.ts), but deliberately NOT an async function: this is plain
		// synchronous Zotero API data (no I/O), and chat.js's fillScopeNames() relies on getting it back in the
		// same script turn — see the comment there.
		scopeNames(kind) {
			const libraryID = Zotero.Libraries.userLibraryID;
			if (kind === "savedSearch") return Zotero.Searches.getByLibrary(libraryID).map((s) => s.name);
			if (kind === "tag") return (Zotero.Tags.getAll(libraryID) ?? []).map((t) => t.tag ?? t.name ?? t).filter(Boolean);
			return [];
		},
		// Spec 008 Z4: the collection tree for the "Where to look" picker's checkboxes. Also plain synchronous
		// Zotero API data (no I/O), same reasoning as scopeNames above; count is the collection's own items, not
		// its descendants' (the tree component sums those itself when it needs a rolled-up count).
		collections() {
			const libraryID = Zotero.Libraries.userLibraryID;
			return Zotero.Collections.getByLibrary(libraryID, true).map((c) => ({
				key: c.key, name: c.name, parent: c.parentKey || null, count: c.getChildItems().length,
			}));
		},

		// ---------- going places
		openRef(ref, opts_) {
			if (ref.kind === "paper") sb.openPaper(ref.citekey, opts_?.newTab);
			else if (ref.kind === "note") sb.open(/\.\w+$/.test(ref.path) ? ref.path : `${ref.path}.md`);
		},
		openLink(url) { sb.openURL(url); },
		revealFile(path) { Zotero.File.reveal(path); },
		...(opts.openInTab ? { openInTab: () => opts.openInTab() } : {}),

		// ---------- outside papers
		async searchOutside(query, perSource) {
			const discover = new SecondBrain.Discover(sb);
			const results = await discover.search(query, discover.chosenSources(), perSource);
			return {
				papers: results.map((r) => ({
					title: r.title, authors: r.authors ?? [], year: r.year ?? null, venue: r.venue ?? "",
					doi: r.doi ?? null, abstract: r.abstract ?? "", url: r.pdf ?? (r.doi ? `https://doi.org/${r.doi}` : null),
					source: (r.sources ?? [])[0] ?? "unknown", arxiv: r.arxiv ?? null, pmid: r.pmid ?? null, pdf: r.pdf ?? null,
					type: r.type ?? "article", key: r.key ?? null,
					// spec 007 E4: not in host.d.ts's OutsidePaper yet, so extra properties (undefined-safe for old readers)
					studyType: r.studyType ?? null, fullText: !!r.fullText, pdfUrl: r.pdfUrl ?? r.pdf ?? null, citations: r.citations ?? null,
					sources: r.sources ?? [],
				})),
				failed: results.failed ?? [],
			};
		},
		async addToLibrary(papers) {
			const discover = new SecondBrain.Discover(sb);
			const items = [];
			for (const paper of papers) {
				try {
					const item = await discover.add(paper);
					items.push({ key: item.key, citekey: item.getField("citationKey") || item.key });
				} catch (error) {
					Zotero.logError(error);
					items.push(null);
				}
			}
			return { items };
		},

		// ---------- find papers' direct library search
		async searchLibrary(query, scope, limit) {
			const hits = await sb.agent.library().search({ text: query, scope, limit });
			const rows = [];
			for (const hit of hits) {
				if (hit.ref.kind !== "paper") continue;
				const item = await sb.itemByCitekey(hit.ref.citekey);
				if (item) rows.push(await libraryPaperRow(item));
			}
			return rows;
		},
		async libraryPaperByKey(key) {
			const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
			return item ? await libraryPaperRow(item) : null;
		},

		// ---------- small chrome
		notice(text) {
			const progress = new Zotero.ProgressWindow({ closeOnClick: true });
			progress.changeHeadline("Second Brain AI");
			new progress.ItemProgress(sb.rootURI + "content/icon.svg", text);
			progress.show();
			progress.startCloseTimer(4000);
		},
		logError(error) { Zotero.logError(error); },
		// Not called by the moved chat/find/report views: they already inject their own <style> per document
		// (ChatView.style() etc., moved unchanged from 0.22) and the shell (ChatTab/ChatSidebar) still does the
		// DOM attach itself, same as before this move. Kept on the host for a future caller (a stage-2 panel).
		mount() {},

		// ---------- C1 additions
		async confirm(message, dialogOpts = {}) {
			return Services.prompt.confirm(win, dialogOpts.title ?? "Second Brain AI", message);
		},
		async promptText(message, initial, dialogOpts = {}) {
			const value = { value: initial };
			const ok = Services.prompt.prompt(win, dialogOpts.title ?? "Second Brain AI", message, value, null, {});
			return ok ? value.value : null;
		},
		citeLabel(citekey) { return sb.citeLabel(citekey); },
		async resolveLabel(citekey) {
			const item = await sb.itemByCitekey(citekey);
			return item ? (sb.shortLabel(item) || citekey) : citekey;
		},
		async exportRows(text, format, suggestedName) {
			try {
				const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
				const picker = new FilePicker();
				picker.init(win, format === "csv" ? "Export papers as CSV" : "Export papers as RIS", picker.modeSave);
				picker.defaultString = suggestedName;
				picker.appendFilter(format.toUpperCase(), `*.${format}`);
				if (![picker.returnOK, picker.returnReplace].includes(await picker.show())) return false;
				await IOUtils.writeUTF8(picker.file, text);
				Zotero.File.reveal(picker.file);
				return true;
			} catch (error) {
				Zotero.logError(error);
				Services.prompt.alert(win, "Couldn't export", error?.message ?? String(error));
				return false;
			}
		},
		async writeFile(path, text) {
			await IOUtils.writeUTF8(path, text);
		},
		async saveFile(name, text, _mime) {
			try {
				const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
				const picker = new FilePicker();
				const ext = name.includes(".") ? name.split(".").pop() : "";
				picker.init(win, "Save", picker.modeSave);
				picker.defaultString = name;
				if (ext) picker.appendFilter(ext.toUpperCase(), `*.${ext}`);
				if (![picker.returnOK, picker.returnReplace].includes(await picker.show())) return;
				await IOUtils.writeUTF8(picker.file, text);
				Zotero.File.reveal(picker.file);
				return { path: picker.file };
			} catch (error) {
				Zotero.logError(error);
				Services.prompt.alert(win, "Couldn't save", error?.message ?? String(error));
			}
		},
	};
	return host;
};
