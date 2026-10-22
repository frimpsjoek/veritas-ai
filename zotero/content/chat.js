/* global Zotero, SecondBrain, SecondBrainUI */
// The "Second Brain AI" tab: the full-tab shell around the shared chat (ui-src/src/chat/chat.js, spec 005 C1).
// SecondBrainUI.ChatView owns the chat's state and DOM and knows nothing about tabs or panes; this file only
// makes the tab, a UiHost for it (content/ui-host-zotero.js), and the toolbar button that opens the docked
// sidebar (content/chat-sidebar.js).

// Backward-compat aliases: the Zotero harness tests (agent-src/dev/zotero-harness/tests/*.js, required to pass
// unmodified) still reach these through Zotero.SecondBrain (`SB` in the harness), e.g. SB.ChatView.ICONS,
// `new SB.FindView(...)`, SB.FindView.remove(id).
SecondBrain.ChatView = SecondBrainUI.ChatView;
SecondBrain.FindView = SecondBrainUI.FindView;
SecondBrain.ReportView = SecondBrainUI.ReportView;

/** The full-tab host: "Second Brain AI" in Zotero_Tabs. All state and DOM belong to ChatView; this owns the tab. */
SecondBrain.ChatTab = class {
	static TYPE = "second-brain-ai";

	/** Opens the tab (or brings it forward), shows `conversation` if given, and adds `attach` (Zotero items) to the
	 *  message being written. `start` ("papers" | "extract" | "report") begins a new session from `items`. Returns the view. */
	static open(sb, { attach = [], mode = null, conversation = null, start = null, items = [] } = {}) {
		const win = Zotero.getMainWindow();
		const tabs = win.Zotero_Tabs;
		// read before the chat tab comes forward: Zotero reports no selection while another tab is showing
		const selected = SecondBrain.ChatTab.librarySelection();
		let host = sb.chatTab;
		if (host && tabs._getTab(host.tabID)?.tab) tabs.select(host.tabID);
		else host = sb.chatTab = new SecondBrain.ChatTab(sb, win);
		const view = host.view;
		if (mode && (mode !== view.mode || view.conversationID || view.reviewID || view.findID)) view.setMode(mode);
		if (conversation) view.openHistoryItem(conversation);
		host.setSelected(selected);
		view.attach(attach.filter((item) => item?.isRegularItem?.())
			.map((item) => ({ attachment: { kind: "zoteroItem", citekey: item.getField("citationKey") || item.key }, label: sb.shortLabel(item) || item.getField("title") })));
		view.renderSuggestions();
		view.input.focus();
		// New from selection (spec 011 U5): the menu's items, else what was selected when the tab opened
		if (start) {
			const picked = items.filter((item) => item?.isRegularItem?.());
			const list = picked.length ? picked.map((item) => ({ attachment: { kind: "zoteroItem", citekey: item.getField("citationKey") || item.key }, label: sb.shortLabel(item) || item.getField("title") })) : view.selected;
			view.startFromSelection(start, list).catch((error) => Zotero.logError(error));
		}
		return view;
	}

	/** The papers selected in the library. The items view keeps its selection while another tab is showing, though
	 *  the pane itself reports none then. */
	static librarySelection() {
		const pane = Zotero.getActiveZoteroPane();
		const items = pane?.itemsView?.getSelectedItems?.() ?? pane?.getSelectedItems() ?? [];
		return items.filter((item) => item?.isRegularItem?.());
	}

	constructor(sb, win) {
		this.sb = sb;
		const { id, container } = win.Zotero_Tabs.add({
			type: SecondBrain.ChatTab.TYPE, title: "Second Brain AI", data: {}, select: true,
			onClose: () => this.close(),
		});
		this.tabID = id;
		const host = SecondBrain.createZoteroHost(sb, win, { placement: "tab", historyPref: "chatHistoryCollapsed", historyDefault: false });
		SecondBrain.addUiStyles(win.document, sb.rootURI);
		this.view = new SecondBrainUI.ChatView(host, win.document);
		this.view.tabID = id;
		container.append(this.view.root);
		// The tab stays open while the selection in the library changes, so coming back to it re-reads the selection.
		this.notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids) => {
				if (type === "tab" && event === "select" && ids[0] === this.tabID) win.setTimeout(() => this.setSelected(SecondBrain.ChatTab.librarySelection()), 0);
			},
		}, ["tab"], "second-brain-chat-tab");
	}

	/** The library selection the empty chat names in its suggestions. */
	setSelected(items) {
		this.view.selected = items.map((item) => ({ attachment: { kind: "zoteroItem", citekey: item.getField("citationKey") || item.key }, label: this.sb.shortLabel(item) || item.getField("title") }));
		this.view.renderSuggestions();
	}

	close() {
		Zotero.Notifier.unregisterObserver(this.notifierID);
		this.view.destroy();
		if (this.sb.chatTab === this) this.sb.chatTab = null;
	}

	/** A toolbar button next to the search field that opens the docked chat. */
	static addToolbarButton(sb, window) {
		const doc = window.document;
		if (doc.getElementById("second-brain-tb-ai")) return;
		const anchor = doc.getElementById("second-brain-tb-search") ?? doc.getElementById("zotero-tb-search");
		if (!anchor) return;
		const button = doc.createXULElement("toolbarbutton");
		button.id = "second-brain-tb-ai";
		button.className = "zotero-tb-button";
		button.setAttribute("tooltiptext", "Second Brain AI: chat beside the paper you're reading");
		button.setAttribute("image", sb.rootURI + "content/chat20.svg");
		button.style.cssText = "-moz-context-properties: fill; fill: var(--fill-secondary);"; // the icon draws in the toolbar's own grey
		button.addEventListener("command", () => SecondBrain.ChatSidebar.toggle(sb, window));
		anchor.after(button);
	}
};
