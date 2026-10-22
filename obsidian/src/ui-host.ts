import { App, MarkdownView, Modal, Notice, Setting, SuggestModal } from "obsidian";
import type SecondBrainSearch from "./main";
import type { Hit } from "./api";
import type { AgentService } from "../../agent/src/service";
import type { UiHost, ContextItem, ContextCandidate, LibraryPaperRow, OutsidePaper, CollectionNode } from "../../ui/src/host";
import { debouncedChanges, selectionLabel, candidatesFromFiles } from "./context-sources";
import { openZotero } from "./zotero";
import { isListedPath, listedUrl } from "./listed-paths";

// src/ui-host.ts. The Obsidian UiHost (ui-src/src/host.d.ts) for the shared chat (spec 005 C3). One host per
// plugin instance (Obsidian has a single ChatView, docked in the right sidebar by default — no tab/dock split
// the way Zotero has a ChatTab and several ChatSidebar docks, so unlike createZoteroHost this isn't a factory).
// can.addToLibrary / can.openInTab are false: no write access to the Zotero library, and no second place to pop
// the chat into. can.scopes is true (spec 008 Z4): the server now knows the Zotero collection tree, so the
// "Where to look" picker's collection checkboxes work here too, over GET /zotero/collections; scopeNames still
// answers [] for "A tag"/"A saved search" (Obsidian has no local notion of either).

const FOLDER = "searches"; // kept the same on-disk name as the pre-005 find-papers.ts, and Zotero's ui-host

function folder(plugin: SecondBrainSearch): string {
	return `${plugin.manifest.dir}/${FOLDER}`;
}

/** A small confirm dialog (Services.prompt.confirm's equivalent). */
class ConfirmModal extends Modal {
	result = false;
	constructor(app: App, private message: string, private titleText?: string) { super(app); }
	onOpen() {
		this.titleEl.setText(this.titleText ?? "Second Brain AI");
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("OK").setCta().onClick(() => { this.result = true; this.close(); }));
	}
}

/** A small text-prompt dialog (Services.prompt.prompt's equivalent). */
class PromptModal extends Modal {
	value: string | null = null;
	private input!: HTMLInputElement;
	constructor(app: App, private message: string, private initial: string, private titleText?: string) { super(app); }
	onOpen() {
		this.titleEl.setText(this.titleText ?? "Second Brain AI");
		this.contentEl.createEl("p", { text: this.message });
		this.input = this.contentEl.createEl("input", { type: "text", value: this.initial });
		this.input.style.width = "100%";
		this.input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") { this.value = this.input.value; this.close(); }
		});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("OK").setCta().onClick(() => { this.value = this.input.value; this.close(); }));
		window.setTimeout(() => this.input.focus(), 0);
	}
}

/** "+ Add papers…": search-as-you-type over the Zotero library, one at a time (Obsidian's SuggestModal has no
 *  built-in multi-select the way Zotero's selectItemsDialog.xhtml does; picking again reopens it). */
