/* global SB, Zotero, PathUtils */
// Spec 008 follow-up: in the reader, the docked chat's Current chip names the paper being read. The harness
// library has no PDFs, so this imports fixtures/reader-fixture.pdf under a new paper in the scratch library.

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(t) {
	const win = Zotero.getMainWindow();
	const doc = win.document;
	win.resizeTo(1400, 900);
	win.Zotero_Tabs.select("zotero-pane");

	await t.waitFor(() => !Zotero.DB.inTransaction(), "Zotero's startup transactions to finish", 120000);
	await pause(3000);
	const title = "Harness Reader Fixture Paper";
	const paper = new Zotero.Item("journalArticle");
	paper.setField("title", title);
	await paper.saveTx();
	const fixture = PathUtils.join(PathUtils.parent(PathUtils.parent(Zotero.Prefs.get("extensions.sbtest.script", true))), "fixtures", "reader-fixture.pdf");
	const pdf = await Zotero.Attachments.importFromFile({ file: fixture, parentItemID: paper.id });
	await t.check(await pdf.fileExists() && pdf.isPDFAttachment(), "the fixture PDF is attached to the new paper");

	const host = SB.chatSidebars.get(win);
	if (!host.isOpen) host.toggle();
	const view = host.view;
	const chip = () => view.chips.querySelector(".sb-ai-context");

	await Zotero.Reader.open(pdf.id);
	await t.waitFor(() => win.Zotero_Tabs.selectedType === "reader", "the reader tab", 30000);
	await pause(2500);
	win.ZoteroContextPane.collapsed = false;
	await pause(800);
	view.refreshContext();
	await t.check(!!view.root.closest("#zotero-context-pane"), "the chat is docked in the reader's pane");
	await t.waitFor(() => chip(), "a context chip", 10000);
	const text = chip().textContent;
	await t.check(text.includes("Current") && text.includes(SB.shortLabel(paper) || title), "the chip names the paper being read and says Current", text);
	await t.check(chip().querySelector(".sb-ai-context-title")?.textContent === (SB.shortLabel(paper) || title), "its title is the paper's label", chip().querySelector(".sb-ai-context-title")?.textContent);

	win.Zotero_Tabs.close(win.Zotero_Tabs.selectedID);
	await pause(800);
	host.toggle();
	await paper.eraseTx();
}
