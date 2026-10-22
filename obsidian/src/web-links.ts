import { App, Notice, WorkspaceLeaf } from "obsidian";
import { openExternal } from "./links";
import { NOTICE_PREF, NOTICE_TEXT, WEB_VIEWER, planLink } from "./web-link-plan";

// Spec 015 B2: a web link opens in Obsidian's own Web viewer (the core plugin, view type "webviewer") in one reused
// tab; with the plugin off, in the system browser, with a one-time notice saying how to turn it on.

export class WebLinks {
	/** The one tab links open in (D2); forgotten when its tab is closed. */
	private leaf: WorkspaceLeaf | null = null;

	constructor(
		private app: App,
		private pref: { get(key: string): unknown; set(key: string, value: unknown): void },
	) {}

	/** Obsidian keeps core plugins in a private registry; `getEnabledPluginById` is what its own empty-tab screen uses. */
	viewerOn(): boolean {
		const registry = (this.app as unknown as { internalPlugins?: { getEnabledPluginById?(id: string): unknown } }).internalPlugins;
		return Boolean(registry?.getEnabledPluginById?.(WEB_VIEWER));
	}

	open(url: string, opts?: { outside?: boolean }) {
		const plan = planLink(url, opts, {
			mode: this.pref.get("openLinks"),
			viewerOn: this.viewerOn(),
			noticed: this.pref.get(NOTICE_PREF) === true,
		});
		if (plan === "viewer") return this.inViewer(url);
		if (plan === "outside-with-notice") {
			this.pref.set(NOTICE_PREF, true);
			new Notice(NOTICE_TEXT, 8000);
		}
		openExternal(url);
	}

	private inViewer(url: string) {
		const open = this.app.workspace.getLeavesOfType(WEB_VIEWER);
		const leaf = this.leaf && open.includes(this.leaf) ? this.leaf : this.app.workspace.getLeaf("tab");
		this.leaf = leaf;
		void leaf.setViewState({ type: WEB_VIEWER, active: true, state: { url, navigate: true } })
			.then(() => this.app.workspace.revealLeaf(leaf));
	}
}
