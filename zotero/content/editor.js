/* global Zotero, SecondBrain, PathUtils, IOUtils */
// The paper-note editor: "My notes" of the paper's Obsidian note, edited from Zotero. The note file stays the
// only copy; every save goes to the index server, which writes it into the vault.
//
// The note is edited in live preview (content/note-editor.js, CodeMirror): it stays Markdown but shows
// formatted, with images, citation chips and links; markup appears only on the line being edited. Below it,
// live from Zotero: the paper's highlights and comments (click opens the PDF there), notes written in Zotero,
// and the papers cited. While the note is open, each new highlight is added to it as a linked quote.
// The same layout fills the item pane, the reader's side pane and a Zotero tab.

SecondBrain.Editor = class {
	/**
	 * @param {Document} doc
	 * @param {HTMLElement} host - emptied and filled with the editor
	 * @param {Zotero.Item} item - the paper
	 * @param {{ tab?: boolean }} options - tab: a full page in a Zotero tab
	 */
	constructor(doc, host, item, options = {}) {
		this.sb = SecondBrain;
		this.doc = doc;
		this.item = item;
		this.key = item.key;
		this.tab = !!options.tab;
		this.hash = null;
		this.path = null;
		this.dirty = false;
		this.saving = null;
		this.saveTimer = null;
		this.store = this.sb.store();
		this.build(host);
		this.load();
		this.poll = setInterval(() => this.checkForChanges(), 3000);
	}

	el(tag, cls, text) { return this.sb.el(this.doc, tag, cls, text); }

	build(host) {
		host.replaceChildren();
		this.root = this.el("div", this.tab ? "sb-ed is-tab" : "sb-ed");

		// Title: says plainly that this is the place to write
		const head = this.el("div", "sb-ed-head");
		const heading = this.el("div", "sb-ed-heading");
		// the save status sits under the title, so the toolbar fits on one row in a narrow pane
		this.status = this.el("span", "sb-ed-status", "Loading…");
		heading.append(this.el("b", "", "✎ My notes"), this.status);
		head.append(heading);
		if (!this.tab) {
			this.focusButton = this.button("", "Hide the other sections so only the note is left", () => this.sb.setFocus(!this.sb.focusMode));
			head.append(this.focusButton, this.button("⤢ Full page", "Open the note in its own Zotero tab", () => this.sb.openNoteTab(this.item)));
			this.showFocus();
		}
		head.append(this.button("⚙", "Second Brain settings: colors and where notes are kept", () => this.sb.openSettings(), "is-icon"));

		// Formatting toolbar
		const bar = this.el("div", "sb-ed-bar");
		const tools = this.el("div", "sb-ed-tools");
		const tool = (label, title, run, cls = "") => tools.append(this.button(label, title, run, `sb-tool ${cls}`));
		tool("B", "Bold (⌘B)", () => this.cm?.bold(), "is-bold");
		tool("I", "Italic (⌘I)", () => this.cm?.italic(), "is-italic");
		tool("H", "Heading", () => this.cm?.heading(2), "is-heading");
		tool("•", "Bulleted list", () => this.cm?.bullet());
		tool("1.", "Numbered list", () => this.cm?.numbered());
		tool("☐", "Task", () => this.cm?.task());
		tool("❝", "Quote", () => this.cm?.quote());
		tool("≡", "Highlight text (==…==)", () => this.cm?.mark(), "is-mark");
		tool("🔗", "Link (⌘K)", () => this.cm?.link());
		tool("@", "Cite a paper from your library", () => this.openCite(), "is-cite");
		bar.append(tools);

		bar.append(this.el("span", "sb-ed-spacer"));
		this.autoQuote = this.button("", "New highlights you make are added to these notes as linked quotes",
			() => this.sb.setAutoQuote(!this.sb.autoQuote), "sb-ed-toggle");
		bar.append(this.autoQuote);
		this.obsidian = this.button("Obsidian ↗", "Open the note in Obsidian", () => this.path && this.sb.open(this.path));
		this.obsidian.hidden = true;
		bar.append(this.obsidian);
		this.showAutoQuote();

		// Cite search: one field, a short list, Enter inserts.
		this.cite = this.el("div", "sb-cite");
		this.cite.hidden = true;
		this.citeInput = this.el("input", "sb-cite-input");
		this.citeInput.placeholder = "Author, title, year or citekey";
		this.citeList = this.el("div", "sb-cite-list");
		this.cite.append(this.citeInput, this.citeList);
		this.citeInput.addEventListener("input", () => {
			clearTimeout(this.citeTimer);
			this.citeTimer = setTimeout(() => this.searchCite(), 120);
		});
		this.citeInput.addEventListener("keydown", (event) => this.citeKeydown(event));
		this.citeInput.addEventListener("blur", () => setTimeout(() => {
			if (!this.cite.contains(this.doc.activeElement)) this.cite.hidden = true;
		}, 150));

		this.conflict = this.el("div", "sb-ed-conflict");
		this.conflict.hidden = true;

		// The note itself, in its own page (CodeMirror can't track the caret inside Zotero's XUL panes)
		this.surface = this.el("div", "sb-ed-surface");
		// A XUL iframe, like Zotero's own note editor; chrome-privileged, so the plugin can drive it directly.
		this.frame = this.doc.createXULElement("iframe");
		this.frame.className = "sb-ed-frame";
		this.frame.setAttribute("src", "chrome://second-brain/content/note-frame.html");
		this.surface.append(this.frame);
		this.ready = new Promise((resolve, reject) => this.frame.addEventListener("DOMContentLoaded", () => { try {
			const win = this.frame.contentWindow;
			if (this.tab) win.document.body.classList.add("is-tab");
			this.cm = win.SecondBrainCM.create(win.document.body, {
				doc: "",
				placeholder: "Write your notes on this paper… Type [@ to cite, paste images; new highlights land here.",
				onChange: () => this.changed(),
				onBlur: () => this.flush(),
				onSave: () => this.flush(),
				onUpdate: () => this.fit(),
				imageURL: (target, embed) => this.imageURL(target, embed),
				citeLabel: (key) => this.sb.citeLabel(key, () => this.cm?.redraw()),
				onCiteClick: (key) => this.sb.selectByCitekey(key),
				onLinkClick: (href) => this.sb.openURL(href),
				onNoteClick: (name) => this.sb.open(/\.\w+$/.test(name) ? name : name + ".md"),
				findPapers: (query) => this.findPapers(query, 8).then((items) => items.map((i) => this.paperInfo(i))),
				saveImage: (file) => this.saveImage(file),
			});
			// images load after layout; re-fit when they do
			win.document.addEventListener("load", () => this.fit(), true);
			new win.ResizeObserver(() => this.fit()).observe(win.document.body);
			this.doc.defaultView.addEventListener("resize", () => this.fit());
			const pane = this.root.closest(".zotero-view-item");
			if (pane) (this.paneObserver = new this.doc.defaultView.ResizeObserver(() => this.fit())).observe(pane);
			this.applyColors();
			this.themeQuery = this.doc.defaultView.matchMedia("(prefers-color-scheme: dark)");
			this.themeListener = () => setTimeout(() => this.applyColors(), 50);
			this.themeQuery.addEventListener("change", this.themeListener);
			this.fit();
			resolve();
		} catch (error) { Zotero.logError(error); reject(error); } }, { once: true }));

		// Live from Zotero
		this.highlights = this.el("div", "sb-doc-section");
		this.zoteroNotes = this.el("div", "sb-doc-section");
		this.refs = this.el("div", "sb-doc-section");
		const sheet = this.el("div", "sb-ed-sheet");
		sheet.append(bar, this.cite, this.conflict, this.surface);
		this.root.append(head, sheet, this.highlights, this.zoteroNotes, this.refs);
		this.showWhere();
		host.append(this.root);
		this.renderFromZotero();
	}

	button(label, title, onClick, extra = "") {
		const b = this.el("button", `sb-button ${extra}`.trim(), label);
		b.title = title;
		b.addEventListener("mousedown", (event) => event.preventDefault()); // keep the caret in the note
		b.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
		return b;
	}

	/** Size the note's frame to its content, including an open suggestion list. */
	fit() {
		const doc = this.frame?.contentDocument;
		if (!doc?.body) return;
		// The writing area fills the visible item pane (less the title and toolbar), or 75% of a tab, and grows with the text.
		const pane = !this.tab && this.root.closest(".zotero-view-item");
		const room = pane ? pane.clientHeight - 105 : this.doc.defaultView.innerHeight * 0.8;
		const floor = Math.max(480, Math.round(room));
		if (this.floor !== floor) {
			this.floor = floor;
			doc.documentElement.style.setProperty("--sb-min", `${floor}px`);
		}
		let bottom = doc.body.getBoundingClientRect().bottom;
		for (const tip of doc.querySelectorAll(".cm-tooltip")) bottom = Math.max(bottom, tip.getBoundingClientRect().bottom);
		const height = `${Math.ceil(bottom) + 6}px`;
		if (this.frame.style.height !== height) this.frame.style.height = height;
	}

	/** The auto-add switch is shared by every open note; the plugin calls this when it flips. */
	showAutoQuote() {
		const on = this.sb.autoQuote;
		this.autoQuote.textContent = on ? "Auto-add highlights ✓" : "Auto-add highlights";
		this.autoQuote.classList.toggle("is-on", on);
	}

	imageURL(target, embed) {
		if (/^(https?|data):/i.test(target)) return target;
		let path = target;
		if (!embed) try { path = decodeURIComponent(target); } catch (error) { /* keep as written */ }
		return this.store.imageURL(path, embed, this.path);
	}

	/** Zotero's own colors unless the settings pick others; the note's frame is a separate page, so they're copied in. */
	applyColors() {
		const doc = this.frame?.contentDocument;
		if (!doc?.documentElement) return;
		const style = this.doc.defaultView.getComputedStyle(this.root);
		const zotero = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
		const pick = (name) => Zotero.Prefs.get(`extensions.secondbrain.color.${name}`, true) || "";
		const accent = pick("accent") || zotero("--color-accent", zotero("--accent-blue", "#4072e5"));
		const vars = {
			"--sb-text": pick("text") || style.color,
			"--sb-link": accent,
			"--sb-muted": zotero("--fill-tertiary", "#8a8a8a"),
			"--sb-quote": zotero("--fill-secondary", "#5b5b5b"),
			"--sb-rule": zotero("--fill-quinary", "rgba(128,128,128,.2)"),
			"--sb-code-bg": zotero("--fill-quinary", "rgba(128,128,128,.12)"),
			"--sb-popup": zotero("--material-background", "Canvas"),
			"--sb-hover": zotero("--fill-quinary", "rgba(128,128,128,.12)"),
		};
		if (pick("highlight")) vars["--sb-mark"] = `color-mix(in srgb, ${pick("highlight")} 45%, transparent)`;
		else doc.documentElement.style.removeProperty("--sb-mark");
		for (const [name, value] of Object.entries(vars)) doc.documentElement.style.setProperty(name, value);
		this.root.style.setProperty("--ed-sheet-bg", pick("background") || "");
		this.root.style.setProperty("--ed-accent", accent);
		if (!pick("background")) this.root.style.removeProperty("--ed-sheet-bg");
	}

	async saveImage(file) {
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			let binary = "";
			for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			return await this.store.saveImage(file.name || "pasted.png", this.doc.defaultView.btoa(binary));
		} catch (error) {
			this.setStatus(`Image not saved: ${error.message}`, true);
			return null;
		}
	}

	// ------------------------------------------------------------------ loading and saving

	async load() {
		try {
			let note;
			try {
				note = await this.store.load(this.item);
			} catch (error) {
				if (this.store.kind !== "obsidian" || !this.sb.isOffline(error)) throw error;
				this.sb.setOnline(false);
				this.store = this.sb.local;
				note = await this.store.load(this.item);
			}
			await this.ready;
			this.apply(note);
			if (this.store.kind === "obsidian") await this.adoptLocalCopy(note);
			this.restoreDraft();
		} catch (error) {
			this.setStatus(`Couldn't open the note: ${error.message ?? error}`, true);
		}
	}

	/** Notes written while Second Brain wasn't running live in the local folder; move them into the vault. */
	async adoptLocalCopy(note) {
		const local = await this.sb.local.load(this.item).catch(() => null);
		if (!local?.path) return;
		// a notes folder inside the vault: the server already treats this very file as the paper's note
		if (note.path && local.path.replace(/\\/g, "/").endsWith("/" + note.path)) return;
		if (local.text.trim() === note.text.trim()) return this.sb.local.retire(this.key);
		if (!note.text.trim()) {
			this.applying = true;
			this.cm.setText(local.text);
			this.applying = false;
			this.dirty = true;
			await this.flush();
			if (!this.dirty && this.store.kind === "obsidian") await this.sb.local.retire(this.key);
			return;
		}
		this.setStatus("Two versions", true);
		this.conflict.replaceChildren(
			this.el("span", "", "You also wrote in this note while Second Brain wasn't running."),
			this.button("Use that version", "Replace the Obsidian note with the one written offline", async () => {
				this.applying = true;
				this.cm.setText(local.text);
				this.applying = false;
				await this.flush(true);
				if (!this.dirty) await this.sb.local.retire(this.key);
			}),
			this.button("Keep Obsidian's", "The offline copy is kept in Zotero's data folder, under second-brain/moved-to-obsidian", async () => {
				this.conflict.hidden = true;
				await this.sb.local.retire(this.key);
				this.setStatus(this.savedLabel());
			}),
		);
		this.conflict.hidden = false;
	}

	savedLabel() {
		if (!this.path) return this.store.kind === "local" ? "New note · saved on this computer when you write" : "New note · saved to Obsidian when you write";
		return this.store.kind === "local" ? "Saved on this computer" : "Synced with Obsidian";
	}

	showWhere() {
		this.obsidian.hidden = this.store.kind !== "obsidian" || !this.path;
	}

	apply(note) {
		this.hash = note.hash;
		this.path = note.path;
		this.showWhere();
		if (!this.dirty && this.cm.getText() !== note.text) {
			this.applying = true;
			this.cm.setText(note.text);
			this.applying = false;
		}
		// a full-page note opens with the caret at the end, where new writing goes (and the first line, often an
		// image, stays rendered instead of showing its Markdown)
		if (this.tab && !this.loaded) this.cm.select(this.cm.getText().length);
		this.loaded = true;
		this.renderReferences(note.references ?? []);
		this.markQuoted();
		this.setStatus(this.savedLabel());
	}

	/** Text that was still unsaved when Zotero last quit: put it back and save it against the version it was based on. */
	restoreDraft() {
		const drafts = this.sb.drafts();
		const draft = drafts[this.key];
		if (!draft) return;
		delete drafts[this.key];
		this.sb.saveDrafts(drafts);
		if (draft.text === this.cm.getText()) return;
		this.applying = true;
		this.cm.setText(draft.text);
		this.applying = false;
		this.hash = draft.hash;
		this.dirty = true;
		this.flush();
	}

	changed() {
		if (this.applying) return;
		this.dirty = true;
		this.setStatus("Editing…");
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.flush(), 800);
	}

	/** Save now if anything is unsaved. Resolves when the save is done. */
	async flush(force = false) {
		clearTimeout(this.saveTimer);
		if (this.saving) await this.saving;
		if ((!this.dirty && !force) || !this.cm) return;
		const text = this.cm.getText();
		this.dirty = false;
		this.setStatus("Saving…");
		this.saving = (async () => {
			try {
				let saved;
				try {
					saved = await this.store.save(this.item, text, this.hash, force);
				} catch (error) {
					if (this.store.kind !== "obsidian" || !this.sb.isOffline(error)) throw error;
					// Second Brain stopped: keep writing to this computer; it moves into the vault when it's back
					this.sb.setOnline(false);
					this.store = this.sb.local;
					saved = await this.store.save(this.item, text, null, true);
				}
				this.hash = saved.hash;
				this.path = saved.path;
				this.showWhere();
				this.renderReferences(saved.references ?? []);
				this.markQuoted();
				this.conflict.hidden = true;
				if (this.cm.getText() !== text) this.dirty = true; // typed while saving
				this.setStatus(this.dirty ? "Editing…" : this.savedLabel());
				this.sb.notesChanged(this.key);
			} catch (error) {
				this.dirty = true;
				if (error.status === 409) this.showConflict(error.body);
				else this.setStatus(`Not saved: ${error.message ?? error}`, true);
			} finally {
				this.saving = null;
			}
		})();
		return this.saving;
	}

	/** Edits made in Obsidian show up here while nothing is unsaved and the note isn't being typed in. */
	async checkForChanges() {
		// the pane closed (e.g. the panel beside a PDF): save what was typed before letting go
		if (!this.root.isConnected) return this.flush().finally(() => this.destroy());
		if (!this.cm || this.dirty || this.saving || this.doc.hidden || !this.conflict.hidden || this.cm.hasFocus()) return;
		try {
			const note = await this.store.load(this.item);
			if (note.hash !== this.hash && !this.dirty) this.apply(note);
		} catch (error) { /* server gone for a moment; next tick */ }
	}

	showConflict(current) {
		const elsewhere = this.store.kind === "local" ? "outside Zotero" : "in Obsidian";
		this.setStatus(`Changed ${elsewhere}`, true);
		this.conflict.replaceChildren(
			this.el("span", "", `This note was also changed ${elsewhere}.`),
			this.button("Keep mine", "Save this version over the other one", () => this.flush(true)),
			this.button("Use the other", "Discard the edits made here", () => {
				this.dirty = false;
				this.conflict.hidden = true;
				this.apply(current);
			}),
		);
		this.conflict.hidden = false;
	}

	setStatus(text, error = false) {
		this.status.textContent = text;
		this.status.classList.toggle("is-error", error);
	}

	showFocus() {
		if (!this.focusButton) return;
		const on = this.sb.focusMode;
		this.focusButton.textContent = on ? "Show all" : "Focus";
		this.focusButton.classList.toggle("is-on", on);
	}

	destroy() {
		this.paneObserver?.disconnect();
		this.themeQuery?.removeEventListener("change", this.themeListener);
		clearInterval(this.poll);
		clearTimeout(this.saveTimer);
		this.cm?.destroy();
		this.sb.editors.delete(this);
	}

	// ------------------------------------------------------------------ from Zotero: highlights, notes

	annotations() {
		const out = [];
		for (const id of this.item.getAttachments()) {
			const attachment = Zotero.Items.get(id);
			if (!attachment?.isFileAttachment?.() || attachment.deleted) continue;
			for (const a of attachment.getAnnotations()) {
				if (a.annotationType === "ink") continue;
				out.push({ attachment, a });
			}
		}
		const order = (x) => x.a.annotationSortIndex ?? "";
		return out.sort((x, y) => (x.attachment.id - y.attachment.id) || order(x).localeCompare(order(y)));
	}

	/** A cheap fingerprint of highlights and Zotero notes, so a change elsewhere re-renders only when needed. */
	zoteroSignature() {
		const parts = this.annotations().map(({ a }) => `${a.key}|${a.annotationText}|${a.annotationComment}|${a.annotationColor}`);
		for (const id of this.item.getNotes()) parts.push(`${id}|${Zotero.Items.get(id)?.dateModified}`);
		return parts.join("\n");
	}

	/** Called by the plugin when annotations or notes change in Zotero. Returns whether anything changed. */
	renderFromZotero() {
		const signature = this.zoteroSignature();
		if (signature === this.signature) return false;
		this.signature = signature;
		this.renderHighlights();
		this.renderZoteroNotes();
		return true;
	}

	sectionHead(box, label, count) {
		const head = this.el("div", "sb-doc-head");
		head.append(this.el("span", "", label));
		if (count) head.append(this.el("span", "sb-count", String(count)));
		box.append(head);
	}

	renderHighlights() {
		const box = this.highlights;
		box.replaceChildren();
		const list = this.annotations();
		this.sectionHead(box, "Highlights", list.length);
		if (!list.length) {
			box.append(this.el("div", "sb-md-empty", "Highlights and comments you make in the PDF appear here, and in your notes, as you make them."));
			return;
		}
		for (const { attachment, a } of list) {
			const card = this.el("div", "sb-hl");
			card.dataset.key = a.key;
			card.style.setProperty("--hl", a.annotationColor || "#ffd400");
			card.title = "Open the PDF here";
			if (a.annotationType === "image") card.append(this.annotationImage(a));
			else if (a.annotationText) card.append(this.el("div", "sb-hl-text", a.annotationText));
			if (a.annotationComment) card.append(this.el("div", "sb-hl-comment", a.annotationComment));
			const foot = this.el("div", "sb-hl-foot");
			foot.append(this.el("span", "", a.annotationPageLabel ? `p. ${a.annotationPageLabel}` : ""));
			const quote = this.el("button", "sb-hl-quote", "Add to notes");
			quote.title = "Add this highlight to your notes, linked to its place in the PDF";
			quote.addEventListener("click", (event) => { event.stopPropagation(); this.quote(attachment, a); });
			foot.append(quote);
			card.append(foot);
			card.addEventListener("click", () => Zotero.Reader.open(attachment.id, { annotationID: a.key }));
			box.append(card);
		}
		this.markQuoted();
	}

	/** Image selections: Zotero renders them into its cache; show that picture, drawing it first if needed. */
	annotationImage(a) {
		const holder = this.el("div", "sb-hl-image");
		const path = Zotero.Annotations.getCacheImagePath({ libraryID: a.libraryID, key: a.key });
		(async () => {
			if (!(await IOUtils.exists(path))) {
				const note = this.el("div", "sb-hl-text is-image", "Drawing image…");
				holder.append(note);
				const drawn = await this.renderImages(a.parentID);
				if (!drawn || !(await IOUtils.exists(path))) {
					note.textContent = drawn === null
						? "Image selection · the PDF file is missing (Tools → Fix Missing PDFs)"
						: "Image selection · open the PDF once to draw it";
					return;
				}
				note.remove();
			}
			const img = this.el("img");
			img.src = PathUtils.toFileURI(path);
			holder.append(img);
		})();
		return holder;
	}

	/** Ask Zotero to draw a PDF's image selections, once per PDF. Resolves true when drawn, null when the PDF
	 *  file is missing, false when drawing failed. */
	renderImages(attachmentID) {
		this.sb.rendering ??= new Map();
		if (!this.sb.rendering.has(attachmentID)) {
			this.sb.rendering.set(attachmentID, (async () => {
				const attachment = Zotero.Items.get(attachmentID);
				if (!attachment || !(await attachment.fileExists())) return null;
				try {
					await Zotero.PDFWorker.renderAttachmentAnnotations(attachmentID);
					return true;
				} catch (error) {
					return false;
				}
			})());
		}
		return this.sb.rendering.get(attachmentID);
	}

	/** Highlights already quoted in the notes say so, instead of offering to add them again. */
	markQuoted() {
		const text = this.cm?.getText() ?? "";
		for (const card of this.highlights.querySelectorAll(".sb-hl")) {
			const quoted = text.includes(`annotation=${card.dataset.key}`);
			card.classList.toggle("is-quoted", quoted);
			const button = card.querySelector(".sb-hl-quote");
			if (button) button.textContent = quoted ? "In notes ✓" : "Add to notes";
		}
	}

	renderZoteroNotes() {
		const box = this.zoteroNotes;
		box.replaceChildren();
		const notes = this.item.getNotes().map((id) => Zotero.Items.get(id)).filter((n) => n && !n.deleted);
		if (!notes.length) return;
		this.sectionHead(box, "Notes in Zotero", notes.length);
		for (const note of notes) {
			const block = this.el("div", "sb-md sb-znote");
			block.append(...this.sanitize(note.getNote()));
			box.append(block);
		}
	}

	renderReferences(list) {
		const box = this.refs;
		box.replaceChildren();
		if (!list.length) return;
		this.sectionHead(box, "Cited in these notes", list.length);
		for (const ref of list) {
			const row = this.el("div", ref.key ? "sb-ref" : "sb-ref is-missing");
			row.append(this.el("span", "sb-ref-label", ref.key ? ref.label || ref.citekey : `@${ref.citekey}`),
				this.el("span", "sb-ref-title", ref.key ? ref.title : "not in your library"));
			if (ref.key) row.addEventListener("click", () => this.sb.open("zotero/" + ref.key));
			box.append(row);
		}
	}

	/** The highlight as a quote at the end of the notes, with a link back to its spot in the PDF. */
	quote(attachment, a) {
		if (!this.loaded || !this.cm || this.cm.getText().includes(`annotation=${a.key}`)) return;
		const link = `zotero://open-pdf/library/items/${attachment.key}?annotation=${a.key}`;
		const page = a.annotationPageLabel ? `p. ${a.annotationPageLabel}` : "PDF";
		const body = a.annotationType === "image" ? `![[zotero-${a.key}.png]]`
			: (a.annotationText || "").replace(/\s+/g, " ").trim();
		const lines = [`> ${body}`, `> — [${page}](${link})`];
		if (a.annotationComment) lines.push("", a.annotationComment.trim());
		const current = this.cm.getText().replace(/\s+$/, "");
		this.applying = true;
		this.cm.setText((current ? current + "\n\n" : "") + lines.join("\n") + "\n");
		this.applying = false;
		this.changed();
		this.flush();
		this.markQuoted();
		// An image selection is drawn by Zotero a moment after it's made; once it exists, have the server copy
		// it into the vault so the note's ![[zotero-KEY.png]] resolves in Obsidian.
		if (a.annotationType === "image") this.copyImageWhenDrawn(a);
	}

	async copyImageWhenDrawn(a) {
		const path = Zotero.Annotations.getCacheImagePath({ libraryID: a.libraryID, key: a.key });
		for (let i = 0; i < 30 && !(await IOUtils.exists(path)); i++) {
			if (i === 5) this.renderImages(a.parentID);
			await Zotero.Promise.delay(1000);
		}
		await this.flush();
		if (this.store.kind === "obsidian") this.sb.post("/paper-note/refresh", { key: this.key }).catch((error) => Zotero.logError(error));
	}

	/** Rebuild HTML (Zotero notes) from an allowlist, so nothing in a note can run inside Zotero. */
	sanitize(html) {
		const TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "b", "i", "code",
			"pre", "blockquote", "a", "span", "br", "hr", "div", "table", "thead", "tbody", "tr", "th", "td", "del", "sup", "sub"]);
		const parsed = new this.doc.defaultView.DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
		const copy = (node) => {
			if (node.nodeType === 3) return [this.doc.createTextNode(node.textContent)];
			if (node.nodeType !== 1) return [];
			const children = [...node.childNodes].flatMap(copy);
			const tag = node.localName;
			if (!TAGS.has(tag)) return children;
			const out = this.doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
			out.append(...children);
			if (tag === "a") {
				const href = node.getAttribute("href") ?? "";
				if (/^(https?|zotero|obsidian):/i.test(href)) {
					out.title = href;
					out.addEventListener("click", (event) => { event.preventDefault(); this.sb.openURL(href); });
				}
			}
			return [out];
		};
		return [...parsed.body.childNodes].flatMap(copy);
	}

	// ------------------------------------------------------------------ finding papers

	citekey(item) {
		return item?.isRegularItem() ? (item.getField("citationKey") || item.key) : null;
	}

	paperInfo(item) {
		return { citekey: this.citekey(item), title: item.getField("title"), label: this.sb.shortLabel(item) };
	}

	/** Papers matching a query, best first: citekey starts with it, then first author, then the rest. */
	async findPapers(query, limit = 8) {
		const run = async (condition) => {
			try {
				const search = new Zotero.Search();
				search.libraryID = Zotero.Libraries.userLibraryID;
				search.addCondition(condition, "contains", query);
				search.addCondition("itemType", "isNot", "attachment");
				search.addCondition("itemType", "isNot", "note");
				return await search.search();
			} catch (error) {
				return [];
			}
		};
		// Conditions are ANDed, so citekey and title/creator/year are two searches.
		const [byCitekey, byText] = await Promise.all([run("citationKey"), run("quicksearch-titleCreatorYear")]);
		const lower = query.toLowerCase();
		const items = Zotero.Items.get([...new Set([...byCitekey, ...byText])].slice(0, 300))
			.filter((item) => item.isRegularItem() && !item.deleted);
		const rank = (item) => this.citekey(item).toLowerCase().startsWith(lower) ? 0
			: (item.getField("firstCreator") || "").toLowerCase().startsWith(lower) ? 1 : 2;
		return items.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
	}

	paperRow(item, onPick) {
		const row = this.el("div", "sb-pick");
		const main = this.el("div", "sb-pick-main");
		main.append(this.el("div", "sb-pick-title", item.getField("title")),
			this.el("div", "sb-pick-meta", this.sb.shortLabel(item)));
		row.append(main, this.el("span", "sb-pick-key", this.citekey(item)));
		row.addEventListener("mousedown", (event) => { event.preventDefault(); onPick(); });
		return row;
	}

	markActive(list, n) {
		[...list.children].forEach((row, i) => row.classList.toggle("is-active", i === n));
		list.children[n]?.scrollIntoView({ block: "nearest" });
	}

	// ------------------------------------------------------------------ Cite button

	openCite() {
		this.cite.hidden = false;
		this.citeInput.value = "";
		this.citeList.replaceChildren(this.el("div", "sb-pick-hint", "Type to search your library"));
		this.citeItems = [];
		this.citeInput.focus();
	}

	async searchCite() {
		const query = this.citeInput.value.trim();
		if (query.length < 2) {
			this.citeItems = [];
			return this.citeList.replaceChildren(this.el("div", "sb-pick-hint", "Type to search your library"));
		}
		const mine = (this.citeQuery = query);
		const items = await this.findPapers(query, 7);
		if (mine !== this.citeQuery) return;
		this.citeItems = items;
		this.citeActive = 0;
		this.citeList.replaceChildren(...(items.length
			? items.map((item) => this.paperRow(item, () => this.pickCite(item)))
			: [this.el("div", "sb-pick-hint", "No papers match")]));
		this.markActive(this.citeList, 0);
	}

	pickCite(item) {
		this.cite.hidden = true;
		this.cm?.cite(this.citekey(item));
	}

	citeKeydown(event) {
		const n = this.citeItems?.length ?? 0;
		if (event.key === "ArrowDown" && n) { event.preventDefault(); this.citeActive = Math.min(n - 1, this.citeActive + 1); this.markActive(this.citeList, this.citeActive); }
		else if (event.key === "ArrowUp" && n) { event.preventDefault(); this.citeActive = Math.max(0, this.citeActive - 1); this.markActive(this.citeList, this.citeActive); }
		else if (event.key === "Enter" && n) { event.preventDefault(); this.pickCite(this.citeItems[this.citeActive]); }
		else if (event.key === "Escape") { event.preventDefault(); this.cite.hidden = true; this.cm?.focus(); }
	}
};
