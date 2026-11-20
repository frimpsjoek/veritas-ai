// Run with: node --test zotero/test/pending-adds-attach.test.mjs
// Loads content/pending-adds.js in a bare context with a fake Zotero and server; a PDF saved in Browse (spec 027 G3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const BYTES = new TextEncoder().encode("%PDF-1.7 publisher");
const ENTRY = { id: "0123456789abcdef", kind: "attach", doi: "10.1021/a.b", title: "A paper", url: "https://pubs.acs.org/doi/pdf/10.1021/a.b", md5: "m-new" };

let items, imports, fetched, found, discovered, tempDir;
function reset(make = () => null) {
	items = new Map();
	const item = make();
	imports = [];
	fetched = [];
	discovered = [];
	found = item;
	if (item) items.set(item.id, item);
}

function attachment(id, key, hash) {
	return { id, key, deleted: false, isPDFAttachment: () => true, get attachmentHash() { return Promise.resolve(hash); } };
}

function parent(id, attachments = []) {
	for (const a of attachments) items.set(a.id, a);
	return { id, key: "ITEM" + id, deleted: false, getAttachments: () => attachments.map((a) => a.id) };
}

globalThis.PathUtils = { tempDir: tmpdir(), join: (...parts) => join(...parts) };
globalThis.IOUtils = {
	async createUniqueDirectory(dir, prefix) { tempDir = mkdtempSync(join(dir, prefix + "-")); return tempDir; },
	async write(path, bytes) { writeFileSync(path, bytes); },
	async remove(path, opts) { rmSync(path, { recursive: !!opts?.recursive, force: true }); },
	async makeDirectory(path) { mkdirSync(path, { recursive: true }); },
};
globalThis.SecondBrain = {
	Discover: class {
		async add(paper, opts) {
			discovered.push({ paper, opts });
			const item = parent(900);
			items.set(900, item);
			return item;
		}
	},
};
globalThis.Zotero = {
	Libraries: { userLibraryID: 1 },
	Items: { get: (id) => items.get(id) ?? false, getByLibraryAndKey: () => false },
	HTTP: {
		async request(method, url, opts) {
			fetched.push({ method, url, opts });
			return { status: 200, response: BYTES.buffer.slice(0) };
		},
	},
	Attachments: {
		async importFromFile(options) {
			const copied = readFileSync(options.file);
			const made = {
				id: 500 + imports.length, key: "ATT" + imports.length, fields: {}, saved: 0,
				setField(name, value) { this.fields[name] = value; }, async saveTx() { this.saved += 1; },
			};
			imports.push({ options, copied, made });
			return made;
		},
	},
	logError() {},
};
vm.runInThisContext(readFileSync(fileURLToPath(new URL("../content/pending-adds.js", import.meta.url)), "utf8"));

function server() {
	return { server: "http://127.0.0.1:8765", serverHeaders: (extra = {}) => ({ ...extra }), normalizeTitle: (t) => t.toLowerCase() };
}

function adds() {
	const pending = new SecondBrain.PendingAdds(server());
	pending.find = async () => found;
	return pending;
}

test('an attach on an item without that file adds "Publisher PDF"', async () => {
	reset(() => parent(7));
	const result = await adds().attach(ENTRY);
	assert.equal(imports.length, 1);
	const [{ options, made }] = imports;
	assert.equal(options.parentItemID, 7);
	assert.equal(options.title, "Publisher PDF");
	assert.equal(options.contentType, "application/pdf");
	assert.equal(made.fields.url, ENTRY.url);
	assert.equal(made.saved, 1);
	assert.deepEqual(result, { key: "ATT0" });
});

test("an attach whose file is already there is not added again", async () => {
	reset(() => parent(7, [attachment(70, "OLDPDF01", "m-new")]));
	const result = await adds().attach(ENTRY);
	assert.equal(imports.length, 0);
	assert.equal(fetched.length, 0);
	assert.deepEqual(result, { key: "OLDPDF01", already: true });
});

test("an attach on an item with a different PDF adds a second one", async () => {
	reset(() => parent(7, [attachment(70, "OLDPDF01", "m-old")]));
	const result = await adds().attach(ENTRY);
	assert.equal(imports.length, 1);
	assert.equal(imports[0].options.parentItemID, 7);
	assert.deepEqual(result, { key: "ATT0" });
});

test("an attach for a paper not in Zotero adds the item first", async () => {
	reset();
	await adds().attach(ENTRY);
	assert.equal(discovered.length, 1);
	assert.equal(discovered[0].paper.title, "A paper");
	assert.equal(discovered[0].paper.doi, "10.1021/a.b");
	assert.equal(imports.length, 1);
	assert.equal(imports[0].options.parentItemID, 900);
});

test("the file is fetched from the server and the temp file removed", async () => {
	reset(() => parent(7));
	await adds().attach(ENTRY);
	assert.equal(fetched.length, 1);
	assert.equal(fetched[0].method, "GET");
	assert.equal(fetched[0].url, "http://127.0.0.1:8765/zotero/pending-adds/file?id=0123456789abcdef");
	assert.equal(fetched[0].opts.responseType, "arraybuffer");
	assert.deepEqual(new Uint8Array(imports[0].copied), BYTES);
	assert.equal(existsSync(imports[0].options.file), false);
	assert.equal(existsSync(tempDir), false);
});

test("a file the server no longer has is a failed attempt, and nothing is imported", async () => {
	reset(() => parent(7));
	const original = Zotero.HTTP.request;
	Zotero.HTTP.request = async () => ({ status: 404, response: null });
	try {
		await assert.rejects(adds().attach(ENTRY), /the PDF is no longer on the server/);
		assert.equal(imports.length, 0);
	} finally {
		Zotero.HTTP.request = original;
	}
});

test("runNow reports already in its result row", async () => {
	reset(() => parent(7, [attachment(70, "OLDPDF01", "m-new")]));
	const sb = { ...server(), posts: [], api: async () => [ENTRY], post: async (path, body) => { sb.posts.push([path, body]); } };
	const pending = new SecondBrain.PendingAdds(sb);
	pending.find = async () => found;
	const results = await pending.runNow();
	assert.deepEqual(results, [{ id: ENTRY.id, ok: true, key: "OLDPDF01", already: true }]);
	assert.deepEqual(sb.posts, [["/zotero/pending-adds/done", { ids: [ENTRY.id] }]]);
});
