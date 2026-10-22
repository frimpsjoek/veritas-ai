/* global SB, Zotero, IOUtils, PathUtils */
// Spec 011 U5 (New from selection) in real Zotero. Three library items are selected; the empty chat names them in a
// card ("3 papers selected") and "Chat with these" starts a new session over exactly those papers. Back in the library
// the item context menu's "Second Brain AI" submenu starts "Extract data" (Columns popover open) and "Write a report"
// (a review started over the same set). Scripted provider, no model calls. Writes pictures to
// <harness dir>/new-from-selection-*.png.

function scriptedProvider() {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req) {
			const props = req.outputSchema?.properties ?? {};
			if (props.questions) { // the clarify turn of a report: a clear question asks nothing
				const json = { questions: [] };
				yield { type: "final", text: JSON.stringify(json), json, usage: {} };
				return;
			}
			yield { type: "text", delta: "An answer." };
			yield { type: "final", text: "An answer.", json: null, usage: {} };
		},
	};
}

async function snapshot(win, name) {
	const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
	canvas.width = win.innerWidth;
	canvas.height = win.innerHeight;
	canvas.getContext("2d").drawWindow(win, 0, 0, canvas.width, canvas.height, "white");
	const base64 = canvas.toDataURL("image/png").split(",")[1];
	const path = PathUtils.join(PathUtils.parent(Zotero.DataDirectory.dir), name);
	await IOUtils.write(path, Uint8Array.from(win.atob(base64), (c) => c.charCodeAt(0)));
	return path;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 900);
	Zotero.Prefs.clear("extensions.secondbrain.chatMode", true);
	const ai = await SB.ai();
	SB.agent.providers.set("fake", scriptedProvider());
	for (const role of ["chat", "ask", "lead", "researcher", "writer"]) await ai.providers.setRole(role, { provider: "fake", model: null });

	const ZP = Zotero.getActiveZoteroPane();
	const ids = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false, true);
	const items = (await Zotero.Items.getAsync(ids)).filter((item) => item.isRegularItem()).slice(0, 3);
	await Zotero.Items.loadDataTypes(items);
	await t.check(items.length === 3, "the library has three regular items to select", items.length);
	const select = async () => {
		win.Zotero_Tabs.select("zotero-pane");
		await ZP.selectItems(items.map((item) => item.id));
		await t.waitFor(() => ZP.getSelectedItems().length === 3, `three items selected in the library (now ${ZP.getSelectedItems().length})`, 10000);
	};
	const sessionsBefore = (await ai.conversations.list()).length;

	// ---- the card in the empty chat
	await select();
	let view = SB.openChat();
	await t.waitFor(() => view.root.querySelectorAll(".sb-ai-selcard button").length === 3, "the selection card with three buttons");
	const card = view.root.querySelector(".sb-ai-selcard");
	await t.check(card.querySelector(".sb-ai-selcard-title").textContent === "3 papers selected", "the card says 3 papers selected", card.textContent);
	const labels = [...card.querySelectorAll("button")].map((b) => b.textContent);
	await t.check(JSON.stringify(labels) === JSON.stringify(["Chat with these", "Extract data", "Write a report"]), "it offers chat, extract and report", labels);
	const style = win.getComputedStyle(card.querySelector("button"));
	await t.check(style.whiteSpace === "normal" && (style.maxHeight === "none" || parseFloat(style.maxHeight) > 25), "its buttons wrap and are not capped at 25px", `${style.whiteSpace} ${style.maxHeight}`);
	await t.check(!/session|import|artifact/i.test(card.textContent), "no jargon on the card");
	await t.check(view.root.querySelectorAll(".sb-ai-selcard").length === 1, "one card only");
	const cardShot = await snapshot(win, "new-from-selection-card.png").catch(() => null);

	// ---- Chat with these
	[...card.querySelectorAll("button")][0].click();
	await t.waitFor(() => view.sessionID && view.root.querySelector(".sb-art"), "a new session with its panel open", 30000);
	const first = view.sessionID;
	const records = await ai.conversations.load(first);
	const step = records.find((r) => r.type === "step" && r.step?.kind === "import") ?? records.find((r) => JSON.stringify(r).includes('"selection"'));
	await t.check(JSON.stringify(step ?? {}).includes('"from":"selection"'), "the session starts with an import from the selection", JSON.stringify(step ?? records.map((r) => r.type)));
	const sessionView = await ai.sessions.view(first);
	const set = sessionView.results.find((r) => r.kind === "papers");
	await t.check(set && set.ref.id === "R1", "the session holds the paper set as R1", JSON.stringify(sessionView.results.map((r) => r.ref)));
	const result = await ai.sessions.result?.(first, set.ref).catch(() => null);
	const rowCount = result?.rows?.length ?? set.rows ?? set.count;
	await t.check(rowCount === 3, "the set has the three selected papers", String(rowCount));
	const tabs = [...view.root.querySelectorAll(".sb-art-tabs .sb-art-tab")];
	await t.check(/Chat with papers/.test(tabs.find((b) => b.classList.contains("is-active") || b.getAttribute("aria-selected") === "true")?.textContent ?? ""), "the Chat with papers tab is open", tabs.map((b) => b.className + ":" + b.textContent));
	await t.check((await ai.conversations.list()).length === sessionsBefore + 1, "exactly one new session was made");

	// ---- the item context menu
	await select();
	const menuEl = win.document.getElementById("zotero-itemmenu");
	await ZP.buildItemContextMenu();
	await pause(300);
	await t.log("menus:", [...menuEl.querySelectorAll("menu")].map((m) => [...m.attributes].map((a) => a.name + "=" + a.value).join(" ")));
	const submenu = [...menuEl.querySelectorAll("menu")].find((m) => m.getAttribute("data-l10n-id") === "second-brain-menu-ai");
	await t.check(!!submenu, "the item menu has a Second Brain AI submenu", [...menuEl.children].map((c) => c.id || c.localName).join(","));
	submenu?.menupopup?.dispatchEvent(new win.Event("popupshowing", { bubbles: false }));
	await pause(300);
	await t.log("submenu:", submenu?.childElementCount, [...(submenu?.querySelectorAll("*") ?? [])].map((e) => e.localName + ":" + (e.getAttribute("data-l10n-id") ?? "") + ":" + (e.getAttribute("label") ?? "")));
	const entries = [...(submenu?.querySelectorAll("menuitem") ?? [])];
	const entryIDs = entries.map((e) => e.getAttribute("data-l10n-id"));
	await t.check(JSON.stringify(entryIDs) === JSON.stringify(["second-brain-menu-ask", "second-brain-menu-chat-with", "second-brain-menu-extract", "second-brain-menu-report"]), "with Ask, Chat, Extract and Report entries", entryIDs);
	const shown = (await Promise.all(entries.map(async (e) => { await e.ownerDocument.l10n?.translateElements?.([e]); return e.getAttribute("label"); }))).join("|");
	await t.check(/Extract Data From These Papers/.test(shown) && /Write a Report on These Papers/.test(shown), "the labels read in plain words", shown);
	const popup = submenu?.menupopup;
	let menuShot = null;
	if (popup) {
		submenu.open = true;
		popup.openPopup?.(submenu, "end_before");
		await pause(500);
		menuShot = await snapshot(win, "new-from-selection-menu.png").catch(() => null);
		popup.hidePopup?.();
	}
	const click = (id) => entries.find((e) => e.getAttribute("data-l10n-id") === id).doCommand();

	// ---- Extract data
	click("second-brain-menu-extract");
	await t.waitFor(() => SB.chatTab?.view?.sessionID && SB.chatTab.view.sessionID !== first, "a second session", 30000);
	view = SB.chatTab.view;
	const second = view.sessionID;
	await t.waitFor(() => view.root.querySelector(".sb-col-pop"), "the Columns popover", 30000);
	await t.check(true, "Extract data opened the Columns popover");
	await t.check((await ai.conversations.list()).length === sessionsBefore + 2, "the second start made one more session");
	await snapshot(win, "new-from-selection-extract.png").catch(() => {});

	// ---- Write a report
	await select();
	await ZP.buildItemContextMenu();
	await pause(300);
	const again = [...win.document.getElementById("zotero-itemmenu").querySelectorAll("menu")].find((m) => m.getAttribute("data-l10n-id") === "second-brain-menu-ai");
	again.menupopup.dispatchEvent(new win.Event("popupshowing"));
	await pause(300);
	const reviewsBefore = (await ai.reviews.list()).length;
	[...again.querySelectorAll("menuitem")].find((e) => e.getAttribute("data-l10n-id") === "second-brain-menu-report").doCommand();
	await t.waitFor(async () => (await ai.reviews.list()).length === reviewsBefore + 1, "one new review", 60000);
	const review = (await ai.reviews.list())[0];
	const request = JSON.parse(await IOUtils.readUTF8(PathUtils.join(Zotero.DataDirectory.dir, "second-brain", "reviews", review.id, "request.json")));
	const third = request.session;
	await t.check(third && third !== first && third !== second, "the report has its own new session", third);
	await t.check(request.on?.id === "R1", "the review is tied to that session and its R1 set", JSON.stringify({ session: request.session, on: request.on }));
	await t.check((await ai.conversations.list()).length === sessionsBefore + 3, "three starts, three sessions");

	t.log(`pictures: ${cardShot} ${menuShot}`);
}
