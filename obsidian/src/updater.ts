import { isNewer, verifySha256 } from "./updater-core.ts";

// src/updater.ts. Auto-update from the Second Brain server (spec 006). Checks at load, every 15 min, and on
// demand from the settings "Check for updates" button. `data.json` (plugin settings) is never touched -- only
// main.js, manifest.json and styles.css are written.

const FILES = ["main.js", "manifest.json", "styles.css"] as const;
const CHECK_EVERY_MS = 15 * 60 * 1000;
const RETRY_WHILE_BUSY_MS = 60 * 1000;

export interface UpdaterLatest { version: string; files: Record<string, string> }

/** What updater.ts needs from the running plugin, narrowed so the logic below can be driven by a fake in tests
 *  without spinning up real Obsidian. */
export interface UpdaterHost {
	currentVersion: string;
	pluginId: string;
	fetchLatest(): Promise<UpdaterLatest>;
	fetchFile(version: string, name: string): Promise<ArrayBuffer>;
	writeFile(name: string, data: ArrayBuffer): Promise<void>;
	isIdle(): boolean;
	reload(): Promise<void>;
	notify(message: string): void;
	log(message: string): void;
	/** Persists across plugin reloads (each reload builds a new PluginUpdater). */
	lastInstalled(): { version: string; at: number } | null;
	rememberInstalled(version: string): void;
}

// If the plugin comes back from a reload still reporting the old version, Obsidian enabled it from a stale
// manifest; installing again would reload forever (0.27.0, 2026-09-29).
const REINSTALL_GUARD_MS = 6 * 60 * 60 * 1000;

export class PluginUpdater {
	private timer: ReturnType<typeof setInterval> | null = null;
	private checking = false;
	private pending: UpdaterLatest | null = null;
	private retryHandle: ReturnType<typeof setTimeout> | null = null;
	private host: UpdaterHost;
	private enabled: () => boolean;
	lastResult = "";

	// Not a TS parameter-property constructor: Node's --experimental-strip-types (used to run updater.test.ts and
	// updater-core.test.ts without a build step) can't strip that syntax, only plain type annotations.
	constructor(host: UpdaterHost, enabled: () => boolean) {
		this.host = host;
		this.enabled = enabled;
	}

	start() {
		this.check();
		this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
	}

	stop() {
		if (this.timer !== null) clearInterval(this.timer);
		if (this.retryHandle !== null) clearTimeout(this.retryHandle);
		this.timer = this.retryHandle = null;
	}

	/** For the settings button: always allowed, regardless of the "off" setting (a manual check is explicit
	 *  consent), and returns a short status string for display. */
	async checkNow(): Promise<string> {
		await this.check(true);
		return this.lastResult || "Checked.";
	}

	async check(manual = false): Promise<void> {
		if (this.checking) return;
		if (!manual && !this.enabled()) return;
		this.checking = true;
		try {
			let latest: UpdaterLatest;
			try {
				latest = await this.host.fetchLatest();
			} catch (error) {
				this.lastResult = `Couldn't check: ${(error as Error).message ?? error}`;
				this.host.log(`check failed: ${(error as Error).message ?? error}`);
				return;
			}
			if (!isNewer(this.host.currentVersion, latest.version)) {
				this.lastResult = `Already up to date (${this.host.currentVersion}).`;
				return;
			}
			this.pending = latest;
			this.lastResult = `Update ${latest.version} found; waiting to install…`;
			await this.tryInstall();
		} finally {
			this.checking = false;
		}
	}

	private async tryInstall(attemptsLeft = 30): Promise<void> {
		if (!this.pending) return;
		if (!this.host.isIdle()) {
			if (attemptsLeft <= 0) { this.host.log("gave up waiting for idle"); this.pending = null; return; }
			this.host.log("waiting: busy");
			this.retryHandle = setTimeout(() => this.tryInstall(attemptsLeft - 1), RETRY_WHILE_BUSY_MS);
			return;
		}
		const latest = this.pending;
		this.pending = null;
		try {
			await this.install(latest);
		} catch (error) {
			this.lastResult = `Update failed: ${(error as Error).message ?? error}`;
			this.host.log(`install failed: ${(error as Error).message ?? error}`);
		}
	}

	/** Downloads and verifies every file before writing any of them: a bad hash on file 2 of 3 must not leave a
	 *  half-updated plugin on disk. */
	private async install(latest: UpdaterLatest): Promise<void> {
		if (!isNewer(this.host.currentVersion, latest.version)) {
			this.host.log("refused: no longer newer (raced with another check)");
			return;
		}
		const last = this.host.lastInstalled();
		if (last?.version === latest.version && Date.now() - last.at < REINSTALL_GUARD_MS) {
			this.lastResult = `${latest.version} is installed, but Obsidian still reports ${this.host.currentVersion}. Restart Obsidian to finish.`;
			this.host.log(`refused ${latest.version}: installed already, running version still ${this.host.currentVersion}`);
			return;
		}
		const downloads: { name: string; data: ArrayBuffer }[] = [];
		for (const name of FILES) {
			const expected = latest.files[name];
			if (!expected) { this.lastResult = `Refused: the server's build is missing ${name}.`; this.host.log(`refused ${latest.version}: missing ${name} in file list`); return; }
			const data = await this.host.fetchFile(latest.version, name);
			if (!(await verifySha256(data, expected))) {
				this.lastResult = "Refused: a downloaded file didn't match its checksum.";
				this.host.log(`refused ${latest.version}: sha256 mismatch on ${name}`);
				return;
			}
			downloads.push({ name, data });
		}
		for (const { name, data } of downloads) await this.host.writeFile(name, data);
		this.host.rememberInstalled(latest.version);
		await this.host.reload();
		this.lastResult = `Updated to ${latest.version}.`;
		this.host.notify(`Second Brain updated to ${latest.version}`);
	}
}
