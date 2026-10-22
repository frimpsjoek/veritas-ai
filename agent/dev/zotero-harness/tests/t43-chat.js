/* global SB, Zotero, IOUtils, PathUtils */
// T4.3: the Second Brain AI tab in local mode, against a scripted provider (no model calls): send, stream,
// citations, Stop, Ask's not-found, history reload, and the switch to a server runtime only once idle.
// Writes a picture of the tab to <harness dir>/t43-chat.png.

function scriptedProvider(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req, signal) {
			state.inputs.push(req.input);
			yield { type: "activity", id: "a1", phase: "start", kind: "library", label: `Searching your papers for "${state.query}"` };
			yield { type: "activity", id: "a1", phase: "end", kind: "library", label: `Searching your papers for "${state.query}"`, ok: true };
			for (const word of state.words) {
				if (signal.aborted) { yield { type: "failed", error: { kind: "cancelled", message: "Interrupted." } }; return; }
				yield { type: "text", delta: word };
				await new Promise((resolve) => setTimeout(resolve, state.delay));
			}
			if (signal.aborted) { yield { type: "failed", error: { kind: "cancelled", message: "Interrupted." } }; return; }
			const text = req.outputSchema ? JSON.stringify({ status: "not_found", markdown: "Your library doesn't cover this." }) : state.words.join("");
			yield { type: "final", text, json: null, usage: {} };
		},
	};
}

