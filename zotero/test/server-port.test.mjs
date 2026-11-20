// Run with: node --test zotero/test/server-port.test.mjs
// Loads content/server-port.js in a bare context: how the plugin finds the desktop app's server when the app had to
// take a port other than 27182 (it writes the port to `server-port` in its data folder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

globalThis.SecondBrain = {};
vm.runInThisContext(readFileSync(fileURLToPath(new URL("../content/server-port.js", import.meta.url)), "utf8"));
const { ServerPort } = SecondBrain;

test("the port file is in the desktop app's data folder on each system", () => {
	assert.equal(ServerPort.file({ os: "mac", home: "/Users/a" }),
		"/Users/a/Library/Application Support/io.github.frimpsjoek.veritas/server-port");
	assert.equal(ServerPort.file({ os: "win", appData: "C:\\Users\\a\\AppData\\Roaming" }),
		"C:\\Users\\a\\AppData\\Roaming\\io.github.frimpsjoek.veritas\\server-port");
	assert.equal(ServerPort.file({ os: "linux", home: "/home/a" }), "/home/a/.local/share/io.github.frimpsjoek.veritas/server-port");
	assert.equal(ServerPort.file({ os: "linux", home: "/home/a", xdgData: "/data" }), "/data/io.github.frimpsjoek.veritas/server-port");
});

test("only a port number is read from the file", () => {
	assert.equal(ServerPort.parse("52172\n"), 52172);
	assert.equal(ServerPort.parse(" 27182 "), 27182);
	for (const bad of ["", "0", "70000", "52172abc", "http://evil.example:80", "-1", null]) assert.equal(ServerPort.parse(bad), null, String(bad));
});

const where = { os: "mac", home: "/Users/a" };

test("the app's port is used when its server answers there", async () => {
	const asked = [];
	const url = await ServerPort.find({ ...where, read: async () => "52172\n", ping: async (u) => { asked.push(u); return true; } });
	assert.equal(url, "http://127.0.0.1:52172");
	assert.deepEqual(asked, ["http://127.0.0.1:52172"]);
});

test("no file, a broken file or a port that does not answer finds nothing", async () => {
	const missing = async () => { throw new Error("no such file"); };
	assert.equal(await ServerPort.find({ ...where, read: missing, ping: async () => true }), null);
	assert.equal(await ServerPort.find({ ...where, read: async () => "junk", ping: async () => true }), null);
	assert.equal(await ServerPort.find({ ...where, read: async () => "52172", ping: async () => false }), null);
	assert.equal(await ServerPort.find({ ...where, read: async () => "52172", ping: async () => { throw new Error("refused"); } }), null);
});

test("the address the plugin uses: a chosen server first, then the app's, then 27182", () => {
	assert.equal(ServerPort.address("http://10.0.0.5:27182/", "http://127.0.0.1:52172"), "http://10.0.0.5:27182");
	assert.equal(ServerPort.address("", "http://127.0.0.1:52172"), "http://127.0.0.1:52172");
	assert.equal(ServerPort.address(undefined, null), "http://127.0.0.1:27182");
});

test("bootstrap.js loads server-port.js right after second-brain.js", () => {
	const boot = readFileSync(fileURLToPath(new URL("../bootstrap.js", import.meta.url)), "utf8");
	assert.match(boot, /content\/second-brain\.js"\);\n\tServices\.scriptloader\.loadSubScript\(rootURI \+ "content\/server-port\.js"\);/);
});
