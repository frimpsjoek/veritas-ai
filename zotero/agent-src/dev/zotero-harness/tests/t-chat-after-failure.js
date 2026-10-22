/* global SB, Zotero */
// A chat whose first turn failed (Codex not installed) and whose roles are then moved to another provider (the "On this
// Mac" menu does exactly this through providers.setRole): the next question must be answered by the new provider and show
// no trace of the old failure, with and without a Chat-with-papers `on` scope; a send while a turn runs must not start
// a second turn. The runtime here is Zotero's own (SB_SERVER on a dead port); the stale-log replay of the server runtime
// is covered by agent-src/test/remote-second-turn.test.js.

function failing(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn() {
			state.failing += 1;
			yield { type: "failed", error: { kind: "not_installed", message: "Codex is not installed. Install ChatGPT.app or the codex CLI." } };
		},
	};
}

function local(state) {
	return {
		id: "fake2", caps: {},
		async status() { return { provider: "fake2", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req) {
			state.local.push(req.input.slice(0, 80));
			await state.gate;
			const text = `Local answer ${state.local.length}.`;
			yield { type: "text", delta: text };
			yield { type: "final", text, json: null, usage: {} };
		},
	};
}

const papers = (n) => Array.from({ length: n }, (_, i) => ({
	id: `x:${i + 1}`, ref: { kind: "web", url: `https://doi.org/10.9999/invented.${i + 1}`, title: `Invented Study ${i + 1}` }, inLibrary: false,
	title: `Invented Study ${i + 1} of Meadow Life`, authors: [`A. Author${i + 1}`], year: 2015 + i, venue: "Journal of Invented Zoology",
	doi: `10.9999/invented.${i + 1}`, url: null, abstract: `Study ${i + 1} looks at voles.`,
	citations: i, fullText: false, pdfUrl: null, studyType: null, foundBy: ["OpenAlex"],
}));

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 900);
	const ai = await SB.ai();
	const state = { failing: 0, local: [], gate: Promise.resolve() };
	SB.agent.providers.set("fake", failing(state));
	SB.agent.providers.set("fake2", local(state));
	for (const role of ["chat", "ask"]) await ai.providers.setRole(role, { provider: "fake", model: null });

	const id = await ai.conversations.create("chat");
	const draft = {
		ref: { id: "R1", version: 1 }, title: "Invented voles", created: new Date().toISOString(), madeBy: "S1", from: [], change: "Found papers",
		kind: "papers", query: "voles", rows: papers(6), columns: [], cells: {}, screening: null, summary: null,
	};
	await ai.sessions.put(id, { kind: "find", query: "voles", sources: { papers: true, notes: false, scholarly: true, web: false }, scope: { kind: "library" } }, draft);
	const view = SB.openChat();
	await view.openConversation(id);
	await t.waitFor(() => view.root.querySelector(".sb-ai-on"), "the On: chip", 30000);
	const ask = async (text) => { view.input.value = text; await view.submit(); };
	const errors = () => view.thread.querySelectorAll(".sb-ai-error").length;

	// 1. the first question fails on the provider that is not installed
	await ask("what is the ideas exporessed here?");
	await t.waitFor(() => errors() === 1 && !view.running, "the first failure shown", 30000);
	await t.check(/Codex is not installed/.test(view.thread.querySelector(".sb-ai-error").textContent), "the first question shows the not-installed error");

	// 2. the roles move to the other provider; the same question again
	for (const role of ["chat", "ask"]) await ai.providers.setRole(role, { provider: "fake2", model: null });
	let release;
	state.gate = new Promise((r) => { release = r; });
	void ask("what is the ideas exporessed here?"); // not awaited: the turn is held at the gate
	await t.waitFor(() => state.local.length === 1, "the new provider got the question", 30000);
	await t.check(errors() === 1, "while it answers, the thread still shows only the first error", errors());
	await t.check(view.running, "the turn is running");

	// 3. a message sent while the turn runs starts nothing and shows nothing
	const before = view.thread.querySelectorAll(".sb-ai-user, .sb-ai-msg-user").length;
	view.input.value = "hi";
	await view.submit();
	await t.check(state.local.length === 1 && state.failing === 1, "a send while a turn runs starts no second turn", JSON.stringify({ local: state.local.length, failing: state.failing }));
	await t.check(errors() === 1 && !view.thread.textContent.includes("hi\n"), "and adds no error to the thread", errors());
	void before;
	release();
	await t.waitFor(() => view.thread.textContent.includes("Local answer 1."), "the local answer", 30000);
	await t.waitFor(() => !view.running, "the turn ends", 30000);
	await t.check(errors() === 1, "after the answer there is still only the first (correct) error", errors());
	const answers = view.thread.querySelectorAll(".sb-ai-answer");
	await t.check(!answers[1].querySelector(".sb-ai-error"), "the second question's answer has no error under it");

	// 4. the same through the Chat with papers tab (an `on` scope)
	await t.waitFor(() => view.root.querySelector(".sb-art-card"), "the papers card", 30000);
	view.root.querySelector(".sb-art-card").click();
	await t.waitFor(() => view.root.querySelector(".sb-art .sb-art-body")?.textContent.includes("Invented Study 1"), "the papers panel", 30000);
	const panel = view.root.querySelector(".sb-art");
	[...panel.querySelectorAll(".sb-art-tabs .sb-art-tab")][1].click();
	await t.waitFor(() => panel.querySelector(".sb-pc-input"), "the papers composer");
	const input = panel.querySelector(".sb-pc-input");
	input.value = "What do these papers say?";
	input.dispatchEvent(new win.Event("input", { bubbles: true }));
	panel.querySelector(".sb-pc-send").click();
	await t.waitFor(() => panel.querySelector(".sb-pc-thread")?.textContent.includes("Local answer 2."), "the answer in the tab", 30000);
	await t.check(panel.querySelectorAll(".sb-pc-thread .sb-ai-error").length === 0, "the papers tab shows no error");
	const records = await ai.conversations.load(id);
	const users = records.filter((r) => r.type === "user");
	await t.check(users.length === 3 && users.every((u) => u.on?.result?.id === "R1"), "the \"On: <set>\" chip made all three questions about the set (`on` stored); the main composer sends it too", JSON.stringify(users.map((u) => u.on)));
	await t.check(users.every((u) => u.on.rows === "all"), "with nothing ticked, every question is on all rows", JSON.stringify(users.map((u) => u.on.rows)));
	await t.check(!users.some((u) => u.text === "hi"), "'hi' was never stored");
	// 5. the chip says it scopes, and a refused (busy) send puts the question back in the box
	const chip = view.root.querySelector(".sb-ai-on");
	await t.check(/answered from this set only/.test(chip.querySelector(".sb-ai-chip-label").title) && /whole library/.test(chip.querySelector(".sb-ai-chip-x").title),
		"the chip's titles say it scopes the questions and how to ask the whole library", chip.querySelector(".sb-ai-chip-label").title + " | " + chip.querySelector(".sb-ai-chip-x").title);
	const realAi = SB.ai;
	SB.ai = async () => {
		const real = await realAi.call(SB);
		return { ...real, conversations: { ...real.conversations, async *send() { yield { type: "failed", seq: 1, error: { kind: "busy", message: "An answer is still coming in this chat." } }; } } };
	};
	const bubbles = () => view.thread.querySelectorAll(".sb-ai-user").length;
	const count = bubbles();
	view.input.value = "a question the server refuses";
	await view.submit();
	SB.ai = realAi;
	await t.check(bubbles() === count && view.input.value === "a question the server refuses", "a busy refusal removes the bubble and returns the text to the box", `${bubbles()} vs ${count}; "${view.input.value}"`);
	await SB.agent.shutdown();
}
