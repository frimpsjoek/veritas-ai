// src/web-links.test.ts. Where a link goes in Obsidian (spec 015 B2). run with: node --experimental-strip-types --test src/web-links.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { planLink } from "./web-link-plan.ts";

const on = { mode: undefined, viewerOn: true, noticed: false };

test("a web link opens in the Web viewer when the core plugin is on", () => {
	assert.equal(planLink("https://example.org/a", undefined, on), "viewer");
	assert.equal(planLink("http://example.org/a", { outside: false }, on), "viewer");
	assert.equal(planLink("https://example.org/a", undefined, { ...on, mode: "inside" }), "viewer");
});

test("outside means the system browser, whatever else is set", () => {
	assert.equal(planLink("https://example.org/a", { outside: true }, on), "outside");
	assert.equal(planLink("https://example.org/a", undefined, { ...on, mode: "outside" }), "outside");
	assert.equal(planLink("https://example.org/a", { outside: false }, { ...on, mode: "outside" }), "outside");
});

test("with the Web viewer off the link goes outside, with the notice the first time only", () => {
	assert.equal(planLink("https://example.org/a", undefined, { ...on, viewerOn: false }), "outside-with-notice");
	assert.equal(planLink("https://example.org/a", undefined, { ...on, viewerOn: false, noticed: true }), "outside");
	// an explicit outside click is not a reason to nag about the setting
	assert.equal(planLink("https://example.org/a", { outside: true }, { ...on, viewerOn: false }), "outside");
});

test("zotero: and obsidian: links are not web pages", () => {
	assert.equal(planLink("zotero://select/library/items/K1", undefined, on), "scheme");
	assert.equal(planLink("obsidian://open?vault=v", undefined, on), "scheme");
	assert.equal(planLink("javascript:alert(1)", undefined, on), "scheme");
});
