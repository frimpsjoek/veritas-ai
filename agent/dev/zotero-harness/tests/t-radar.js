/* global SB, Zotero */
// Spec 012 R4 in real Zotero (spec checks 3 and 9): a radar with arXiv, one feed and OpenAlex (size 3) runs now. OpenAlex is there
// because arXiv and its feed are empty at weekends, and a quiet run has no digest to check. its digest opens from
// the Routines card, the New table shows rows (with the why line and the three actions on a build that has R4), Not relevant
// and Undo work, and a second run shows none of the same papers. Run against the LIVE server (SB_SERVER=http://127.0.0.1:27182):
// the radar needs its embeddings and its sidecar. The radar is set for 23:59 so the scheduler leaves it alone, and it is archived
// at the end whatever happens.
//
// The live sidecar runs dist/agentd.mjs of the main checkout. Until R4 is merged and that file rebuilt, a digest has no
// `radar` field, so the checks marked "needs the merged build" log SKIP and everything else (run, digest opens, table rows,
// no repeats) still runs. The last lines printed are the ids to clean up by hand:
//   TEST-IDS routine=<id> sessions=<id>,<id> note=<name or none>
// (routine file data/agent/routines/<id>.json, state dir data/agent/radar/<id>, DELETE /agent/conversations?id=<session>,
// and the vault note Second Brain/Digests/<note>.md).

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NAME = "R4 digest test radar (delete me)";
const FEED = "https://rss.arxiv.org/atom/cond-mat.mtrl-sci";

