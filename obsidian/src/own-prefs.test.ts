import { test } from "node:test";
import assert from "node:assert/strict";
import { ownPrefs } from "./own-prefs.ts";

function setup() {
	const settings = { port: 27182, remoteUrl: "http://mac:27182", startServer: true, ui: {} };
	const shared = new Map<string, unknown>();
	let saves = 0;
	const prefs = ownPrefs(settings, { get: (k) => shared.get(k), set: (k, v) => void shared.set(k, v) }, () => { saves++; });
	return { settings, shared, prefs, saves: () => saves };
}

test("the plugin's own fields are read and written on its settings and saved", () => {
	const { settings, shared, prefs, saves } = setup();
	assert.equal(prefs.get("remoteUrl"), "http://mac:27182");
	prefs.set("startServer", false);
	prefs.set("remoteUrl", "http://other:1");
	assert.equal(settings.startServer, false);
	assert.equal(settings.remoteUrl, "http://other:1");
	assert.equal(saves(), 2);
	assert.equal(shared.size, 0, "nothing leaks into the shared store");
});

test("any other key goes to the shared store, such as the Open links choice", () => {
	const { settings, shared, prefs, saves } = setup();
	prefs.set("openLinks", "outside");
	assert.equal(shared.get("openLinks"), "outside");
	assert.equal(prefs.get("openLinks"), "outside");
	assert.equal(saves(), 0, "the shared store saves itself");
	assert.equal("openLinks" in settings, false);
});

test("an emptied text field becomes an empty string, and a fractional port is refused", () => {
	const { settings, prefs, saves } = setup();
	prefs.set("remoteUrl", undefined);
	assert.equal(settings.remoteUrl, "");
	prefs.set("port", 1025.5);
	prefs.set("port", 30000);
	assert.equal(settings.port, 30000);
	assert.equal(saves(), 2);
});
