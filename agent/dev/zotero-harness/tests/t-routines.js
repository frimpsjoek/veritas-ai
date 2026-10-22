/* global SB, Zotero */
// Spec 011 U4 in real Zotero: Routines opens from the mode menu (no composer, not remembered), shows three starter cards
// when empty, "Create routine for this" on a papers result opens the sheet prefilled, the routine runs (Run now) and writes
// V2 with the new rows highlighted, a second run with nothing new writes no version, Pause moves the card to Paused.
// Run with SB_SERVER at a dead port so routines live in Zotero's own data folder. Scripted provider, invented papers.
// Not run yet when written (Zotero.app was being reinstalled): the selectors follow ui-src/src/chat/routines-view.js.

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LIMIT = "Routines run while the Second Brain server or Zotero is running. Missed runs catch up once.";

// A routine's search turn asks for CANDIDATES_SCHEMA (a `candidates` array); everything else gets a short answer.
function scriptedProvider(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req) {
			const wantsCandidates = Boolean(req.outputSchema?.properties?.candidates);
			state.turns.push({ candidates: wantsCandidates, input: req.input });
			if (wantsCandidates) {
				const json = { candidates: state.found, searchLog: [] };
				yield { type: "final", text: JSON.stringify(json), json, usage: {} };
				return;
			}
			yield { type: "final", text: "A short answer.", json: null, usage: {} };
		},
	};
}

const papers = (n) => Array.from({ length: n }, (_, i) => ({
	id: `x:${i + 1}`, ref: { kind: "web", url: `https://doi.org/10.9999/invented.${i + 1}`, title: `Invented Study ${i + 1}` }, inLibrary: false,
	title: `Invented Study ${i + 1} of Meadow Life`, authors: [`A. Author${i + 1}`], year: 2015 + (i % 10), venue: "Journal of Invented Zoology",
	doi: `10.9999/invented.${i + 1}`, url: null,
	abstract: `Study ${i + 1} looks at voles. It found that burrow depth matters.`,
	citations: i, fullText: false, pdfUrl: null, studyType: null, foundBy: ["OpenAlex"],
}));

const candidate = (n) => ({
	citekey: null, doi: `10.9999/fresh.${n}`, url: null, title: `Fresh Vole Study ${n}`, year: 2026,
	abstract: `New study ${n} on vole burrows.`, authors: [`B. Newcomer${n}`], venue: "Journal of Invented Zoology",
});

