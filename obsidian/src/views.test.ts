// src/views.test.ts. Obsidian calls open, close, load and unload on every view and modal itself; a subclass method
// with one of those names replaces Obsidian's, so the view never draws (0.50.0's Home did this with open(target)).
// run with: node --experimental-strip-types --test src/views.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const RESERVED = ["open", "close", "load", "unload"];

test("no view or modal declares a method Obsidian calls itself", () => {
	const dir = new URL(".", import.meta.url);
	const found: string[] = [];
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
		const source = readFileSync(new URL(file, dir), "utf8");
		for (const cls of source.matchAll(/class (\w+) extends (?:ItemView|View|Modal|FuzzySuggestModal|SuggestModal)\b[^{]*\{([\s\S]*?)\n\}/g)) {
			for (const name of RESERVED) {
				if (new RegExp(`^\\t(?:private |protected |public )?(?:async )?${name}\\(`, "m").test(cls[2])) found.push(`${file}: ${cls[1]}.${name}`);
			}
		}
	}
	assert.deepEqual(found, []);
});
