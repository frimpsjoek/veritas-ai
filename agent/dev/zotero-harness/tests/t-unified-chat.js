/* global SB, Zotero, IOUtils, PathUtils */
// Spec 002 U1: one chat window. The mode menu under the message box replaces the header switch and the separate
// Literature Review tab; a Research report runs in the thread (plan card, approve, finished report with an
// evidence table), and chats and reports share one history list. Scripted provider, no model calls.
// Writes pictures to <harness dir>/unified-*.png.

function scriptedProvider(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req) {
			state.inputs.push(req.input);
			const props = req.outputSchema?.properties ?? {};
			let json = null;
			if (props.questions) {
				json = { questions: [] }; // spec 007 E7: the clarify turn; a clear question asks nothing
			} else if (props.candidates) {
				json = { candidates: [
					{ citekey: state.key, doi: null, url: null, title: state.title, year: 2024, abstract: "The trial found a large effect.", authors: [], venue: "" },
					{ citekey: null, doi: "10.1234/outside", url: null, title: "An outside paper", year: 2020, abstract: "", authors: [], venue: "" },
				], searchLog: [{ query: "q", source: "library", results: 1 }] };
			} else if (props.rows) {
				const rows = [...req.input.matchAll(/### Paper (\S+)\nTitle: .*\nColumns to fill: (.*)\n/g)].map((m) => ({ row: m[1], cells: m[2].split(", ").map((column) => ({ column, status: "not_found", value: "", quotes: [] })) }));
				json = { rows };
			} else if (props.subQuestions) {
				json = { criteria: [], columns: [{ name: "Main findings", instruction: "The findings" }], assumed: [], subQuestions: [
					{ id: "sq1", question: "What do trials show?", strategy: "Search trials", sources: ["library", "scholarly"] },
					{ id: "sq2", question: "What are the mechanisms?", strategy: "Search reviews", sources: ["library"] },
				] };
			} else if (props.findings) {
				json = { findings: [{ claim: "It works", confidence: "high", quotes: ["a quote"], sources: [
					{ citekey: state.key, doi: null, url: null, title: state.title, year: 2024 },
					{ citekey: null, doi: "10.1234/outside", url: null, title: "An outside paper", year: 2020 },
				] }], searchLog: [{ query: "q", source: "library", results: 1 }] };
			} else if (props.title) {
				json = { title: "What the trials say", scope: "The whole library.", method: "Two sub-questions.",
					themes: [{ heading: "Efficacy", body: `Trials agree [@${state.key}].` }],
					evidence: [{ claim: "The effect is large", sources: [state.key], strength: "strong", cells: [] }],
					disagreements: "None found.", gaps: "Long-term data." };
			}
			if (json) { yield { type: "final", text: JSON.stringify(json), json, usage: {} }; return; }
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
	await IOUtils.write(PathUtils.join(PathUtils.parent(Zotero.DataDirectory.dir), name), Uint8Array.from(win.atob(base64), (c) => c.charCodeAt(0)));
}

const visible = (node) => node && !node.hidden && !node.closest("[hidden]");

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 900);
	Zotero.Prefs.clear("extensions.secondbrain.chatMode", true);
	Zotero.Prefs.clear("extensions.secondbrain.chatSources", true);
	const ai = await SB.ai();

	const ids = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false, true);
	const paper = (await Zotero.Items.getAsync(ids)).find((item) => item.isRegularItem()); // getAsync: Items.get throws on items not loaded yet
	await Zotero.Items.loadDataTypes([paper]);
	const state = { inputs: [], key: paper.getField("citationKey") || paper.key, title: paper.getField("title") };
	SB.agent.providers.set("fake", scriptedProvider(state));
	for (const role of ["chat", "ask", "lead", "researcher", "writer"]) await ai.providers.setRole(role, { provider: "fake", model: null });

	// ---- one composer, one mode menu
	const view = SB.openChat();
	await t.check(!view.doc.querySelector(".sb-ai-modes"), "the header has no mode switch any more");
	const labels = [...view.modePick.options].map((o) => o.textContent);
	await t.check(JSON.stringify(labels) === JSON.stringify(["Chat", "Research report", "Systematic review", "Routines", "Find papers", "Chat with papers", "Extract data", "Quick answer"]), "the mode menu lists the modes", labels);
	await t.check(view.modePick.closest(".sb-ai-composer"), "the mode menu sits in the composer, under the message box");
	await t.check(view.mode === "chat" && !visible(view.reportOptions), "Chat is the default; report options are hidden");
	// Spec 005 C2: all four source pills show in every mode now (Papers/Notes replaced the single Library pill).
	const shownSources = () => Object.entries(view.sourceButtons).filter(([, b]) => visible(b)).map(([id]) => id);
	await t.check(JSON.stringify(shownSources()) === '["papers","notes","scholarly","web"]', "Chat offers all four sources", shownSources());

	view.modePick.value = "report";
	view.modePick.dispatchEvent(new win.Event("change"));
	await t.check(view.mode === "report" && visible(view.optionsButton) && !visible(view.reportOptions), "picking Research report shows the options button, panel closed");
	view.optionsButton.click();
	await t.check(visible(view.scopeKind) && visible(view.yearFrom) && visible(view.depth), "its panel has scope, years and depth");
	view.setOptionsOpen(false);
	await t.check(JSON.stringify(shownSources()) === '["papers","notes","scholarly","web"]', "Research report offers all four sources", shownSources());
	await t.check(visible(view.attachButton) && view.attachButton.title === "Skills", "in Research report mode + is Skills", view.attachButton.title);
	await t.check(Zotero.Prefs.get("extensions.secondbrain.chatMode", true) === "report", "the mode is remembered");

	view.modePick.value = "chat";
	view.modePick.dispatchEvent(new win.Event("change"));
	const again = SB.openReview();
	await t.check(again === view && view.mode === "report", "Tools → Research Report opens the same chat, in report mode");
	const tabTypes = win.Zotero_Tabs._tabs.map((tab) => tab.type);
	await t.check(!tabTypes.includes("second-brain-review"), "no separate Literature Review tab exists", tabTypes);

	// ---- a report runs in the thread
	view.input.value = "Do the trials agree?";
	view.send.click();
	await t.waitFor(() => view.thread.querySelector(".sb-rp-plan"), "the plan");
	await t.check(view.thread.querySelector(".sb-ai-user-text")?.textContent === "Do the trials agree?", "the question shows as the user's message");
	await t.check(view.thread.querySelector(".sb-rp-stages.is-awaiting_approval")?.textContent.includes("Waiting for your approval"), "the progress line says it's waiting for the user");
	const questions = [...view.thread.querySelectorAll(".sb-rp-plan-q")];
	await t.check(questions.length === 2, "the plan's sub-questions are editable", questions.map((q) => q.textContent));
	await t.waitFor(() => view.list.querySelector(".sb-ai-conv.is-report"), "the report in the history");
	await t.waitFor(() => /waiting for your approval/.test(view.list.querySelector(".sb-ai-conv.is-report")?.textContent), "the history row's status");
	await t.check(view.list.querySelector(".sb-ai-conv.is-report .sb-ai-conv-title").textContent === "Do the trials agree?", "the history row is titled with the question");
	await snapshot(win, "unified-plan.png").catch(() => {});

	questions[0].textContent = "What do randomized trials show?";
	questions[0].dispatchEvent(new win.Event("input"));
	[...view.thread.querySelectorAll(".sb-rp-plan button")].find((b) => b.textContent === "Start research").click();
	await t.waitFor(() => view.thread.querySelector(".sb-rp-report"), "the finished report", 90000);
	await t.check(state.inputs.some((input) => input.includes("What do randomized trials show?")), "the edited sub-question reached the researcher");
	const report = view.thread.querySelector(".sb-rp-report");
	await t.check(report.querySelector(".sb-rp-title")?.textContent === "What the trials say", "the report shows in the thread with its title");
	const rows = report.querySelectorAll(".sb-rp-evidence tr");
	await t.check(rows.length === 2 && rows[1].querySelector(".sb-rp-strength.is-strong"), "the evidence table has the claim and its strength");
	const cite = report.querySelector(".sb-rp-evidence .cite");
	await t.check(cite && !cite.classList.contains("missing"), "the evidence table's paper is a working citation", cite?.textContent);
	await t.check([...report.querySelectorAll("h3")].some((h) => h.textContent === "Efficacy"), "themes show as sections");
	await t.check([...report.querySelectorAll("button")].some((b) => b.textContent === "Export as Word"), "export buttons sit under the report");
	await t.check(/Papers not in your library \(1\)/.test(view.thread.querySelector(".sb-rp-outside summary")?.textContent), "papers found outside the library are listed");
	await t.waitFor(() => /finished/.test(view.list.querySelector(".sb-ai-conv.is-report")?.textContent), "the history row says finished");
	await snapshot(win, "unified-report.png").catch(() => {});

	// ---- chats and reports share the history; reopening a report re-renders it
	view.modePick.value = "chat";
	view.modePick.dispatchEvent(new win.Event("change"));
	await t.check(!view.thread.querySelector(".sb-rp"), "switching mode starts an empty thread");
	view.input.value = "A quick chat";
	view.send.click();
	await t.waitFor(() => !view.running && view.list.querySelector(".sb-ai-conv:not(.is-report)"), "the chat in the history");
	const kinds = [...view.list.querySelectorAll(".sb-ai-conv")].map((row) => (row.classList.contains("is-report") ? "report" : "chat"));
	await t.check(kinds[0] === "chat" && kinds.includes("report"), "one list holds chats and reports, newest first", kinds);

	view.list.querySelector(".sb-ai-conv.is-report").click();
	await t.waitFor(() => view.thread.querySelector(".sb-rp-report"), "the reopened report");
	await t.check(view.mode === "report" && view.modePick.value === "report", "opening a report switches the menu to Research report");
	await t.check(view.list.querySelector(".sb-ai-conv.is-report").classList.contains("is-selected"), "the opened report is selected in the list");

	view.list.querySelector(".sb-ai-conv:not(.is-report)").click();
	await t.waitFor(() => !view.thread.querySelector(".sb-rp") && view.thread.querySelector(".sb-ai-md"), "the reopened chat");
	await t.check(view.mode === "chat" && !view.thread.querySelector(".sb-rp"), "opening a chat switches back to Chat");

	Zotero.Prefs.clear("extensions.secondbrain.chatMode", true);
	win.Zotero_Tabs.close(view.tabID);
	await t.check(SB.chatTab === null, "closing the tab clears it");
}
