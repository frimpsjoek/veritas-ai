// Live-preview Markdown editor for paper notes, the way Obsidian edits: the text stays Markdown (so nothing is
// lost going back to the vault), but it is shown formatted. Headings are large, bold is bold, and the markup
// (**, #, >, [ ]( ) …) only shows on the line being edited. Images (![[x.png]] and ![](x.png)) show as pictures,
// [@citekey] as an author–year chip, [[links]] as links. Built into content/note-editor.js (npm run build).

import { EditorState, EditorSelection, Compartment } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin, WidgetType, keymap, placeholder as placeholderExt, drawSelection, tooltips } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { syntaxTree, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";

const style = HighlightStyle.define([
	{ tag: t.heading1, fontSize: "1.45em", fontWeight: "650", lineHeight: "1.3" },
	{ tag: t.heading2, fontSize: "1.25em", fontWeight: "650", lineHeight: "1.3" },
	{ tag: t.heading3, fontSize: "1.1em", fontWeight: "650" },
	{ tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650" },
	{ tag: t.strong, fontWeight: "700" },
	{ tag: t.emphasis, fontStyle: "italic" },
	{ tag: t.strikethrough, textDecoration: "line-through" },
	{ tag: t.link, color: "var(--sb-link)" },
	{ tag: t.url, color: "var(--sb-muted)" },
	{ tag: t.monospace, fontFamily: "ui-monospace, Menlo, monospace", fontSize: "0.9em", background: "var(--sb-code-bg)", borderRadius: "3px" },
	{ tag: [t.processingInstruction, t.meta], color: "var(--sb-muted)" },
	{ tag: t.quote, color: "var(--sb-quote)" },
]);

// ------------------------------------------------------------------ widgets

class ImageWidget extends WidgetType {
	constructor(src, alt) { super(); this.src = src; this.alt = alt; }
	eq(other) { return other.src === this.src; }
	toDOM() {
		const wrap = document.createElement("span");
		wrap.className = "sb-cm-image";
		const img = document.createElement("img");
		img.src = this.src;
		img.alt = this.alt;
		img.onerror = () => { wrap.textContent = `Image not found: ${this.alt}`; wrap.classList.add("is-missing"); };
		wrap.append(img);
		return wrap;
	}
	ignoreEvent() { return false; }
}

class CiteWidget extends WidgetType {
	constructor(keys, labels, onClick) { super(); this.keys = keys; this.labels = labels; this.onClick = onClick; }
	eq(other) { return other.keys.join() === this.keys.join() && other.labels.map((l) => l?.label).join() === this.labels.map((l) => l?.label).join(); }
	toDOM() {
		const wrap = document.createElement("span");
		wrap.className = "sb-cm-cite";
		this.keys.forEach((key, i) => {
			if (i) wrap.append("; ");
			const chip = document.createElement("span");
			const info = this.labels[i];
			chip.className = info ? "sb-cm-cite-item" : "sb-cm-cite-item is-missing";
			chip.textContent = info ? info.label : `@${key}`;
			chip.title = info ? info.title : "Not in your Zotero library";
			chip.addEventListener("mousedown", (event) => { event.preventDefault(); if (info) this.onClick(key); });
			wrap.append(chip);
		});
		return wrap;
	}
	ignoreEvent() { return false; }
}

class BulletWidget extends WidgetType {
	eq() { return true; }
	toDOM() { const s = document.createElement("span"); s.className = "sb-cm-bullet"; s.textContent = "•"; return s; }
}

// ------------------------------------------------------------------ live preview

const CITATION = /\[([^\[\]\n]*@[^\[\]\n]+)\]/g;
const CITEKEY = /@([\w:.#$%&+?<>~/-]+)/g;
const EMBED = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
const WIKILINK = /(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const HIGHLIGHT = /==([^=\n]+)==/g;

function livePreview(options) {
	const hide = Decoration.replace({});
	const lineClass = (cls) => Decoration.line({ class: cls });

	function build(view) {
		const { state } = view;
		const active = new Set();
		for (const range of state.selection.ranges) {
			const a = state.doc.lineAt(range.from).number, b = state.doc.lineAt(range.to).number;
			for (let n = a; n <= b; n++) active.add(n);
		}
		const focused = view.hasFocus;
		const isActive = (pos) => focused && active.has(state.doc.lineAt(pos).number);
		// Like Obsidian: inline marks (*, **, `, ~~, links, citations) show only while the cursor is inside that
		// piece of formatting; line marks (#, >) show while the cursor is on their line.
		const touches = (a, b) => focused && state.selection.ranges.some((r) => r.from <= b && r.to >= a);
		const decos = [];
		const covered = []; // ranges replaced by widgets, so regex passes don't overlap tree decorations

		for (const { from, to } of view.visibleRanges) {
			syntaxTree(state).iterate({
				from, to,
				enter(node) {
					const name = node.name;
					const heading = /^ATXHeading(\d)$/.exec(name);
					if (heading) decos.push(lineClass(`sb-cm-h sb-cm-h${heading[1]}`).range(state.doc.lineAt(node.from).from));
					if (name === "Blockquote") {
						for (let pos = node.from; pos <= node.to;) {
							const line = state.doc.lineAt(pos);
							decos.push(lineClass("sb-cm-quote").range(line.from));
							pos = line.to + 1;
						}
					}
					if (name === "FencedCode") {
						for (let pos = node.from; pos <= node.to;) {
							const line = state.doc.lineAt(pos);
							decos.push(lineClass("sb-cm-codeblock").range(line.from));
							pos = line.to + 1;
						}
						return false;
					}
					if (name === "HeaderMark") {
						if (isActive(node.from)) return;
						const end = Math.min(node.to + 1, state.doc.lineAt(node.from).to);
						decos.push(hide.range(node.from, end));
					} else if (["EmphasisMark", "CodeMark", "StrikethroughMark", "QuoteMark"].includes(name)) {
						if (name === "CodeMark" && node.node.parent?.name === "FencedCode") return;
						const parent = node.node.parent;
						if (name === "QuoteMark" ? isActive(node.from) : touches(parent?.from ?? node.from, parent?.to ?? node.to)) return;
						let end = node.to;
						if (name === "QuoteMark" && state.doc.sliceString(end, end + 1) === " ") end++;
						decos.push(hide.range(node.from, end));
					} else if (name === "ListMark") {
						if (isActive(node.from)) return;
						const text = state.doc.sliceString(node.from, node.to);
						if (/^[-*+]$/.test(text)) decos.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
					} else if (name === "Image") {
						if (isActive(node.from)) return false;
						const text = state.doc.sliceString(node.from, node.to);
						const m = /^!\[([^\]]*)\]\(([^)\s]+)/.exec(text);
						if (m) {
							decos.push(Decoration.replace({ widget: new ImageWidget(options.imageURL(m[2]), m[1] || m[2]) }).range(node.from, node.to));
							covered.push([node.from, node.to]);
						}
						return false;
					} else if (name === "Link") {
						// [text](url): show only the text, styled as a link
						const marks = [];
						node.node.getChildren("LinkMark").forEach((c) => marks.push(c));
						const url = node.node.getChild("URL");
						// [@key] and [[note]] parse as links without a URL; the citation and wiki-link passes own them
						if (!url || touches(node.from, node.to)) return false;
						if (marks.length >= 2) {
							decos.push(hide.range(marks[0].from, marks[0].to));
							decos.push(Decoration.mark({ class: "sb-cm-link", attributes: { "data-href": url ? state.doc.sliceString(url.from, url.to) : "" } })
								.range(marks[0].to, marks[1].from));
							decos.push(hide.range(marks[1].from, node.to));
							covered.push([node.from, node.to]);
						}
						return false;
					}
				},
			});

			// Obsidian syntax the Markdown parser doesn't know: embeds, citations, wiki links, ==highlights==
			const text = state.doc.sliceString(from, to);
			const overlaps = (a, b) => covered.some(([x, y]) => a < y && b > x);
			const scan = (re, fn) => {
				re.lastIndex = 0;
				for (let m; (m = re.exec(text));) {
					const a = from + m.index, b = a + m[0].length;
					if (!overlaps(a, b)) fn(m, a, b);
				}
			};
			scan(EMBED, (m, a, b) => {
				if (isActive(a)) return;
				decos.push(Decoration.replace({ widget: new ImageWidget(options.imageURL(m[1], true), m[1]) }).range(a, b));
				covered.push([a, b]);
			});
			scan(WIKILINK, (m, a, b) => {
				if (touches(a, b)) { decos.push(Decoration.mark({ class: "sb-cm-wikilink" }).range(a, b)); covered.push([a, b]); return; }
				const shown = m[2] ?? m[1];
				const start = b - 2 - (m[2] ? m[2].length : m[1].length);
				decos.push(hide.range(a, start));
				decos.push(Decoration.mark({ class: "sb-cm-wikilink", attributes: { "data-note": m[1] } }).range(start, start + shown.length));
				decos.push(hide.range(b - 2, b));
				covered.push([a, b]);
			});
			scan(CITATION, (m, a, b) => {
				const keys = [...m[1].matchAll(CITEKEY)].map((k) => k[1].replace(/[.,;:]+$/, ""));
				if (!keys.length) return;
				const inside = touches(a, b);
				if (inside) {
					decos.push(Decoration.mark({ class: "sb-cm-cite-raw" }).range(a, b));
				} else {
					decos.push(Decoration.replace({ widget: new CiteWidget(keys, keys.map((k) => options.citeLabel(k)), options.onCiteClick) }).range(a, b));
				}
				covered.push([a, b]);
			});
			scan(HIGHLIGHT, (m, a, b) => {
				if (touches(a, b)) { decos.push(Decoration.mark({ class: "sb-cm-mark" }).range(a, b)); return; }
				decos.push(hide.range(a, a + 2));
				decos.push(Decoration.mark({ class: "sb-cm-mark" }).range(a + 2, b - 2));
				decos.push(hide.range(b - 2, b));
			});
		}
		return Decoration.set(decos, true);
	}

	return ViewPlugin.fromClass(class {
		constructor(view) { this.decorations = build(view); }
		update(update) {
			if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged
				|| update.transactions.some((tr) => tr.effects.length)) {
				this.decorations = build(update.view);
			}
		}
	}, { decorations: (v) => v.decorations });
}

// ------------------------------------------------------------------ editing helpers

function wrap(view, before, after = before) {
	const changes = view.state.changeByRange((range) => {
		const text = view.state.sliceDoc(range.from, range.to);
		const has = text.startsWith(before) && text.endsWith(after) && text.length >= before.length + after.length;
		const insert = has ? text.slice(before.length, text.length - after.length) : before + text + after;
		const from = range.from;
		const selection = has ? EditorSelection.range(from, from + insert.length)
			: range.empty ? EditorSelection.cursor(from + before.length)
			: EditorSelection.range(from + before.length, from + before.length + text.length);
		return { changes: { from: range.from, to: range.to, insert }, range: selection };
	});
	view.dispatch(view.state.update(changes, { scrollIntoView: true, userEvent: "input" }));
	view.focus();
}

function prefixLines(view, prefix) {
	const { state } = view;
	const lines = new Set();
	for (const r of state.selection.ranges) {
		for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) lines.add(n);
	}
	const changes = [];
	const strip = /^(#{1,6} |> |- |\d+\. |- \[[ x]\] )/;
	for (const n of lines) {
		const line = state.doc.line(n);
		const m = strip.exec(line.text);
		if (m && m[0] === prefix) changes.push({ from: line.from, to: line.from + m[0].length, insert: "" });
		else changes.push({ from: line.from, to: line.from + (m ? m[0].length : 0), insert: prefix });
	}
	view.dispatch({ changes, userEvent: "input" });
	view.focus();
}

// ------------------------------------------------------------------ public API

export function create(parent, options) {
	const refresh = new Compartment();
	const citeCompletion = async (context) => {
		const m = context.matchBefore(/\[[^\[\]\n]*@[^\s;\[\]@]*$/);
		if (!m) return null;
		const at = m.text.lastIndexOf("@");
		const query = m.text.slice(at + 1);
		if (query.length < 2 && !context.explicit) return null;
		const papers = await options.findPapers(query);
		const closed = /^[^\[\]\n]*\]/.test(context.state.sliceDoc(context.pos, context.pos + 200));
		return {
			from: m.from + at + 1,
			filter: false,
			options: papers.map((p) => ({
				label: p.citekey, detail: p.label, info: p.title, type: "text",
				apply: p.citekey + (closed ? "" : "]"),
			})),
		};
	};

	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc: options.doc ?? "",
			extensions: [
				history(),
				drawSelection(),
				EditorView.lineWrapping,
				markdown({ base: markdownLanguage }),
				syntaxHighlighting(style),
				livePreview(options),
				refresh.of([]),
				placeholderExt(options.placeholder ?? ""),
				autocompletion({ override: [citeCompletion], icons: false, activateOnTyping: true }),
				// in the page's flow, so the frame can grow to show them
				tooltips({ position: "absolute" }),
				keymap.of([
					{ key: "Mod-b", run: (v) => (wrap(v, "**"), true) },
					{ key: "Mod-i", run: (v) => (wrap(v, "*"), true) },
					{ key: "Mod-k", run: (v) => (wrap(v, "[", "]()"), true) },
					{ key: "Mod-s", run: () => (options.onSave?.(), true) },
					...completionKeymap, ...markdownKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab,
				]),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) options.onChange?.(update.state.doc.toString());
					if (update.focusChanged) (update.view.hasFocus ? options.onFocus : options.onBlur)?.();
					options.onUpdate?.();
				}),
				EditorView.domEventHandlers({
					mousedown(event) {
						const link = event.target.closest?.(".sb-cm-link, .sb-cm-wikilink");
						if (link && (event.metaKey || event.ctrlKey || !view.hasFocus)) {
							event.preventDefault();
							if (link.dataset.href) options.onLinkClick?.(link.dataset.href);
							else if (link.dataset.note) options.onNoteClick?.(link.dataset.note);
							return true;
						}
						return false;
					},
					paste(event) { return pasteImages(event, event.clipboardData?.files); },
					drop(event) { return pasteImages(event, event.dataTransfer?.files); },
				}),
			],
		}),
	});

	function pasteImages(event, files) {
		const images = [...(files ?? [])].filter((f) => f.type.startsWith("image/"));
		if (!images.length || !options.saveImage) return false;
		event.preventDefault();
		(async () => {
			for (const file of images) {
				const name = await options.saveImage(file);
				if (name) insert(`\n![[${name}]]\n`);
			}
		})();
		return true;
	}

	function insert(text) {
		const { from, to } = view.state.selection.main;
		view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true, userEvent: "input" });
		view.focus();
	}

	return {
		view,
		getText: () => view.state.doc.toString(),
		/** Replace the whole text (an edit arriving from Obsidian), keeping the caret near where it was. */
		setText(text) {
			const head = Math.min(view.state.selection.main.head, text.length);
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: head } });
		},
		focus: () => view.focus(),
		select: (anchor, head = anchor) => view.dispatch({ selection: { anchor, head } }),
		hasFocus: () => view.hasFocus,
		insert,
		bold: () => wrap(view, "**"),
		italic: () => wrap(view, "*"),
		strike: () => wrap(view, "~~"),
		mark: () => wrap(view, "=="),
		code: () => wrap(view, "`"),
		link: () => wrap(view, "[", "]()"),
		heading: (level = 2) => prefixLines(view, "#".repeat(level) + " "),
		bullet: () => prefixLines(view, "- "),
		numbered: () => prefixLines(view, "1. "),
		task: () => prefixLines(view, "- [ ] "),
		quote: () => prefixLines(view, "> "),
		/** Insert [@key], or add "; @key" when the caret is inside a citation already. */
		cite(key) {
			const { state } = view;
			const at = state.selection.main.head;
			const before = state.sliceDoc(Math.max(0, at - 300), at), after = state.sliceDoc(at, at + 300);
			const inside = /\[[^\[\]\n]*@[^\[\]\n]*$/.test(before) && /^[^\[\]\n]*\]/.test(after);
			insert(inside ? `; @${key}` : `${before && !/\s$/.test(before) ? " " : ""}[@${key}]`);
		},
		/** Labels for citation chips arrived: redraw. */
		redraw: () => view.dispatch({ effects: refresh.reconfigure([]) }),
		destroy: () => view.destroy(),
	};
}
