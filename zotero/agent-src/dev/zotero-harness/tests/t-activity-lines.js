/* global SB, Zotero, IOUtils, PathUtils */
// Spec 007 E2: activity lines + folded reasoning. A streaming turn with several tool calls (two searches, one
// read) plus reasoning folds to ONE line while streaming and after it ends; clicking expands it (reasoning +
// each raw label); reopening the chat from its JSONL folds identically (record.lines, not one row per call).
// Scripted provider, no model calls. Writes a picture to <harness dir>/t-activity-lines.png.

function scriptedProvider(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req, signal) {
			state.inputs.push(req.input);
			yield { type: "reasoning", delta: "I should check the library before answering. " };
			yield { type: "activity", id: "a1", phase: "start", kind: "library", label: 'Searching your papers for "sleep"' };
			await new Promise((resolve) => setTimeout(resolve, 30));
			yield { type: "activity", id: "a1", phase: "end", kind: "library", label: 'Searching your papers for "sleep"', ok: true };
			yield { type: "activity", id: "a2", phase: "start", kind: "scholarly", label: 'Searching the literature for "sleep"' };
			await new Promise((resolve) => setTimeout(resolve, 30));
			yield { type: "activity", id: "a2", phase: "end", kind: "scholarly", label: 'Searching the literature for "sleep"', ok: true };
			yield { type: "activity", id: "a3", phase: "start", kind: "read", label: "Reading a source" };
			await new Promise((resolve) => setTimeout(resolve, 30));
			yield { type: "activity", id: "a3", phase: "end", kind: "read", label: "Reading a source", ok: true };
			if (signal.aborted) { yield { type: "failed", error: { kind: "cancelled", message: "Interrupted." } }; return; }
			yield { type: "text", delta: "Three sources agree." };
			yield { type: "final", text: "Three sources agree.", json: null, usage: {} };
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

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1100, 820);
	const ai = await SB.ai();
	await t.check(ai.where === "local", "no server: the runtime inside Zotero is used");

	const state = { inputs: [] };
	SB.agent.providers.set("fake", scriptedProvider(state));
	await ai.providers.setRole("chat", { provider: "fake", model: null });

	const view = SB.openChat({});
	view.setMode("chat");
	view.input.value = "What does the literature say about sleep?";
	view.send.click();

	// While the turn is running, the just-started call's own label is the (single-line) detail -- not the
	// eventual "Conducted N searches" summary (spec 007 §3.2 rule 3).
	await t.waitFor(() => view.thread.querySelector(".sb-ai-activity"), "an activity line appears");
	await t.check(view.thread.querySelectorAll(".sb-ai-activity").length === 1, "several tool calls in one turn fold to one line while streaming",
		view.thread.querySelectorAll(".sb-ai-activity").length);

	await t.waitFor(() => !view.running && view.thread.querySelector(".sb-ai-md"), "the answer");
	const rows = view.thread.querySelectorAll(".sb-ai-activity");
	await t.check(rows.length === 1, "still one line once the turn ends", rows.length);
	const label = rows[0].querySelector(".sb-ai-activity-label")?.textContent;
	await t.check(label === "Ran analysis · Conducted 2 searches · read 1 source", "the folded detail matches spec 007 §3.2 rule 2", label);

	// Collapsed by default (spec 007 §3.2 rule 5): the reasoning/labels body is not shown until clicked.
	const body = rows[0].querySelector(".sb-ai-activity-body");
	await t.check(win.getComputedStyle(body).display === "none", "the expanded body is collapsed by default (computed style)", win.getComputedStyle(body).display);
	rows[0].querySelector(".sb-ai-activity-chevron").click();
	await t.check(win.getComputedStyle(body).display !== "none", "clicking the chevron expands it (computed style)", win.getComputedStyle(body).display);
	const reasoning = body.querySelector(".sb-ai-activity-reasoning")?.textContent ?? "";
	await t.check(reasoning.includes("check the library before answering"), "expanding shows the folded reasoning, in grey", reasoning);
	const items = [...body.querySelectorAll(".sb-ai-step")].map((n) => n.textContent); // rows of the live/folded list (past tense once done)
	await t.check(items.length === 3, "expanding lists the individual tool-call labels", items);
	const reasoningColor = win.getComputedStyle(body.querySelector(".sb-ai-activity-reasoning")).color;
	const textColor = win.getComputedStyle(view.thread.querySelector(".sb-ai-md")).color;
	await t.check(reasoningColor !== textColor, "the reasoning is visually distinct (muted) from the answer text (computed style)", { reasoningColor, textColor });

	await snapshot(win, "t-activity-lines.png").then(() => t.log("snapshot written"), (error) => t.log(`no snapshot: ${error.message}`));

	// Reopening the chat from its JSONL folds the same way it streamed (record.lines, spec 007 §3.1/§3.2), not
	// one row per tool call the way a pre-E2 record would.
	const id = view.conversationID;
	await view.openConversation(id);
	const reopened = view.thread.querySelectorAll(".sb-ai-activity");
	await t.check(reopened.length === 1, "reopening the chat still shows one folded line", reopened.length);
	const reopenedLabel = reopened[0].querySelector(".sb-ai-activity-label")?.textContent;
	await t.check(reopenedLabel === label, "a reopened chat folds identically to how it streamed", { streamed: label, reopened: reopenedLabel });

	win.Zotero_Tabs.close(view.tabID);
}
