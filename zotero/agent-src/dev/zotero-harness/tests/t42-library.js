/* global SB, Zotero, IOUtils */
// T4.2: the Zotero library backend with the server down (run with SB_SERVER pointing at a dead port), and the
// local note sink.

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	await t.check(!SB.online, "the Second Brain server counts as down");
	await t.waitFor(() => SB.localIndex.ready, "the built-in search model's saved vectors", 30000).catch(() => null);
	await t.log(`built-in model: ${SB.localIndex.state} ${SB.localIndex.detail}`);

	const library = SB.agent.library();
	const hits = await library.search({ text: "rotation equivariant neural networks for molecules", scope: { kind: "library" }, limit: 6 });
	await t.check(hits.length > 0 && hits.every((hit) => hit.ref.kind === "paper" && hit.ref.citekey && hit.title), "a query returns papers with citekeys",
		hits.map((hit) => `${hit.ref.citekey} ${hit.title.slice(0, 50)}`));
	const dated = hits.filter((hit) => hit.year != null);
	if (dated.length) {
		const year = dated[0].year;
		const ranged = await library.search({ text: "rotation equivariant neural networks for molecules", scope: { kind: "library" }, limit: 6, years: { from: year, to: year } });
		await t.check(ranged.length > 0 && ranged.every((hit) => hit.year === year), `a years filter keeps only papers from ${year}`,
			ranged.map((hit) => `${hit.year} ${hit.title.slice(0, 40)}`));
		const none = await library.search({ text: "rotation equivariant neural networks for molecules", scope: { kind: "library" }, limit: 6, years: { from: 1800, to: 1801 } });
		await t.check(none.length === 0, "a year range with no papers returns none", none.length);
	}
	const items = await Promise.all(hits.map((hit) => SB.itemByCitekey(hit.ref.citekey)));
	await t.check(items.every(Boolean), "every citekey maps back to a Zotero item");

	let withText = null;
	for (const hit of hits) {
		const full = await library.read(hit.ref, { maxChars: 20000 });
		if (full?.text.includes("\nFull text\n")) { withText = { hit, full }; break; }
	}
	await t.check(!!withText, "read_source returns Zotero's full text for a paper that has it", withText?.hit.ref);
	if (withText) {
		const capped = await library.read(withText.hit.ref, { maxChars: 1500 });
		await t.check(capped.text.length <= 1500 && withText.full.text.length > 1500, "full-text reads are capped by size", [capped.text.length, withText.full.text.length]);
	}

	const collection = Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID, true).find((c) => c.getChildItems(false).length >= 5);
	if (collection) {
		const inside = collection.getChildItems(false).find((item) => item.isRegularItem());
		const scoped = await library.search({ text: inside.getField("title"), scope: { kind: "collection", name: collection.name }, limit: 10 });
		const keys = await library.scopeKeys({ kind: "collection", name: collection.name });
		const inScope = await Promise.all(scoped.map(async (hit) => keys.has((await SB.itemByCitekey(hit.ref.citekey))?.key)));
		await t.check(scoped.length > 0 && inScope.every(Boolean), `a collection-scoped search finds papers only inside "${collection.name}"`, scoped.length);
	}

	const related = await library.related(hits[0].ref, { limit: 5 });
	await t.check(!SB.localIndex.ready || related.length > 0, "related_sources uses the local vectors", related.map((r) => r.ref.citekey));

	const resolved = await library.resolve([hits[0].ref, { kind: "paper", citekey: "madeUp2099" }, { kind: "note", path: "Some note.md" }]);
	await t.check(resolved.get(`paper:${hits[0].ref.citekey}`)?.title === hits[0].title && resolved.get("paper:madeUp2099") === null && resolved.get("note:Some note.md") === null,
		"resolve: real paper yes, made-up key and unreachable vault note no");

	await SB.agent.local();
	const tools = SB.agent.gateway.open({ scope: { kind: "library" }, web: "off", sources: { papers: true, notes: true, scholarly: false, web: false }, audit: "harness:t42" });
	const out = await tools.call("search_library", { query: "equivariant graph networks" });
	await t.check(out.ok && /\[@[^\]]+\]/.test(out.text), "search_library tool answers from Zotero alone", out.text.slice(0, 160));
	tools.close();

	const sink = new SB.LocalNoteSink(SB);
	const first = await sink.publish({ reviewId: "R1", title: "Sleep and memory", markdown: "# One", frontMatter: { question: "Q?" } });
	const again = await sink.publish({ reviewId: "R1", title: "Sleep and memory", markdown: "# Two" });
	const other = await sink.publish({ reviewId: "R2", title: "Sleep and memory", markdown: "# Other" });
	const text = await IOUtils.readUTF8(first.path);
	await t.check(first.path === again.path && text.includes("# Two") && text.includes('review-id: "R1"'), "publishing a review twice rewrites its own note", first.path);
	await t.check(other.path !== first.path && / 2\.md$/.test(other.path), "another review with the same title gets a numbered name", other.path);
	await t.check(first.path.startsWith(SB.local.folder), "reviews go to the local notes folder", SB.local.folder);
	await SB.agent.shutdown();
}
