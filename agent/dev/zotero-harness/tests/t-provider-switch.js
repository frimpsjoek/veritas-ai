/* global SB, Zotero */
// The chat role is set to a provider that is not installed: the error card offers a button for each ready provider,
// and clicking one sets the Chat and Ask roles and asks the same question again, which is then answered with no new
// error. The runtime here is Zotero's own (SB_SERVER on a dead port).

function failing(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "missing", version: null, account: { kind: "none", label: null, plan: null }, usage: null, installHelp: "Install it." }; },
		async models() { return []; },
		async dispose() {},
		async *turn() {
			state.failing += 1;
			yield { type: "failed", error: { kind: "not_installed", message: "Codex is not installed. Install ChatGPT.app or the codex CLI." } };
		},
	};
}

function ready(state) {
	return {
		id: "fake2", caps: {},
		async status() { return { provider: "fake2", state: "ready", version: null, account: { kind: "none", label: null, plan: null }, usage: null, installHelp: null }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req) {
			state.ready.push(req.input.slice(0, 80));
			const text = `Ready answer ${state.ready.length}.`;
			yield { type: "text", delta: text };
			yield { type: "final", text, json: null, usage: {} };
		},
	};
}

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 900);
	const ai = await SB.ai();
	const state = { failing: 0, ready: [] };
	SB.agent.providers.set("fake", failing(state));
	SB.agent.providers.set("fake2", ready(state));
	for (const role of ["chat", "ask"]) await ai.providers.setRole(role, { provider: "fake", model: null });

	const view = SB.openChat();
	const errors = () => view.thread.querySelectorAll(".sb-ai-error").length;
	const buttons = () => [...view.thread.querySelectorAll(".sb-ai-error-use")];
	view.input.value = "what is the ideas exporessed here?";
	await view.submit();
	await t.waitFor(() => errors() === 1 && !view.running, "the not-installed error", 30000);
	await t.check(/Codex is not installed/.test(view.thread.querySelector(".sb-ai-error").textContent), "the error is shown");
	await t.waitFor(() => buttons().length > 0 || view.thread.querySelector(".sb-ai-error-none"), "the switch buttons", 30000);
	const labels = buttons().map((b) => b.textContent);
	await t.check(labels.length >= 1 && labels.every((l) => /^Use .+ instead$/.test(l)), "one 'Use <name> instead' button per ready provider", JSON.stringify(labels));
	await t.check(!view.thread.querySelector(".sb-ai-error-none"), "no 'nothing is set up' line while a provider is ready");
	await t.check(buttons().every((b) => win.getComputedStyle(b).whiteSpace === "normal"), "the buttons wrap");

	// the ready fake is the one to click; the others (if any are ready on this machine) stay in the list
	const fakeButton = buttons().find((b) => /fake2/.test(b.textContent));
	await t.check(Boolean(fakeButton), "the ready test provider has a button", JSON.stringify(labels));
	fakeButton.click();
	await t.waitFor(() => state.ready.length === 1, "the same question was asked again on the new provider", 30000);
	await t.waitFor(() => view.thread.textContent.includes("Ready answer 1.") && !view.running, "the answer arrives", 30000);
	const roles = await ai.providers.roles();
	await t.check(roles.chat?.provider === "fake2" && roles.ask?.provider === "fake2", "chat and ask now use the chosen provider", JSON.stringify(roles));
	await t.check(state.ready[0].includes("what is the ideas exporessed here?"), "the question is the same one", state.ready[0]);
	await t.check(errors() === 1, "no new error: only the first one remains", errors());
	await t.check(!view.thread.querySelector(".sb-ai-error-use"), "the buttons are gone after the click");
	await t.check(state.failing === 1, "the old provider was asked once", state.failing);
	await SB.agent.shutdown();
}
