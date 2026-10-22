/* global SB, Zotero, IOUtils, PathUtils */
// Spec 011 U5 (Projects UI) in real Zotero. The history column opens with one quiet switcher ("All chats"); a new
// project makes a scoped list (empty line), chats started inside join it, the row menu moves a chat out and back,
// Rename and Delete project work from the switcher menu, and the open project is remembered across the tab.
// Scripted provider, no model calls. Writes pictures to <harness dir>/projects-*.png.

function scriptedProvider() {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn() {
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
	const path = PathUtils.join(PathUtils.parent(Zotero.DataDirectory.dir), name);
	await IOUtils.write(path, Uint8Array.from(win.atob(base64), (c) => c.charCodeAt(0)));
	return path;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PREF = "extensions.secondbrain.chatProject";

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 800);
	Zotero.Prefs.clear("extensions.secondbrain.chatMode", true);
	Zotero.Prefs.clear(PREF, true);
	const ai = await SB.ai();
	await t.check(!!ai.projects, "the engine has projects");
	SB.agent.providers.set("fake", scriptedProvider());
	for (const role of ["chat", "ask", "lead", "researcher", "writer"]) await ai.providers.setRole(role, { provider: "fake", model: null });

	let view = SB.openChat();
	await pause(600);
	const label = () => view.switcher.querySelector(".sb-ai-project-label")?.textContent;
	const titles = () => [...view.list.querySelectorAll(".sb-ai-conv-title")].map((e) => e.textContent);
	const popItems = () => [...view.side.querySelectorAll(".sb-art-pop .sb-art-item-label")].map((e) => e.textContent);
	const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
	const send = async (text) => {
		view.newChat();
		view.input.value = text;
		view.input.dispatchEvent(new win.Event("input"));
		await view.submit();
		await t.waitFor(() => !view.running && view.thread.querySelector(".sb-ai-md"), "the answer", 20000);
		await view.refreshList();
	};
	const form = async (name) => {
		const input = view.side.querySelector(".sb-ai-project-input");
		await t.check(!!input, `the name field opens inline for ${name}`);
		input.value = name;
		click(view.side.querySelector(".sb-ai-project-go"));
		await pause(500);
	};

	// the switcher: one quiet row, All chats
	await t.check(!view.switcher.hidden && label() === "All chats", "the switcher reads All chats", label());
	await t.check(view.side.firstElementChild === view.switcher, "the switcher is the first row of the history column");
	await send("A chat before any project");
	await t.check(titles().includes("A chat before any project"), "a chat started outside a project is listed", titles());
	await snapshot(win, "projects-switcher-closed.png");

	// New project through the switcher's popover
	click(view.switcher);
	await pause(200);
	await t.check(popItems().join("|") === "All chats|New project...", "the menu lists All chats and New project", popItems());
	await snapshot(win, "projects-switcher-open.png");
	click([...view.side.querySelectorAll(".sb-art-item")].find((b) => b.textContent.includes("New project")));
	await pause(200);
	await form("Voles");
	await t.check(label() === "Voles", "creating Voles opens it: the switcher reads Voles", label());
	await t.check(Zotero.Prefs.get(PREF, true) === view.projectId && !!view.projectId, "the open project is written to the chatProject pref");
	await t.check(view.list.querySelector(".sb-ai-list-empty")?.textContent === "Nothing in Voles yet. Start a chat, or move one here from its ... menu.",
		"an empty project says so in plain words", view.list.textContent);
	await t.check(!titles().includes("A chat before any project"), "the other chat is not listed under Voles");

	// a chat started inside the project joins it
	await send("Voles question");
	const voles = (await ai.projects.list()).find((p) => p.name === "Voles");
	const mine = (await ai.conversations.list()).find((c) => c.title === "Voles question");
	await t.check(mine?.project === voles.id, "the new chat carries the project in its summary", mine?.project);
	await t.check(titles().join("|") === "Voles question", "the Voles list shows the chat", titles());
	await snapshot(win, "projects-open-project.png");

	// All chats lists both
	click(view.switcher);
	await pause(150);
	click([...view.side.querySelectorAll(".sb-art-item")].find((b) => b.textContent === "All chats"));
	await pause(500);
	await t.check(label() === "All chats" && titles().length >= 2 && titles().includes("Voles question") && titles().includes("A chat before any project"),
		"All chats lists both chats", titles());
	await t.check(Zotero.Prefs.get(PREF, true) === undefined || Zotero.Prefs.get(PREF, true) === "", "the pref is cleared for All chats");

	// row menu: Move to project (the "before" chat joins Voles) with a picture of the menu
	const rowOf = (title) => [...view.list.querySelectorAll(".sb-ai-conv")].find((r) => r.querySelector(".sb-ai-conv-title")?.textContent === title);
	const more = rowOf("A chat before any project").querySelector(".sb-ai-conv-more");
	await t.check(!!more, "each row has a ... button");
	click(more);
	await pause(200);
	await t.check(popItems().join("|") === "Rename|Voles|New project...|Delete", "a chat with no project: Rename, Move to project (Voles, New project), Delete", popItems());
	await snapshot(win, "projects-row-menu.png");
	click([...view.side.querySelectorAll(".sb-art-item")].find((b) => b.textContent === "Voles"));
	await pause(600);
	let moved = (await ai.conversations.list()).find((c) => c.title === "A chat before any project");
	await t.check(moved?.project === voles.id, "Move to project puts the chat in Voles", moved?.project);

	// Remove from project, from inside Voles
	click(view.switcher);
	await pause(150);
	click([...view.side.querySelectorAll(".sb-art-item")].find((b) => b.textContent === "Voles"));
	await pause(500);
	await t.check(titles().length === 2, "Voles now lists both chats", titles());
	click(rowOf("A chat before any project").querySelector(".sb-ai-conv-more"));
	await pause(200);
	await t.check(popItems().includes("Remove from project"), "a member's menu offers Remove from project", popItems());
	click([...view.side.querySelectorAll(".sb-art-item")].find((b) => b.textContent === "Remove from project"));
	await pause(600);
	await t.check(titles().join("|") === "Voles question", "Remove from project takes it out of Voles", titles());
	moved = (await ai.conversations.list()).find((c) => c.title === "A chat before any project");
	await t.check(!moved?.project, "the summary no longer has a project", moved?.project);

	// right-click opens the same menu (a real mouse event: a synthetic contextmenu does not reach the row in Zotero's chrome)
	const target = rowOf("Voles question");
	const box = target.getBoundingClientRect();
	win.windowUtils.sendMouseEvent("contextmenu", box.left + 40, box.top + box.height / 2, 2, 1, 0);
	await pause(300);
	await t.check(popItems().includes("Voles") && popItems().includes("Rename"), "right-click opens the row menu", popItems());
	win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	await pause(100);

	// Rename project
	click(view.switcher);
	await pause(150);
	await t.check(popItems().join("|") === "All chats|Voles|New project...|Rename project...|Delete project...", "an open project adds Rename and Delete", popItems());
	click([...view.side.querySelectorAll(".sb-art-item")].find((b) => b.textContent === "Rename project..."));
	await pause(200);
	await form("Field voles");
	await t.check(label() === "Field voles", "Rename project updates the switcher", label());
	click(view.switcher);
	await pause(150);
	await t.check(popItems().includes("Field voles") && !popItems().includes("Voles"), "and the menu", popItems());
	win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

	// the open project is remembered across closing the tab
	view.win.Zotero_Tabs.close(view.tabID);
	await t.check(SB.chatTab === null, "closing the tab clears it");
	view = SB.openChat();
	await t.waitFor(() => !view.switcher.hidden && titles().length > 0, "the reopened history", 15000);
	await t.check(label() === "Field voles" && titles().join("|") === "Voles question", "reopening restores the open project", `${label()} / ${titles()}`);

	// Delete project: inline confirm, the chat stays under All chats
	click(view.switcher);
	await pause(150);
	click([...view.side.querySelectorAll(".sb-art-item")].find((b) => b.textContent === "Delete project..."));
	await pause(200);
	await t.check(view.side.querySelector(".sb-ai-project-ask")?.textContent === 'Delete "Field voles"? Its chats and reports stay in your history.', "the confirm is inline and says what is kept",
		view.side.querySelector(".sb-ai-project-ask")?.textContent);
	click([...view.side.querySelectorAll(".sb-ai-project-buttons .sb-button")].find((b) => b.textContent === "Delete project"));
	await pause(700);
	await t.check((await ai.projects.list()).length === 0, "the project is gone");
	await t.check(label() === "All chats" && titles().includes("Voles question") && titles().includes("A chat before any project"), "both chats are still listed under All chats", titles());

	// a pref that points at a deleted project resets to All chats
	Zotero.Prefs.set(PREF, "no-such-project", true);
	view.win.Zotero_Tabs.close(view.tabID);
	view = SB.openChat();
	await t.waitFor(() => !view.switcher.hidden && titles().length >= 2, "the reopened history", 15000);
	await t.check(label() === "All chats" && titles().length >= 2, "a stale chatProject pref reads as All chats", `${label()} / ${titles()}`);
	await t.check(!Zotero.Prefs.get(PREF, true), "and is reset");

	// cleanup of what the test made
	for (const c of await ai.conversations.list()) if (["Voles question", "A chat before any project"].includes(c.title)) await ai.conversations.remove(c.id);
	Zotero.Prefs.clear(PREF, true);
	view.win.Zotero_Tabs.close(view.tabID);
	await SB.agent.shutdown();
}
