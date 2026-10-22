/* global SB, Zotero, IOUtils, PathUtils */
// Spec 007 E6 in real Zotero: the grouped mode menu (Workflows / Tools), session cards in the empty state, the
// "On: ..." current-result chip, and "+ Add step" offering only the steps that fit a paper set. Real engine, no model
// calls. Writes pictures to <harness dir>/steps-*.png.

async function snapshot(win, name) {
	const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
	canvas.width = win.innerWidth;
	canvas.height = win.innerHeight;
	canvas.getContext("2d").drawWindow(win, 0, 0, canvas.width, canvas.height, "white");
	const base64 = canvas.toDataURL("image/png").split(",")[1];
	await IOUtils.write(PathUtils.join(PathUtils.parent(Zotero.DataDirectory.dir), name), Uint8Array.from(win.atob(base64), (c) => c.charCodeAt(0)));
}

const papers = (n) => Array.from({ length: n }, (_, i) => ({
	id: `x:${i + 1}`, ref: { kind: "web", url: `https://doi.org/10.9999/invented.${i + 1}`, title: `Invented Study ${i + 1}` }, inLibrary: false,
	title: `Invented Study ${i + 1} of Meadow Life`, authors: [`A. Author${i + 1}`], year: 2015 + (i % 10), venue: "Journal of Invented Zoology",
	doi: `10.9999/invented.${i + 1}`, url: null, abstract: `Study ${i + 1} looks at voles. It found that burrow depth matters.`,
	citations: i, fullText: i % 2 === 0, pdfUrl: null, studyType: null, foundBy: ["OpenAlex"],
}));

async function makeSession(ai, title, n) {
	const conv = await ai.conversations.create("chat");
	const id = conv.id ?? conv;
	const draft = {
		ref: { id: "R1", version: 1 }, title, created: new Date().toISOString(), madeBy: "S1", from: [], change: "Found papers",
		kind: "papers", query: title, rows: papers(n), columns: [], cells: {}, screening: null, summary: null,
	};
	await ai.sessions.put(id, { kind: "find", query: title, sources: { papers: true, notes: false, scholarly: true, web: false }, scope: { kind: "library" } }, draft);
	await ai.conversations.rename(id, title); // the real Find flow titles its session with the query
	return id;
}

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 900);
	Zotero.Prefs.clear("extensions.secondbrain.chatMode", true);
	const ai = await SB.ai();
	const a = await makeSession(ai, "Voles and burrows", 12);
	await makeSession(ai, "Owls and migration", 8);

	// ---- the grouped menu
	const view = SB.openChat();
	const groups = [...view.modePick.querySelectorAll("optgroup")].map((g) => `${g.label}: ${[...g.querySelectorAll("option")].map((o) => o.textContent).join(", ")}`);
	await t.check(groups.length === 2 && groups[0].startsWith("Workflows: Chat") && groups[1].startsWith("Tools: Find papers"), "the mode menu has Workflows and Tools groups", groups);
	await t.check(groups[0] === "Workflows: Chat, Research report, Systematic review, Routines", "Systematic review and Routines are offered under Workflows (spec 007 E8, 011 U4)", groups[0]);

	// ---- empty state: recent sessions as cards
	view.newChat();
	await t.waitFor(() => view.root.querySelectorAll(".sb-ai-card").length >= 2, "session cards in the empty state", 15000);
	const cards = [...view.root.querySelectorAll(".sb-ai-card")].map((c) => c.textContent);
	await t.check(cards.some((c) => /Voles and burrows/.test(c)) && cards.some((c) => /Owls and migration/.test(c)), "the two recent sessions are offered as cards", cards);
	await t.check(cards.some((c) => /1 artifact|1 result/i.test(c) || /·/.test(c)), "a card says what kind of session it is and how many artifacts", cards[0]);
	await snapshot(win, "steps-zotero-empty.png").catch(() => {});

	// ---- reopen one from its card; the current-result chip and + Add step appear
	[...view.root.querySelectorAll(".sb-ai-card")].find((c) => /Voles and burrows/.test(c.textContent)).click();
	await t.waitFor(() => view.root.querySelector(".sb-ai-on"), "the On: chip", 15000);
	await t.check(/^On:/.test(view.root.querySelector(".sb-ai-current").textContent.trim()) || /Voles and burrows/.test(view.root.querySelector(".sb-ai-on").textContent), "the composer shows the current result", view.root.querySelector(".sb-ai-current").textContent);
	const addBtn = await t.waitFor(() => view.root.querySelector(".sb-addstep-btn"), "the + Add step button", 15000);
	addBtn.click();
	const menu = await t.waitFor(() => view.doc.documentElement.querySelector(".sb-addstep-menu"), "the Add step menu", 5000);
	const items = [...menu.querySelectorAll("button, [role=menuitem]")].map((b) => b.textContent.trim());
	await t.check(items.some((s) => /Add columns/.test(s)) && items.some((s) => /Keep filtered rows/.test(s)) && items.some((s) => /Chat with these/.test(s)), "on a paper set the menu offers Add columns, Keep filtered rows, Chat with these", items);
	await t.check(items.some((s) => /Report on these/.test(s)), "and Report on these (spec 007 E7)", items);
	await t.check(!items.some((s) => /screen|more like/i.test(s)), "and does not offer steps that don't exist yet", items);
	await snapshot(win, "steps-zotero-addstep.png").catch(() => {});

	// ---- picking one does the step: Chat with these opens the panel's chat tab
	[...menu.querySelectorAll("button, [role=menuitem]")].find((b) => /Chat with these/.test(b.textContent)).click();
	await t.waitFor(() => view.root.querySelector(".sb-art .sb-pc-input"), "the Chat with papers tab", 15000);
	await snapshot(win, "steps-zotero-chat-tab.png").catch(() => {});
	void a;
}
