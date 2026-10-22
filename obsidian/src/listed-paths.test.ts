// src/listed-paths.test.ts. Listed-folder paths open in the web app (server spec 018). run with: node --experimental-strip-types --test src/listed-paths.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { isListedPath, listedUrl } from "./listed-paths.ts";

test("listed-folder paths are told apart from vault and Zotero paths", () => {
	assert.equal(isListedPath("papers:/review.md"), true);
	assert.equal(isListedPath("Papers/review.md"), false);
	assert.equal(isListedPath("zotero/ABCD1234"), false);
});

test("notes open in the web reader, PDFs and images as files", () => {
	const base = "http://127.0.0.1:27182";
	assert.equal(listedUrl(base, "papers:/sub/methods note.md"), `${base}/app/#/note/papers%3A/sub/methods%20note.md`);
	assert.equal(listedUrl(base, "papers:/scan.pdf"), `${base}/folder-file?path=papers%3A%2Fscan.pdf`);
});
