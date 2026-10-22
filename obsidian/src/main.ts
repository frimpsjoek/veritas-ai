import { App, MarkdownView, Modal, Notice, Platform, Plugin, Setting, TFile, TFolder } from "obsidian";
import { createAgentService } from "./agent-api";
import { Api, DEFAULTS, Settings } from "./api";
import { ChatView, CHAT_VIEW } from "./chat";
import { HomeView, HOME_VIEW } from "./home";
import { copyFolderContext, copyNoteContext } from "./context";
import { DuplicatesView, DUPLICATES_VIEW } from "./duplicates";
import { Links } from "./links";
import { WebLinks } from "./web-links";
import { RelatedView, RELATED_VIEW } from "./related";
import { SearchView, SEARCH_VIEW } from "./search";
import { duration, Status, StatusView, STATUS_VIEW } from "./status";
import { openZotero, ZoteroView, ZOTERO_VIEW } from "./zotero";
import { PluginUpdater } from "./updater";
import { createObsidianUpdaterHost } from "./updater-host";
import { SettingsTab, SETUP_ACTION } from "./settings-tab";
import { listedUrl } from "./listed-paths";

// Search, related notes, duplicates and "copy for AI" over the vault and Zotero library, served by ~/obsidian-kb
// (kb.py serve): the same index the agents use. On the phone it reaches the Mac over Tailscale.

export default class SecondBrainSearch extends Plugin {
	settings!: Settings;
	api!: Api;
	links!: Links;
	webLinks!: WebLinks;
	agent!: ReturnType<typeof createAgentService>;
	updater!: PluginUpdater;

