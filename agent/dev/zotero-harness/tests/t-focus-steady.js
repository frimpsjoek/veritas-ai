/* global SB, Zotero */
// Spec 003 F1: Focus hides the other item-pane sections and changes no pane size, so the note doesn't jump wider
// or narrower. A layout widened by an older version (the saved focusLayout pref) is put back once.

async function run(t) {
	const win = Zotero.getMainWindow();
	const doc = win.document;
	const pane = win.ZoteroPane;
	win.resizeTo(1400, 900);
	await t.waitFor(() => win.innerWidth >= 1300, "the window at 1400 px");
	SB.setFocus(false);

	const item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).find((i) => i.isRegularItem() && !i.deleted);
	await pane.selectItem(item.id);
	const editor = () => [...doc.querySelectorAll("#zotero-item-pane .sb-ed")].find((node) => node.getBoundingClientRect().width > 0);
	await t.waitFor(editor, "the note editor in the item pane", 20000);

	const splitter = doc.getElementById("zotero-collections-splitter");
	const measure = () => ({
		note: Math.round(editor().getBoundingClientRect().width),
		noteHeight: Math.round(editor().getBoundingClientRect().height),
		itemPane: Math.round(doc.getElementById("zotero-item-pane").getBoundingClientRect().width),
		collections: splitter.getAttribute("state") || "open",
	});
	// the note's frame loads after the section appears and then sizes itself; wait until it stops changing
	let last = "";
	await t.waitFor(async () => {
		const now = JSON.stringify(measure());
		const settled = now === last;
		last = now;
		await new Promise((resolve) => setTimeout(resolve, 700));
		return settled;
	}, "the note at its settled size", 20000);
	const before = measure();
	await t.log(`before: ${JSON.stringify(before)}`);

	SB.setFocus(true);
	await new Promise((resolve) => setTimeout(resolve, 500));
	const focused = measure();
	const hidden = [...editor().closest(".zotero-view-item").querySelectorAll(":scope > [data-pane]")]
		.filter((section) => section.dataset.pane !== SB.paneID).every((section) => section.getBoundingClientRect().height === 0);
	await t.check(hidden, "Focus hides the other sections");
	await t.check(JSON.stringify(focused) === JSON.stringify(before), "Focus on: note, item pane and collections pane keep their size", focused);

	SB.setFocus(false);
	await new Promise((resolve) => setTimeout(resolve, 500));
	const after = measure();
	await t.check(JSON.stringify(after) === JSON.stringify(before), "Focus off: still the same size", after);

	// an older version saved the layout it replaced; the next render puts it back and forgets it
	Zotero.Prefs.set("extensions.secondbrain.focusLayout", JSON.stringify({ collapsed: false, widths: { "zotero-item-pane": "480" } }), true);
	splitter.setAttribute("state", "collapsed");
	doc.getElementById("zotero-item-pane").setAttribute("width", "900");
	SB.applyFocus(doc);
	await new Promise((resolve) => setTimeout(resolve, 500));
	await t.check(doc.getElementById("zotero-item-pane").getAttribute("width") === "480" && splitter.getAttribute("state") !== "collapsed"
		&& !Zotero.Prefs.get("extensions.secondbrain.focusLayout", true), "a layout saved by the old Focus is restored once and cleared");
}
