/* global Zotero, SecondBrain, SecondBrainUI */
// The "Second Brain Home" tab (spec 014 G4): ui-src's HomeView (today's reading radar issue and the shelves) in
// Zotero_Tabs. Home hands back what it opens: a chat or a radar issue opens in the "Second Brain AI" tab, Routines
// there too, a paper's page in the browser. Sources opens inside Home itself.

/** Home's sheet (content/home/sb-home.css, built by ui-src/build.mjs with its fonts and photos beside it), once per document. */
SecondBrain.addHomeStyles = function addHomeStyles(doc, rootURI) {
	if (doc.getElementById("second-brain-home-style")) return;
	const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
	link.id = "second-brain-home-style";
	link.rel = "stylesheet";
	link.href = rootURI + "content/home/sb-home.css";
	doc.documentElement.append(link);
};

SecondBrain.HomeTab = class {
	static TYPE = "second-brain-home";

	/** Opens the tab, or brings it forward (which repaints it). */
	static open(sb) {
		const tabs = Zotero.getMainWindow().Zotero_Tabs;
		if (sb.homeTab && tabs._getTab(sb.homeTab.tabID)?.tab) tabs.select(sb.homeTab.tabID);
		else sb.homeTab = new SecondBrain.HomeTab(sb, Zotero.getMainWindow());
		return sb.homeTab;
	}

	constructor(sb, win) {
		this.sb = sb;
		const { id, container } = win.Zotero_Tabs.add({
			type: SecondBrain.HomeTab.TYPE, title: "Second Brain Home", data: {}, select: true,
			onClose: () => this.close(),
		});
		this.tabID = id;
		const host = SecondBrain.createZoteroHost(sb, win, { placement: "tab" });
		SecondBrain.addUiStyles(win.document, sb.rootURI);
		SecondBrain.addHomeStyles(win.document, sb.rootURI);
		this.view = SecondBrainUI.HomeView(win.document, host, { open: (target) => this.open(target) });
		container.append(this.view.root);
		// Coming back to the tab shows what the radar and the chats added meanwhile.
		this.notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids) => {
				if (type === "tab" && event === "select" && ids[0] === this.tabID) this.view.refresh().catch((error) => Zotero.logError(error));
			},
		}, ["tab"], "second-brain-home-tab");
	}

	/** What Home hands the host: a session (a chat, report or radar issue), Routines, or a web page. */
	open(target) {
		if (target.to === "url") this.sb.openURL(target.url);
		else if (target.to === "routines") SecondBrain.ChatTab.open(this.sb, { mode: "routines" });
		else if (target.to === "session") this.openSession(target.id).catch((error) => Zotero.logError(error));
	}

	/** As the web app does: a saved Find papers search opens as its table, anything else as its thread. */
	async openSession(id) {
		const view = SecondBrain.ChatTab.open(this.sb);
		await view.refreshList();
		const known = view.recent.find((c) => c.id === id);
		await (known ? view.openSession(known) : view.openConversation(id));
	}

	close() {
		Zotero.Notifier.unregisterObserver(this.notifierID);
		if (this.sb.homeTab === this) this.sb.homeTab = null;
	}

	/** A toolbar button beside the AI one that opens Home. */
	static addToolbarButton(sb, window) {
		const doc = window.document;
		if (doc.getElementById("second-brain-tb-home")) return;
		const anchor = doc.getElementById("second-brain-tb-ai");
		if (!anchor) return;
		const button = doc.createXULElement("toolbarbutton");
		button.id = "second-brain-tb-home";
		button.className = "zotero-tb-button";
		button.setAttribute("tooltiptext", "Second Brain Home: today's reading radar and your chats");
		button.setAttribute("image", sb.rootURI + "content/home20.svg");
		button.style.cssText = "-moz-context-properties: fill; fill: var(--fill-secondary);";
		button.addEventListener("command", () => SecondBrain.HomeTab.open(sb));
		anchor.after(button);
	}
};