	async onload() {
		this.settings = { ...DEFAULTS, ...(await this.loadData()) };
		this.api = new Api(() => this.settings);
		this.agent = createAgentService(this.api);
		this.updater = new PluginUpdater(createObsidianUpdaterHost(this), () => this.settings.updates === "server");
		// the same store host.prefs reads, so spec 016's Settings row (host.prefs.set('openLinks', ...)) is seen here
		this.webLinks = new WebLinks(this.app, {
			get: (key) => this.settings.ui?.[key],
			set: (key, value) => { this.settings.ui = { ...this.settings.ui, [key]: value }; void this.saveSettings(); },
		});
		this.links = new Links(this.app, (ref, newTab) => openZotero(this, ref, newTab), (ref) => this.registerEvent(ref),
			(path) => this.webLinks.open(listedUrl(this.api.serverBase(), path)));

		this.registerView(SEARCH_VIEW, (leaf) => new SearchView(leaf, this));
		this.registerView(RELATED_VIEW, (leaf) => new RelatedView(leaf, this));
		this.registerView(DUPLICATES_VIEW, (leaf) => new DuplicatesView(leaf, this));
		this.registerView(ZOTERO_VIEW, (leaf) => new ZoteroView(leaf, this));
		this.registerView(STATUS_VIEW, (leaf) => new StatusView(leaf, this));
		this.registerView(CHAT_VIEW, (leaf) => new ChatView(leaf, this));
		this.registerView(HOME_VIEW, (leaf) => new HomeView(leaf, this));
		this.registerHoverLinkSource(SEARCH_VIEW, { display: "Vault search", defaultMod: true });
		this.registerHoverLinkSource(RELATED_VIEW, { display: "Related notes", defaultMod: true });

		this.addRibbonIcon("search-code", "Search vault by meaning", () => this.openSearch());
		this.addRibbonIcon("bot", "Second Brain AI", () => this.openChat());
		this.addRibbonIcon("home", "Second Brain Home", () => this.openHome());
		this.addCommand({ id: "open-search", name: "Search vault", callback: () => this.openSearch() });
		this.addCommand({ id: "open-related", name: "Show related notes", callback: () => this.openRelated() });
		this.addCommand({ id: "open-duplicates", name: "Find duplicate notes", callback: () => this.openDuplicates() });
		this.addCommand({ id: "open-status", name: "Show search index status", callback: () => this.openStatus() });
		this.addCommand({ id: "open-chat", name: "Open Second Brain AI", callback: () => this.openChat() });
		this.addCommand({ id: "open-home", name: "Open Second Brain Home", callback: () => this.openHome() });
		// The old separate Literature Review view is gone (spec 002): a report is now one mode of the same chat.
		this.addCommand({ id: "open-report", name: "Open research report", callback: () => this.openChat("report") });
		this.addCommand({
			id: "search-selection",
			name: "Search vault for selected text",
			editorCallback: (editor) => {
				const text = editor.getSelection().trim();
				if (text) this.openSearch(text);
			},
		});
		this.addCommand({
			id: "ask-about-selection",
			name: "Ask about selection",
			editorCallback: async (editor) => {
				const text = editor.getSelection().trim();
				if (!text) { new Notice("Select some text first."); return; }
				const view = await this.openChat();
				await view.askAboutSelection(text);
			},
		});
		this.addCommand({
			id: "copy-context",
			name: "Copy note and linked notes for AI",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
				if (!file) return false;
				if (!checking) copyNoteContext(this.app, this.api, file, this.settings.contextDepth, this.settings.contextSimilar);
				return true;
			},
		});
		this.addCommand({
			id: "reindex",
			name: "Update search index now",
			callback: async () => {
				try {
					await this.api.call("/index", "POST");
					new Notice("Updating the search index. New notes appear in a minute or two.");
				} catch (error) {
					new Notice(`Couldn't reach the index: ${(error as Error).message}`);
				}
			},
		});
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			menu.addItem((item) => item.setTitle("Copy for AI").setIcon("clipboard-copy").onClick(() => {
				if (file instanceof TFolder) copyFolderContext(this.app, file);
				else if (file instanceof TFile) copyNoteContext(this.app, this.api, file, this.settings.contextDepth, this.settings.contextSimilar);
			}));
		}));

		// obsidian://second-brain-search-setup?url=…&token=… (from the QR code in the Mac's settings) sets up the phone.
		// Any link can carry a url, so confirm the host before pointing the bearer token at it.
		this.registerObsidianProtocolHandler(SETUP_ACTION, async (params) => {
			if (!params.url || !/^https?:\/\//i.test(params.url)) return;
			new ConnectModal(this.app, params.url, async () => {
				this.settings.remoteUrl = params.url;
				if (params.token) this.settings.token = params.token;
				await this.saveSettings();
				new Notice((await this.api.up()) ? "Vault search is connected to your Mac." : `Saved. ${this.api.unreachableMessage()}`);
			}).open();
		});

		this.addSettingTab(new SettingsTab(this.app, this));
		if (Platform.isDesktop) this.watchIndexing();
		this.app.workspace.onLayoutReady(async () => {
			// Not awaited: starting the server can take seconds, and the sidebars should not wait for it.
			if (Platform.isDesktopApp) void this.api.ensure();
			// The search lives in the left sidebar as a tab next to Files and Search, always there.
			if (!this.app.workspace.getLeavesOfType(SEARCH_VIEW).length) {
				await this.app.workspace.getLeftLeaf(false)?.setViewState({ type: SEARCH_VIEW, active: false });
			}
			if (!this.app.workspace.getLeavesOfType(RELATED_VIEW).length) {
				await this.app.workspace.getRightLeaf(false)?.setViewState({ type: RELATED_VIEW, active: false });
			}
			// Docked in the right sidebar by default (spec 004), next to Related notes, so it's always reachable
			// without opening a tab.
			if (!this.app.workspace.getLeavesOfType(CHAT_VIEW).length) {
				await this.app.workspace.getRightLeaf(false)?.setViewState({ type: CHAT_VIEW, active: false });
			}
			this.updater.start();
		});
	}

	onunload() {
		this.api.stop();
		this.updater.stop();
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async openSearch(query?: string) {
		let leaf = this.app.workspace.getLeavesOfType(SEARCH_VIEW)[0];
		if (!leaf) {
			leaf = this.app.workspace.getLeftLeaf(false)!;
			await leaf.setViewState({ type: SEARCH_VIEW, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		const view = leaf.view as SearchView;
		if (query) view.setQuery(query);
		view.focus();
	}

	async openRelated() {
		let leaf = this.app.workspace.getLeavesOfType(RELATED_VIEW)[0];
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false)!;
			await leaf.setViewState({ type: RELATED_VIEW, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	async openStatus() {
		const leaf = this.app.workspace.getLeavesOfType(STATUS_VIEW)[0] ?? this.app.workspace.getRightLeaf(false)!;
		await leaf.setViewState({ type: STATUS_VIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	/** Status bar (Mac): "Indexing · Reading PDFs and images 45%" while a run is going; hidden when idle. */
	private watchIndexing() {
		const item = this.addStatusBarItem();
		item.addClass("sb-set-statusbar", "mod-clickable");
		item.hide();
		item.addEventListener("click", () => this.openStatus());
		const update = async () => {
			try {
				const s = await this.api.call<Status>("/status");
				const p = s.indexing ?? {};
				if (!s.running) return item.hide();
				const pct = p.total ? ` ${Math.floor(((p.done ?? 0) / p.total) * 100)}%` : "";
				const eta = p.eta_seconds ? ` · ${duration(p.eta_seconds)} left` : "";
				item.setText(`⟳ ${p.label ?? "Indexing"}${pct}${eta}`);
				item.setAttr("aria-label", "Search index: click for details");
				item.show();
			} catch {
				item.hide();
			}
		};
		update();
		this.registerInterval(window.setInterval(update, 10_000));
	}

	/** Opens the chat, docked in the right sidebar by default (spec 004). `mode` also switches it, e.g. from the
	 *  "Open research report" command, which replaces the old separate Literature Review view. */
	async openChat(mode?: "chat" | "ask" | "find" | "report" | "routines"): Promise<ChatView> {
		let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW)[0];
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false)!;
			await leaf.setViewState({ type: CHAT_VIEW, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		const view = leaf.view as ChatView;
		if (mode) view.openMode(mode);
		return view;
	}

	/** Home opens as a tab in the main area, like a note; a second call brings the same one forward. */
	async openHome() {
		const leaf = this.app.workspace.getLeavesOfType(HOME_VIEW)[0] ?? this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: HOME_VIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	async openDuplicates() {
		const leaf = this.app.workspace.getLeavesOfType(DUPLICATES_VIEW)[0] ?? this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: DUPLICATES_VIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}
}

/** Confirms the host before a setup link is allowed to replace the Mac address and access token. */
class ConnectModal extends Modal {
	constructor(app: App, private url: string, private onConfirm: () => Promise<void>) { super(app); }

	onOpen() {
		const host = (() => { try { return new URL(this.url).host; } catch { return this.url; } })();
		this.titleEl.setText(`Connect Second Brain Search to ${host}?`);
		this.contentEl.createEl("p", { text: "This replaces the Mac address (and access token) vault search uses." });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Connect").setCta().onClick(async () => {
				this.close();
				await this.onConfirm();
			}));
	}
}
