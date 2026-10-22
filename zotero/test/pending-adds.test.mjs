// Run with: node --test zotero-plugin/test/pending-adds.test.mjs
// Loads content/pending-adds.js in a bare context with a fake Zotero and server; a highlight from the web reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const items = new Map();
const saved = [];
globalThis.SecondBrain = {};
globalThis.Zotero = {
	Libraries: { userLibraryID: 1 },
	Items: { getByLibraryAndKey: (_, key) => items.get(key) ?? false },
	Annotations: {
		async saveFromJSON(attachment, json) {
			saved.push({ attachment: attachment.key, json });
			const item = { key: json.key };
			items.set(json.key, item);
			return item;
		},
	},
	logError() {},
};
vm.runInThisContext(readFileSync(fileURLToPath(new URL("../content/pending-adds.js", import.meta.url)), "utf8"));

const ANNOTATION = {
	type: "highlight", text: "Voles cache seeds.", comment: "check", color: "#ffd400", pageLabel: "3", sortIndex: "00002|000010|00079",
	position: { pageIndex: 2, rects: [[72, 700.5, 300, 712]] }, key: "HL234567",
};
const ENTRY = { id: "e1", kind: "annotation", key: "ATTACH23", annotation: ANNOTATION };

function server(entries) {
	const posts = [];
	return { posts, api: async () => entries, post: async (path, body) => { posts.push([path, body]); } };
}

test("a queued highlight is saved on its PDF under its own key, then reported done", async () => {
	items.clear(); saved.length = 0;
	items.set("ATTACH23", { key: "ATTACH23", deleted: false, isPDFAttachment: () => true });
	const sb = server([ENTRY]);
	const results = await new SecondBrain.PendingAdds(sb).runNow();
	assert.deepEqual(results, [{ id: "e1", ok: true, key: "HL234567" }]);
	assert.deepEqual(saved, [{ attachment: "ATTACH23", json: {
		key: "HL234567", type: "highlight", text: "Voles cache seeds.", comment: "check", color: "#ffd400", pageLabel: "3",
		sortIndex: "00002|000010|00079", position: { pageIndex: 2, rects: [[72, 700.5, 300, 712]] }, tags: [],
	} }]);
	assert.deepEqual(sb.posts, [["/zotero/pending-adds/done", { ids: ["e1"] }]]);
});

test("a retry after the server missed the reply finds the saved highlight and adds no second one", async () => {
	const sb = server([ENTRY]);
	const results = await new SecondBrain.PendingAdds(sb).runNow();
	assert.deepEqual(results, [{ id: "e1", ok: true, key: "HL234567" }]);
	assert.equal(saved.length, 1);
});

test("a highlight whose PDF is gone is reported as a failed attempt", async () => {
	items.clear(); saved.length = 0;
	const sb = server([ENTRY]);
	const [result] = await new SecondBrain.PendingAdds(sb).runNow();
	assert.equal(result.ok, false);
	assert.match(result.message, /no PDF attachment ATTACH23/);
	assert.deepEqual(sb.posts, [["/zotero/pending-adds/attempt", { id: "e1", message: result.message }]]);
	assert.equal(saved.length, 0);
});
