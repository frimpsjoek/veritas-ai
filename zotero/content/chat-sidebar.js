/* global Zotero, SecondBrain */
// The sidebar host: the same ChatView docked full-height on the right, next to the library list or next to the
// reader, opened from a button on the right-hand icon strip (and from the toolbar AI button). One ChatView per
// main window; when the user switches between the library and a reader tab, its node moves to the dock that is
// on screen, so the conversation carries over.
//
// Each dock is our own element, placed beside Zotero's pane content (the item pane's deck in the library, the
// context pane's vbox in the reader) rather than inside it: Zotero re-renders and scrolls its item sections on
// every selection, and a chat living among them lost its height and scroll position. While open, the dock sits
// along the bottom of the pane and Zotero's content keeps the space above it, so the paper's info and notes stay
// in view; a handle on the dock's top edge sets the split (a share of the pane's height, remembered).
SecondBrain.ChatSidebar = class {
	/** The pane, the content it covers while open, and the icon strip, for the library and for the reader. */
	static PLACES = {
		library: { pane: "zotero-item-pane", content: "#zotero-item-pane-content", sidenav: "zotero-view-item-sidenav" },
		reader: { pane: "zotero-context-pane", content: ":scope > vbox", sidenav: "zotero-context-pane-sidenav" },
	};

	static addToWindow(sb, win) {
		sb.chatSidebars ??= new Map();
		if (!sb.chatSidebars.has(win)) sb.chatSidebars.set(win, new SecondBrain.ChatSidebar(sb, win));
	}

	static removeFromWindow(sb, win) {
		sb.chatSidebars?.get(win)?.destroy();
		sb.chatSidebars?.delete(win);
	}

	static toggle(sb, win) {
		sb.chatSidebars?.get(win)?.toggle();
	}

	constructor(sb, win) {
		this.sb = sb;
		this.win = win;
		this.doc = win.document;
		this.isOpen = Zotero.Prefs.get("extensions.secondbrain.sidebarChatOpen", true) ?? false;
		this.share = Number(Zotero.Prefs.get("extensions.secondbrain.sidebarChatShare", true)) || 0.55;
		SecondBrain.ChatSidebar.style(this.doc);
		const host = SecondBrain.createZoteroHost(sb, win, {
			placement: "sidebar",
			historyPref: "sidebarHistoryCollapsed",
			historyDefault: true,
			paperContext: () => this.paperContext(),
			reading: () => this.where === "reader",
			autoContext: true,
			isOpen: () => this.isOpen,
			openInTab: () => this.openInTab(),
		});
		SecondBrain.addUiStyles(this.doc, sb.rootURI);
		this.view = new SecondBrainUI.ChatView(host, this.doc);
		this.docks = {};
		this.buttons = [];
		for (const [where, place] of Object.entries(SecondBrain.ChatSidebar.PLACES)) {
			const pane = this.doc.getElementById(place.pane);
			if (!pane) continue;
			const dock = this.sb.el(this.doc, "div", "sb-chat-dock");
			dock.id = `second-brain-chat-dock-${where}`;
			dock.append(this.resizeHandle(pane));
			const sidenav = this.doc.getElementById(place.sidenav);
			pane.insertBefore(dock, sidenav?.parentNode === pane ? sidenav : null);
			this.docks[where] = dock;
			if (sidenav) this.addButton(sidenav);
		}
		this.notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type) => { if (type === "tab" && event === "select") this.win.setTimeout(() => this.place(), 0); },
		}, ["tab"], "second-brain-chat-sidebar");
		this.resizer = new this.win.ResizeObserver(() => this.layout());
		for (const place of Object.values(SecondBrain.ChatSidebar.PLACES)) {
			const pane = this.doc.getElementById(place.pane);
			if (pane) this.resizer.observe(pane);
		}
		this.place();
	}

	/** Dragging the dock's top edge moves the split between Zotero's content and the chat. */
	resizeHandle(pane) {
		const handle = this.sb.el(this.doc, "div", "sb-chat-resize");
		handle.title = "Drag to resize the chat";
		handle.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			handle.setPointerCapture(event.pointerId);
			const move = (e) => {
				const box = pane.getBoundingClientRect();
				this.share = Math.min(0.9, Math.max(0.2, (box.bottom - e.clientY) / box.height));
				this.layout();
			};
			const up = () => {
				handle.removeEventListener("pointermove", move);
				Zotero.Prefs.set("extensions.secondbrain.sidebarChatShare", String(this.share), true);
			};
			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", up, { once: true });
		});
		return handle;
	}

	/** The dock's height (a share of the pane, never so small the composer doesn't fit) and its width (the pane
	 *  less the icon strip), written as custom properties the stylesheet uses. */
	layout() {
		for (const [where, place] of Object.entries(SecondBrain.ChatSidebar.PLACES)) {
			const pane = this.doc.getElementById(place.pane);
			if (!pane?.classList.contains("sb-chat-open")) continue;
			const height = Math.round(Math.max(220, Math.min(pane.clientHeight - 80, pane.clientHeight * this.share)));
			pane.style.setProperty("--sb-chat-h", `${height}px`);
			const sidenav = this.doc.getElementById(place.sidenav);
			pane.style.setProperty("--sb-chat-nav-w", `${sidenav && !sidenav.hidden ? sidenav.getBoundingClientRect().width : 0}px`);
			this.docks[where]?.classList.toggle("is-short", height < 320);
		}
	}

	/** A toggle at the bottom of the icon strip, styled like Zotero's own sidenav buttons. */
	addButton(sidenav) {
		const wrapper = this.sb.el(this.doc, "div", "pin-wrapper sb-chat-nav");
		const button = this.doc.createXULElement("toolbarbutton");
		button.className = "btn";
		button.setAttribute("tooltiptext", "Second Brain AI: chat with your library");
		button.setAttribute("image", this.sb.rootURI + "content/chat20.svg");
		button.addEventListener("command", () => this.toggle());
		wrapper.append(button);
		sidenav.append(this.sb.el(this.doc, "div", "divider sb-chat-nav"), wrapper);
		this.buttons.push(button);
	}

	/** The paper open in the current reader tab, or else whatever's selected in the library. */
	paperContext() {
		const tabs = this.win.Zotero_Tabs;
		if (tabs?.selectedType === "reader") {
			const reader = Zotero.Reader.getByTabID(tabs.selectedID);
			const item = reader && Zotero.Items.get(reader.itemID);
			const paper = item?.parentItem ?? item;
			if (paper?.isRegularItem()) return [paper];
		}
		return Zotero.getActiveZoteroPane()?.getSelectedItems()?.filter((i) => i.isRegularItem()) ?? [];
	}

	get where() {
		return this.win.Zotero_Tabs?.selectedType === "reader" ? "reader" : "library";
	}

	toggle() {
		this.isOpen = !this.isOpen;
		Zotero.Prefs.set("extensions.secondbrain.sidebarChatOpen", this.isOpen, true);
		if (this.isOpen && this.where === "reader" && this.win.ZoteroContextPane?.collapsed) this.win.ZoteroContextPane.collapsed = false;
		this.place();
		if (this.isOpen) this.view.input.focus();
	}

	/** Puts the view in the dock that's on screen and shows or hides the docks to match `isOpen`. */
	place() {
		const where = this.where;
		const dock = this.docks[where] ?? this.docks.library;
		if (this.isOpen && dock && this.view.root.parentNode !== dock) dock.append(this.view.root);
		for (const [name, place] of Object.entries(SecondBrain.ChatSidebar.PLACES)) {
			this.doc.getElementById(place.pane)?.classList.toggle("sb-chat-open", this.isOpen && this.docks[name] === dock);
		}
		for (const button of this.buttons) button.toggleAttribute("checked", this.isOpen);
		this.layout();
		this.view.refreshContext();
	}

	openInTab() {
		const item = this.view.handoff();
		SecondBrain.ChatTab.open(this.sb, { mode: item ? null : this.view.mode, conversation: item });
	}

	destroy() {
		if (this.notifierID) Zotero.Notifier.unregisterObserver(this.notifierID);
		this.resizer?.disconnect();
		this.view.destroy();
		for (const place of Object.values(SecondBrain.ChatSidebar.PLACES)) {
			const pane = this.doc.getElementById(place.pane);
			pane?.classList.remove("sb-chat-open");
			pane?.style.removeProperty("--sb-chat-h");
			pane?.style.removeProperty("--sb-chat-nav-w");
		}
		for (const node of this.doc.querySelectorAll(".sb-chat-dock, .sb-chat-nav")) node.remove();
		this.doc.getElementById("second-brain-chat-sidebar-style")?.remove();
	}

	static style(doc) {
		if (doc.getElementById("second-brain-chat-sidebar-style")) return;
		const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
		style.id = "second-brain-chat-sidebar-style";
		const panes = Object.values(SecondBrain.ChatSidebar.PLACES).map((p) => `#${p.pane}.sb-chat-open`);
		const content = Object.values(SecondBrain.ChatSidebar.PLACES).map((p) => `#${p.pane}.sb-chat-open > ${p.content.replace(":scope > ", "")}`).join(", ");
		style.textContent = `
			.sb-chat-dock { display: none; }
			${panes.join(", ")} { position: relative; }
			${content} { margin-bottom: var(--sb-chat-h) !important; }
			${panes.map((p) => `${p} > .sb-chat-dock`).join(", ")} {
				display: flex; flex-direction: column; position: absolute; inset-inline-start: 0; inset-inline-end: var(--sb-chat-nav-w, 0px);
				bottom: 0; height: var(--sb-chat-h); z-index: 2; border-top: 1px solid var(--fill-quinary); background: var(--material-background); }
			.sb-chat-resize { flex: none; height: 5px; margin-top: -3px; cursor: row-resize; }
			.sb-chat-resize:hover { background: var(--color-accent); opacity: .5; }
			.sb-chat-dock > .sb-ai { flex: 1; min-height: 0; }
			.sb-chat-dock.is-short .sb-ai-empty { margin-top: 12px; }
		`;
		doc.documentElement.append(style);
	}
};