const q = (view, sel) => view.root.querySelector(sel);
const all = (view, sel) => [...view.root.querySelectorAll(sel)];
const winOf = (el) => el.ownerGlobal ?? el.ownerDocument?.defaultView ?? Zotero.getMainWindow();
const click = (el) => el.dispatchEvent(new (winOf(el).MouseEvent)("click", { bubbles: true }));
const fire = (el, type) => el.dispatchEvent(new (winOf(el).Event)(type, { bubbles: true }));
const isoDay = (ms) => {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	Zotero.getMainWindow().resizeTo(1280, 900);
	const ai = await SB.ai();
	await t.check(ai.where === "server", "the library server is up, so Zotero uses its engine", ai.where);
	await t.check(!!ai.radar && typeof ai.radar.profile === "function", "the service has the radar API");
	const before = new Set((await ai.routines.list()).map((r) => r.id));
	const sessions = [];
	let made = null;
	try {
		made = await ai.routines.create({
			name: NAME, kind: "radar", schedule: { days: { kind: "daily" }, times: { kind: "at", times: ["23:59"] } },
			radar: {
				scope: { kind: "library" }, note: true, size: { fresh: 3, older: 0 },
				profile: { topics: ["machine learning interatomic potentials", "density functional theory", "quantum dots"].map((text) => ({ text, weight: 1, origin: "user" })), authors: [], journals: [] },
				sources: [{ kind: "database", db: "arxiv" }, { kind: "database", db: "openalex" }, { kind: "feed", url: FEED, title: "arXiv materials science" }],
			},
		});
		t.log(`TEST-IDS routine=${made.id}`);
		await t.check(made.kind === "radar" && !before.has(made.id), "the radar was created", made.kind);

		await ai.routines.runNow(made.id);
		const first = await t.waitFor(async () => (await ai.routines.list()).find((r) => r.id === made.id)?.lastRun, "the first run to finish", 240000);
		t.log(`first run: ${first.status}, added ${first.added}, ${first.summary ?? first.reason}`);
		await t.check(first.status === "done", "the first run finished", first.reason);
		if (first.session) sessions.push(first.session);
		if (!first.added) {
			t.log("quiet run (nothing above the bar today): the digest checks cannot run now");
			return;
		}
		t.log(`TEST-IDS routine=${made.id} sessions=${sessions.join(",")}`);

		const view = SB.openChat();
		await pause(500);
		view.modePick.value = "routines";
		fire(view.modePick, "change");
		await t.waitFor(() => all(view, ".sb-rt-card").some((c) => c.querySelector(".sb-rt-name")?.textContent === NAME), "the radar is listed", 20000);
		const card = all(view, ".sb-rt-card").find((c) => c.querySelector(".sb-rt-name")?.textContent === NAME);
		await t.waitFor(() => card.querySelector(".sb-rt-last.is-link"), "its last-run line becomes a link", 20000);
		click(card.querySelector(".sb-rt-last.is-link"));
		await t.waitFor(() => all(view, ".sb-art-card").some((c) => /New/.test(c.textContent)), "the digest opens with a New card", 20000);
		click(all(view, ".sb-art-card").find((c) => /New/.test(c.textContent)));
		await t.waitFor(() => q(view, ".sb-art-table, .sb-art-cardlist"), "the New table", 20000);
		const rows = all(view, ".sb-art-row, .sb-art-rowcard");
		await t.check(rows.length === first.added, `the New table has the ${first.added} rows the run reported`, rows.length);
		await t.check(rows.every((r) => r.querySelector(".sb-art-title")?.textContent), "every row has a title");

		const body = await ai.sessions.read(first.session, (await ai.sessions.view(first.session)).results.find((r) => r.title === "New").ref);
		const merged = !!body.radar;
		const needsMerged = async (label, fn) => {
			if (!merged) { t.log(`SKIP (needs the merged build): ${label}`); return; }
			await fn();
		};
		t.log(merged ? "this sidecar has R4: running the action checks" : "this sidecar predates R4: the action checks are skipped");

		await needsMerged("the summary line sits above the table", async () => {
			const line = q(view, ".sb-dg-summary")?.textContent ?? "";
			await t.check(/^\d+ new from \d+ sources?/.test(line) && line === body.radar.summary, "the summary line reads like '3 new from 2 sources'", line);
		});
		await needsMerged("every row has Add to Zotero, Read later and Not relevant", async () => {
			const first3 = all(view, ".sb-art-row:first-child .sb-dg-act, .sb-art-rowcard:first-child .sb-dg-act").map((b) => b.textContent);
			await t.check(first3.join() === "Add to Zotero,Read later,Not relevant", "the first row offers the three actions", first3);
		});
		await needsMerged("the rows carry a why line or a cited-by reason or the no-abstract note", async () => {
			const lines = all(view, ".sb-dg-line").map((l) => l.textContent);
			await t.check(lines.length > 0 && lines.every((l) => l.length > 0), "why lines are shown (a model failure leaves none, which is also allowed)", lines);
		});
		await needsMerged("Not relevant greys the row, Undo brings it back", async () => {
			const rowEl = all(view, ".sb-art-row, .sb-art-rowcard")[0];
			const key = rowEl.dataset.row;
			click([...rowEl.querySelectorAll(".sb-dg-act")].find((b) => b.textContent === "Not relevant"));
			await t.waitFor(() => rowEl.classList.contains("is-dismissed"), "the row greys out", 20000);
			await t.check(rowEl.querySelector(".sb-dg-state")?.textContent === "Not relevant" && q(view, ".sb-dg-toast"), "it says Not relevant and a toast offers Undo");
			const verdicts = await ai.radar.verdicts(made.id);
			await t.check(Object.values(verdicts).includes("dismissed"), "the radar recorded the dismissal", verdicts);
			click(q(view, ".sb-dg-toast .sb-dg-act"));
			await t.waitFor(() => !rowEl.classList.contains("is-dismissed"), "Undo restores the row", 20000);
			const after = await ai.radar.verdicts(made.id);
			await t.check(!Object.keys(after).includes(body.rows.find((r) => r.id === key)?.radar?.key), "the verdict is gone after Undo", after);
		});

		// spec check 3: a second run shows none of the papers the first one showed
		const shown = new Set(body.rows.map((r) => r.doi ?? r.title));
		await pause(1500);
		await ai.routines.runNow(made.id);
		const second = await t.waitFor(async () => { const l = (await ai.routines.list()).find((r) => r.id === made.id)?.lastRun; return l && l.at !== first.at ? l : null; }, "the second run to finish", 240000);
		t.log(`second run: ${second.status}, added ${second.added}, ${second.summary ?? second.reason}`);
		await t.check(second.status === "done", "the second run finished", second.reason);
		if (second.session) {
			sessions.push(second.session);
			t.log(`TEST-IDS routine=${made.id} sessions=${sessions.join(",")}`);
			const again = await ai.sessions.read(second.session, (await ai.sessions.view(second.session)).results.find((r) => r.title === "New").ref);
			const repeats = again.rows.filter((r) => shown.has(r.doi ?? r.title));
			await t.check(repeats.length === 0, "the second digest repeats nothing from the first", repeats.map((r) => r.title));
		} else await t.check(true, "the second run was quiet, so nothing can repeat");
		t.log(`vault note: ${merged ? `Second Brain/Digests/${isoDay(Date.now())} ${NAME}.md (written by the run when the vault accepts it)` : "none: this sidecar predates R4"}`);
	} finally {
		if (made) {
			await ai.routines.archive(made.id).catch((e) => t.log(`archive failed: ${e}`));
			t.log(`archived test radar ${made.id}`);
			t.log(`TEST-IDS routine=${made.id} sessions=${sessions.join(",") || "none"} note=${isoDay(Date.now())} ${NAME}`);
		}
	}
}
