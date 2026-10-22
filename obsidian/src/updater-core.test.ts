// src/updater-core.test.ts. Run with: node --experimental-strip-types --test src/updater-core.test.ts
// No `obsidian` import anywhere in the chain (updater-core.ts is obsidian-free), so this runs in plain Node.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewer, isIdle, verifySha256 } from "./updater-core.ts";

test("isNewer: patch/minor/major bumps", () => {
	assert.equal(isNewer("0.24.0", "0.25.0"), true);
	assert.equal(isNewer("0.24.0", "0.24.1"), true);
	assert.equal(isNewer("0.24.0", "1.0.0"), true);
});

test("isNewer: equal or older is not newer", () => {
	assert.equal(isNewer("0.24.0", "0.24.0"), false);
	assert.equal(isNewer("0.25.0", "0.24.0"), false);
	assert.equal(isNewer("1.0.0", "0.99.99"), false);
});

test("isNewer: malformed version strings never compare as newer", () => {
	assert.equal(isNewer("0.24.0", "0.24.0-beta"), false);
	assert.equal(isNewer("0.24.0", "not-a-version"), false);
	assert.equal(isNewer("dev", "0.24.0"), false);
	assert.equal(isNewer("", ""), false);
});

test("isIdle: any busy signal means not idle", () => {
	assert.equal(isIdle({ chatRunning: false, fieldFocused: false }), true);
	assert.equal(isIdle({ chatRunning: true, fieldFocused: false }), false);
	assert.equal(isIdle({ chatRunning: false, fieldFocused: true }), false);
	assert.equal(isIdle({ chatRunning: true, fieldFocused: true }), false);
});

test("verifySha256: matches the real hash and rejects a tampered one", async () => {
	const data = new TextEncoder().encode("second brain auto-update fixture").buffer;
	const digest = await crypto.subtle.digest("SHA-256", data);
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	assert.equal(await verifySha256(data, hex), true);
	assert.equal(await verifySha256(data, hex.toUpperCase()), true); // case-insensitive compare
	const tampered = hex.slice(0, -1) + (hex.at(-1) === "0" ? "1" : "0");
	assert.equal(await verifySha256(data, tampered), false);
});
