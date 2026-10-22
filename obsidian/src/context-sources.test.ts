// src/context-sources.test.ts. Run with: node --experimental-strip-types --test src/context-sources.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { debouncedChanges, selectionLabel, candidatesFromFiles, type ChangeSource } from "./context-sources.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeSource() {
	let fire: (() => void) | null = null;
	let subscribed = false;
	const source: ChangeSource = (changed) => { fire = changed; subscribed = true; return () => { subscribed = false; }; };
	return { source, fire: () => fire?.(), get subscribed() { return subscribed; } };
}

test("a burst of changes from two sources reaches the listener once, 100 ms after the last", async () => {
	const leaf = fakeSource();
	const selection = fakeSource();
	let calls = 0;
	const stop = debouncedChanges([leaf.source, selection.source], () => { calls += 1; });
	for (let i = 0; i < 5; i++) { (i % 2 ? leaf : selection).fire(); await sleep(20); }
	assert.equal(calls, 0, "nothing before the burst settles");
	await sleep(130);
	assert.equal(calls, 1);
	stop();
});

test("unsubscribing drops a pending change and unsubscribes every source", async () => {
	const leaf = fakeSource();
	let calls = 0;
	const stop = debouncedChanges([leaf.source], () => { calls += 1; });
	leaf.fire();
	stop();
	await sleep(150);
	assert.equal(calls, 0);
	assert.equal(leaf.subscribed, false);
});

test("selectionLabel is one line, cut with an ellipsis", () => {
	assert.equal(selectionLabel("Voles  dig\nshallow burrows"), "Voles dig shallow burrows");
	assert.equal(selectionLabel("a".repeat(60), 10), `${"a".repeat(9)}…`);
});

test("a note with a zotero-key is offered as its paper, others as notes", () => {
	const rows = candidatesFromFiles([
		{ path: "papers/Vole foraging.md", basename: "Vole foraging", folder: "papers", zoteroKey: "bramblewood2021" },
		{ path: "Vole diary.md", basename: "Vole diary", folder: "/", zoteroKey: null },
	]);
	assert.deepEqual(rows, [
		{ category: "paper", label: "Vole foraging", detail: "papers", attachment: { kind: "zoteroItem", citekey: "bramblewood2021" } },
		{ category: "note", label: "Vole diary", detail: undefined, attachment: { kind: "note", path: "Vole diary.md" } },
	]);
});
