/* global SB, Zotero */
// Spec 005 unit A3: ZoteroLibrary.search honours `only` with the server down (run with SB_SERVER pointing at a
// dead port, same as t42-library.js). "papers" and no-`only` both stay local (Zotero is the authority on its own
// papers and the server is unreachable); "notes" has nothing to search locally, so it comes back empty.

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	await t.check(!SB.online, "the Second Brain server counts as down");
	await t.waitFor(() => SB.localIndex.ready, "the built-in search model's saved vectors", 30000).catch(() => null);

	const library = SB.agent.library();
	const query = "rotation equivariant neural networks for molecules";

	const papersOnly = await library.search({ text: query, scope: { kind: "library" }, limit: 6, only: "papers" });
	await t.check(papersOnly.length > 0 && papersOnly.every((hit) => hit.ref.kind === "paper"), "only: \"papers\" returns items, offline", papersOnly.length);

	const notesOnly = await library.search({ text: query, scope: { kind: "library" }, limit: 6, only: "notes" });
	await t.check(Array.isArray(notesOnly) && notesOnly.length === 0, "only: \"notes\" returns [] offline (the vault index lives only on the server)", notesOnly.length);

	const neither = await library.search({ text: query, scope: { kind: "library" }, limit: 6 });
	await t.check(neither.length > 0 && neither.every((hit) => hit.ref.kind === "paper"), "no `only` falls back to local papers offline", neither.length);
}
