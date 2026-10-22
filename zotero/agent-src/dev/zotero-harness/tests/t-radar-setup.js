/* global SB, Zotero */
// Spec 012 R2 in real Zotero: Routines offers the Reading radar (starter card when the list is empty, else the New radar
// button), the sheet opens, a topic is typed, Save creates a kind:radar routine that is then listed. Run against the LIVE
// server (SB_SERVER=http://127.0.0.1:27182): the radar needs it. The routine is set for 23:59 so the scheduler leaves it
// alone, and it is archived at the end whatever happens. A sidecar older than this build answers the profile route with a
// 404; the sheet then says it could not read the library and the test goes on with a typed topic.

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NAME = "R2 setup test radar (delete me)";

const q = (view, sel) => view.root.querySelector(sel);
const all = (view, sel) => [...view.root.querySelectorAll(sel)];
// HTML elements in a chrome document have no ownerGlobal; the docked chat lives in zoteroPane.xhtml.
const winOf = (el) => el.ownerGlobal ?? el.ownerDocument.defaultView;
const click = (el) => el.dispatchEvent(new (winOf(el).MouseEvent)("click", { bubbles: true }));
const fire = (el, type) => el.dispatchEvent(new (winOf(el).Event)(type, { bubbles: true }));
const type = (el, value) => { el.value = value; fire(el, "input"); };

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	Zotero.getMainWindow().resizeTo(1280, 900);
	const ai = await SB.ai();
	await t.check(ai.where === "server", "the library server is up, so Zotero uses its engine", ai.where);
	await t.check(!!ai.radar && typeof ai.radar.profile === "function" && typeof ai.radar.checkSource === "function", "the service has the radar API");
	const before = new Set((await ai.routines.list()).map((r) => r.id));
	let made = null;
	try {
		const view = SB.openChat();
		await pause(500);
		view.modePick.value = "routines";
		fire(view.modePick, "change");
		await t.waitFor(() => q(view, ".sb-rt"), "the Routines view", 10000);
		await t.waitFor(() => q(view, ".sb-rt-new-radar"), "the New radar button", 10000);
		const card = q(view, '[data-template="reading-radar"]');
		t.log(card ? "opening the Reading radar starter card" : "no starter cards (routines exist): opening New radar");
		click(card ?? q(view, ".sb-rt-new-radar"));
		await t.waitFor(() => q(view, ".sb-ra-card"), "the radar sheet", 10000);
		await t.check(q(view, ".sb-sk-title").textContent === "Reading radar", "the sheet is titled Reading radar", q(view, ".sb-sk-title").textContent);
		await t.check(q(view, ".sb-ra-name").value === "Reading radar" && q(view, ".sb-rt-time").value === "07:00", "name and time default", { name: q(view, ".sb-ra-name").value, time: q(view, ".sb-rt-time").value });
		await t.check(all(view, 'input[data-source^="database:"]').filter((i) => i.checked).map((i) => i.dataset.source).join() === "database:arxiv,database:chemrxiv,database:openalex", "arXiv, chemRxiv and OpenAlex are on");
		await t.waitFor(() => !/Reading your library/.test(q(view, ".sb-ra-bar .sb-ra-meta")?.textContent ?? ""), "the library profile to settle", 120000);
		t.log(`profile note: ${q(view, ".sb-ra-bar .sb-ra-meta").textContent}; topics ${all(view, '[data-list="topics"] .sb-ra-title').length}, authors ${all(view, '[data-list="authors"] .sb-ra-row:not(.sb-ra-add)').length}, journals ${all(view, '[data-list="journals"] .sb-ra-row:not(.sb-ra-add)').length}`);
		const style = view.win.getComputedStyle(q(view, ".sb-ra-save"));
		await t.check(style.whiteSpace === "normal", "sheet buttons wrap long text", style.whiteSpace);

		type(q(view, ".sb-ra-name"), NAME);
		type(q(view, '[data-list="topics"] .sb-ra-add-in'), "invented vole burrow ecology");
		click(q(view, '[data-list="topics"] .sb-ra-add-go'));
		await t.check(all(view, '[data-list="topics"] .sb-ra-title').some((n) => n.textContent === "invented vole burrow ecology"), "the typed topic is listed");
		type(q(view, ".sb-rt-time"), "23:59");
		click(q(view, ".sb-ra-save"));
		await t.waitFor(() => !q(view, ".sb-ra-card"), "the sheet to close after Save", 20000);

		made = (await ai.routines.list()).find((r) => r.name === NAME && !before.has(r.id));
		await t.check(!!made && made.kind === "radar" && made.status === "active", "a radar routine was created", made && { kind: made.kind, status: made.status });
		await t.check(made.radar.profile.topics.some((x) => x.text === "invented vole burrow ecology") && made.schedule.times.times.join() === "23:59" && made.target.kind === "session", "it holds the topic, the time and a new-chat target", made.radar.profile.topics.map((x) => x.text));
		await t.waitFor(() => all(view, ".sb-rt-name").some((n) => n.textContent === NAME), "the routine is listed in Routines", 20000);
		const listed = all(view, ".sb-rt-card").find((c) => c.querySelector(".sb-rt-name").textContent === NAME);
		await t.check(/^Reading radar/.test(listed.querySelector(".sb-rt-target").textContent), "its card says it is a reading radar", listed.textContent);

		click(listed.querySelector('[data-action="edit"]'));
		await t.waitFor(() => q(view, ".sb-ra-card"), "Edit opens the radar sheet", 10000);
		await t.check(q(view, ".sb-sk-title").textContent === "Edit reading radar" && q(view, ".sb-ra-name").value === NAME, "editing shows the saved name", q(view, ".sb-ra-name").value);
		click(all(view, ".sb-ra-card .sb-button").find((b) => b.textContent === "Cancel"));
	} finally {
		if (made) {
			await ai.routines.archive(made.id).catch((e) => t.log(`archive failed: ${e}`));
			t.log(`archived test routine ${made.id}`);
		}
	}
}