const q = (view, sel) => view.root.querySelector(sel);
const all = (view, sel) => [...view.root.querySelectorAll(sel)];
const winOf = (el) => el.ownerGlobal ?? el.ownerDocument.defaultView;
const click = (el) => el.dispatchEvent(new (winOf(el).MouseEvent)("click", { bubbles: true }));
const fire = (el, type) => el.dispatchEvent(new (winOf(el).Event)(type, { bubbles: true }));
const type = (el, value) => { el.value = value; fire(el, "input"); };
const latestVersion = async (ai, id) => (await ai.sessions.view(id)).results.find((r) => r.ref.id === "R1")?.ref.version;

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 900);
	const ai = await SB.ai();
	await t.check(!!ai.routines && typeof ai.routines.list === "function", "the service has routines");
	const state = { turns: [], found: [candidate(1), candidate(2), { ...candidate(3), doi: "10.9999/invented.1" }] };
	SB.agent.providers.set("fake", scriptedProvider(state));
	for (const role of ["chat", "ask", "researcher", "extract", "writer"]) await ai.providers.setRole(role, { provider: "fake", model: null }).catch(() => {});

	// an artifact to watch: eight papers
	const conv = await ai.conversations.create("chat");
	const id = conv.id ?? conv;
	await ai.sessions.put(id, { kind: "find", query: "voles", sources: { papers: true, notes: false, scholarly: true, web: false }, scope: { kind: "library" } }, {
		ref: { id: "R1", version: 1 }, title: "Invented voles", created: new Date().toISOString(), madeBy: "S1", from: [], change: "Found papers",
		kind: "papers", query: "voles", rows: papers(8), columns: [], cells: {}, screening: null, summary: null,
	});

	// ---- Routines from the mode menu: a view, no composer, never remembered
	const view = SB.openChat();
	await pause(500);
	const values = [...view.modePick.options].map((o) => o.value);
	await t.check(values.includes("routines") && values.indexOf("routines") > values.indexOf("systematic"), "Routines is in the mode menu, under Workflows", values);
	view.modePick.value = "routines";
	fire(view.modePick, "change");
	await t.waitFor(() => q(view, ".sb-rt"), "the Routines view", 10000);
	await t.check(view.mode === "routines" && view.composer.hidden, "Routines has no composer", { mode: view.mode, hidden: view.composer.hidden });
	await t.check(view.host.prefs.get("chatMode") !== "routines", "Routines is never saved as the chat mode", view.host.prefs.get("chatMode"));
	await t.check(all(view, ".sb-rt-tab").map((b) => b.textContent.replace(/ \(\d+\)$/, "")).join() === "Active,Paused,Archived", "tabs are Active / Paused / Archived");
	await t.waitFor(() => all(view, ".sb-rt-template").length === 3, "three starter cards when empty", 10000);
	const boxes = all(view, ".sb-rt-template").map((c) => ({ r: c.getBoundingClientRect(), fits: c.scrollHeight <= c.clientHeight + 1 }));
	const overlap = boxes.some((x, i) => boxes.some((y, j) => i < j && x.r.left < y.r.right && y.r.left < x.r.right && x.r.top < y.r.bottom && y.r.top < x.r.bottom));
	await t.check(!overlap && boxes.every((b) => b.fits), "the starter cards hold their text and do not overlap", boxes.map((b) => [Math.round(b.r.top), Math.round(b.r.height), b.fits]));
	await t.check(q(view, ".sb-rt-foot").textContent === LIMIT, "the footer says when routines run", q(view, ".sb-rt-foot").textContent);

	// a starter opens the sheet with its draft; nothing is saved until the user confirms
	click(q(view, ".sb-rt-template"));
	await t.waitFor(() => q(view, ".sb-rt-overlay .sb-rt-in-name"), "the sheet from a starter", 10000);
	await t.check(q(view, ".sb-rt-in-name").value === "Daily preprint digest" && q(view, ".sb-rt-time").value === "07:30", "the starter fills name and time", q(view, ".sb-rt-in-name").value);
	await t.check((await ai.routines.list()).length === 0, "nothing is saved yet");
	const saveStyle = view.win.getComputedStyle(q(view, ".sb-rt-save"));
	await t.check(saveStyle.whiteSpace === "normal", "sheet buttons wrap long text (Obsidian buttons are nowrap)", saveStyle.whiteSpace);
	click(all(view, ".sb-rt-overlay .sb-button").find((b) => b.textContent === "Cancel"));
	await t.check(!q(view, ".sb-rt-overlay") && (await ai.routines.list()).length === 0, "Cancel closes the sheet and saves nothing");

	// ---- "Create routine for this" on the papers result prefills the sheet
	await view.openConversation(id);
	await t.waitFor(() => q(view, ".sb-art-card"), "the papers card", 30000);
	await t.check(!view.composer.hidden && view.mode !== "routines", "leaving Routines brings the composer back");
	click(q(view, ".sb-art-card"));
	await t.waitFor(() => /Invented Study 1/.test(q(view, ".sb-art .sb-art-body")?.textContent ?? ""), "the papers panel", 30000);
	const panel = q(view, ".sb-art");
	click(panel.querySelector('.sb-art-iconbtn[aria-label="More"]'));
	const item = await t.waitFor(() => [...view.doc.documentElement.querySelectorAll(".sb-art-item")].find((b) => /^Create routine for this/.test(b.textContent)), "More offers Create routine for this", 10000);
	click(item);
	await t.waitFor(() => q(view, ".sb-rt-overlay .sb-rt-in-name"), "the prefilled sheet", 10000);
	await t.check(/^Watch: Invented voles/.test(q(view, ".sb-rt-in-name").value) && /Invented voles/.test(q(view, ".sb-rt-in-prompt").value), "name and prompt come from the table", { name: q(view, ".sb-rt-in-name").value, prompt: q(view, ".sb-rt-in-prompt").value });
	const radios = all(view, ".sb-rt-radio input");
	await t.check(radios.length === 2 && radios[0].value === "artifact" && radios[0].checked, "the target is this table, with a new session as the other choice", radios.map((r) => [r.value, r.checked]));
	// the When row: days, times as chips, a plain preview from the engine's nextRun
	const sheet = q(view, ".sb-rt-overlay");
	await t.check(q(view, ".sb-rt-days").value === "daily" && all(view, ".sb-rt-timechip").length === 1 && /^Next: /.test(q(view, ".sb-rt-preview").textContent), "a new routine is daily at one time, with a Next preview", q(view, ".sb-rt-preview").textContent);
	q(view, ".sb-rt-days").value = "some";
	fire(q(view, ".sb-rt-days"), "change");
	await t.check(all(view, "[data-weekday]").length === 7, "Pick days shows seven day chips", all(view, "[data-weekday]").length);
	click(q(view, '[data-weekday="1"]'));
	await t.check(q(view, '[data-weekday="1"]').getAttribute("aria-pressed") === "false" && /day/.test(q(view, ".sb-rt-preview").textContent), "with no day chosen the preview becomes the problem", q(view, ".sb-rt-preview").textContent);
	click(q(view, '[data-weekday="1"]'));
	q(view, ".sb-rt-days").value = "weekdays";
	fire(q(view, ".sb-rt-days"), "change");
	click(q(view, ".sb-rt-addtime"));
	await t.check(all(view, ".sb-rt-timechip").length === 2, "+ Add time adds a second time chip");
	const preview = q(view, ".sb-rt-preview").textContent;
	await t.check(/^Next: (today|tomorrow|Mon|Tue|Wed|Thu|Fri) \d\d:\d\d, then /.test(preview) && /07:30/.test(preview) && /08:30/.test(preview), "the preview names the next two runs", preview);
	for (let i = 0; i < 5; i++) if (!q(view, ".sb-rt-addtime").disabled) click(q(view, ".sb-rt-addtime"));
	await t.check(all(view, ".sb-rt-timechip").length === 6 && q(view, ".sb-rt-addtime").disabled, "six times is the most, and + Add time stops");
	await t.check(sheet.scrollWidth <= sheet.clientWidth + 1, "the When row stays inside the sheet", { scroll: sheet.scrollWidth, client: sheet.clientWidth });
	q(view, ".sb-rt-mode").value = "hourly";
	fire(q(view, ".sb-rt-mode"), "change");
	q(view, ".sb-rt-hours").value = "4"; fire(q(view, ".sb-rt-hours"), "input");
	await t.check(/^Next: .*\d\d:\d\d, then/.test(q(view, ".sb-rt-preview").textContent), "every 4 hours previews", q(view, ".sb-rt-preview").textContent);
	q(view, ".sb-rt-mode").value = "at";
	fire(q(view, ".sb-rt-mode"), "change");
	while (all(view, ".sb-rt-timechip").length > 1) click(all(view, ".sb-rt-timex")[1]);
	await t.check(all(view, ".sb-rt-timechip").length === 1 && q(view, ".sb-rt-time").value === "07:30", "chips can be removed down to the first time", all(view, ".sb-rt-time").map((i) => i.value));
	q(view, ".sb-rt-days").value = "daily";
	fire(q(view, ".sb-rt-days"), "change");
	// the Skills field uses the U3 dialog: its "Use skill" adds a chip here
	click(q(view, ".sb-rt-addskill"));
	await t.waitFor(() => all(view, ".sb-sk-row").length >= 5, "the Skills dialog over the sheet", 20000);
	click(all(view, ".sb-sk-use")[0]);
	await t.waitFor(() => q(view, ".sb-rt-overlay .sb-ai-skill-chip"), "a skill chip in the sheet", 10000);
	await t.check(q(view, ".sb-rt-overlay .sb-ai-skill-chip .sb-ai-chip-x") !== null, "the chip can be removed");
	// an empty name is refused with a plain sentence
	type(q(view, ".sb-rt-in-name"), "");
	click(q(view, ".sb-rt-save"));
	await t.check(/name/i.test(q(view, ".sb-rt-overlay .sb-sk-status").textContent), "saving without a name says so", q(view, ".sb-rt-overlay .sb-sk-status").textContent);
	type(q(view, ".sb-rt-in-name"), "Watch voles");
	q(view, ".sb-rt-time").value = "07:30";
	click(q(view, ".sb-rt-save"));
	await t.waitFor(() => !q(view, ".sb-rt-overlay"), "the sheet closes after saving", 20000);
	const made = await ai.routines.list();
	await t.check(made.length === 1 && made[0].target.kind === "artifact" && made[0].target.session === id && made[0].schedule.times.times.join() === "07:30" && made[0].schedule.days.kind === "daily" && made[0].name === "Watch voles", "one routine saved, aimed at the table", made[0]);
	await t.check(typeof made[0].nextRun === "string" && made[0].skills.length === 1, "it has a next run and the chosen skill", { next: made[0].nextRun, skills: made[0].skills });

	// ---- the card, then a run: V2 with the new rows (one candidate was already in the table)
	view.modePick.value = "routines";
	fire(view.modePick, "change");
	await t.waitFor(() => all(view, ".sb-rt-card").length === 1, "one card in Active", 10000);
	const card = q(view, ".sb-rt-card");
	await t.check(card.querySelector(".sb-rt-name").textContent === "Watch voles" && /^Every day at 07:30/.test(card.querySelector(".sb-rt-schedule").textContent), "the card names it and its schedule");
	await t.check(/^Next run: /.test(card.querySelector(".sb-rt-next").textContent) && /Has not run yet/.test(card.querySelector(".sb-rt-last").textContent), "next run and 'has not run yet'", card.textContent);
	await t.check(["run", "pause", "edit", "archive"].every((a) => card.querySelector(`[data-action="${a}"]`)), "Run now, Pause, Edit and Archive", [...card.querySelectorAll("[data-action]")].map((b) => b.dataset.action));
	click(card.querySelector('[data-action="run"]'));
	await t.waitFor(async () => (await latestVersion(ai, id)) === 2, "the run to write V2", 120000);
	const v2 = await ai.sessions.read(id, { id: "R1" });
	await t.check(v2.rows.length === 10 && v2.addedRows?.length === 2 && v2.rows.slice(0, 8).every((r, i) => r.id === `x:${i + 1}`), "V2 keeps the 8 rows and adds the 2 new ones (the duplicate DOI is dropped)", { rows: v2.rows.length, added: v2.addedRows });
	await t.check(/2 new/.test(v2.change ?? ""), "the change line counts the new papers", v2.change);
	await t.waitFor(() => /Ran .*2 new papers/.test(q(view, ".sb-rt-last")?.textContent ?? ""), "the card reports the run", 30000);
	await t.check(!q(view, ".sb-rt-note"), "once the run has ended, the 'Started' line is gone", q(view, ".sb-rt-note")?.textContent);

	// the table highlights those two rows
	await view.openConversation(id);
	await t.waitFor(() => q(view, ".sb-art-card"), "the card again", 30000);
	click([...view.root.querySelectorAll(".sb-art-card")].pop());
	await t.waitFor(() => view.root.querySelectorAll(".sb-art .sb-art-row").length === 10, "ten rows in the panel", 30000);
	const fresh = [...view.root.querySelectorAll(".sb-art .sb-art-row-new")];
	await t.check(fresh.length === 2 && fresh.every((r) => v2.addedRows.includes(r.dataset.row)), "exactly the two added rows carry sb-art-row-new", fresh.map((r) => r.dataset.row));
	const bg = (el) => view.win.getComputedStyle(el.querySelector(".sb-art-td")).backgroundColor;
	await t.check(bg(fresh[0]) !== bg(view.root.querySelector(".sb-art .sb-art-row:not(.sb-art-row-new)")), "a new row looks different from an old one", [bg(fresh[0]), bg(view.root.querySelector(".sb-art .sb-art-row:not(.sb-art-row-new)"))]);

	// ---- nothing new: no V3
	state.found = [candidate(1), candidate(2)];
	view.modePick.value = "routines";
	fire(view.modePick, "change");
	await t.waitFor(() => q(view, ".sb-rt-card"), "the card", 10000);
	click(q(view, '.sb-rt-card [data-action="run"]'));
	await t.waitFor(() => /nothing new/.test(q(view, ".sb-rt-last")?.textContent ?? ""), "the card says nothing new", 120000);
	await t.check((await latestVersion(ai, id)) === 2, "a run with nothing new writes no version", await latestVersion(ai, id));

	// ---- Pause moves it out of Active; Resume brings it back; Archive then Restore
	click(q(view, '.sb-rt-card [data-action="pause"]'));
	await t.waitFor(() => all(view, ".sb-rt-card").length === 0, "Pause takes it out of Active", 10000);
	click(view.root.querySelector('.sb-rt-tab[data-tab="paused"]'));
	await t.waitFor(() => all(view, ".sb-rt-card").length === 1, "it is under Paused", 10000);
	await t.check(q(view, ".sb-rt-next").textContent === "Paused" && q(view, '[data-action="run"]').disabled, "a paused card says Paused and cannot Run now", q(view, ".sb-rt-card").textContent);
	click(q(view, '.sb-rt-card [data-action="resume"]'));
	await t.waitFor(() => all(view, ".sb-rt-card").length === 0, "Resume takes it out of Paused", 10000);
	click(view.root.querySelector('.sb-rt-tab[data-tab="active"]'));
	await t.waitFor(() => all(view, ".sb-rt-card").length === 1, "and puts it back in Active", 10000);
	click(q(view, '.sb-rt-card [data-action="archive"]'));
	await t.waitFor(() => all(view, ".sb-rt-card").length === 0, "Archive takes it out of Active", 10000);
	click(view.root.querySelector('.sb-rt-tab[data-tab="archived"]'));
	await t.waitFor(() => all(view, ".sb-rt-card").length === 1, "it is under Archived", 10000);
	await t.check(all(view, ".sb-rt-card [data-action]").map((b) => b.dataset.action).join() === "restore", "an archived card offers only Restore", all(view, ".sb-rt-card [data-action]").map((b) => b.dataset.action));
	click(q(view, '.sb-rt-card [data-action="restore"]'));
	await t.waitFor(() => all(view, ".sb-rt-card").length === 0, "Restore takes it out of Archived", 10000);
	click(view.root.querySelector('.sb-rt-tab[data-tab="active"]'));
	await t.waitFor(() => all(view, ".sb-rt-card").length === 1, "and it is Active again", 10000);
	await t.check((await ai.routines.list())[0].status === "active", "the stored status is active");

	// ---- a spec 011 record (daily/weekly with one time) is read as the new shape and still shows in plain words
	const now = new Date().toISOString();
	const old = { id: "oldweekly1", name: "Old Monday watch", prompt: "p", skills: [], depth: "quick", schedule: { kind: "weekly", weekday: 1, time: "18:00" }, target: { kind: "session" },
		sources: null, scope: null, status: "active", created: now, updated: now, lastSlot: now, lastRun: null, notify: false };
	await ai.routines.adopt([old]);
	const migrated = (await ai.routines.list()).find((r) => r.id === "oldweekly1");
	await t.check(migrated && migrated.schedule.days.kind === "some" && migrated.schedule.days.weekdays.join() === "1" && migrated.schedule.times.times.join() === "18:00", "an old weekly record reads as Mondays at 18:00", migrated?.schedule);
	click(view.root.querySelector('.sb-rt-tab[data-tab="paused"]'));
	click(view.root.querySelector('.sb-rt-tab[data-tab="active"]'));
	await t.waitFor(() => all(view, ".sb-rt-card").some((c) => /^Every Monday at 18:00/.test(c.querySelector(".sb-rt-schedule")?.textContent ?? "")), "its card says 'Every Monday at 18:00'", 30000);
}
