/* global Zotero, SB, IOUtils, PathUtils, ChromeUtils, Components */
// Spec 006: the Zotero auto-updater against a fixture server it starts itself (never the real dist/).
//
//   1. The expected version comes from the built manifest.json inside the installed xpi, not a literal.
//   2. Three fixture xpis (patch+1, +2, +3) are built here from that same xpi with only the manifest version
//      changed; their sha256 are computed here too. A throwaway HttpServer serves /plugins/zotero/latest and
//      /plugins/zotero/xpi, and extensions.secondbrain.server points at it.
//   3. checkNow() installs patch+1 live; a fresh probe of Zotero.SecondBrain.version reports it (proves the new
//      code runs, not just "looked installed").
//   4. With a fake streaming turn (agent.busy = 1) the next version is offered but waits until idle.
//   5. A wrong sha256 is refused and the version stays put.

const { HttpServer } = ChromeUtils.importESModule("chrome://remote/content/server/httpd.sys.mjs");

const ID = "second-brain@frimpsjoe.local";

function bump(version, by) {
	const [a, b, c] = version.split(".").map(Number);
	return `${a}.${b}.${c + by}`;
}

function toHex(buffer) {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Copies every file in `source` (an xpi) to `dest`, replacing manifest.json's version. Returns the new bytes. */
async function buildFixtureXpi(source, dest, version) {
	const Cc = Components.classes, Ci = Components.interfaces;
	const open = (path) => { const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile); f.initWithPath(path); return f; };
	const reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
	reader.open(open(source));
	const writer = Cc["@mozilla.org/zipwriter;1"].createInstance(Ci.nsIZipWriter);
	writer.open(open(dest), 0x04 | 0x08 | 0x20); // RDWR | CREATE | TRUNCATE
	try {
		const entries = reader.findEntries("*");
		while (entries.hasMore()) {
			const name = entries.getNext();
			if (name.endsWith("/")) continue;
			let stream = reader.getInputStream(name);
			if (name === "manifest.json") {
				const text = new TextDecoder().decode(await readAll(stream));
				const manifest = JSON.parse(text);
				manifest.version = version;
				const out = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
				const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
				out.setByteStringData(String.fromCharCode(...bytes));
				stream = out;
			}
			writer.addEntryStream(name, Date.now() * 1000, Ci.nsIZipWriter.COMPRESSION_DEFAULT, stream, false);
		}
	} finally {
		reader.close();
	}
	await new Promise((resolve) => writer.processQueue({ onStartRequest() {}, onStopRequest() { resolve(); } }, null));
	writer.close();
	return IOUtils.read(dest);
}

async function readAll(stream) {
	const Cc = Components.classes, Ci = Components.interfaces;
	const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
	binary.setInputStream(stream);
	const bytes = new Uint8Array(binary.readByteArray(binary.available()));
	binary.close();
	return bytes;
}

async function run(t) {
	// A live install tears down and rebuilds SecondBrain, so a reference taken before it goes stale.
	const sb = () => Zotero.SecondBrain;
	const Cc = Components.classes, Ci = Components.interfaces;

	const installedXpi = PathUtils.join(PathUtils.profileDir, "extensions", `${ID}.xpi`);
	const manifestBytes = await (async () => {
		const reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
		const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
		f.initWithPath(installedXpi);
		reader.open(f);
		try { return await readAll(reader.getInputStream("manifest.json")); } finally { reader.close(); }
	})();
	const base = JSON.parse(new TextDecoder().decode(manifestBytes)).version;
	await t.check(/^\d+\.\d+\.\d+$/.test(base), "the built manifest has a plain a.b.c version", base);
	const [v1, v2, v3] = [bump(base, 1), bump(base, 2), bump(base, 3)];

	const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "sb-auto-update");
	const fixtures = {};
	for (const version of [v1, v2, v3]) {
		const path = PathUtils.join(dir, `second-brain-${version}.xpi`);
		const bytes = await buildFixtureXpi(installedXpi, path, version);
		const digest = toHex(await Zotero.getMainWindow().crypto.subtle.digest("SHA-256", bytes));
		fixtures[version] = { bytes, sha256: digest };
	}
	await t.check(Object.keys(fixtures).length === 3, "three fixture xpis built with their own hashes", Object.keys(fixtures));

	let offer = null; // { version, sha256 }
	const server = new HttpServer();
	server.registerPathHandler("/plugins/zotero/latest", (request, response) => {
		response.setHeader("Content-Type", "application/json", false);
		response.write(JSON.stringify({ version: offer.version, sha256: offer.sha256, url: `/plugins/zotero/xpi?version=${offer.version}` }));
	});
	server.registerPathHandler("/plugins/zotero/xpi", (request, response) => {
		const version = new URLSearchParams(request.queryString).get("version");
		const fixture = fixtures[version];
		if (!fixture) { response.setStatusLine(request.httpVersion, 404, "Not Found"); return; }
		response.setHeader("Content-Type", "application/x-xpinstall", false);
		const out = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
		out.setOutputStream(response.bodyOutputStream);
		out.writeByteArray(fixture.bytes);
	});
	server.start(-1);
	const serverPref = "extensions.secondbrain.server";
	const oldServer = Zotero.Prefs.get(serverPref, true);
	Zotero.Prefs.set(serverPref, `http://127.0.0.1:${server.identity.primaryPort}`, true);
	Zotero.Prefs.set("extensions.secondbrain.updates", "server", true);

	// The rebuilt updater runs its own startup check; a manual check made while that is in flight is a no-op.
	const startupCheckDone = () => t.waitFor(() => sb().updater && !sb().updater.checking && sb().updater.lastResult, "the startup check to finish");

	try {
		await t.check(sb().version === base, "starts at the version in the built manifest", sb().version);
		await t.check(!!sb().updater, "SB.updater exists");

		offer = { version: v1, sha256: fixtures[v1].sha256 };
		const result1 = await sb().updater.checkNow();
		await t.log("checkNow (good update):", result1);
		await t.waitFor(() => sb()?.version === v1, `version becomes ${v1} after live install`, 60000);
		await t.check(sb().version === v1, "SB.version reports the new version after install", sb().version);
		await t.check(!!sb().updater, "SB.updater exists again after the reload (new startup() ran)");

		await startupCheckDone();
		offer = { version: v2, sha256: fixtures[v2].sha256 };
		sb().agent.busy = 1;
		const result2 = await sb().updater.checkNow();
		await t.log("checkNow (busy):", result2);
		await t.check(/waiting/i.test(result2 ?? "") || /waiting/i.test(sb().updater.lastResult ?? ""), "reports it is waiting, not installing", result2);
		await t.check(sb().version === v1, "version unchanged while busy", sb().version);
		sb().agent.busy = 0;
		await sb().updater.tryInstall(0);
		await t.waitFor(() => sb()?.version === v2, "installs once idle", 60000);
		await t.check(sb().version === v2, `SB.version reports ${v2} once idle`, sb().version);

		await startupCheckDone();
		offer = { version: v3, sha256: "0".repeat(64) };
		const result3 = await sb().updater.checkNow();
		await t.log("checkNow (bad sha256):", result3);
		await t.check(/checksum/i.test(result3 ?? ""), "refuses with a checksum message", result3);
		await t.check(sb().version === v2, "version unchanged after a bad-hash refusal", sb().version);
	} finally {
		if (oldServer === undefined) Zotero.Prefs.clear(serverPref, true); else Zotero.Prefs.set(serverPref, oldServer, true);
		await new Promise((resolve) => server.stop(resolve));
		await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
	}
}
