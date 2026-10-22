/* global Zotero, SB */
// Spec 008 follow-up: the `@` / `+` context picker works in real Zotero. host.contextCandidates() returns library
// papers and collections, typing "@" opens the picker, and choosing a row attaches it as a chip.

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(t) {
	// saving straight after startup races Zotero's own startup transactions (DB TimeoutError)
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	const libraryID = Zotero.Libraries.userLibraryID;
	const collectionName = "SB picker test collection";
	if (!Zotero.Collections.getByLibrary(libraryID, true).some((c) => c.name === collectionName)) {
		const collection = new Zotero.Collection();
		collection.libraryID = libraryID;
		collection.name = collectionName;
		await collection.saveTx();
	}

	const view = SB.openChat();
	await pause(300);
	view.setMode("chat");
	await t.check(!!view.picker, "the Zotero host offers the context picker");

	const candidates = await view.host.contextCandidates();
	const papers = candidates.filter((c) => c.category === "paper");
	const collections = candidates.filter((c) => c.category === "collection");
	await t.check(papers.length > 0 && papers.every((c) => c.label && c.attachment.kind === "zoteroItem" && c.attachment.citekey), "candidates include library papers with citekeys", papers.length);
	await t.check(collections.some((c) => c.label === collectionName && c.attachment.kind === "collection" && c.attachment.name === collectionName), "candidates include collections", collections.map((c) => c.label));

	const word = papers[0].label.split(/\s+/).find((w) => w.length > 3) ?? papers[0].label;
	view.input.value = `look at @${word}`;
	view.input.setSelectionRange(view.input.value.length, view.input.value.length);
	view.input.dispatchEvent(new win.Event("input"));
	await t.waitFor(() => !view.picker.root.hidden && view.picker.list.querySelector(".sb-ai-picker-item"), "typing @ to open the picker with matching rows", 5000);
	const rows = [...view.picker.list.querySelectorAll(".sb-ai-picker-item")];
	await t.check(rows.length > 0, `@${word} lists matching rows`, rows.length);
	await t.check(rows.every((row) => row.getBoundingClientRect().height > 25 || row.textContent.length < 40), "picker rows are not clipped to 25px");

	rows[0].dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
	rows[0].click();
	await pause(100);
	await t.check(view.attachments.length === 1, "choosing a row attaches it as a chip", view.attachments);
	await t.check(view.picker.root.hidden && !view.input.value.includes(`@${word}`), "the picker closes and removes @query", view.input.value);

	view.input.value = "@picker";
	view.input.setSelectionRange(view.input.value.length, view.input.value.length);
	view.input.dispatchEvent(new win.Event("input"));
	await t.waitFor(() => [...view.picker.list.querySelectorAll(".sb-ai-picker-item")].some((r) => r.textContent.includes(collectionName)), "the collection to be offered", 5000);
	const row = [...view.picker.list.querySelectorAll(".sb-ai-picker-item")].find((r) => r.textContent.includes(collectionName));
	row.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
	row.click();
	await pause(100);
	await t.check(view.attachments.some((a) => a.attachment.kind === "collection" && a.attachment.name === collectionName), "a collection attaches as a collection chip", view.attachments);
}
