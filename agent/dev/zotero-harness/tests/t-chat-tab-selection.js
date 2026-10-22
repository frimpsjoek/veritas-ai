/* global SB, Zotero */
// Spec 003 follow-up: the suggestion pills in the full chat tab follow the library selection. The tab stays open
// while the user picks another paper in the library and comes back to it.

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(t) {
	const win = Zotero.getMainWindow();
	const ZP = win.ZoteroPane;
	win.Zotero_Tabs.select("zotero-pane");
	Zotero.Prefs.set("extensions.secondbrain.chatMode", "chat", true);

	const regular = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).filter((i) => i.isRegularItem() && !i.deleted);
	const [a, b] = regular;
	await Zotero.Items.loadDataTypes([a, b]);
	const label = (item) => SB.shortLabel(item) || item.getField("title");
	t.log("papers:", label(a), "|", label(b));
	await t.check(label(a) !== label(b), "two papers with different labels");

	await ZP.selectItem(a.id);
	await pause(600);
	const view = SB.ChatTab.open(SB);
	await pause(800);
	const tabID = SB.chatTab.tabID;
	const pillText = () => [...view.thread.querySelectorAll(".sb-ai-pill")].map((p) => p.textContent).join(" | ");
	await t.check(pillText().includes(label(a)), "the pills name the paper selected when the tab opened", pillText());

	win.Zotero_Tabs.select("zotero-pane");
	await pause(400);
	await ZP.selectItem(b.id);
	await pause(400);
	win.Zotero_Tabs.select(tabID);
	await t.waitFor(() => pillText().includes(label(b)), "the pills to follow the new selection", 5000)
		.catch(() => {});
	await t.check(pillText().includes(label(b)) && !pillText().includes(label(a)), "back on the tab, the pills name the paper now selected", pillText());

	win.Zotero_Tabs.close(tabID);
}
