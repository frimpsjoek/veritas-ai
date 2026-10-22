/* global SB, Zotero, IOUtils, PathUtils */
// Spec 007 E5 in real Zotero: "Chat with papers" over a 30-paper set. Two rows are ticked, a question is sent from
// the panel's own composer, and the real engine runs it as a chat_papers turn (scripted provider): only read_result /
// read_source tools, the `on` scope saved on the user record, the answer shown in the tab and in the thread, and a
// citation to a paper outside the ticked rows marked unresolved. Writes pictures to <harness dir>/papers-chat-*.png.

function scriptedProvider(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req) {
			state.turns.push({ tools: (req.tools?.specs ?? []).map((s) => s.name), input: req.input.slice(0, 2000) });
			const text = "Study 3 used 22 animals ([Invented Study 3 of Meadow Life](https://doi.org/10.9999/invented.3)), and study 5 used 24 " +
				"([Invented Study 5 of Meadow Life](https://doi.org/10.9999/invented.5)). Study 9 is not among these papers " +
				"([Invented Study 9 of Meadow Life](https://doi.org/10.9999/invented.9)).";
			yield { type: "text", delta: text };
			yield { type: "final", text, json: null, usage: {} };
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

const papers = (n) => Array.from({ length: n }, (_, i) => ({
	id: `x:${i + 1}`, ref: { kind: "web", url: `https://doi.org/10.9999/invented.${i + 1}`, title: `Invented Study ${i + 1}` }, inLibrary: false,
	title: `Invented Study ${i + 1} of Meadow Life`, authors: [`A. Author${i + 1}`], year: 2015 + (i % 10), venue: "Journal of Invented Zoology",
	doi: `10.9999/invented.${i + 1}`, url: null,
	abstract: `Study ${i + 1} looks at voles. It found that burrow depth matters. The sample was ${20 + i} animals.`,
	citations: i, fullText: false, pdfUrl: null, studyType: null, foundBy: ["OpenAlex"],
}));

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 900);
	const ai = await SB.ai();
	const state = { turns: [] };
	SB.agent.providers.set("fake", scriptedProvider(state));
	for (const role of ["chat", "ask"]) await ai.providers.setRole(role, { provider: "fake", model: null });

	const conv = await ai.conversations.create("chat");
	const id = conv.id ?? conv;
	const draft = {
		ref: { id: "R1", version: 1 }, title: "Invented voles", created: new Date().toISOString(), madeBy: "S1", from: [], change: "Found papers",
		kind: "papers", query: "voles", rows: papers(30), columns: [], cells: {}, screening: null, summary: null,
	};
	await ai.sessions.put(id, { kind: "find", query: "voles", sources: { papers: true, notes: false, scholarly: true, web: false }, scope: { kind: "library" } }, draft);

	const view = SB.openChat();
	await view.openConversation(id);
	await t.waitFor(() => view.root.querySelector(".sb-art-card"), "the papers card", 30000);
	view.root.querySelector(".sb-art-card").click();
	await t.waitFor(() => view.root.querySelector(".sb-art .sb-art-body")?.textContent.includes("Invented Study 1"), "the papers panel", 30000);
	const panel = view.root.querySelector(".sb-art");

	// ---- the tab, the scope line
	const tabs = [...panel.querySelectorAll(".sb-art-tabs .sb-art-tab")].map((b) => b.textContent.trim());
	await t.check(tabs.length === 2 && /Chat with papers/.test(tabs[1]), "a paper set has Papers and Chat with papers tabs", tabs);
	const ticks = [...panel.querySelectorAll("[data-row] input[type=checkbox]")];
	await t.check(ticks.length >= 5, "the rows have ticks", ticks.length);
	ticks[2].click();
	ticks[4].click();
	[...panel.querySelectorAll(".sb-art-tabs .sb-art-tab")][1].click();
	await t.waitFor(() => panel.querySelector(".sb-pc-scope-text"), "the scope line");
	await t.check(/These 2 papers/.test(panel.querySelector(".sb-pc-scope-text").textContent), "the scope line counts the two ticked rows", panel.querySelector(".sb-pc-scope-text").textContent);
	await t.check(/All 30/.test(panel.querySelector(".sb-pc-scope-toggle").textContent), "and offers All 30", panel.querySelector(".sb-pc-scope-toggle").textContent);
	await snapshot(win, "papers-chat-zotero-empty.png").catch(() => {});

	// ---- ask
	const input = panel.querySelector(".sb-pc-input");
	input.value = "How many animals did each of these use?";
	input.dispatchEvent(new win.Event("input", { bubbles: true }));
	panel.querySelector(".sb-pc-send").click();
	await t.waitFor(() => panel.querySelector(".sb-pc-thread")?.textContent.includes("Study 3 used 22 animals"), "the answer in the tab", 60000);
	await t.waitFor(() => view.thread.textContent.includes("Study 3 used 22 animals"), "the answer in the main thread too", 30000);
	await snapshot(win, "papers-chat-zotero-answer.png").catch(() => {});

	// ---- what the engine did
	const turn = state.turns[state.turns.length - 1];
	await t.check(turn.tools.some((n) => /read_result/.test(n)) && !turn.tools.some((n) => /search|web/.test(n)), "only set-reading tools were offered, no search", JSON.stringify(turn.tools));
	const records = await ai.conversations.load(id);
	const user = records.filter((r) => r.type === "user").pop();
	await t.check(user?.on?.result?.id === "R1" && Array.isArray(user.on.rows) && user.on.rows.length === 2 && user.on.rows.includes("x:3") && user.on.rows.includes("x:5"),
		"the user record keeps the scope: R1 and the two ticked rows", JSON.stringify(user?.on));

	// ---- citations: inside the ticked rows resolve, the one outside does not
	const links = [...panel.querySelectorAll(".sb-pc-thread .sb-ai-md a")];
	const missing = links.filter((a) => a.classList.contains("is-missing"));
	await t.check(links.length === 3 && missing.length === 1 && /invented\.9/.test(missing[0].title), "three citations shown, exactly one (Study 9, outside the ticked rows) marked unresolved", JSON.stringify(links.map((a) => a.className + ":" + a.textContent.slice(0, 22))));
	const color = win.getComputedStyle(missing[0]).color, other = win.getComputedStyle(links[0]).color;
	await t.check(color !== other, "and it is drawn in a different (red) colour", color + " vs " + other);

	// ---- expand swaps the layout and back
	panel.querySelector(".sb-art-head button[aria-label*=xpand], .sb-art-expand")?.click();
	await snapshot(win, "papers-chat-zotero-expanded.png").catch(() => {});
}
