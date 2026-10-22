/* global SB, Zotero, IOUtils, PathUtils */
// Spec 007 E3: a chat answer with an `sb-table` block becomes a table artifact -- a card in the thread, a side
// panel with the table -- and a malformed block falls back to a Markdown table plus a notice. Scripted provider,
// no model calls. Writes pictures to <harness dir>/artifacts-*.png.

function scriptedProvider(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req) {
			state.inputs.push(req.input);
			const bad = /broken/i.test(req.input);
			const block = bad
				? "```sb-table\n{ not json\n```"
				: "```sb-table\n" + JSON.stringify({
					title: "Invented widget models",
					columns: ["Family", "Why it matters"],
					rows: [
						{ label: "Widget A", cells: { Family: { value: "Gears", cite: [`[@${state.key}]`] }, "Why it matters": { value: "Fast" } } },
						{ label: "Widget B", cells: { Family: { value: "Springs" }, "Why it matters": { value: "Cheap" } } },
					],
				}) + "\n```";
			const text = `Here is the comparison.\n\n${block}`;
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

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 900);
	Zotero.Prefs.clear("extensions.secondbrain.chatMode", true);
	const ai = await SB.ai();

	const ids = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false, true);
	const paper = Zotero.Items.get(ids.find((id) => Zotero.Items.get(id).isRegularItem()));
	await Zotero.Items.loadDataTypes([paper]);
	const state = { inputs: [], key: paper.getField("citationKey") || paper.key };
	SB.agent.providers.set("fake", scriptedProvider(state));
	for (const role of ["chat", "ask"]) await ai.providers.setRole(role, { provider: "fake", model: null });

	const view = SB.openChat();
	view.input.value = "Compare the widget models in a table.";
	view.send.click();

	// ---- the block never shows as text; a card appears instead
	await t.waitFor(() => view.thread.querySelector(".sb-art-card"), "the table card in the thread", 60000);
	const answer = view.thread.querySelector(".sb-ai-assistant, .sb-ai-answer")?.textContent ?? view.thread.textContent;
	await t.check(!answer.includes("sb-table") && !answer.includes("```"), "the sb-table block is not shown in the answer");
	const card = view.thread.querySelector(".sb-art-card");
	await t.check(/Table · 2 rows · V1/.test(card.textContent), "the card says what it is", card.textContent);
	await t.check(card.textContent.includes("Invented widget models"), "the card carries the table's title");
	await t.check(view.artifactsButton.textContent === "Artifacts (1)" && !view.artifactsButton.hidden, "the header lists Artifacts (1)", view.artifactsButton.textContent);

	// ---- the card opens the panel with the real table
	card.click();
	await t.waitFor(() => view.root.querySelector(".sb-art .sb-art-body"), "the artifact panel");
	const panel = view.root.querySelector(".sb-art");
	await t.waitFor(() => /Widget A/.test(panel.textContent), "the table rows to load in the panel", 30000);
	const cellText = () => [...panel.querySelectorAll("td, .sb-art-cell")].map((c) => c.textContent).join(" | ");
	await t.check(/Widget A/.test(panel.textContent) && /Gears/.test(cellText()) && /Springs/.test(cellText()), "the panel shows rows and cells", cellText());
	await t.check(panel.querySelector(".sb-art-version")?.textContent.includes("V1"), "the version menu says V1");
	const search = panel.querySelector(".sb-art-search-input");
	search.value = "Springs";
	search.dispatchEvent(new win.Event("input", { bubbles: true }));
	await t.waitFor(() => !/Widget A/.test(panel.querySelector(".sb-art-body").textContent) && /Widget B/.test(panel.querySelector(".sb-art-body").textContent), "search narrows the rows");
	await snapshot(win, "artifacts-zotero-panel.png").catch(() => {});

	// ---- the engine wrote it, and it survives a reload
	const convs = await ai.conversations.list();
	const withArtifacts = convs.find((c) => c.artifacts === 1);
	await t.check(withArtifacts, "the conversation summary counts one artifact", convs.map((c) => [c.id, c.artifacts]));
	const sessionView = await ai.sessions.view(withArtifacts.id);
	await t.check(sessionView.results.length === 1 && sessionView.results[0].kind === "table", "sessions.view lists the table result", sessionView.results);

	// ---- a malformed block: Markdown fallback and a notice, no card
	view.newChat?.();
	view.input.value = "Make it broken please";
	view.send.click();
	await t.waitFor(() => /Couldn.t turn this into a table/.test(view.thread.textContent), "the notice for a bad block", 60000);
	await t.check(!view.thread.querySelector(".sb-art-card"), "a bad block makes no card");
}
