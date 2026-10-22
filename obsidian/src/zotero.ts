import { ItemView, MarkdownRenderer, Menu, Notice, TFile, ViewStateResult, WorkspaceLeaf } from "obsidian";
import type SecondBrainSearch from "./main";
import type { NoteRef, Related } from "./api";
import { openExternal } from "./links";
import { ChipRow, Highlight, PaperCard, Row, Section, StateLine, Subhead, metaOf, closeness, titleOf } from "../../zotero-plugin/ui-src/src/index.js";
import { wireRow } from "./panel-rows";

// A Zotero item as an Obsidian tab: header, actions, abstract, the user's highlights and notes, related vault
// notes, and the full text on demand. Works the same on the phone (the data comes from the Mac's index server).

export const ZOTERO_VIEW = "second-brain-zotero";

interface HighlightData { type: string; text: string; comment: string; color: string; page: string }
interface Attachment { key: string; title: string; content_type: string; highlights: HighlightData[]; has_full_text: boolean; open_uri: string; full_text?: string }
interface Item {
	key: string; type: string; title: string; creators: { name: string; role: string }[];
	date: string; year: string; venue: string; volume: string; issue: string; pages: string;
	doi: string; url: string; citekey: string; abstract: string; tags: string[]; collections: string[];
	notes: string[]; attachments: Attachment[]; zotero_uri: string;
}

const TYPE_LABELS: Record<string, string> = {
	journalArticle: "Journal article", preprint: "Preprint", conferencePaper: "Conference paper", book: "Book",
	bookSection: "Book chapter", thesis: "Thesis", report: "Report", webpage: "Web page", computerProgram: "Software",
	blogPost: "Blog post", document: "Document", presentation: "Presentation", manuscript: "Manuscript",
};
const AUTHORS_SHOWN = 8;

