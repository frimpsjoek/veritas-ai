// Run with: node --test zotero/test/client-only.test.mjs
// Phase 2 Task 7 (design goal 8): the Zotero plugin is a client of the Veritas server, like the Obsidian plugin. No local
// search index, no agent runtime inside Zotero, no notes folder of its own; every server call carries the access token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const content = fileURLToPath(new URL("../content/", import.meta.url));
const read = (name) => readFileSync(content + name, "utf8");

/** content/*.js written by hand: the bundles the build writes there (listed in zotero/.gitignore) are left out. */
function handWritten() {
	const generated = new Set(readFileSync(root + ".gitignore", "utf8").split("\n")
		.filter((line) => line.startsWith("content/")).map((line) => line.slice("content/".length).trim()));
	return readdirSync(content).filter((name) => name.endsWith(".js") && !generated.has(name));
}

test("no local fallback references remain", () => {
	const files = handWritten();
	assert.ok(files.includes("second-brain.js") && files.includes("agent-host.js"), "the scan sees the plugin's own files");
	const banned = /localIndex|LocalIndex|startLocal|LocalStore|engine\.js|searchLocally|similarLocally|planWithoutServer|createLocalRuntime|createGeckoPlatform/;
	const found = [];
	for (const name of files) {
		read(name).split("\n").forEach((line, n) => { if (banned.test(line)) found.push(`${name}:${n + 1}: ${line.trim()}`); });
	}
	assert.deepEqual(found, []);
	for (const gone of ["local-index.js", "engine.html"]) assert.ok(!readdirSync(content).includes(gone), `${gone} is deleted`);
});

/** second-brain.js and agent-host.js in one bare context, over a fake Zotero whose HTTP layer records each request. */
function loadClient({ token = "s3cret", up = true } = {}) {
	const requests = [];
	const prefs = new Map([["extensions.secondbrain.server", "http://127.0.0.1:9"]]);
	if (token) prefs.set("extensions.secondbrain.token", token);
	const Zotero = {
		Prefs: { get: (key) => prefs.get(key), set: (key, value) => prefs.set(key, value), clear: (key) => prefs.delete(key) },
		HTTP: {
			async request(method, url, options = {}) {
				requests.push({ method, url, headers: options.headers ?? {} });
				if (!up) throw Object.assign(new Error("NS_ERROR_CONNECTION_REFUSED"), { status: 0 });
				return { status: 200, response: url.endsWith("/agent/conversations") ? [] : { ok: true } };
			},
		},
		ItemTreeManager: {}, logError() {}, debug() {},
	};
	const context = vm.createContext({ Zotero, Services: {}, IOUtils: {}, PathUtils: {}, TextDecoder, URLSearchParams, setTimeout, clearTimeout, console });
	context.SecondBrainAgent = { createRemoteRuntime: (transport) => ({ where: "server", transport }), MCP_CATALOG: [] };
	vm.runInContext(read("second-brain.js"), context);
	vm.runInContext("this.SecondBrain = SecondBrain;", context);
	vm.runInContext(read("agent-host.js"), context);
	return { sb: context.SecondBrain, requests, prefs };
}

test("every server call sends the token pref", async () => {
	// statically: every Zotero.HTTP.request to the server's address takes its headers from the one helper that reads the pref
	const second = read("second-brain.js");
	assert.match(second, /extensions\.secondbrain\.token/, "second-brain.js reads the token pref");
	assert.match(second, /Authorization[^\n]*Bearer/, "and turns it into an Authorization header");
	const unsigned = [];
	for (const name of handWritten()) {
		const text = read(name);
		for (const match of text.matchAll(/Zotero\.HTTP\.request\(([\s\S]*?)\);/g)) {
			const call = match[1];
			if (/\b(?:server|base)\b/.test(call.split(",").slice(0, 2).join(",")) && !/serverHeaders\(/.test(call)) {
				unsigned.push(`${name}: ${call.split("\n")[0].trim()}`);
			}
		}
		assert.doesNotMatch(text, /\bfetch\([^)]*server/, `${name} fetches the server without the token`);
	}
	assert.deepEqual(unsigned, [], "a request to the server without serverHeaders()");

	// and in practice: api, post, the agent's transport and its ping all carry it
	const { sb, requests, prefs } = loadClient();
	await sb.api("/search?q=x");
	await sb.post("/paper-note/body", { key: "ABCD1234" });
	const host = new sb.AgentHost(sb);
	await host.remoteTransport().request("GET", "/conversations");
	await host.ai();
	assert.ok(requests.length >= 4, `requests: ${requests.map((r) => r.url).join(", ")}`);
	for (const r of requests) assert.equal(r.headers.Authorization, "Bearer s3cret", `${r.method} ${r.url}`);
	assert.ok(requests.some((r) => r.url.endsWith("/agent/ping")), "the agent pings the server");
	// no token set: no header at all (the server treats loopback as local without one)
	prefs.delete("extensions.secondbrain.token");
	await sb.api("/search?q=y");
	assert.equal(requests.at(-1).headers.Authorization, undefined);
});

test("server down: a clear 'not running' state, and the agent host never throws", async () => {
	const { sb } = loadClient({ up: false });
	const error = await sb.api("/search?q=x").then(() => null, (e) => e);
	assert.ok(sb.isOffline(error));
	assert.match(sb.unreachable(error), /Veritas server is not running/);
	const host = new sb.AgentHost(sb);
	const ai = await host.ai(); // resolves: calls on it fail one by one with the message above
	assert.equal(ai.where, "server");
	const failed = await host.remoteTransport().request("GET", "/conversations").then(() => null, (e) => e);
	assert.match(String(failed?.message), /Veritas server is not running/);
});

test("agent bundle exposes the remote runtime only", () => {
	execFileSync(process.execPath, ["build-agent.mjs"], { cwd: root, stdio: "pipe" });
	const bundle = read("agent.js");
	assert.match(bundle, /createRemoteRuntime/);
	assert.doesNotMatch(bundle, /createLocalRuntime/);
	assert.doesNotMatch(bundle, /createGeckoPlatform|createToolGateway/);
	const context = vm.createContext({});
	vm.runInContext(`${bundle}\nthis.SecondBrainAgent = SecondBrainAgent;`, context);
	assert.equal(typeof context.SecondBrainAgent.createRemoteRuntime, "function");
	assert.ok(Array.isArray(context.SecondBrainAgent.MCP_CATALOG) && context.SecondBrainAgent.MCP_CATALOG.length > 0);
});
