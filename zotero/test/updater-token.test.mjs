// Run with: node --test zotero/test/updater-token.test.mjs
// The updater sends the access token only to the Veritas server itself: same origin, not a URL that merely starts
// with the server's address (http://host:1 is a prefix of http://host:1.evil.example/...).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

function loadUpdater(server) {
	const sent = [];
	const context = {
		SecondBrain: {}, URL,
		ChromeUtils: { importESModule: () => ({ AddonManager: {} }) },
		Zotero: { HTTP: { request: async (method, url, opts) => { sent.push({ url, headers: opts.headers }); return { response: new ArrayBuffer(0) }; } } },
	};
	vm.createContext(context);
	vm.runInContext(readFileSync(fileURLToPath(new URL("../content/updater.js", import.meta.url)), "utf8"), context);
	const updater = new context.SecondBrain.Updater({ server, serverHeaders: () => ({ Authorization: "Bearer tok" }) });
	return { updater, sent };
}

test("the token goes to the server and nowhere else", async () => {
	const { updater, sent } = loadUpdater("http://127.0.0.1:27182");
	await updater.fetchBytes("http://127.0.0.1:27182/plugins/zotero/file?v=1");
	await updater.fetchBytes("http://127.0.0.1:271820/steal");
	await updater.fetchBytes("http://127.0.0.1:27182.evil.example/steal");
	assert.deepEqual(sent.map((s) => Boolean(s.headers.Authorization)), [true, false, false]);
});
