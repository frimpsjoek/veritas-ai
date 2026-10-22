/* global Zotero, Services, IOUtils, PathUtils */
// sb-test@local: runs one test script inside a headless Zotero and writes what happened to out.txt.
// harness.sh sets extensions.sbtest.script and extensions.sbtest.out in the profile's user.js. The script
// defines `async function run(t)`; t.log, t.check and t.done append to out.txt as they go, so a hang still
// leaves a trail. Startup never waits on the test, so Zotero finishes loading normally.

function install() {}
function uninstall() {}
function shutdown() {}

function startup() {
	const script = Zotero.Prefs.get("extensions.sbtest.script", true);
	const out = Zotero.Prefs.get("extensions.sbtest.out", true);
	if (!script || !out) return;
	let pass = 0;
	let fail = 0;
	let queue = IOUtils.writeUTF8(out, "");
	const write = (line) => { queue = queue.then(() => IOUtils.writeUTF8(out, line + "\n", { mode: "appendOrCreate" })); return queue; };
	const t = {
		log: (...parts) => write(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")),
		check(ok, label, detail) {
			if (ok) pass++; else fail++;
			return write(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : " :: " + (typeof detail === "string" ? detail : JSON.stringify(detail))}`);
		},
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		async waitFor(fn, label, ms = 60000) {
			const end = Date.now() + ms;
			while (Date.now() < end) {
				const value = await fn();
				if (value) return value;
				await t.sleep(250);
			}
			throw new Error(`timed out waiting for ${label}`);
		},
	};
	setTimeout(async () => {
		try {
			await Zotero.uiReadyPromise;
			await t.waitFor(() => Zotero.SecondBrain, "the Second Brain plugin");
			const scope = { Zotero, Services, IOUtils, PathUtils, ChromeUtils, SB: Zotero.SecondBrain, t };
			Services.scriptloader.loadSubScript(PathUtils.toFileURI(script) + "?" + Date.now(), scope);
			await scope.run(t);
		} catch (error) {
			fail++;
			await write(`ERROR ${error?.message ?? error}\n${error?.stack ?? ""}`);
		}
		await write(`DONE pass=${pass} fail=${fail}`);
	}, 0);
}
