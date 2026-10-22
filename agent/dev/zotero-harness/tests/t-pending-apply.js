/* global Zotero, SB */
// Spec 013 W3: a running Zotero applies queued entries the moment the server asks, and only the server's kind of
// caller can ask. Run with SB_SERVER=http://127.0.0.1:$SB_PORT/sbfake (the fake KB server is endpoints on Zotero's own
// HTTP server, as in t-pending-adds.js). The call to /second-brain/pending-adds/apply is made over real HTTP.

const DOI = "10.1103/PhysRevB.108.235156";
const TITLE = "Crossover from Fermi arc to full Fermi surface";
const APPLY = `http://127.0.0.1:${Zotero.Prefs.get("httpServer.port")}/second-brain/pending-adds/apply`;

async function run(t) {
	const fake = { entries: [], done: [] };
	const endpoint = (methods, handle) => {
		const E = function () {};
		E.prototype = { supportedMethods: methods, supportedDataTypes: ["application/json"], allowRequestsFromUnsafeWebContent: true, init: async (req) => [200, "application/json", JSON.stringify(handle(req.data))] };
		return E;
	};
	Zotero.Server.Endpoints["/sbfake/zotero/pending-adds"] = endpoint(["GET"], () => fake.entries);
	Zotero.Server.Endpoints["/sbfake/zotero/pending-adds/done"] = endpoint(["POST"], (data) => { fake.done.push(...data.ids); return { ok: true }; });
	Zotero.Server.Endpoints["/sbfake/zotero/pending-adds/attempt"] = endpoint(["POST"], () => ({ ok: true }));

	const copies = async () => {
		const search = new Zotero.Search();
		search.libraryID = Zotero.Libraries.userLibraryID;
		search.addCondition("title", "contains", TITLE);
		return Zotero.Items.getAsync(await search.search());
	};
	const post = (ids, headers = {}) => Zotero.HTTP.request("POST", APPLY, {
		body: JSON.stringify({ ids }), headers: { "Content-Type": "application/json", "Zotero-Allowed-Request": "1", ...headers },
		responseType: "json", timeout: 20000, successCodes: false,
	}).catch((error) => ({ status: 0, error: String(error?.message ?? error) }));

	// only the endpoint should apply entries here, not the startup poll
	clearTimeout(SB.pendingAdds.first);
	clearInterval(SB.pendingAdds.timer);
	await SB.pendingAdds.last;

	const collection = new Zotero.Collection();
	collection.libraryID = Zotero.Libraries.userLibraryID;
	collection.name = "SB apply test";
	await collection.saveTx();
	await t.check((await copies()).length === 0, "the paper is not in the library yet");

	fake.entries = [
		{ id: "evil", kind: "add", paper: { title: TITLE, authors: [], doi: DOI }, collection: collection.key, tag: "from-a-web-page", attempts: 0 },
		{ id: "e1", kind: "add", paper: { title: TITLE, authors: ["Zhang"], year: 2023, venue: "Physical Review B", doi: DOI, abstract: "" }, collection: collection.key, tag: "Read later", attempts: 0 },
	];

	// The server's client sends no Origin and is not a "Mozilla/" browser, so Zotero lets it through on its own; the
	// Zotero-Allowed-Request header stands in for that here, since this caller is Zotero's own XHR.
	const refused = await post(["evil"], { Origin: "https://evil.example" });
	await t.check(refused.status === 403, "a request with a web page Origin is refused by the endpoint", { status: refused.status, error: refused.error });
	const browser = await post(["evil"], { Origin: "https://evil.example", "Zotero-Allowed-Request": "" });
	await t.check(browser.status !== 200, "and by Zotero's own server when it is not marked as allowed", { status: browser.status });
	await t.check((await copies()).length === 0 && fake.done.length === 0, "and applied nothing");

	const started = Date.now();
	const reply = await post(["e1"]);
	const elapsed = Date.now() - started;
	const [result] = reply.response?.results ?? [];
	await t.check(reply.status === 200 && result?.id === "e1" && result.ok && /^[A-Z0-9]{8}$/.test(result.key ?? ""), "the endpoint answers ok with the item key", reply.response);
	await t.check(elapsed < 10000, "within 10 seconds (the DOI lookup is a network round trip)", elapsed);

	const found = await copies();
	await t.check(found.length === 1, "the item exists once", found.length);
	await t.check(found[0]?.key === result?.key, "and it is the key the endpoint reported");
	await t.check(found[0]?.inCollection(collection.id) && found[0]?.hasTag("Read later") && !found[0]?.hasTag("from-a-web-page"), "in the collection with the tag", found[0]?.getTags());
	await t.check(fake.done.join() === "e1", "done was posted for e1 only", fake.done);

	const again = await post(["e1"]);
	await t.check((await copies()).length === 1 && again.response?.results?.[0]?.key === result.key, "asking again adds nothing and returns the same key");
}
