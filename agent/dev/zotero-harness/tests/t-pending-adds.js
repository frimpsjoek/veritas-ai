/* global Zotero, SB */
// Spec 013 W3: the plugin applies adds and tags the server queued while Zotero was closed, exactly once.
// The Second Brain server is faked by endpoints on Zotero's own HTTP server, so run with
//   SB_SERVER=http://127.0.0.1:$SB_PORT/sbfake   (SB_PORT is Zotero's HTTP port, 23191 by default)
// The fake keeps offering the same entries after they are reported done, which is what a lost "done" looks like.

const DOI = "10.1103/PhysRevB.108.235156";
const TITLE = "Crossover from Fermi arc to full Fermi surface";

async function run(t) {
	const fake = { entries: [], done: [], attempts: [] };
	const endpoint = (methods, handle) => {
		const E = function () {};
		E.prototype = { supportedMethods: methods, supportedDataTypes: ["application/json"], allowRequestsFromUnsafeWebContent: true, init: async (req) => [200, "application/json", JSON.stringify(handle(req.data))] };
		return E;
	};
	Zotero.Server.Endpoints["/sbfake/zotero/pending-adds"] = endpoint(["GET"], () => fake.entries);
	Zotero.Server.Endpoints["/sbfake/zotero/pending-adds/done"] = endpoint(["POST"], (data) => { fake.done.push(...data.ids); return { ok: true }; });
	Zotero.Server.Endpoints["/sbfake/zotero/pending-adds/attempt"] = endpoint(["POST"], (data) => { fake.attempts.push(data); return { ok: true }; });

	await t.check(SB.server.endsWith("/sbfake"), "the plugin points at the fake server", SB.server);
	await t.check(!!SB.pendingAdds?.timer, "the plugin polls on a timer");
	const copies = async () => {
		const search = new Zotero.Search();
		search.libraryID = Zotero.Libraries.userLibraryID;
		search.addCondition("title", "contains", TITLE);
		return Zotero.Items.getAsync(await search.search());
	};
	await t.check((await copies()).length === 0, "the paper is not in the library yet");

	const collection = new Zotero.Collection();
	collection.libraryID = Zotero.Libraries.userLibraryID;
	collection.name = "SB pending-adds test";
	await collection.saveTx();

	fake.entries = [
		{ id: "e1", kind: "add", paper: { title: TITLE, authors: ["Zhang"], year: 2023, venue: "Physical Review B", doi: DOI, abstract: "" }, collection: collection.key, tag: "Read later", attempts: 0 },
		{ id: "e2", kind: "tag", doi: DOI, title: TITLE, tag: "Second tag", attempts: 0 },
		{ id: "e3", kind: "tag", key: "NOPE0000", tag: "Read later", attempts: 0 },
	];
	await SB.pendingAdds.run();

	let found = await copies();
	await t.check(found.length === 1, "the paper was added once", found.length);
	const item = found[0];
	await t.check(item?.inCollection(collection.id), "it is in the requested collection");
	await t.check(item?.hasTag("Read later") && item?.hasTag("Second tag"), "it has both tags", item?.getTags());
	await t.check(["e1", "e2"].every((id) => fake.done.includes(id)) && !fake.done.includes("e3"), "done was posted for e1 and e2 only", fake.done);
	await t.check(fake.attempts.length === 1 && fake.attempts[0].id === "e3" && fake.attempts[0].message, "e3 reported an attempt with a message", fake.attempts);

	fake.done = [];
	await SB.pendingAdds.run();
	found = await copies();
	await t.check(found.length === 1, "a second poll offering the same entries adds nothing", found.length);
	await t.check(fake.done.includes("e1"), "and done is posted again");
}
