import { App, Editor, EventRef, MarkdownView, Menu, Notice, Platform, TFile } from "obsidian";
import type { NoteRef } from "./api";
import { isListedPath } from "./listed-paths";

// Everything a result row can do: open, preview, drag into a note, insert or copy as a link or citation.

export const ZOTERO_PREFIX = "zotero/";

export function isZotero(ref: NoteRef): boolean {
	return ref.path.startsWith(ZOTERO_PREFIX);
}

/** Opens only schemes we trust; server-supplied URIs otherwise reach window.open() unchecked. */
export function openExternal(url: string | undefined | null) {
	if (url && /^(zotero|https?):/i.test(url)) window.open(url);
}

export class Links {
	/** The last Markdown editor the user worked in; sidebars take focus, so "insert" goes here. */
	private lastView: MarkdownView | null = null;

	constructor(private app: App, private openZotero: (ref: NoteRef, newTab: boolean) => void, register: (ref: EventRef) => void,
		private openListed: (path: string) => void = () => {}) {
		register(app.workspace.on("active-leaf-change", (leaf) => {
			if (leaf?.view instanceof MarkdownView) this.lastView = leaf.view;
		}));
	}

	editor(): { editor: Editor; file: TFile } | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView) ?? this.attachedLastView();
		return view?.file && view.editor ? { editor: view.editor, file: view.file } : null;
	}

	/** lastView keeps its object after its tab closes; only trust it while its leaf is still open. */
	private attachedLastView(): MarkdownView | null {
		if (!this.lastView) return null;
		const open = this.app.workspace.getLeavesOfType("markdown").some((leaf) => leaf.view === this.lastView);
		if (!open) this.lastView = null;
		return this.lastView;
	}

	/** [[wiki link]] for a note (honours the vault's link settings), [@citekey] for a Zotero item. */
	linkText(ref: NoteRef, sourcePath: string): string {
		if (isZotero(ref)) return ref.zotero?.citekey ? `[@${ref.zotero.citekey}]` : ref.title;
		const file = this.app.vault.getAbstractFileByPath(ref.path);
		return file instanceof TFile ? this.app.fileManager.generateMarkdownLink(file, sourcePath) : `[[${ref.title}]]`;
	}

	open(ref: NoteRef, heading: string | null, newTab: boolean) {
		if (isZotero(ref)) return this.openZotero(ref, newTab);
		if (isListedPath(ref.path)) return this.openListed(ref.path);  // a listed folder (server spec 018), not in the vault
		const last = heading?.split(" > ").pop() ?? "";
		const page = /\.pdf$/i.test(ref.path) ? /^Page (\d+)$/.exec(last) : null;
		// PDFs open at the matching page; images have no sections; notes open at the heading.
		const section = page ? `#page=${page[1]}` : last && ref.path.endsWith(".md") ? `#${last}` : "";
		this.app.workspace.openLinkText(`${ref.path}${section}`, "", newTab);
	}

	insert(ref: NoteRef) {
		const target = this.editor();
		if (!target) return new Notice("Open a note to insert the link into.");
		target.editor.replaceSelection(this.linkText(ref, target.file.path));
	}

	async copy(refs: NoteRef[]) {
		const source = this.editor()?.file.path ?? "";
		const text = refs.map((r) => `- ${this.linkText(r, source)}`).join("\n");
		await navigator.clipboard.writeText(text);
		new Notice(refs.length === 1 ? "Link copied" : `${refs.length} links copied`);
	}

	/** Click opens, Cmd/Ctrl-click opens in a new tab; the rest is `decorate`. */
	wire(el: HTMLElement, ref: NoteRef, hoverSource: string, hoverParent: any, heading: string | null = null) {
		el.addEventListener("click", (e) => this.open(ref, heading, e.metaKey || e.ctrlKey));
		this.decorate(el, ref, hoverSource, hoverParent, heading);
	}

	/** For rows that already open on click (shared panel Rows): drag drops a link, right-click / long-press shows actions, hover previews. */
	decorate(el: HTMLElement, ref: NoteRef, hoverSource: string, hoverParent: any, heading: string | null = null) {
		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.menu(ref, heading).showAtMouseEvent(e);
		});
		if (!isZotero(ref)) {
			el.addEventListener("mouseover", (event) => {
				this.app.workspace.trigger("hover-link", {
					event, source: hoverSource, hoverParent, targetEl: el, linktext: ref.path, sourcePath: "",
				});
			});
		}
		if (Platform.isDesktop) {
			el.draggable = true;
			el.addEventListener("dragstart", (e) => {
				const file = this.app.vault.getAbstractFileByPath(ref.path);
				const drag = (this.app as any).dragManager;
				if (file instanceof TFile && drag?.dragFile) {
					drag.onDragStart(e, drag.dragFile(e, file)); // Obsidian's own drag: drops as a link
				} else {
					e.dataTransfer?.setData("text/plain", this.linkText(ref, this.editor()?.file.path ?? ""));
				}
			});
		}
	}

	menu(ref: NoteRef, heading: string | null): Menu {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Open").setIcon("file-text").onClick(() => this.open(ref, heading, false)));
		if (!isZotero(ref)) {
			menu.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => this.open(ref, heading, true)));
		}
		menu.addItem((i) => i.setTitle(isZotero(ref) ? "Insert citation" : "Insert link")
			.setIcon("link").onClick(() => this.insert(ref)));
		menu.addItem((i) => i.setTitle(isZotero(ref) ? "Copy citation" : "Copy link")
			.setIcon("copy").onClick(() => this.copy([ref])));
		if (isZotero(ref)) {
			menu.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => this.open(ref, heading, true)));
		}
		if (isZotero(ref) && ref.zotero?.zotero_uri) {
			menu.addItem((i) => i.setTitle("Show in Zotero app").setIcon("book-open")
				.onClick(() => openExternal(ref.zotero!.zotero_uri)));
		}
		return menu;
	}
}
