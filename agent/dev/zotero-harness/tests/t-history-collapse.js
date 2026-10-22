/* global SB, Zotero, Services */
// Collapsible chat history sidebar (Zotero AI tab): the toggle hides/shows the conversation list, the current
// conversation's title stays visible in the header while collapsed, "New chat" stays reachable, and the state
// persists across tab close/reopen through the extensions.secondbrain.chatHistoryCollapsed pref.

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	Zotero.Prefs.clear("extensions.secondbrain.chatHistoryCollapsed", true);

	let view = SB.openChat();
	await t.check(view.historyCollapsed === false, "starts expanded by default");
	await t.check(!view.side.hidden, "the conversation list is visible");
	await t.check(view.historyNewChat.hidden, "the header's New chat button is hidden while expanded (the side one already shows it)");
	await t.check(view.historyToggle.getAttribute("aria-expanded") === "true", "aria-expanded reflects the expanded state");
	await t.check(view.historyToggle.title === "Hide chat history", "the tooltip names the collapsing action");

	view.historyToggle.click();
	await t.check(view.historyCollapsed === true && view.side.hidden, "clicking the toggle collapses the list");
	await t.check(!view.historyNewChat.hidden, "New chat becomes reachable from the header once the side panel is hidden");
	await t.check(!view.headerTitle.hidden && view.headerTitle.textContent === "New chat", "the header shows the current (new) conversation's title");
	await t.check(view.historyToggle.getAttribute("aria-expanded") === "false", "aria-expanded flips to false");
	await t.check(view.historyToggle.title === "Show chat history", "the tooltip flips to the expanding action");
	await t.check(Zotero.Prefs.get("extensions.secondbrain.chatHistoryCollapsed", true) === true, "the collapsed state is written to a Zotero pref");

	view.input.value = "A question while collapsed";
	await t.check(!!view.input.value, "the composer still works while the list is collapsed");
	view.conversationID = "not-actually-a-conversation"; // simulate having opened one, the same way newChat() below is exercised elsewhere
	view.historyNewChat.click();
	await t.check(view.conversationID === null, "the header's New chat button starts a fresh chat (same as the side panel's)");

	const tabID = view.tabID;
	view.win.Zotero_Tabs.close(tabID);
	await t.check(SB.chatTab === null, "closing the tab clears it");

	view = SB.openChat();
	await t.check(view.historyCollapsed === true && view.side.hidden, "reopening the tab restores the collapsed state from the pref");

	view.historyToggle.click();
	await t.check(view.historyCollapsed === false && !view.side.hidden, "toggling again expands it back");
	await t.check(Zotero.Prefs.get("extensions.secondbrain.chatHistoryCollapsed", true) === false, "the pref updates back to expanded");

	Zotero.Prefs.clear("extensions.secondbrain.chatHistoryCollapsed", true);
	view.win.Zotero_Tabs.close(view.tabID);
}
