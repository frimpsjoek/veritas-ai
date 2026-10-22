import { Notice } from "obsidian";
import type { Api } from "./api";
import { isIdle } from "./updater-core";
import type { UpdaterHost, UpdaterLatest } from "./updater";

// src/updater-host.ts. The real UpdaterHost, wired to a running Obsidian plugin instance. Kept separate from
// updater.ts's pure PluginUpdater logic (which has no `obsidian` import and is unit tested directly with
// `node --experimental-strip-types`) because `obsidian` has no runtime outside the app itself.

const INSTALLED_KEY = "second-brain-updater-installed";

export function createObsidianUpdaterHost(plugin: {
	app: any;
	manifest: { id: string; version: string };
	api: Api;
}): UpdaterHost {
	const { app, manifest, api } = plugin;
	const pluginDir = `${app.vault.configDir}/plugins/${manifest.id}`;
	return {
		currentVersion: manifest.version,
		pluginId: manifest.id,
		fetchLatest: () => api.call<UpdaterLatest>("/plugins/obsidian/latest"),
		async fetchFile(version, name) {
			// requestUrl (via Api) returns text/json; a raw arraybuffer is fetched here directly since these
			// files must be verified byte-for-byte before anything touches disk.
			return await api.rawBinary(`/plugins/obsidian/file?version=${encodeURIComponent(version)}&name=${encodeURIComponent(name)}`);
		},
		async writeFile(name, data) {
			await app.vault.adapter.writeBinary(`${pluginDir}/${name}`, data);
		},
		isIdle() {
			const chatView = app.workspace.getLeavesOfType("second-brain-chat")[0]?.view;
			const chatRunning = !!chatView?.isRunning?.();
			const active = app.workspace.activeDocument?.activeElement ?? document.activeElement;
			const fieldFocused = !!active?.closest?.('[contenteditable], .cm-editor, textarea, input[type="text"]');
			return isIdle({ chatRunning, fieldFocused });
		},
		async reload() {
			// Obsidian's own plugin reload re-reads manifests between disable and enable; without it the plugin
			// comes back reporting the version it started with.
			await app.plugins.disablePlugin(manifest.id);
			await app.plugins.loadManifests();
			await app.plugins.enablePlugin(manifest.id);
		},
		lastInstalled() {
			const value = app.loadLocalStorage(INSTALLED_KEY);
			return typeof value?.version === "string" && typeof value?.at === "number" ? value : null;
		},
		rememberInstalled(version) {
			app.saveLocalStorage(INSTALLED_KEY, { version, at: Date.now() });
		},
		notify(message) { new Notice(message); },
		log(message) { console.warn(`[second-brain-updater] ${message}`); },
	};
}