async function snapshot(win, path) {
	const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
	canvas.width = win.innerWidth;
	canvas.height = win.innerHeight;
	canvas.getContext("2d").drawWindow(win, 0, 0, canvas.width, canvas.height, "white");
	const base64 = canvas.toDataURL("image/png").split(",")[1];
	await IOUtils.write(path, Uint8Array.from(win.atob(base64), (c) => c.charCodeAt(0)));
}

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 820);
	const ai = await SB.ai();
	await t.check(ai.where === "local", "no server: the runtime inside Zotero is used");

	const [paperID] = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false, true).then((ids) => ids.filter((id) => Zotero.Items.get(id).isRegularItem()).slice(0, 1));
	const paper = Zotero.Items.get(paperID);
	await Zotero.Items.loadDataTypes([paper]);
	const key = paper.getField("citationKey") || paper.key;
	const state = { inputs: [], query: "sleep", delay: 20, words: ["Two studies agree ", `[@${key}]`, " but one does not ", "[@madeUp2099]", ". Again ", `[@${key}]`, "."] };
	SB.agent.providers.set("fake", scriptedProvider(state));
	// T6.2: role -> provider/model now lives in the one persisted settings.json (settings.js), read live by
	// getRoleModel on every turn, not the old per-key Zotero prefs this test used to set directly.
	await ai.providers.setRole("chat", { provider: "fake", model: null });
	await ai.providers.setRole("ask", { provider: "fake", model: null });

	const toolbarButton = win.document.getElementById("second-brain-tb-ai");
	await t.check(toolbarButton?.localName === "toolbarbutton", "a toolbar button opens the tab");
	await snapshot(win, PathUtils.join(PathUtils.parent(Zotero.DataDirectory.dir), "t43-library.png")).catch(() => {});

	const view = SB.openChat({ attach: [paper] });
	await t.check(win.Zotero_Tabs._getTab(view.tabID)?.tab?.type === "second-brain-ai", "the tab opens as a Zotero tab");
	await t.check(view.chips.children.length === 1, "the paper from the context menu is attached", view.chips.textContent);

	view.input.value = "How do these compare?";
	view.send.click();
	await t.waitFor(() => !view.running && view.thread.querySelector(".sb-ai-md"), "the answer");
	await t.check(state.inputs[0].includes(`[@${key}]`), "the attached paper reaches the model as a citekey", state.inputs[0]);
	// spec 007 E2: activity is folded to one line per step ("Ran analysis · Conducted N searches"), not one row
	// per tool call; expanding (not exercised here) shows the raw per-call labels.
	await t.check(view.thread.querySelector(".sb-ai-activity-label")?.textContent === "Ran analysis · Conducted 1 search", "tool activity folds to one plain-language line",
		view.thread.querySelector(".sb-ai-activity-label")?.textContent);
	const cites = [...view.thread.querySelectorAll(".sb-ai-md .cite")];
	await t.check(cites.length === 3 && !cites[0].classList.contains("missing") && cites[1].classList.contains("missing"), "a real citation is a link; a made-up one is marked",
		cites.map((c) => `${c.textContent}${c.classList.contains("missing") ? " (missing)" : ""}`));
	await t.sleep(200);
	await t.check(cites[0].textContent === cites[2].textContent && cites[2].textContent !== key, "every mention of a paper shows its author-year label", [cites[0].textContent, cites[2].textContent]);
	await t.check(/couldn't be found/.test(view.thread.querySelector(".sb-ai-notice")?.textContent), "the answer says a citation couldn't be found");
	await t.waitFor(() => view.list.querySelector(".sb-ai-conv"), "the chat in the list");
	await t.check(view.list.querySelector(".sb-ai-conv-title").textContent === "How do these compare?", "the chat is named after its first message");

	await snapshot(win, PathUtils.join(PathUtils.parent(Zotero.DataDirectory.dir), "t43-chat.png")).then(() => t.log("snapshot written"), (error) => t.log(`no snapshot: ${error.message}`));

	cites[0].click();
	await t.waitFor(() => win.Zotero_Tabs.selectedID === "zotero-pane" && Zotero.getActiveZoteroPane().getSelectedItems()[0]?.id === paper.id, "the paper selected", 5000)
		.then(() => t.check(true, "clicking a citation selects the paper in the library"), (error) => t.check(false, "clicking a citation selects the paper in the library", error.message));
	win.Zotero_Tabs.select(view.tabID);

	state.delay = 400;
	view.input.value = "Keep going";
	view.send.click();
	await t.sleep(300);
	await t.check(view.send.getAttribute("aria-label") === "Stop" && SB.agent.busy === 1, "while answering, Send becomes Stop");
	view.send.click();
	await t.waitFor(() => !view.running, "the stop");
	await t.check(view.thread.lastElementChild.querySelector(".sb-ai-notice").textContent === "Stopped." && SB.agent.busy === 0, "Stop ends the turn");

	const id = view.conversationID;
	view.setMode("ask");
	state.delay = 5;
	view.input.value = "What does my library say about volcanoes?";
	view.send.click();
	await t.waitFor(() => !view.running && view.thread.querySelector(".sb-ai-badge"), "the ask answer");
	await t.check(view.thread.querySelector(".sb-ai-badge").textContent === "Not in your library", "Ask says plainly when the library has no answer");

	await view.openConversation(id);
	await t.check(view.thread.querySelectorAll(".sb-ai-user").length === 2 && view.thread.querySelectorAll(".sb-ai-md .cite").length === 3, "a chat reloads from its stored history");

	// The server appears while a turn is running: stay local until it ends, then hand the chats over once.
	const adoptCalls = [];
	const serverRuntime = {
		where: "server",
		conversations: {
			list: async () => [], load: async () => [], create: async () => "S1", rename: async () => {}, remove: async () => {},
			async *send() {}, adopt: async (files) => { adoptCalls.push(files.map((f) => f.id)); return files.map((f) => f.id); },
		},
		async *ask() {},
	};
	state.delay = 300;
	view.setMode("chat");
	view.input.value = "Long answer";
	view.send.click();
	await t.sleep(200);
	SB.agent.remoteFactory = () => serverRuntime;
	SB.agent.pinged = { at: Date.now(), ok: true };
	await t.check((await SB.ai()).where === "local", "while a turn runs, the runtime does not switch");
	await t.waitFor(() => !view.running, "the long answer");
	const next = await SB.ai();
	await t.check(next.where === "server", "once idle, the server's runtime takes over");
	await t.check(adoptCalls.length === 1 && adoptCalls[0].includes(id), "local chats are handed to the server", adoptCalls);
	const left = await IOUtils.getChildren(PathUtils.join(SB.agent.dataDir, "chats")).catch(() => []);
	const moved = await IOUtils.getChildren(PathUtils.join(SB.agent.dataDir, "chats-adopted"));
	await t.check(left.length === 0 && moved.length >= 2, "handed-over chats move aside, kept", { left: left.length, moved: moved.length });
	await SB.agent.adoptInto(serverRuntime);
	await t.check(adoptCalls.length === 1, "handing over again sends nothing twice");

	SB.agent.remoteFactory = null;
	SB.agent.pinged = { at: 0, ok: false };
	await t.check((await SB.ai()).where === "local", "server gone: back to the runtime inside Zotero");
	await (await SB.ai()).providers.setRole("chat", { provider: "codex", model: null });
	await (await SB.ai()).providers.setRole("ask", { provider: "codex", model: null });
	win.Zotero_Tabs.close(view.tabID);
	await t.check(SB.chatTab === null, "closing the tab clears it");
}
