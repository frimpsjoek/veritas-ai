import { Notice, Platform, PluginSettingTab } from "obsidian";
import type { App } from "obsidian";
import qrcode from "qrcode-generator";
import type SecondBrainSearch from "./main";
import { createObsidianHost } from "./ui-host";
import { ownPrefs, type PrefStore } from "./own-prefs";
import { SettingsView } from "../../zotero-plugin/ui-src/src/settings/settings-view.js";

// The Settings tab is the shared SettingsView (ui-src/src/settings/, spec 016) drawn by every app. This file only
// supplies what the table leaves to Obsidian: where its own rows are stored, the phone QR and the buttons.

export const SETUP_ACTION = "second-brain-search-setup";

export class SettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: SecondBrainSearch) { super(app, plugin); }

	display() {
		const { containerEl, plugin } = this;
		containerEl.empty();
		const base = createObsidianHost(plugin);
		const host = { ...base, prefs: ownPrefs(plugin.settings, base.prefs as PrefStore, () => void plugin.saveSettings()) };
		const mount = containerEl.createDiv();
		SettingsView(host, containerEl.ownerDocument, mount, {
			platform: Platform.isDesktopApp ? "desktop" : "mobile",
			renderers: {
				version: (_row: unknown, ctx: { doc: Document }) => { const el = ctx.doc.createElement("span"); el.textContent = plugin.manifest.version; return el; },
				...(Platform.isDesktopApp ? { phone: (_row: unknown, ctx: { doc: Document }) => phoneSetup(plugin, ctx.doc) } : {}),
			},
			actions: {
				openIndexStatus: async () => { await plugin.openStatus(); },
				checkUpdates: async (_row: unknown, say: (text: string) => void) => { say("Checking…"); return plugin.updater.checkNow(); },
				testConnection: async () => ((await plugin.api.up()) ? "Connected to your Mac." : plugin.api.unreachableMessage()),
			},
		});
	}
}

/** The phone's setup QR and copy-link button; with no token yet, a line and a way to look again once the index has run. */
function phoneSetup(plugin: SecondBrainSearch, doc: Document): HTMLElement {
	const box = doc.createElement("div");
	const paint = () => {
		box.replaceChildren();
		const token = plugin.api.readToken();
		if (!token) {
			box.createEl("p", { cls: "sbs-help", text: "Start the index once to create the phone's access token, then check again." });
			const again = box.createEl("button", { cls: "sb-button", text: "Check again" });
			again.type = "button";
			again.addEventListener("click", paint);
			return;
		}
		const link = `obsidian://${SETUP_ACTION}?${new URLSearchParams({ url: plugin.settings.remoteUrl, token })}`;
		box.createEl("p", { cls: "sbs-help", text: "With Tailscale on, scan this with the iPhone camera. It opens Obsidian and connects it to this Mac. The code contains your access token, so don't share it." });
		const qr = qrcode(0, "M");
		qr.addData(link);
		qr.make();
		box.createDiv({ cls: "sb-set-qr" }).innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
		const copy = box.createEl("button", { cls: "sb-button", text: "Copy link" });
		copy.type = "button";
		copy.addEventListener("click", async () => {
			await navigator.clipboard.writeText(link);
			new Notice("Setup link copied. Open it on the phone.");
		});
	};
	paint();
	return box;
}
