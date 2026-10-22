/* global Zotero, SB */
// Spec 006 follow-up: the updater's idle rule. 0.25.0 treated a focused chat box as busy, and the chat box keeps
// focus for hours, so an update waited forever. Now only text that would be lost holds an update back.

async function run(t) {
	const win = Zotero.getMainWindow();
	win.Zotero_Tabs.select("zotero-pane");
	await SB.openChat?.();
	await t.waitFor(() => win.document.querySelector("textarea.sb-ai-input"), "a chat box", 20000);
	const input = win.document.querySelector("textarea.sb-ai-input");
	SB.agent.busy = 0;

	input.value = "";
	input.focus();
	await t.check(win.document.activeElement === input, "the chat box has focus");
	await t.check(SB.updater.idle(), "an empty, focused chat box doesn't block an update");

	input.value = "What does the research say about";
	await t.check(!SB.updater.idle(), "a half-typed message does");
	input.value = "";

	SB.agent.busy = 1;
	await t.check(!SB.updater.idle(), "a streaming turn does");
	SB.updater.pending = { version: "9.9.9" };
	let installed = null;
	SB.updater.installVersion = async (latest) => { installed = latest.version; };
	await SB.updater.tryInstall(0);
	await t.check(installed === null, "an update waits for a streaming turn");
	SB.agent.busy = 0;

	input.value = "";
	SB.updater.pending = { version: "9.9.9" };
	await SB.updater.tryInstall(0);
	await t.check(installed === "9.9.9", "and installs once the turn ends, cursor still in the chat box", installed);
}
