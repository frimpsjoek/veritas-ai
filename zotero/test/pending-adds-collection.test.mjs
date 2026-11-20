// Run with: node --test zotero/test/pending-adds-collection.test.mjs
// A liked paper (spec 027 follow-up): the add names its collection, "To classify", which the plugin finds or makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

let collections, made, items;
class FakeCollection {
	constructor() { this.id = 100 + collections.length; this.key = `COL${collections.length}`; this.parentID = false; this.deleted = false; }
	async saveTx() { collections.push(this); made.push(this.name); }
}
function item() {
	return {
		key: "ITEM0001", tags: [], in: new Set(), saves: 0,
		inCollection(id) { return this.in.has(id); }, addToCollection(id) { this.in.add(id); },
		hasTag(t) { return this.tags.includes(t); }, addTag(t) { this.tags.push(t); }, async saveTx() { this.saves += 1; },
	};
}
globalThis.SecondBrain = { Discover: class { async add() { return items.added; } } };
globalThis.Zotero = {
	Libraries: { userLibraryID: 1 },
	Items: { getByLibraryAndKey: () => false },
	Collections: { getByLibrary: () => collections, getByLibraryAndKey: () => false },
	Collection: FakeCollection,
	logError() {},
	debug() {},
};
vm.runInThisContext(readFileSync(fileURLToPath(new URL("../content/pending-adds.js", import.meta.url)), "utf8"));

function adds(found) {
	const pending = new SecondBrain.PendingAdds({ normalizeTitle: (t) => t.toLowerCase() });
	pending.find = async () => found;
	return pending;
}
const ENTRY = { id: "e1", kind: "add", paper: { title: "A liked paper", doi: "10.1/x" }, collection: null, collection_name: "To classify", tag: "Liked" };

test("a liked paper goes into To classify, made the first time", async () => {
	collections = []; made = []; items = { added: item() };
	const result = await adds(null).apply({ ...ENTRY, paper: { ...ENTRY.paper } });
	assert.deepEqual(made, ["To classify"]);
	assert.ok(result.inCollection(100));
	assert.deepEqual(result.tags, ["Liked"]);
});

test("an existing To classify is used, and a paper already in Zotero is not added again", async () => {
	const existing = new FakeCollection();
	collections = []; made = [];
	existing.name = "To classify";
	collections.push(existing);
	made.length = 0;
	const known = item();
	items = { added: null };
	const result = await adds(known).apply({ ...ENTRY, paper: { ...ENTRY.paper } });
	assert.equal(result, known);
	assert.deepEqual(made, []);
	assert.ok(known.inCollection(existing.id));
	assert.deepEqual(known.tags, ["Liked"]);
});

test("a sub-collection or a deleted one with that name is not the one", async () => {
	collections = []; made = []; items = { added: item() };
	const sub = new FakeCollection(); sub.name = "To classify"; sub.parentID = 5; collections.push(sub);
	const gone = new FakeCollection(); gone.name = "To classify"; gone.deleted = true; collections.push(gone);
	made.length = 0;
	await adds(null).apply({ ...ENTRY, paper: { ...ENTRY.paper } });
	assert.deepEqual(made, ["To classify"]);
});
