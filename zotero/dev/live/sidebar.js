// dev/live/run.sh dev/live/sidebar.js 120 : the docked chat, the library filter and the search additions, in a real Zotero.
const sb = Zotero.SecondBrain, doc = win.document, ZP = Zotero.getActiveZoteroPane();
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
const rect = (el) => el?.getBoundingClientRect() ?? { width: 0, height: 0 };
const navButton = (sidenav) => doc.querySelector(`#${sidenav} .sb-chat-nav toolbarbutton`);

win.Zotero_Tabs.select("zotero-pane");
win.resizeTo(1400, 900);
await ZP.collectionsView.selectLibrary(Zotero.Libraries.userLibraryID);
await Zotero.Promise.delay(1000);
const regular = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).filter((i) => i.isRegularItem());
let paper, pdf;
for (const item of regular) {
	await item.loadDataType("childItems");
	for (const id of item.getAttachments()) {
		const a = Zotero.Items.get(id);
		if (a.isPDFAttachment() && await a.fileExists()) { paper = item; pdf = a; break; }
	}
	if (paper) break;
}
await ZP.selectItem(paper.id);
await Zotero.Promise.delay(800);

const host = sb.chatSidebars.get(win);
if (host.isOpen) host.toggle();
navButton("zotero-view-item-sidenav").doCommand();
await Zotero.Promise.delay(600);
const root = host.view.root;
const pane = rect(doc.getElementById("zotero-item-pane")), sidenav = rect(doc.getElementById("zotero-view-item-sidenav"));
check("opens from the library icon strip", host.isOpen);
const deck = rect(doc.getElementById("zotero-item-pane-content"));
check("docked along the bottom of the item pane", Math.abs(rect(root).bottom - pane.bottom) < 2 && Math.abs(rect(root).width - (pane.width - sidenav.width)) < 2 && rect(root).height > 200, `${Math.round(rect(root).width)}x${Math.round(rect(root).height)}`);
check("Zotero's item pane stays visible above it", deck.height > 100 && Math.abs(deck.bottom - rect(root.parentNode).top) < 3, `${Math.round(deck.height)}px`);
host.share = 0.3;
host.layout();
check("the split follows the resize share", Math.abs(rect(root.parentNode).height - Math.max(220, pane.height * 0.3)) < 3);
host.share = 0.55;
host.layout();
check("narrow layout below 560px", root.classList.contains("is-narrow"));

if (!host.view.historyCollapsed) host.view.setHistoryCollapsed(true);
host.view.historyToggle.click();
await Zotero.Promise.delay(200);
check("history drawer opens below the header", rect(host.view.side).top >= rect(host.view.head).bottom - 1 && rect(host.view.side).height > 0);
host.view.scroller.dispatchEvent(new win.PointerEvent("pointerdown"));
check("clicking the conversation closes the drawer", host.view.historyCollapsed);

await ZP.selectItem(regular.find((i) => i !== paper).id);
await Zotero.Promise.delay(600);
check("selecting another paper keeps the same chat", host.view.root === root && rect(root).height > 200);

await Zotero.Reader.open(pdf.id);
await Zotero.Promise.delay(4000);
win.ZoteroContextPane.collapsed = false;
await Zotero.Promise.delay(600);
check("moves into the reader's side pane", !!root.closest("#zotero-context-pane") && rect(root).height > 200);
root.dispatchEvent(new win.PointerEvent("pointerenter"));
check("offers the paper being read", host.view.attachButton.textContent === "Add this paper");
win.Zotero_Tabs.select("zotero-pane");
await Zotero.Promise.delay(600);
check("comes back to the library", !!root.closest("#zotero-item-pane"));

const fullCount = ZP.itemsView.rowCount;
const hits = await sb.searchAll("quantum dot", 10, "zotero");
const keys = await sb.papersInHits(hits);
await sb.showPapersInLibrary(keys);
await Zotero.Promise.delay(1500);
const shown = [];
for (let i = 0; i < ZP.itemsView.rowCount; i++) if (ZP.itemsView.getRow(i).ref.isTopLevelItem()) shown.push(ZP.itemsView.getRow(i).ref.key);
check("filters the library to exactly the found papers", shown.length === keys.length && shown.every((k) => keys.includes(k)), `${shown.length}/${keys.length}`);
check("filter editor stays collapsed", doc.getElementById("zotero-advanced-search-pane-deck").state === "collapsed");
await ZP.setAdvancedSearchState("closed");
await Zotero.Promise.delay(1500);
check("Zotero's close button clears it", ZP.itemsView.rowCount === fullCount);

const box = doc.createElement("div");
box.append(sb.renderSnippet(doc, "see [@a2020; @b2021] here"));
check("citekeys in snippets become links", box.querySelectorAll(".sb-cite-chip").length === 2);

host.toggle();
check("closes and gives the pane back", !host.isOpen && Math.abs(rect(doc.getElementById("zotero-item-pane-content")).height - pane.height) < 2);
const shot = async (r, file) => { const bmp = await win.browsingContext.currentWindowGlobal.drawSnapshot(new win.DOMRect(...r), 2, "white"); const c = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas"); c.width = bmp.width; c.height = bmp.height; c.getContext("2d").drawImage(bmp, 0, 0); const b = await new Promise((res) => c.toBlob(res, "image/png")); await IOUtils.write(file, new Uint8Array(await b.arrayBuffer())); };
if (Services.env.get("SB_LIVE_SHOT")) { host.toggle(); await Zotero.Promise.delay(800); await shot([900, 0, 500, 900], Services.env.get("SB_LIVE_SHOT")); host.toggle(); }
return results.join("\n");
