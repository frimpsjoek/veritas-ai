/* global Zotero, Services, SB */
// Verifies the Chat/Quick answer scope work end to end in the UI layer (chat.js), without needing a real model:
//   1. "Look in" (the options button) now shows in Chat and Quick answer, not just Report/Find.
//   2. "Search all papers…" in the + picker opens Zotero's own item picker (selectItemsDialog.xhtml) instead of grabbing the
//      library pane's current selection, and attaches whatever the dialog returns.
//   3. Ticking a collection in the "Collections" tree (spec 008 Z4) and sending a chat message passes that scope
//      through to ai.conversations.send / ai.ask, as `{ kind: "collections", keys }` (fake SB.ai() below stands
//      in for the real AgentService, whose own scope plumbing is covered by agent-src/test/local-runtime.test.js
//      and remote.test.js).

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeAi(calls) {
	return {
		where: "local",
		conversations: {
			list: async () => [], load: async () => [], create: async () => "conv1", rename: async () => {}, remove: async () => {},
			send: (id, input) => { calls.push({ kind: "send", id, input }); return (async function* () { yield { type: "done", answer: { text: "ok", citations: [] } }; })(); },
		},
		ask: (question, opts) => { calls.push({ kind: "ask", question, opts }); return (async function* () { yield { type: "done", answer: { structured: { status: "answered", markdown: "ok" } } }; })(); },
		reviews: { list: async () => [] },
	};
}

async function run(t) {
	const win = Zotero.getMainWindow();
	const view = SB.openChat();
	await pause(300);

	// 1. the options button shows in every mode now
	for (const mode of ["chat", "ask", "find", "report"]) {
		view.setMode(mode);
		await t.check(!view.optionsButton.hidden, `${mode}: the "Look in" options button is shown`, view.optionsButton.hidden);
	}
	view.setMode("chat");
	view.attachButton.click();
	await t.check(view.picker?.isOpen, '"+" opens the context picker', view.attachButton.textContent);
	const searchAll = [...view.picker.root.querySelectorAll(".sb-ai-picker-more")].find((b) => b.textContent.includes("Search all papers"));
	await t.check(!!searchAll, 'the picker offers "Search all papers…"');

	// 2. "Search all papers…" opens Zotero's real item picker. openDialog's "modal" flag spins a nested event loop
	// (timers still fire) rather than truly blocking, so a self-closing timer scheduled just before the click
	// is how this dialog gets closed again in a headless, unattended run: nothing else here can act on it while
	// the click's own call to openDialog hasn't returned yet.
	let seenDialog = null;
	setTimeout(function pollForDialog() {
		const e = Services.wm.getEnumerator(null);
		while (e.hasMoreElements()) {
			const w = e.getNext();
			if (String(w.document?.documentURI ?? "").includes("selectItemsDialog.xhtml")) { seenDialog = w; w.close(); return; }
		}
		setTimeout(pollForDialog, 100);
	}, 50);
	searchAll.click();
	await t.check(!!seenDialog, "Search all papers… opens chrome://zotero/content/selectItemsDialog.xhtml");
	await pause(300);
	await t.check(view.attachments.length === 0, "cancelling the picker attaches nothing", view.attachments);

	// 3. a chosen scope reaches ai.conversations.send / ai.ask
	const calls = [];
	const realAi = view.sb.ai;
	view.sb.ai = async () => fakeAi(calls);
	try {
		const libraryID = Zotero.Libraries.userLibraryID;
		let collection = Zotero.Collections.getByLibrary(libraryID, true)[0];
		if (!collection) {
			collection = new Zotero.Collection();
			collection.libraryID = libraryID;
			collection.name = "SB scope test";
			await collection.saveTx();
		}
		view.setMode("chat");
		view.setOptionsOpen(true);
		view.scopeKind.value = "collections";
		view.scopeKind.dispatchEvent(new win.Event("change")); // fillScopeNames -> fillScopeTree -> host.collections() (Zotero: synchronous)
		view.scopeTree.toggle(collection.key);
		await t.check(view.scopeValue().kind === "collections" && JSON.stringify(view.scopeValue().keys) === JSON.stringify([collection.key]),
			"scopeValue() reflects the ticked collection's key", view.scopeValue());

		view.input.value = "Summarize this collection";
		view.input.dispatchEvent(new win.Event("input"));
		await view.submit();
		await t.waitFor(() => calls.length > 0, "conversations.send to be called", 5000);
		await t.check(calls[0]?.kind === "send" && calls[0].input.scope?.kind === "collections" && JSON.stringify(calls[0].input.scope.keys) === JSON.stringify([collection.key]),
			"Chat: the ticked collection's key reaches conversations.send", calls[0]);

		calls.length = 0;
		view.setMode("ask");
		view.setOptionsOpen(true);
		view.scopeKind.value = "collections";
		view.scopeKind.dispatchEvent(new win.Event("change"));
		await t.check(JSON.stringify(view.scopeValue().keys) === JSON.stringify([collection.key]),
			"switching to Quick answer keeps the ticked collection", view.scopeValue());
		view.input.value = "What method do these use?";
		view.input.dispatchEvent(new win.Event("input"));
		await view.submit();
		await t.waitFor(() => calls.length > 0, "ask to be called", 5000);
		await t.check(calls[0]?.kind === "ask" && calls[0].opts.scope?.kind === "collections" && JSON.stringify(calls[0].opts.scope.keys) === JSON.stringify([collection.key]),
			"Quick answer: the ticked collection's key reaches ai.ask", calls[0]);
	} finally {
		view.sb.ai = realAi;
	}
}