export class ZoteroView extends ItemView {
	private key = "";
	private title = "Zotero item";
	private item: Item | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: SecondBrainSearch) { super(leaf); }

	getViewType() { return ZOTERO_VIEW; }
	getDisplayText() { return this.title; }
	getIcon() { return "book-open"; }

	getState() { return { key: this.key, title: this.title }; }

	async setState(state: { key?: string; title?: string }, result: ViewStateResult) {
		if (state.key && state.key !== this.key) {
			this.key = state.key;
			this.title = state.title ?? "Zotero item";
			await this.render();
		}
		await super.setState(state, result);
	}

	private async render() {
		this.contentEl.empty();
		this.contentEl.addClass("sb-p-scroll");
		const root = this.contentEl.createDiv({ cls: "sb-p sb-p-page" });
		const doc = root.ownerDocument;
		const loading = root.appendChild(StateLine(doc, "loading", "Loading…"));
		try {
			if (!(await this.plugin.api.ensure())) throw new Error(this.plugin.api.unreachableMessage());
			this.item = await this.plugin.api.call<Item>(`/zotero?${new URLSearchParams({ key: this.key })}`);
		} catch (error) {
			loading.replaceWith(StateLine(doc, "error", `Couldn't load this item: ${(error as Error).message}`));
			return;
		}
		loading.remove();
		const item = this.item;
		this.title = item.title;
		(this.leaf as any).updateHeader?.();
		(this as any).titleEl?.setText?.(this.title); // the header bar keeps "Zotero item" otherwise

		this.header(root, item);
		if (item.abstract) {
			const section = Section(doc, { title: "Abstract" });
			section.body.createDiv({ cls: "sb-p-prose", text: item.abstract.replace(/^S2 TL;DR:\s*/, "") });
			root.append(section.el);
		}
		const highlights = item.attachments.filter((a) => a.highlights.length);
		if (highlights.length) {
			const count = highlights.reduce((n, a) => n + a.highlights.length, 0);
			const section = Section(doc, { title: "Highlights", count });
			for (const attachment of highlights) {
				if (highlights.length > 1) section.body.append(Subhead(doc, attachment.title || "Attachment"));
				for (const h of attachment.highlights) section.body.append(this.highlight(doc, h));
			}
			root.append(section.el);
		}
		if (item.notes.length) {
			const section = Section(doc, { title: "My notes", count: item.notes.length });
			for (const note of item.notes) {
				const el = section.body.createDiv({ cls: "sb-p-note markdown-rendered" });
				await MarkdownRenderer.render(this.app, note, el, "", this);
			}
			root.append(section.el);
		}
		await this.related(root, item);
		this.fullText(root, item);
		this.footer(root, item);
	}

	private header(page: HTMLElement, item: Item) {
		const doc = page.ownerDocument;
		const authors = item.creators.filter((c) => c.role === "author" || item.creators.every((x) => x.role !== "author")).map((a) => a.name);
		const where = [
			item.venue && `${item.venue}${item.volume ? ` ${item.volume}` : ""}${item.issue ? `(${item.issue})` : ""}`,
			item.pages && `pp. ${item.pages}`,
			item.date || item.year,
		].filter(Boolean).join(" · ");
		const chips: { text: string; title?: string; href?: string; onClick?: () => void }[] = [];
		if (item.citekey) chips.push({ text: `@${item.citekey}`, title: "Copy citation", onClick: () => this.plugin.links.copy([this.ref()]) });
		if (item.doi) chips.push({ text: `DOI ${item.doi}`, href: `https://doi.org/${item.doi}` });
		const card = PaperCard(doc, { kicker: TYPE_LABELS[item.type] ?? item.type, title: item.title, authors, authorsShown: AUTHORS_SHOWN, venue: where, chips, openLink: (url, opts) => this.plugin.webLinks.open(url, opts) });
		const pdfs = item.attachments.filter((a) => a.open_uri);
		// one primary: Open PDF (a menu when there are several); otherwise the paper note is the card's one action that matters
		if (pdfs.length === 1) card.addAction({ label: "Open PDF", icon: "paper", primary: true, onClick: () => openExternal(pdfs[0].open_uri) });
		if (pdfs.length > 1) {
			card.addAction({ label: "Open PDF", icon: "paper", primary: true, onClick: (e) => {
				const menu = new Menu();
				for (const pdf of pdfs) menu.addItem((i) => i.setTitle(pdf.title || "PDF").onClick(() => openExternal(pdf.open_uri)));
				menu.showAtMouseEvent(e);
			} });
		}
		this.noteButton(card.addAction({ label: "Paper note", icon: "pen", onClick: () => {} }), item);
		card.addAction({ label: "Show in Zotero", icon: "book", onClick: () => openExternal(item.zotero_uri) });
		card.addAction({ label: "Insert citation", icon: "quote", onClick: () => this.plugin.links.insert(this.ref()) });
		if (!item.doi && item.url) card.addAction({ label: "Web page", icon: "web", onClick: () => this.plugin.webLinks.open(item.url) });
		page.append(card.el);
	}

	/** The paper's own note (Papers/…): open it, or make it with the abstract, highlights and Zotero notes. */
	private async noteButton(b: HTMLButtonElement, item: Item) {
		const label = b.lastElementChild as HTMLElement;
		let path: string | null = null;
		try {
			path = (await this.plugin.api.call<{ path: string | null }>(`/paper-note?key=${item.key}`)).path;
		} catch { /* shown as "Create" */ }
		label.setText(path ? "Open my note" : "Create paper note");
		b.addEventListener("click", async () => {
			if (!path) {
				try {
					path = (await this.plugin.api.call<{ path: string }>("/paper-note", "POST", { key: item.key })).path;
				} catch (error) {
					new Notice(`Couldn't create the note: ${(error as Error).message}`);
					return;
				}
				label.setText("Open my note");
				// The server writes the file; wait until Obsidian has picked it up.
				for (let i = 0; i < 30 && !this.app.vault.getAbstractFileByPath(path); i++) await new Promise((r) => setTimeout(r, 100));
			}
			if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) {
				await this.app.workspace.openLinkText(path, "", "tab");
			} else {
				new Notice("The note was created; it will appear in Papers/ in a moment.");
			}
		});
	}

	private highlight(doc: Document, h: HighlightData): HTMLElement {
		return Highlight(doc, {
			type: h.type, text: h.text, comment: h.comment, page: h.page, color: h.color || "var(--text-highlight-bg)",
			onContext: (e) => {
				e.preventDefault();
				const menu = new Menu();
				menu.addItem((i) => i.setTitle("Copy as quote with citation").setIcon("quote").onClick(async () => {
					const cite = this.item?.citekey ? ` [@${this.item.citekey}${h.page ? `, p. ${h.page}` : ""}]` : "";
					await navigator.clipboard.writeText(`> ${h.text}${cite}`);
					new Notice("Quote copied");
				}));
				menu.showAtMouseEvent(e);
			},
		});
	}

	private async related(page: HTMLElement, item: Item) {
		let related: Related;
		try {
			related = await this.plugin.api.call<Related>(`/related?${new URLSearchParams({ path: `zotero/${item.key}`, limit: "8" })}`);
		} catch {
			return; // optional: the item itself is already shown
		}
		const citing = related.linked_from.map((p) => related.refs[p] ?? { path: p, title: titleOf(p) });
		const similar = related.similar;
		if (!citing.length && !similar.length) return;
		const doc = page.ownerDocument;
		const section = Section(doc, { title: "In your notes" });
		const list = (label: string, refs: (NoteRef & { score?: number })[]) => {
			if (!refs.length) return;
			section.body.append(Subhead(doc, label));
			for (const ref of refs) {
				const row = Row(doc, { path: ref.path, title: ref.title, meta: metaOf(ref as never) || undefined, score: ref.score !== undefined ? closeness(ref.score) : null });
				wireRow(this.plugin, row.el, ref, ZOTERO_VIEW, this);
				section.body.append(row.el);
			}
		};
		list("Cites this paper", citing);
		list("Similar", similar);
		page.append(section.el);
	}

	private fullText(page: HTMLElement, item: Item) {
		if (!item.attachments.some((a) => a.has_full_text)) return;
		const doc = page.ownerDocument;
		let loaded = false;
		const section = Section(doc, {
			title: "Full text", open: false,
			onToggle: async (open) => {
				if (!open || loaded) return;
				loaded = true;
				body.append(StateLine(doc, "loading", "Loading…"));
				try {
					const full = await this.plugin.api.call<Item>(`/zotero?${new URLSearchParams({ key: item.key, full_text: "1" })}`);
					body.empty();
					for (const attachment of full.attachments.filter((a) => a.full_text)) {
						if (full.attachments.length > 1) body.append(Subhead(doc, attachment.title));
						const words = attachment.full_text!.split(/\s+/).length;
						body.createDiv({ cls: "sb-p-meta", text: `${words.toLocaleString()} words, extracted by Zotero` });
						for (const para of paragraphs(attachment.full_text!)) {
							body.createEl(para.heading ? "h4" : "p", { cls: para.heading ? "sb-p-fulltext-head" : "sb-p-para", text: para.text });
						}
					}
				} catch (error) {
					body.empty();
					body.append(StateLine(doc, "error", `Couldn't load the full text: ${(error as Error).message}`));
				}
			},
		});
		const body = section.body;
		page.append(section.el);
	}

	private footer(page: HTMLElement, item: Item) {
		if (!item.tags.length && !item.collections.length) return;
		const doc = page.ownerDocument;
		const foot = page.createDiv({ cls: "sb-p-footer" });
		if (item.collections.length) foot.append(ChipRow(doc, "Collections", item.collections.map(readable)));
		if (item.tags.length) foot.append(ChipRow(doc, "Tags", item.tags));
	}

	private ref(): NoteRef {
		const item = this.item!;
		return {
			path: `zotero/${item.key}`, title: item.title,
			zotero: {
				authors: item.creators.map((c) => c.name), year: item.year, venue: item.venue, doi: item.doi, url: item.url,
				citekey: item.citekey, type: item.type, collections: item.collections, zotero_uri: item.zotero_uri,
			},
		};
	}
}