class PaperPickModal extends SuggestModal<Hit> {
	chosen: ContextItem | null = null;
	constructor(app: App, private plugin: SecondBrainSearch) {
		super(app);
		this.setPlaceholder("Search your Zotero library…");
	}
	async getSuggestions(query: string): Promise<Hit[]> {
		if (!query.trim()) return [];
		if (!(await this.plugin.api.ensure())) return [];
		try {
			return await this.plugin.api.call<Hit[]>(`/search?${new URLSearchParams({ q: query, source: "zotero", limit: "20" })}`);
		} catch {
			return [];
		}
	}
	renderSuggestion(hit: Hit, el: HTMLElement) {
		el.createDiv({ text: hit.title });
		if (hit.zotero) el.createDiv({ cls: "suggestion-note", text: [hit.zotero.authors?.[0], hit.zotero.year].filter(Boolean).join(" · ") });
	}
	onChooseSuggestion(hit: Hit) {
		if (!hit.zotero) return;
		this.chosen = {
			attachment: { kind: "zoteroItem", citekey: hit.zotero.citekey || hit.path.replace(/^zotero\//, "") } as any,
			label: hit.title, why: "selected",
		};
	}
}

function libraryPaperRow(hit: Hit): LibraryPaperRow | null {
	if (!hit.zotero) return null;
	const key = hit.path.replace(/^zotero\//, "");
	return {
		ref: { kind: "paper", citekey: (hit.zotero.citekey || key) as any },
		title: hit.title, authors: hit.zotero.authors ?? [],
		year: hit.zotero.year ? Number(hit.zotero.year) || null : null,
		venue: hit.zotero.venue ?? "", doi: hit.zotero.doi || null,
		abstract: hit.passages.map((p) => p.snippet).join(" ").slice(0, 1500),
		key,
	};
}

export function createObsidianHost(plugin: SecondBrainSearch): UiHost {
	const labelCache = new Map<string, string>();
	// The editor the user last worked in: focusing the chat makes it the active leaf, but the note's selection is
	// still what the user means by "this" (spec 008 C2).
	let lastEditor: MarkdownView | null = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	function selectedText(): string {
		try {
			return lastEditor?.file ? lastEditor.editor.getSelection().trim() : "";
		} catch {
			return ""; // the editor's leaf was closed
		}
	}
	const keyCache = new Map<string, string>(); // citekey -> "zotero/KEY", resolved through /links (@citekey)

	async function resolveKeyPath(citekey: string): Promise<string | null> {
		const cached = keyCache.get(citekey);
		if (cached) return cached;
		// A paper without a citation key is cited by its Zotero item key (8 letters/digits), which the server
		// knows as "zotero/KEY" rather than "@key".
		const attempts = /^[A-Z0-9]{8}$/.test(citekey) ? [`@${citekey}`, `zotero/${citekey}`] : [`@${citekey}`];
		for (const path of attempts) {
			try {
				const info = await plugin.api.call<{ path: string }>(`/links?${new URLSearchParams({ path })}`);
				keyCache.set(citekey, info.path);
				return info.path;
			} catch {
				// try the next form
			}
		}
		return null;
	}

	async function fetchLabel(citekey: string): Promise<string | null> {
		const path = await resolveKeyPath(citekey);
		if (!path) return null;
		try {
			const item = await plugin.api.call<{ creators: { name: string; role: string }[]; year: string }>(
				`/zotero?${new URLSearchParams({ key: path.replace(/^zotero\//, "") })}`);
			const authors = item.creators.filter((c) => c.role === "author" || item.creators.every((x) => x.role !== "author"));
			const names = authors.length > 2 ? `${authors[0].name.split(" ").pop()} et al.`
				: authors.map((a) => a.name.split(" ").pop()).join(" & ");
			return [names, item.year].filter(Boolean).join(" ") || citekey;
		} catch {
			return null;
		}
	}

	const host: UiHost = {
		kind: "obsidian",
		placement: "sidebar",
		can: { scopes: true, addToLibrary: false, openInTab: false, notesWithoutServer: false, linksInside: true },

		// ---------- engine and connection
		async ai(): Promise<AgentService> { return plugin.agent; },
		// Obsidian always talks to the Second Brain server (agent-api.ts's createRemoteRuntime); there is no
		// standalone "local" mode the way Zotero has one, so this stays "server" — a genuinely unreachable server
		// surfaces as a normal error where it's used (refreshList, submit), the same as before this move.
		where() { return "server"; },
		onWhereChange() { return () => {}; },
		json(path, method = "GET", body) { return plugin.api.call(path, method, body); },

		// ---------- remembered state
		prefs: {
			get(key) {
				if (key === "historyCollapsed") return plugin.settings.chatHistoryCollapsed as any;
				if (key === "chatMode") return plugin.settings.chatMode as any;
				if (key === "chatSources") return plugin.settings.chatSources as any;
				if (key === "chatProject") return plugin.settings.chatProject as any;
				return plugin.settings.ui?.[key] as any;
			},
			set(key, value) {
				if (key === "historyCollapsed") plugin.settings.chatHistoryCollapsed = value as boolean;
				else if (key === "chatMode") plugin.settings.chatMode = value as any;
				else if (key === "chatSources") plugin.settings.chatSources = value as any;
				else if (key === "chatProject") plugin.settings.chatProject = value as any;
				else plugin.settings.ui = { ...plugin.settings.ui, [key]: value };
				void plugin.saveSettings();
			},
		},
		files: {
			async list(dir) {
				const path = `${plugin.manifest.dir}/${dir}`;
				if (!(await plugin.app.vault.adapter.exists(path))) return [];
				const { files } = await plugin.app.vault.adapter.list(path);
				return files.map((f) => `${dir}/${f.split("/").pop()}`);
			},
			async read(path) {
				const full = `${plugin.manifest.dir}/${path}`;
				return (await plugin.app.vault.adapter.exists(full)) ? plugin.app.vault.adapter.read(full) : null;
			},
			async write(path, text) {
				const full = `${plugin.manifest.dir}/${path}`;
				await plugin.app.vault.adapter.mkdir(full.slice(0, full.lastIndexOf("/"))).catch(() => {});
				await plugin.app.vault.adapter.write(full, text);
			},
			async remove(path) {
				const full = `${plugin.manifest.dir}/${path}`;
				if (await plugin.app.vault.adapter.exists(full)) await plugin.app.vault.adapter.remove(full);
			},
		},

		// ---------- what the user is looking at
		// The open note as the "Current" chip, and text selected in it as its own chip.
		async context(): Promise<ContextItem[]> {
			const items: ContextItem[] = [];
			const file = plugin.app.workspace.getActiveFile();
			if (file) {
				const zoteroKey = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.["zotero-key"];
				items.push(zoteroKey
					? { attachment: { kind: "zoteroItem", citekey: String(zoteroKey) } as any, label: file.basename, why: "active-note" }
					: { attachment: { kind: "note", path: file.path } as any, label: file.basename, why: "active-note" });
			}
			const selection = selectedText();
			if (selection) items.push({ attachment: { kind: "quote", text: selection }, label: selectionLabel(selection), why: "selection" });
			return items;
		},
		onContextChange(listener) {
			const { workspace } = plugin.app;
			return debouncedChanges([
				(changed) => {
					const ref = workspace.on("active-leaf-change", (leaf) => {
						if (leaf?.view instanceof MarkdownView) lastEditor = leaf.view;
						changed();
					});
					plugin.registerEvent(ref);
					return () => workspace.offref(ref);
				},
				(changed) => {
					document.addEventListener("selectionchange", changed);
					return () => document.removeEventListener("selectionchange", changed);
				},
			], listener);
		},
		async contextCandidates(): Promise<ContextCandidate[]> {
			const { metadataCache } = plugin.app;
			return candidatesFromFiles(plugin.app.vault.getMarkdownFiles().map((file) => {
				const key = metadataCache.getFileCache(file)?.frontmatter?.["zotero-key"];
				return { path: file.path, basename: file.basename, folder: file.parent?.path ?? "", zoteroKey: key ? String(key) : null };
			}));
		},
		async pickPapers(): Promise<ContextItem[]> {
			return new Promise((resolve) => {
				const modal = new PaperPickModal(plugin.app, plugin);
				const originalClose = modal.onClose.bind(modal);
				modal.onClose = () => { originalClose(); resolve(modal.chosen ? [modal.chosen] : []); };
				modal.open();
			});
		},
		// Obsidian has no local notion of a Zotero tag or saved search to list (unlike collections, below, neither
		// is indexed by the server); chat.js's "A tag"/"A saved search" options end up with nothing to pick.
		async scopeNames() { return []; },
		async collections(): Promise<CollectionNode[]> {
			if (!(await plugin.api.ensure())) return [];
			try {
				return await plugin.api.call<CollectionNode[]>("/zotero/collections");
			} catch {
				return [];
			}
		},

		// ---------- going places
		openRef(ref, opts) {
			if (ref.kind === "paper") {
				void (async () => {
					const path = await resolveKeyPath(ref.citekey);
					if (!path) { new Notice(`Couldn't find @${ref.citekey} in your library.`); return; }
					await openZotero(plugin, { path, title: labelCache.get(ref.citekey) ?? ref.citekey }, opts.newTab);
				})();
			} else if (ref.kind === "note" && isListedPath(ref.path)) {
				plugin.webLinks.open(listedUrl(plugin.api.serverBase(), ref.path));  // a listed folder (server spec 018)
			} else if (ref.kind === "note") {
				void plugin.app.workspace.openLinkText(ref.path, "", opts.newTab);
			}
		},
		openLink(url, opts) { plugin.webLinks.open(url, opts); },
		revealFile(path) {
			// A vault note (a review's saved report): open it. An absolute filesystem path (a docx/pdf/md export,
			// written by the sidecar on the Mac, possibly unreachable from a phone): there is nothing Obsidian can
			// "reveal" remotely, so just say where it went — the same as the pre-005 chat.ts's export handler.
			if (plugin.app.vault.getAbstractFileByPath(path)) { void plugin.app.workspace.openLinkText(path, "", false); return; }
			new Notice(`Saved to ${path}`);
		},

		// ---------- outside papers
		async searchOutside(query, perSource) {
			// The agent searches every outside source (and holds the OpenAlex key); Obsidian only asks.
			try {
				return await plugin.agent.scholarly.search(query, perSource);
			} catch (error) {
				return { papers: [], failed: [`outside sources (${error instanceof Error ? error.message : "agent unavailable"})`] };
			}
		},
		// addToLibrary is omitted: can.addToLibrary is false, so find-view.js/report-view.js never show the
		// button that would call it.

		// ---------- find papers' direct library search
		async searchLibrary(query, _scope, limit) {
			if (!(await plugin.api.ensure())) return [];
			try {
				const hits = await plugin.api.call<Hit[]>(`/search?${new URLSearchParams({ q: query, source: "zotero", limit: String(limit) })}`);
				return hits.map(libraryPaperRow).filter((r): r is LibraryPaperRow => !!r);
			} catch {
				return [];
			}
		},
		// Obsidian has no index of its own by Zotero item key (searchLibrary above is the only lookup it has).
		async libraryPaperByKey() { return null; },

		// ---------- small chrome
		notice(text) { new Notice(text); },
		logError(error) { console.error(error); },
		// styles.css already carries sb-ui.css + tokens-obsidian.css (esbuild.config.mjs); nothing to inject.
		mount() {},

		// ---------- C1/C3 additions
		async confirm(message, opts) {
			return new Promise((resolve) => {
				const modal = new ConfirmModal(plugin.app, message, opts?.title);
				const originalClose = modal.onClose.bind(modal);
				modal.onClose = () => { originalClose(); resolve(modal.result); };
				modal.open();
			});
		},
		async promptText(message, initial, opts) {
			return new Promise((resolve) => {
				const modal = new PromptModal(plugin.app, message, initial, opts?.title);
				const originalClose = modal.onClose.bind(modal);
				modal.onClose = () => { originalClose(); resolve(modal.value); };
				modal.open();
			});
		},
		citeLabel(citekey) {
			const label = labelCache.get(citekey);
			return label ? { label } : null;
		},
		async resolveLabel(citekey) {
			if (labelCache.has(citekey)) return labelCache.get(citekey)!;
			const label = await fetchLabel(citekey);
			const resolved = label ?? citekey;
			labelCache.set(citekey, resolved);
			return resolved;
		},
		async exportRows(text, format, suggestedName) {
			try {
				const dir = folder(plugin);
				await plugin.app.vault.adapter.mkdir(dir).catch(() => {});
				await plugin.app.vault.adapter.write(`${dir}/${suggestedName}`, text);
				new Notice(`Saved ${suggestedName} to the plugin folder (${dir}).`);
				return true;
			} catch (error) {
				new Notice(`Couldn't export: ${(error as Error).message}`);
				return false;
			}
		},
		async writeFile(path, text) {
			await plugin.app.vault.adapter.write(path, text);
		},
		async saveFile(name, text) {
			try {
				const adapter = plugin.app.vault.adapter;
				const dir = "Second Brain/Exports";
				await adapter.mkdir("Second Brain").catch(() => {});
				await adapter.mkdir(dir).catch(() => {});
				// Never overwrite an earlier export: "table.csv" -> "table 2.csv".
				const dot = name.lastIndexOf(".");
				const stem = dot > 0 ? name.slice(0, dot) : name;
				const ext = dot > 0 ? name.slice(dot) : "";
				let path = `${dir}/${name}`;
				for (let n = 2; await adapter.exists(path); n++) path = `${dir}/${stem} ${n}${ext}`;
				await adapter.write(path, text);
				new Notice(`Saved to ${path}`);
				if (ext === ".md") void plugin.app.workspace.openLinkText(path, "", false);
				return { path };
			} catch (error) {
				new Notice(`Couldn't save: ${(error as Error).message}`);
			}
		},
	};
	return host;
}
