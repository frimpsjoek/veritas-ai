/* global SB, Zotero */
// Routine news and routines in projects, in real Zotero: a run that adds papers puts an "N new" badge on the history row,
// the Routines card's last-run line opens that session, opening it clears the badge, and a routine filed under a project
// starts its sessions there. Run with SB_SERVER at a dead port. Scripted provider, invented papers.
// Not run when written (the machine was busy): selectors follow ui-src/src/chat/chat.js and routines-view.js.

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scriptedProvider(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req) {
			const wantsCandidates = Boolean(req.outputSchema?.properties?.candidates);
			if (wantsCandidates) {
				const json = { candidates: state.found, searchLog: [] };
				yield { type: "final", text: JSON.stringify(json), json, usage: {} };
				return;
			}
			yield { type: "final", text: "A short answer.", json: null, usage: {} };
		},
	};
}

const candidate = (n) => ({
	citekey: null, doi: `10.9999/fresh.${n}`, url: null, title: `Fresh Vole Study ${n}`, year: 2026,
	abstract: `New study ${n} on vole burrows.`, authors: [`B. Newcomer${n}`], venue: "Journal of Invented Zoology",
});
const row = (n) => ({
	id: `x:${n}`, ref: { kind: "web", url: `https://doi.org/10.9999/invented.${n}`, title: `Invented Study ${n}` }, inLibrary: false,
	title: `Invented Study ${n} of Meadow Life`, authors: [`A. Author${n}`], year: 2020, venue: "Journal of Invented Zoology",
	doi: `10.9999/invented.${n}`, url: null, abstract: "Voles.", citations: 0, fullText: false, pdfUrl: null, studyType: null, foundBy: ["OpenAlex"],
});
const q = (view, sel) => view.root.querySelector(sel);
const all = (view, sel) => [...view.root.querySelectorAll(sel)];
// HTML elements in a chrome document have no ownerGlobal; the docked chat lives in zoteroPane.xhtml.
const winOf = (el) => el.ownerGlobal ?? el.ownerDocument.defaultView;
const click = (el) => el.dispatchEvent(new (winOf(el).MouseEvent)("click", { bubbles: true }));
const fire = (el, type) => el.dispatchEvent(new (winOf(el).Event)(type, { bubbles: true }));
const summary = async (ai, id) => (await ai.conversations.list()).find((c) => c.id === id);

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 900);
	const ai = await SB.ai();
	await t.check(!!ai.routines && typeof ai.conversations.markSeen === "function", "the service has routines and markSeen");
	const state = { found: [candidate(1), candidate(2)] };
	SB.agent.providers.set("fake", scriptedProvider(state));
	for (const role of ["chat", "ask", "researcher", "extract", "writer"]) await ai.providers.setRole(role, { provider: "fake", model: null }).catch(() => {});

	const conv = await ai.conversations.create("chat");
	const id = conv.id ?? conv;
	await ai.sessions.put(id, { kind: "find", query: "voles", sources: { papers: true, notes: false, scholarly: true, web: false }, scope: { kind: "library" } }, {
		ref: { id: "R1", version: 1 }, title: "Invented voles", created: new Date().toISOString(), madeBy: "S1", from: [], change: "Found papers",
		kind: "papers", query: "voles", rows: [row(1), row(2)], columns: [], cells: {}, screening: null, summary: null,
	});

	const routine = await ai.routines.create({
		name: "Vole watch", prompt: "new vole papers", schedule: { days: { kind: "daily" }, times: { kind: "at", times: ["23:59"] } },
		target: { kind: "artifact", session: id, result: { id: "R1" } },
	});
	await t.check(!(await summary(ai, id)).news, "no news before a run");
	await ai.routines.runNow(routine.id);
	await t.waitFor(async () => (await summary(ai, id)).news?.papers === 2, "the run to leave 2 papers of news", 120000);

	// ---- the history row carries the badge
	const view = SB.openChat();
	await pause(500);
	await view.refreshList();
	await t.waitFor(() => q(view, `.sb-ai-conv[data-session="${id}"] .sb-ai-news`), "the history row shows a badge", 10000);
	await t.check(q(view, `.sb-ai-conv[data-session="${id}"] .sb-ai-news`).textContent === "2 new", "the badge reads '2 new'", q(view, ".sb-ai-news")?.textContent);

	// ---- the Routines card line opens the session
	view.modePick.value = "routines";
	fire(view.modePick, "change");
	await t.waitFor(() => q(view, ".sb-rt-last.is-link"), "the last-run line becomes a link", 20000);
	click(q(view, ".sb-rt-last.is-link"));
	await t.waitFor(async () => !(await summary(ai, id)).news, "opening the session marks it seen", 10000);
	await t.waitFor(() => !q(view, `.sb-ai-conv[data-session="${id}"] .sb-ai-news`), "and the badge is gone", 10000);

	// ---- a routine in a project starts its sessions there
	const project = await ai.projects.create("Voles");
	const digest = await ai.routines.create({
		name: "Vole digest", prompt: "vole burrows", depth: "quick", schedule: { days: { kind: "daily" }, times: { kind: "at", times: ["23:59"] } }, target: { kind: "session" }, project: project.id,
	});
	await t.check(digest.project === project.id, "the routine keeps its project", digest.project);
	view.modePick.value = "routines";
	fire(view.modePick, "change");
	await t.waitFor(() => all(view, ".sb-rt-card").some((c) => /In Voles/.test(c.textContent)), "the card says 'In Voles'", 20000);
	click(q(view, ".sb-rt-new"));
	await t.waitFor(() => q(view, ".sb-rt-project-pick"), "the sheet has a Project select", 5000);
	await t.check([...q(view, ".sb-rt-project-pick").options].map((o) => o.textContent).join() === "None,Voles", "None and the project");
	click(view.root.querySelector(".sb-sk-actions button:last-child"));
}
