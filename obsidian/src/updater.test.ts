// src/updater.test.ts. Drives PluginUpdater against a fake UpdaterHost (no real Obsidian, no network) --
// run with: node --experimental-strip-types --test src/updater.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { PluginUpdater, type UpdaterHost, type UpdaterLatest } from "./updater.ts";

function sha256hex(bytes: Uint8Array): Promise<string> {
	return crypto.subtle.digest("SHA-256", bytes).then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}

function makeFile(name: string, text: string) {
	return { name, data: new TextEncoder().encode(`${name}:${text}`).buffer };
}

class FakeHost implements UpdaterHost {
	currentVersion = "0.24.0";
	pluginId = "second-brain-search";
	written: Record<string, ArrayBuffer> = {};
	reloaded = 0;
	notices: string[] = [];
	logs: string[] = [];
	idle = true;
	latest: UpdaterLatest | null = null;
	files: Record<string, ArrayBuffer> = {};
	failFetchFile: string | null = null;
	installed: { version: string; at: number } | null = null;

	async fetchLatest(): Promise<UpdaterLatest> {
		if (!this.latest) throw new Error("no update available (fake)");
		return this.latest;
	}
	async fetchFile(_version: string, name: string): Promise<ArrayBuffer> {
		if (this.failFetchFile === name) throw new Error(`fake fetch failure for ${name}`);
		return this.files[name];
	}
	async writeFile(name: string, data: ArrayBuffer): Promise<void> { this.written[name] = data; }
	isIdle(): boolean { return this.idle; }
	async reload(): Promise<void> { this.reloaded++; }
	notify(message: string): void { this.notices.push(message); }
	log(message: string): void { this.logs.push(message); }
	lastInstalled() { return this.installed; }
	rememberInstalled(version: string) { this.installed = { version, at: Date.now() }; }
}

async function setLatestGood(host: FakeHost, version: string) {
	const main = makeFile("main.js", version);
	const manifest = makeFile("manifest.json", version);
	const styles = makeFile("styles.css", version);
	host.files = { "main.js": main.data, "manifest.json": manifest.data, "styles.css": styles.data };
	host.latest = {
		version,
		files: {
			"main.js": await sha256hex(new Uint8Array(main.data)),
			"manifest.json": await sha256hex(new Uint8Array(manifest.data)),
			"styles.css": await sha256hex(new Uint8Array(styles.data)),
		},
	};
}

test("installs when a newer version verifies and the host is idle", async () => {
	const host = new FakeHost();
	await setLatestGood(host, "0.25.0");
	const updater = new PluginUpdater(host, () => true);
	await updater.check();
	assert.equal(Object.keys(host.written).length, 3);
	assert.equal(host.reloaded, 1);
	assert.deepEqual(host.notices, ["Second Brain updated to 0.25.0"]);
	assert.match(updater.lastResult, /Updated to 0.25.0/);
});

test("refuses an older or equal version and writes nothing", async () => {
	const host = new FakeHost();
	await setLatestGood(host, "0.24.0"); // same as currentVersion
	const updater = new PluginUpdater(host, () => true);
	await updater.check();
	assert.equal(Object.keys(host.written).length, 0);
	assert.equal(host.reloaded, 0);
	assert.match(updater.lastResult, /Already up to date/);

	const host2 = new FakeHost();
	host2.currentVersion = "0.25.0";
	await setLatestGood(host2, "0.24.0"); // older
	const updater2 = new PluginUpdater(host2, () => true);
	await updater2.check();
	assert.equal(Object.keys(host2.written).length, 0);
	assert.equal(host2.reloaded, 0);
});

test("a single bad hash refuses the whole update -- no partial write", async () => {
	const host = new FakeHost();
	await setLatestGood(host, "0.25.0");
	host.latest!.files["styles.css"] = "0".repeat(64); // tamper with one hash
	const updater = new PluginUpdater(host, () => true);
	await updater.check();
	assert.equal(Object.keys(host.written).length, 0, "no file should be written when any hash fails");
	assert.equal(host.reloaded, 0);
	assert.match(updater.lastResult, /checksum/);
	assert.ok(host.logs.some((l) => l.includes("sha256 mismatch")));
});

test("waits while busy, then installs once idle", async () => {
	const host = new FakeHost();
	host.idle = false;
	await setLatestGood(host, "0.25.0");
	const updater = new PluginUpdater(host, () => true);
	await updater.check(); // schedules a retry via setTimeout instead of installing now
	updater.stop(); // cancel that pending retry -- this test drives the retry manually below, not via the timer
	assert.equal(Object.keys(host.written).length, 0);
	assert.equal(host.reloaded, 0);
	assert.ok(host.logs.includes("waiting: busy"));
	host.idle = true;
	// Manually invoke the pending retry path the same way the real timer would, without waiting 60s in a test.
	// PluginUpdater exposes no public "flush" hook (by design -- production code only ever calls it from its own
	// timer), so this drives the same effect through a second check() once idle is true and nothing has changed.
	(updater as any).pending = host.latest;
	await (updater as any).tryInstall(0);
	assert.equal(Object.keys(host.written).length, 3);
	assert.equal(host.reloaded, 1);
});

test("a manual check runs even when the setting is off", async () => {
	const host = new FakeHost();
	await setLatestGood(host, "0.25.0");
	const updater = new PluginUpdater(host, () => false); // "off"
	await updater.check(); // manual=false, disabled -> no-op
	assert.equal(Object.keys(host.written).length, 0);
	const result = await updater.checkNow(); // manual=true -> runs regardless
	assert.equal(Object.keys(host.written).length, 3);
	assert.match(result, /Updated to 0.25.0/);
});

test("a reload that still reports the old version doesn't install the same version again (no update loop)", async () => {
	const host = new FakeHost();
	host.currentVersion = "0.26.1";
	await setLatestGood(host, "0.27.0");
	await new PluginUpdater(host, () => true).check();
	assert.equal(host.reloaded, 1);
	// Obsidian re-enabled the plugin from a cached manifest: the new instance still says 0.26.1.
	host.written = {};
	const again = new PluginUpdater(host, () => true);
	await again.check();
	assert.equal(host.reloaded, 1, "no second reload");
	assert.equal(Object.keys(host.written).length, 0, "nothing rewritten");
	assert.match(again.lastResult, /Restart Obsidian/);
});
