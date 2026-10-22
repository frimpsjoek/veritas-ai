/* global SB, Zotero, Services, IOUtils, PathUtils */
// Spec 003 C1/C2: the chat's empty state (mode icon and title at the top, suggestion pills above the message box),
// icons in the mode menu and history, the message box as one card, and the send button's states. Scripted
// provider, no model calls. Writes pictures to <harness dir>/look-<mode>-<light|dark>.png.

function scriptedProvider(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req) {
			state.inputs.push(req.input);
			yield { type: "text", delta: "A chat answer." };
			yield { type: "final", text: "A chat answer.", json: null, usage: {} };
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

async function run(t) {
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 800);
	Zotero.Prefs.clear("extensions.secondbrain.chatMode", true);
	const ai = await SB.ai();
	const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false, false);
	const paper = items.find((item) => item.isRegularItem());
	await Zotero.Items.loadDataTypes([paper]);
	const state = { inputs: [] };
	SB.agent.providers.set("fake", scriptedProvider(state));
	for (const role of ["chat", "ask", "lead", "researcher", "writer"]) await ai.providers.setRole(role, { provider: "fake", model: null });

	await win.ZoteroPane.selectItem(paper.id);
	const label = SB.shortLabel(paper) || paper.getField("title");
	const view = SB.openChat();
	await pause(500);

	// empty state, every mode
	for (const mode of ["chat", "ask", "report"]) {
		view.setMode(mode);
		const empty = view.thread.querySelector(".sb-ai-empty");
		const title = empty?.querySelector(".sb-ai-empty-title")?.textContent;
		await t.check(empty?.querySelector("svg.sb-ai-empty-icon") && title === view.modeInfo.label, `${mode}: the mode's icon and name head the empty chat`, title);
		const pills = [...view.thread.querySelectorAll(".sb-ai-pill")];
		const box = view.doc.querySelector(".sb-ai-box").getBoundingClientRect();
		const lastPill = pills.at(-1)?.getBoundingClientRect();
		await t.check(pills.length > 0 && box.top - lastPill.bottom < 40 && box.top > lastPill.bottom,
			`${mode}: suggestions sit just above the message box`, pills.map((p) => p.textContent).concat(lastPill && `gap ${Math.round(box.top - lastPill.bottom)}px`));
		await t.check(view.modeIcon.querySelector("path")?.getAttribute("d") === SB.ChatView.ICONS[mode], `${mode}: the mode menu shows the mode's icon`);
		for (const theme of ["light", "dark"]) {
			Services.prefs.setIntPref("ui.systemUsesDarkTheme", theme === "dark" ? 1 : 0);
			await pause(400);
			await snapshot(win, `look-${mode}-${theme}.png`);
		}
	}
	Services.prefs.clearUserPref("ui.systemUsesDarkTheme");

	// the composer is one card
	const composer = view.doc.querySelector(".sb-ai-composer");
	await t.check(win.getComputedStyle(composer).borderTopStyle === "none" || win.getComputedStyle(composer).borderTopWidth === "0px", "no divider above the message box");
	await t.check(view.modePick.closest(".sb-ai-box") && view.send.closest(".sb-ai-box"), "the mode menu and Send are inside the box");

	// send states
	view.setMode("chat");
	await t.check(view.send.dataset.state === "idle", "Send is muted while the box is empty");
	view.input.value = "hello";
	view.input.dispatchEvent(new win.Event("input"));
	await t.check(view.send.dataset.state === "ready", "Send is active once there is text");
	view.input.value = "";
	view.input.dispatchEvent(new win.Event("input"));

	// a pill naming the selected paper sends with the paper attached
	const pill = [...view.thread.querySelectorAll(".sb-ai-pill")].find((p) => p.textContent.includes(label));
	await t.check(!!pill, "a pill names the paper selected in the library", label);
	pill?.click();
	await t.waitFor(() => view.thread.querySelector(".sb-ai-md"), "the answer", 20000);
	const asked = view.thread.querySelector(".sb-ai-user");
	await t.check(asked?.textContent.includes(`Summarize ${label}`) && asked.querySelector(".sb-ai-chip"), "the pill sent its question with the paper attached", asked?.textContent);
	await t.check(!view.thread.querySelector(".sb-ai-pill"), "the suggestions leave once the chat starts");

	await view.refreshList();
	const row = view.list.querySelector(".sb-ai-conv");
	await t.check(row?.querySelector("svg.sb-ai-icon path")?.getAttribute("d") === SB.ChatView.ICONS.chat, "history rows carry the mode's icon");
	await snapshot(win, "look-thread.png");
	await SB.agent.shutdown();
}
