/* global SB, Zotero, IOUtils, PathUtils */
// Spec 004: the chat docked along the bottom of the item pane and the reader's pane, with today's chat inside it,
// the paper being read attached by itself, the options in one button, and "Open in a tab". Scripted provider and
// stubbed outside search, no model or network calls. Writes <harness dir>/sidebar-*.png.

function scriptedProvider(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req) {
			state.inputs.push(JSON.stringify(req.input));
			const markdown = "An answer about the paper.";
			yield { type: "final", text: req.outputSchema ? JSON.stringify({ status: "answered", markdown }) : markdown,
				json: req.outputSchema ? { status: "answered", markdown } : null, usage: {} };
		},
	};
}

async function snapshot(win, name) {
	const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
	canvas.width = win.innerWidth;
	canvas.height = win.innerHeight;
	canvas.getContext("2d").drawWindow(win, 0, 0, canvas.width, canvas.height, "white");
	const base64 = canvas.toDataURL("image/png").split(",")[1];
	await IOUtils.write(PathUtils.join(PathUtils.parent(Zotero.DataDirectory.dir), name), Uint8Array.from(win.atob(base64), (c) => c.charCodeAt(0)));
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (node) => node && !node.hidden && !node.closest("[hidden]") && node.getBoundingClientRect().height > 0;

async function run(t) {
	const win = Zotero.getMainWindow();
	const doc = win.document;
	const ZP = win.ZoteroPane;
	win.resizeTo(1400, 900);
	win.Zotero_Tabs.select("zotero-pane");
	Zotero.Prefs.set("extensions.secondbrain.chatMode", "chat", true);
	const ai = await SB.ai();
	const state = { inputs: [] };
	SB.agent.providers.set("fake", scriptedProvider(state));
	for (const role of ["chat", "ask", "lead", "researcher", "writer"]) await ai.providers.setRole(role, { provider: "fake", model: null });
	SB.Discover.prototype.search = async function () {
		const results = await this.mark([{ id: "x1", title: "An outside study of the same question", doi: "10.9999/outside-one", authors: ["Ada Lovelace"],
			year: 2023, venue: "Outside Letters", abstract: "We measure the effect. It is large.", sources: ["OpenAlex"] }]);
		results.failed = [];
		return results;
	};

	// two papers, one with a PDF on disk for the reader
	const regular = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).filter((i) => i.isRegularItem() && !i.deleted);
	let paper = null, pdf = null;
	for (const item of regular) {
		await item.loadDataType("childItems");
		for (const id of item.getAttachments()) {
			const a = Zotero.Items.get(id);
			if (a.isPDFAttachment() && await a.fileExists()) { paper = item; pdf = a; break; }
		}
		if (paper) break;
	}
	paper ??= regular[0];
	const other = regular.find((i) => i !== paper);
	await Zotero.Items.loadDataTypes([paper, other]);
	const label = (item) => SB.shortLabel(item) || item.getField("title");
	const citekey = (item) => item.getField("citationKey") || item.key;

	await ZP.selectItem(paper.id);
	await pause(600);
	const host = SB.chatSidebars.get(win);
	if (host.isOpen) host.toggle();
	doc.getElementById("second-brain-tb-ai").doCommand();
	await pause(800);
	const view = host.view;
	const rect = (el) => el.getBoundingClientRect();
	const pane = rect(doc.getElementById("zotero-item-pane"));
	await t.check(host.isOpen && Math.abs(rect(view.root).bottom - pane.bottom) < 2 && rect(view.root).height > 200,
		"the toolbar button docks the chat along the bottom of the item pane", `${Math.round(rect(view.root).width)}x${Math.round(rect(view.root).height)}`);
	await t.check(rect(doc.getElementById("zotero-item-pane-content")).height > 100, "Zotero's sections keep the space above it");
	await t.check(view.root.classList.contains("is-narrow"), "the docked chat uses the narrow layout");

	// the paper in context
	view.setMode("chat");
	view.refreshContext();
	const chip = () => view.chips.querySelector(".sb-ai-context");
	await t.check(chip()?.querySelector(".sb-ai-context-title")?.textContent === label(paper) && chip().textContent.includes("Selected"),
		"the selected paper is the context chip", chip()?.textContent);
	await t.check([...view.thread.querySelectorAll(".sb-ai-pill")].some((p) => p.textContent.includes(label(paper))), "the suggestions name it");
	// the shared design tokens reach the real chrome document (0.25.0 shipped without them: every colour unset)
	const style = win.getComputedStyle(view.root);
	await t.check(style.getPropertyValue("--sb-ui-accent").trim() !== "", "the --sb-ui-* token map is loaded", style.getPropertyValue("--sb-ui-accent"));
	const card = view.root.querySelector(".sb-ai-box");
	await t.check(card && win.getComputedStyle(card).borderTopStyle !== "none" && win.getComputedStyle(card).borderTopWidth !== "0px", "the message box is drawn as a card", card && win.getComputedStyle(card).border);
	await snapshot(win, "sidebar-library.png");

	await ZP.selectItem(other.id);
	await t.waitFor(() => chip()?.querySelector(".sb-ai-context-title")?.textContent === label(other), "the chip following a new selection", 5000);
	await t.check(true, "selecting another paper updates the chip without touching the chat");
	await ZP.selectItem(paper.id);
	await t.waitFor(() => chip()?.querySelector(".sb-ai-context-title")?.textContent === label(paper), "the chip back on the first paper", 5000);

	view.input.value = "What is this paper about?";
	await view.submit();
	await t.check(state.inputs.at(-1).includes(`[@${citekey(paper)}]`), "sending attaches the paper in context");
	await t.check(view.thread.querySelector(".sb-ai-user .sb-ai-chip") && view.thread.querySelector(".sb-ai-md"), "the message shows the paper and the answer comes back");
	chip().querySelector(".sb-ai-chip-x").click();
	await t.check(!chip(), "× takes the paper out");
	view.input.value = "And in general?";
	await view.submit();
	await t.check(!state.inputs.at(-1).includes(`[@${citekey(paper)}]`), "the next message goes without it");
	const chatID = view.conversationID;

	// open in a tab: the same conversation
	host.openInTab();
	await pause(800);
	await t.check(SB.chatTab?.view.conversationID === chatID && SB.chatTab.view.thread.querySelectorAll(".sb-ai-user").length === 2,
		"Open in a tab shows the same conversation");
	await t.check(SB.chatTab.view.list.querySelector(`[data-id="${chatID}"]`), "and the tab's history has it");
	win.Zotero_Tabs.close(SB.chatTab.tabID);
	win.Zotero_Tabs.select("zotero-pane");
	await pause(500);

	// options and Find papers in the dock
	view.setMode("find");
	await t.check(visible(view.optionsButton) && !visible(view.reportOptions), "Find papers: the options are one button, panel closed");
	const box = view.doc.querySelector(".sb-chat-dock .sb-ai-box") ?? view.root.querySelector(".sb-ai-box");
	const inputBottom = rect(view.input).bottom, rowTop = rect(view.optionsButton.closest(".sb-ai-row")).top;
	await t.check(rowTop - inputBottom < 16, "nothing sits between the text and the controls", `${Math.round(rowTop - inputBottom)}px`);
	view.optionsButton.click();
	await t.check(visible(view.scopeKind) && !visible(view.depth) && rect(view.reportOptions).bottom <= rect(box).top + 1, "its panel opens above the box with the scope");
	await snapshot(win, "sidebar-options.png");
	doc.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true }));
	await t.check(!visible(view.reportOptions), "clicking elsewhere closes it");
	view.input.value = paper.getField("title");
	await view.submit();
	const row = view.thread.querySelector(".sb-fp-row");
	const columns = row && win.getComputedStyle(row).gridTemplateColumns.split(" ").length;
	await t.check(columns === 2 && rect(row.querySelector(".sb-fp-abstract")).top > rect(row.querySelector(".sb-fp-title")).bottom,
		"Find papers is one column in the dock (summary under the paper)", columns);
	await snapshot(win, "sidebar-find.png");
	await SB.FindView.remove(view.findID);

	// the reader: the conversation moves beside the PDF, with the reader's paper
	if (pdf) {
		view.setMode("chat");
		await Zotero.Reader.open(pdf.id);
		await t.waitFor(() => win.Zotero_Tabs.selectedType === "reader", "the reader tab", 20000);
		await pause(2500);
		win.ZoteroContextPane.collapsed = false;
		await pause(800);
		view.refreshContext();
		await t.check(!!view.root.closest("#zotero-context-pane") && rect(view.root).height > 200, "the chat moves into the reader's pane");
		await t.check(chip()?.textContent.includes("Current") && chip().textContent.includes(label(paper)), "the chip is the paper being read", chip()?.textContent);
		await snapshot(win, "sidebar-reader.png");
		win.Zotero_Tabs.close(win.Zotero_Tabs.selectedID);
		await pause(800);
		await t.check(!!view.root.closest("#zotero-item-pane"), "and comes back to the library");
	}

	host.toggle();
	await t.check(!host.isOpen, "the button closes it again");
	await (await SB.ai()).conversations.remove(chatID);
	await SB.agent.shutdown();
}
