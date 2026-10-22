import { ItemView, WorkspaceLeaf } from "obsidian";
import type SecondBrainSearch from "./main";
// @ts-ignore -- ui-src is plain JS; see chat.ts for the same import.
import { HomeView as SharedHomeView } from "../../ui/src/index.js";
import HOME_CSS from "sb-home-css";
import { createObsidianHost } from "./ui-host";

// Second Brain Home (spec 014 G4): ui-src's HomeView, today's reading radar issue and the shelves, as an ItemView.
// What Home opens comes back here: a chat or radar issue opens in the chat view, Routines there too, a paper's page
// in the browser. Sources opens inside Home itself.

export const HOME_VIEW = "second-brain-home";
const STYLE_ID = "second-brain-home-style";

type HomeTarget = { to: "session"; id: string } | { to: "routines" } | { to: "url"; url: string };

export class HomeView extends ItemView {
	private home: { root: HTMLElement; refresh(): Promise<void> } | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: SecondBrainSearch) { super(leaf); }

	getViewType() { return HOME_VIEW; }
	getDisplayText() { return "Second Brain Home"; }
	getIcon() { return "home"; }

	async onOpen() {
		const doc = this.contentEl.ownerDocument;
		// Obsidian serves a plugin's main.js and styles.css only, and a url() in styles.css resolves against the app,
		// not the plugin folder. So Home's sheet travels in main.js with its fonts and photos inlined (esbuild.config.mjs),
		// and goes into this window's document when Home first opens there.
		if (!doc.getElementById(STYLE_ID)) {
			const style = doc.createElement("style");
			style.id = STYLE_ID;
			style.textContent = HOME_CSS;
			doc.head.append(style);
			this.plugin.register(() => style.remove());
		}
		this.contentEl.empty();
		this.contentEl.addClass("sb-home-root");
		this.home = SharedHomeView(doc, createObsidianHost(this.plugin), { open: (target: HomeTarget) => this.openTarget(target) });
		this.contentEl.append(this.home.root);
		// Coming back to Home shows what the radar and the chats added meanwhile.
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
			if (leaf === this.leaf) void this.home?.refresh();
		}));
	}

	async onClose() {
		this.home = null;
	}

	private openTarget(target: HomeTarget) {
		if (target.to === "url") this.plugin.webLinks.open(target.url);
		else if (target.to === "routines") void this.plugin.openChat("routines");
		else void this.plugin.openChat().then((chat) => chat.openSession(target.id));
	}
}
