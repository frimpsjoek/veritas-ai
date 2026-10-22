/* global Zotero, SB */
// Spec 005 unit C2: the four source pills (Papers/Notes/Scholarly/Web), in the real Zotero chat.
//   1. all four pills show in every mode; Find papers disables Notes and Web with a reason.
//   2. a pill's state is remembered across a new chat and a restart of the view (closing and reopening the tab).
//   3. an old Zotero pref { library, scholarly, web } opens as Papers + Notes on.
//   4. offline (SB_SERVER dead): the Notes pill gets an "offline" mark.
//   5. a chat's request carries `sources` matching the pills.
// Run with SB_SERVER pointing at a dead port (t42-library.js's convention): everything here bypasses the real
// AI (view.sb.ai is monkeypatched, as t-chat-scope.js does), so "offline" here means what host.where() reports,
// not whether the checks themselves can run.

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
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	await t.check(!SB.online, "the Second Brain server counts as down (offline check needs this)");

	Zotero.Prefs.clear("extensions.secondbrain.chatSources", true);
	Zotero.Prefs.clear("extensions.secondbrain.chatMode", true);
	const view = SB.openChat();

	// 1. all four pills, every mode; Find papers disables Notes and Web
	for (const mode of ["chat", "ask", "find", "report"]) {
		view.setMode(mode);
		const ids = Object.keys(view.sourceButtons);
		await t.check(JSON.stringify(ids.sort()) === JSON.stringify(["notes", "papers", "scholarly", "web"]), `${mode}: all four pills exist`, ids);
	}
	view.setMode("find");
	await t.check(view.sourceButtons.notes.disabled && view.sourceButtons.web.disabled && !view.sourceButtons.papers.disabled && !view.sourceButtons.scholarly.disabled,
		"Find papers disables Notes and Web, not Papers or Scholarly",
		Object.fromEntries(Object.entries(view.sourceButtons).map(([id, b]) => [id, b.disabled])));
	await t.check(view.sourceButtons.notes.title.length > 0, "the disabled Notes pill has a reason", view.sourceButtons.notes.title);

	// 4. offline mark (the server is down for this whole test)
	await t.check(view.sourceButtons.notes.classList.contains("is-offline"), "the Notes pill shows an offline mark");
	await t.check(!view.sourceButtons.papers.classList.contains("is-offline"), "Papers does not");

	// 2. remembered across a new chat and a restart of the view
	view.setMode("chat");
	view.sourceButtons.papers.click();
	await t.check(!view.sources.papers, "clicking Papers off updates state", view.sources);
	view.newChat();
	await t.check(!view.sources.papers, "still off in a new chat", view.sources);
	Zotero.getMainWindow().Zotero_Tabs.close(view.tabID);
	const reopened = SB.openChat();
	await t.check(!reopened.sources.papers, "still off after closing and reopening the tab", reopened.sources);
	reopened.sourceButtons.papers.click(); // put it back for the next checks
	await t.check(reopened.sources.papers, "back on", reopened.sources);

	// 3. an old { library, scholarly, web } pref migrates to papers + notes
	Zotero.Prefs.set("extensions.secondbrain.chatSources", JSON.stringify({ library: false, scholarly: true, web: true }), true);
	Zotero.getMainWindow().Zotero_Tabs.close(reopened.tabID);
	const migrated = SB.openChat();
	await t.check(JSON.stringify(migrated.sources) === JSON.stringify({ papers: false, notes: false, scholarly: true, web: true }),
		"an old { library: false, scholarly, web } pref reads as papers + notes off, scholarly + web on", migrated.sources);
	Zotero.Prefs.clear("extensions.secondbrain.chatSources", true);
	Zotero.getMainWindow().Zotero_Tabs.close(migrated.tabID);

	// 5. a chat's request carries `sources`
	const finalView = SB.openChat();
	finalView.setMode("chat");
	const calls = [];
	const realAi = finalView.sb.ai;
	finalView.sb.ai = async () => fakeAi(calls);
	try {
		finalView.sourceButtons.notes.click(); // papers + scholarly on, notes + web off
		finalView.input.value = "What does my library say?";
		finalView.input.dispatchEvent(new (Zotero.getMainWindow()).Event("input"));
		await finalView.submit();
		await t.waitFor(() => calls.length > 0, "conversations.send to be called", 5000);
		await t.check(JSON.stringify(calls[0]?.input.sources) === JSON.stringify({ papers: true, notes: false, scholarly: true, web: false }),
			"the sent request carries sources matching the pills", calls[0]?.input.sources);
	} finally {
		finalView.sb.ai = realAi;
	}
	Zotero.getMainWindow().Zotero_Tabs.close(finalView.tabID);
}
