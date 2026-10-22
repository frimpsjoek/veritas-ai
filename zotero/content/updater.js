/* global Zotero, Services, IOUtils, PathUtils, Components, ChromeUtils */
// AddonManager isn't a bootstrap-scope global (unlike Services/Components): import it explicitly, the same way
// Zotero's own bootstrap-scope code and other Firefox bootstrapped extensions do.
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
// content/updater.js. Auto-update from the Second Brain server (spec 006). Loaded into bootstrap.js's scope,
// used by second-brain.js as `this.updater = new this.Updater(this)`.
//
// Three update sources, chosen by extensions.secondbrain.updates:
//   "server" -- this Mac's Second Brain server (127.0.0.1:27182 by default); checked here, every 15 min, and by
//               the "Check for updates" button in Settings.
//   "github" -- the default for public installs: unchanged, Zotero's own update_url mechanism handles it.
//   "off"    -- neither.
// Never written by this file except through the settings UI (SecondBrainPrefs), so a public install's real
// prefs.js is never touched by code -- only by the person using the settings pane.

SecondBrain.Updater = class {
	static ADDON_ID = "second-brain@frimpsjoe.local";
	static CHECK_EVERY_MS = 15 * 60 * 1000;
	static RETRY_WHILE_BUSY_MS = 60 * 1000;

	constructor(sb) {
		this.sb = sb;
		this.timer = null;
		this.checking = false;
		this.lastResult = null; // for the settings button's status line
	}

	pref() { return Zotero.Prefs.get("extensions.secondbrain.updates", true) || "github"; }

	start() {
		if (this.pref() !== "server") return;
		// Fires once uiReadyPromise resolves; second-brain.js's init() already runs after Zotero.uiReadyPromise
		// for this, so it can check immediately.
		this.check();
		this.timer = setInterval(() => this.check(), SecondBrain.Updater.CHECK_EVERY_MS);
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** For the "Check for updates" button: runs regardless of the pref (a manual check is always allowed) and
	 *  returns a short status string. */
	async checkNow() {
		if (this.pref() === "off") return "Updates are turned off.";
		await this.check(true);
		return this.lastResult ?? "Checked.";
	}

	async check(manual = false) {
		if (this.checking) return;
        if (!manual && this.pref() !== "server") return;
		this.checking = true;
		try {
			let latest;
			try {
				latest = await this.sb.api("/plugins/zotero/latest");
			} catch (error) {
				this.lastResult = this.sb.isOffline(error) ? "Veritas server is not running." : `Couldn't check: ${error.message}`;
				Zotero.debug(`[second-brain updater] check failed: ${error.message ?? error}`);
				return;
			}
			const addon = await AddonManager.getAddonByID(SecondBrain.Updater.ADDON_ID);
			if (!addon) { this.lastResult = "Second Brain isn't installed as an addon (dev mode?)."; return; }
			if (!this.isNewer(addon.version, latest.version)) {
				this.lastResult = `Already up to date (${addon.version}).`;
				return;
			}
			this.pending = latest;
			this.lastResult = `Update ${latest.version} found; waiting to install…`;
			await this.tryInstall();
		} finally {
			this.checking = false;
		}
	}

	/** a.b.c only (matches manifest.json / the server's semver filenames); a non-numeric version is treated as
	 *  not newer, so a corrupt or dev version string never triggers an install. */
	isNewer(current, candidate) {
		const parse = (v) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v || "")?.slice(1).map(Number);
		const a = parse(current), b = parse(candidate);
		if (!a || !b) return false;
		for (let i = 0; i < 3; i++) { if (b[i] !== a[i]) return b[i] > a[i]; }
		return false;
	}

	/** No chat turn streaming, no unsaved paper-note text, no half-typed message or plan edit, in any open window.
	 *  A field merely holding the cursor doesn't count: the chat box keeps focus for hours after its last message,
	 *  and treating that as busy held 0.25.1 back indefinitely. What counts is text that would be lost. */
	idle() {
		if ((this.sb.agent?.busy ?? 0) > 0) return false;
		for (const editor of this.sb.editors) if (editor.dirty || editor.saving) return false;
		for (const win of Zotero.getMainWindows()) {
			const active = win.document.activeElement;
			if (active?.matches?.("textarea.sb-ai-input") && active.value.trim()) return false;
			if (active?.closest?.(".sb-rp-plan [contenteditable]")) return false;
		}
		return true;
	}

	async tryInstall(attemptsLeft = 30) {
		if (!this.pending) return;
		if (!this.idle()) {
			if (attemptsLeft <= 0) { Zotero.debug("[second-brain updater] gave up waiting for idle"); return; }
			Zotero.debug("[second-brain updater] waiting: busy");
			this.retryTimer = setTimeout(() => this.tryInstall(attemptsLeft - 1), SecondBrain.Updater.RETRY_WHILE_BUSY_MS);
			return;
		}
		const latest = this.pending;
		this.pending = null;
		try {
			await this.installVersion(latest);
		} catch (error) {
			Zotero.debug(`[second-brain updater] install failed: ${error.message ?? error}`);
			this.lastResult = `Update failed: ${error.message ?? error}`;
		}
	}

	async fetchBytes(url, onProgress) {
		// the xpi comes from the Veritas server, so it carries the access token like every other server call
		const response = await Zotero.HTTP.request("GET", url, {
			headers: url.startsWith(this.sb.server) ? this.sb.serverHeaders() : {}, responseType: "arraybuffer", timeout: 300000,
			requestObserver: onProgress ? (xhr) => { xhr.onprogress = (event) => onProgress(event.loaded); } : undefined,
		});
		return new Uint8Array(response.response);
	}

	async sha256(bytes) {
		const digest = await Zotero.getMainWindow().crypto.subtle.digest("SHA-256", bytes);
		return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	}

	async installVersion(latest) {
		const bytes = await this.fetchBytes(this.sb.server + latest.url);
		const digest = await this.sha256(bytes);
		if (digest !== latest.sha256) {
			Zotero.debug(`[second-brain updater] refused ${latest.version}: sha256 mismatch (got ${digest}, expected ${latest.sha256})`);
			this.lastResult = "Refused: the download didn't match its checksum.";
			return;
		}
		const addon = await AddonManager.getAddonByID(SecondBrain.Updater.ADDON_ID);
		if (!addon || !this.isNewer(addon.version, latest.version)) {
			Zotero.debug("[second-brain updater] refused: no longer newer (raced with another check or a manual install)");
			return;
		}
		const tmpDir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "sb-update");
		const tmpFile = PathUtils.join(tmpDir, `second-brain-${latest.version}.xpi`);
		await IOUtils.write(tmpFile, bytes, { tmpPath: tmpFile + ".part" });
		try {
			const nsFile = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
			nsFile.initWithPath(tmpFile);
			const install = await AddonManager.getInstallForFile(nsFile, "application/x-xpinstall");
			if (!install) throw new Error("Zotero refused the download (bad xpi or id mismatch)");
			await new Promise((resolve, reject) => {
				install.addListener({
					onInstallFailed: (i) => reject(new Error(i.error ? `install failed (${i.error})` : "install failed")),
					onInstallEnded: () => resolve(),
				});
				install.install();
			});
			// The reason -purgecaches was needed manually: Zotero (Gecko) can keep a startup cache of chrome/JS
			// files across a live addon swap. Ask it to drop that cache before the addon's new startup() runs
			// its loadSubScript calls, so those actually read the new files instead of a stale cache entry.
			try {
				Services.obs.notifyObservers(null, "startupcache-invalidate");
				Zotero.debug("[second-brain updater] startup cache invalidated");
			} catch (error) {
				Zotero.debug(`[second-brain updater] startup cache invalidation failed (continuing): ${error.message ?? error}`);
			}
			this.lastResult = `Updated to ${latest.version}.`;
			this.notify(latest.version);
		} finally {
			IOUtils.remove(tmpDir, { recursive: true }).catch(() => {});
		}
	}

	/** One quiet notice, no focus change: a passive progress window that closes itself, the same UI the plugin
	 *  already uses for background work (e.g. runFix in second-brain.js). */
	notify(version) {
		try {
			const progress = new Zotero.ProgressWindow({ closeOnClick: true });
			progress.changeHeadline("Second Brain");
			new progress.ItemProgress(this.sb.rootURI + "content/icon.svg", `Second Brain updated to ${version}`);
			progress.show();
			progress.startCloseTimer(5000);
		} catch (error) {
			Zotero.debug(`[second-brain updater] notify failed: ${error.message ?? error}`);
		}
	}
};