/**
 * Zotero's extracted text (pdf.js) puts one paragraph per line. Short capitalised lines without closing
 * punctuation are section headings ("Results", "Datasets"); lines of only digits and punctuation are PDF debris.
 */
function paragraphs(text: string): { text: string; heading: boolean }[] {
	return text.split("\n").map((l) => l.trim())
		.filter((l) => l.length > 1 && !/^[\d\s():,;.|-]+$/.test(l))
		.map((l) => ({ text: l, heading: l.length < 48 && /^[A-Z]/.test(l) && !/[.,;:)]$/.test(l) && l.split(" ").length <= 6 }));
}

/** Opens a Zotero item in a tab: the current one, or a new one on Cmd/Ctrl-click. */
export async function openZotero(plugin: SecondBrainSearch, ref: NoteRef, newTab: boolean) {
	const key = ref.path.replace(/^zotero\//, "");
	const leaf = plugin.app.workspace.getLeaf(newTab ? "tab" : false);
	await leaf.setViewState({ type: ZOTERO_VIEW, active: true, state: { key, title: ref.title } });
	await plugin.app.workspace.revealLeaf(leaf);
}

/** Some collection names arrive URL-encoded ("Connected-Papers-%7C-Find"); show them as written. */
function readable(name: string): string {
	try {
		return decodeURIComponent(name).replace(/-/g, " ");
	} catch {
		return name;
	}
}
