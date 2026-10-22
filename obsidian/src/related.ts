import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import type SecondBrainSearch from "./main";
import type { SectionMatch } from "./api";
import { RelatedPanel } from "../../zotero-plugin/ui-src/src/index.js";
import { panelFetch } from "./panel-rows";

export const RELATED_VIEW = "second-brain-related";

/** Right sidebar: what relates to the open note, and to the section the cursor is in. */
export class RelatedView extends ItemView {
	private panel!: ReturnType<typeof RelatedPanel>;
	private sectionKey = "";
	private sectionSeq = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: SecondBrainSearch) { super(leaf); }

	getViewType() { return RELATED_VIEW; }
	getDisplayText() { return "Related notes"; }
	getIcon() { return "network"; }

	async onOpen() {
		const plugin = this.plugin;
		this.contentEl.addClass("sb-p");
		this.panel = RelatedPanel(this.contentEl.ownerDocument, {
			fetchJSON: panelFetch(plugin.api),
			open: (ref, heading, event) => plugin.links.open(ref, heading, !!(event?.metaKey || event?.ctrlKey)),
			decorate: (el, ref, heading) => plugin.links.decorate(el, ref, RELATED_VIEW, this, heading),
			copyLinks: (rows) => { void plugin.links.copy(rows); },
			localLinks: (path) => this.localLinks(path),
		});
		this.contentEl.append(this.panel.el);
		this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));
		// The cursor has no event of its own; checking twice a second is cheap and only queries on a new section.
		this.registerInterval(window.setInterval(() => this.trackSection(), 500));
		this.refresh();
	}

	private activeFile(): TFile | null {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
	}

	async refresh(force = false) {
		const file = this.activeFile();
		if (!file) return; // keep the last note while the sidebar itself has focus
		if (file.path !== this.panel.current || force) this.sectionKey = "";
		await this.panel.show(file.path, { title: file.basename, force });
	}

	/** Obsidian's own link graph, so the phone still shows links without the Mac. */
	private localLinks(path: string) {
		const resolved = this.app.metadataCache.resolvedLinks;
		return {
			links: Object.keys(resolved[path] ?? {}),
			backlinks: Object.keys(resolved).filter((source) => resolved[source]?.[path]),
		};
	}

	/** The heading section around the cursor, or the paragraph when the note has no headings. */
	private currentSection(): { key: string; heading: string; text: string } | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file || view.getMode() !== "source") return null;
		const editor = view.editor;
		const line = editor.getCursor().line;
		const headings = this.app.metadataCache.getFileCache(view.file)?.headings ?? [];
		let start = 0, end = editor.lineCount(), heading = "";
		for (const h of headings) {
			const at = h.position.start.line;
			if (at <= line) { start = at; heading = h.heading; } else { end = at; break; }
		}
		if (!headings.length || end - start > 80) { // no headings, or a very long section: the paragraph instead
			start = line; end = line + 1;
			while (start > 0 && editor.getLine(start - 1).trim()) start--;
			while (end < editor.lineCount() && editor.getLine(end).trim()) end++;
		}
		const text = editor.getRange({ line: start, ch: 0 }, { line: end, ch: 0 });
		return { key: `${view.file.path}:${start}:${text.length >> 6}`, heading, text };
	}

	private async trackSection() {
		if (!this.panel.current || !this.containerEl.isShown()) return;
		const section = this.currentSection();
		if (!section || section.text.trim().length < 60) {
			if (this.sectionKey) { this.panel.setSection(null); this.sectionKey = ""; }
			return;
		}
		if (section.key === this.sectionKey) return;
		this.sectionKey = section.key;
		const seq = ++this.sectionSeq;
		await sleep(700); // settle: typing or moving on quickly shouldn't query every stop
		if (seq !== this.sectionSeq) return;
		let matches: SectionMatch[];
		try {
			matches = await this.plugin.api.call<SectionMatch[]>("/similar", "POST",
				{ text: section.text, path: this.panel.current, limit: 6 });
		} catch {
			return; // the section list is a bonus; the note-level lists already report problems
		}
		if (seq !== this.sectionSeq) return;
		this.panel.setSection({ label: section.heading ? `This section: ${section.heading}` : "This paragraph", matches });
	}
}
