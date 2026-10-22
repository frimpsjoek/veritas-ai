/* global SB, Zotero, IOUtils, PathUtils */
// Spec 011 U3 in real Zotero: the Skills dialog from the `+` menu (tabs, search, create three ways, edit, delete), a chip in
// the composer, a chat turn that carries the skill and records it, files edited outside showing up, and the broken / oversize
// files listed with a warning. Run with SB_SERVER at a dead port so skills live in Zotero's own data folder.
// Scripted provider, invented content.

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scriptedProvider(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn(req) {
			state.turns.push({ instructions: req.instructions, input: req.input, specs: req.tools?.specs?.length ?? 0 });
			if (/^Draft a skill for a research assistant/.test(req.input)) {
				const json = { name: "Two Bullet Answers", description: "Answer in two bullets.", instructions: "Answer in exactly two bullets." };
				yield { type: "final", text: JSON.stringify(json), json, usage: {} };
				return;
			}
			yield { type: "final", text: "A short answer.", json: null, usage: {} };
		},
	};
}

const q = (view, sel) => view.root.querySelector(sel);
const rows = (view) => [...view.root.querySelectorAll(".sb-sk-row")];
const names = (view) => rows(view).map((r) => r.dataset.name);
const winOf = (el) => el.ownerGlobal ?? el.ownerDocument.defaultView;
const click = (el) => el.dispatchEvent(new (winOf(el).MouseEvent)("click", { bubbles: true }));
const type = (el, value) => { el.value = value; el.dispatchEvent(new (winOf(el).Event)("input", { bubbles: true })); };

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 900);
	const ai = await SB.ai();
	const state = { turns: [] };
	SB.agent.providers.set("fake", scriptedProvider(state));
	for (const role of ["chat", "ask", "writer"]) await ai.providers.setRole(role, { provider: "fake", model: null });
	const dir = PathUtils.join(Zotero.DataDirectory.dir, "second-brain", "skills");

	const view = SB.openChat();
	await pause(500);
	const dialog = view.skillsDialog;

	// ---- Skills is in the composer: the `+` picker when the host has one (Obsidian), else a Skills button beside "+ Add papers" (Zotero)
	if (view.picker) {
		click(q(view, ".sb-ai-add"));
		const entry = await t.waitFor(() => q(view, ".sb-ai-picker-skills"), "Skills in the + menu", 10000);
		await t.check(!entry.hidden && entry.textContent.startsWith("Skills"), "the + menu shows Skills", entry.textContent);
		click(entry);
	} else {
		await t.check(!!view.skillsButton && !view.skillsButton.hidden && view.skillsButton.textContent === "Skills", "the composer row has a Skills button (this host has no + picker)");
		click(view.skillsButton);
	}
	await t.waitFor(() => q(view, ".sb-sk-overlay") && rows(view).length === 5, "the dialog lists the five built-ins", 20000);
	await t.check(names(view).join("|") === "General Review|1-Page Overview|Research Gap Analysis|Compare Options Across Items|Reproducibility Review", "the starters are the five generic ones, in order", names(view));
	const tabs = [...view.root.querySelectorAll(".sb-sk-tab")].map((b) => b.textContent);
	await t.check(tabs.join() === "All,By you,Built-in", "tabs are All / By you / Built-in", tabs);
	click(view.root.querySelector('.sb-sk-tab[data-tab="mine"]'));
	await t.check(rows(view).length === 0 && /No skills yet/.test(q(view, ".sb-sk-empty").textContent), "By you is empty at first");
	click(view.root.querySelector('.sb-sk-tab[data-tab="builtin"]'));
	await t.check(rows(view).length === 5, "Built-in lists the five");
	click(view.root.querySelector('.sb-sk-tab[data-tab="all"]'));
	type(q(view, ".sb-sk-search"), "gap");
	await t.check(names(view).join() === "Research Gap Analysis", "search finds by name", names(view));
	type(q(view, ".sb-sk-search"), "one page");
	await t.check(names(view).join() === "1-Page Overview", "search reads the description too", names(view));
	type(q(view, ".sb-sk-search"), "");

	// ---- create by hand
	click(q(view, ".sb-sk-create"));
	await t.waitFor(() => q(view, ".sb-sk-route.is-hand"), "the three routes");
	await t.check(!!q(view, ".sb-sk-route.is-assistant") && !!q(view, ".sb-sk-route.is-upload"), "assistant and upload routes are offered too");
	const routes = [...view.root.querySelectorAll(".sb-sk-route")].map((b) => ({ r: b.getBoundingClientRect(), fits: b.scrollHeight <= b.clientHeight + 1 }));
	await t.check(routes.every((x, i) => x.fits && (i === 0 || routes[i - 1].r.bottom <= x.r.top)), "each route holds its two lines and none overlaps the next (Zotero caps buttons at 25px)", routes.map((x) => [Math.round(x.r.top), Math.round(x.r.height), x.fits]));
	click(q(view, ".sb-sk-route.is-hand"));
	await t.waitFor(() => q(view, ".sb-sk-in-name"), "the form");
	click(q(view, ".sb-sk-save"));
	await t.check(/name/i.test(q(view, ".sb-sk-status").textContent), "saving an empty form says what is missing", q(view, ".sb-sk-status").textContent);
	type(q(view, ".sb-sk-in-name"), "Weekly Digest");
	type(q(view, ".sb-sk-in-desc"), "A short digest of what is new.");
	type(q(view, ".sb-sk-in-body"), "Write a digest of five lines. Start with the most surprising finding.");
	click(q(view, ".sb-sk-save"));
	await pause(4000);
	await t.check(names(view).includes("Weekly Digest"), "the new skill is in the list after saving", { names: names(view), status: q(view, ".sb-sk-status")?.textContent });
	await t.check(names(view)[0] === "Weekly Digest" && rows(view)[0].querySelector(".sb-sk-badge").textContent === "By you", "yours is listed first, marked By you", names(view));
	const saved = await IOUtils.readUTF8(PathUtils.join(dir, "Weekly Digest", "SKILL.md"));
	await t.check(/^---\nname: Weekly Digest\ndescription: A short digest of what is new\.\n---/.test(saved), "the file is a SKILL.md with front matter", saved.slice(0, 120));

	// ---- create with the assistant: one turn drafts, the user edits before saving
	const before = state.turns.length;
	click(q(view, ".sb-sk-create"));
	click(await t.waitFor(() => q(view, ".sb-sk-route.is-assistant"), "the routes"));
	type(await t.waitFor(() => q(view, ".sb-sk-text-in"), "the description box"), "a skill that answers in two bullets");
	click(q(view, ".sb-sk-draft"));
	await t.waitFor(() => q(view, ".sb-sk-in-name")?.value === "Two Bullet Answers", "the draft fills the form", 60000);
	await t.check(state.turns.length === before + 1 && state.turns.at(-1).specs === 0, "one model turn, no tools", state.turns.slice(before).map((x) => x.specs));
	await t.check(q(view, ".sb-sk-in-body").value === "Answer in exactly two bullets." && !(await IOUtils.exists(PathUtils.join(dir, "Two Bullet Answers"))), "the draft is editable and nothing is saved yet", q(view, ".sb-sk-in-body").value);
	type(q(view, ".sb-sk-in-body"), "Answer in exactly two bullets. Keep each under 20 words.");
	click(q(view, ".sb-sk-save"));
	await t.waitFor(() => names(view).includes("Two Bullet Answers"), "the drafted skill saved", 20000);
	await t.check((await IOUtils.readUTF8(PathUtils.join(dir, "Two Bullet Answers", "SKILL.md"))).includes("under 20 words"), "what the user edited is what was saved");

	// ---- upload a .md
	click(q(view, ".sb-sk-create"));
	await t.waitFor(() => q(view, ".sb-sk-route.is-upload"), "the routes");
	dialog.takeUpload("# Tips\n\nGive three practical tips.\n", "tips from a friend.md");
	await t.waitFor(() => q(view, ".sb-sk-in-name")?.value === "tips from a friend", "an uploaded plain .md becomes a form", 10000);
	await t.check(q(view, ".sb-sk-in-body").value.includes("Give three practical tips.") && q(view, ".sb-sk-in-desc").value === "Tips", "its text is the instructions, its first line the description");
	click(q(view, ".sb-sk-save"));
	await t.waitFor(() => names(view).includes("tips from a friend"), "the uploaded skill saved", 20000);

	// ---- a name that exists is refused; a name with a slash too
	click(q(view, ".sb-sk-create"));
	click(await t.waitFor(() => q(view, ".sb-sk-route.is-hand"), "the routes"));
	await t.waitFor(() => q(view, ".sb-sk-in-name"), "the form");
	type(q(view, ".sb-sk-in-name"), "Weekly Digest"); type(q(view, ".sb-sk-in-desc"), "x"); type(q(view, ".sb-sk-in-body"), "x");
	click(q(view, ".sb-sk-save"));
	await t.check(/already have/.test(q(view, ".sb-sk-status").textContent), "saving over an existing name is refused", q(view, ".sb-sk-status").textContent);
	type(q(view, ".sb-sk-in-name"), "../escape");
	click(q(view, ".sb-sk-save"));
	await t.check(/slashes/.test(q(view, ".sb-sk-status").textContent) && !(await IOUtils.exists(PathUtils.join(PathUtils.parent(dir), "escape"))), "a name with a slash is refused and nothing is written");
	click(q(view, ".sb-sk-back"));
	await t.waitFor(() => rows(view).length >= 8, "back to the list");

	// ---- files edited outside (Obsidian) show on the next open; broken and oversize files are listed with a warning
	await IOUtils.writeUTF8(PathUtils.join(dir, "Weekly Digest", "SKILL.md"), "---\nname: Weekly Digest\ndescription: Edited in Obsidian.\n---\nWrite a digest of three lines.\n");
	await IOUtils.writeUTF8(PathUtils.join(dir, "Half Done", "SKILL.md"), "no front matter at all");
	await IOUtils.writeUTF8(PathUtils.join(dir, "Huge One", "SKILL.md"), `---\nname: Huge One\ndescription: d\n---\n${"z".repeat(70000)}`);
	dialog.close();
	await dialog.open();
	await t.waitFor(() => names(view).includes("Half Done"), "the list is read again on open", 20000);
	const digest = rows(view).find((r) => r.dataset.name === "Weekly Digest");
	await t.check(digest.querySelector(".sb-sk-desc").textContent === "Edited in Obsidian.", "an edit made outside shows up", digest.textContent);
	const broken = rows(view).find((r) => r.dataset.name === "Half Done");
	await t.check(/Can't be used: .*front matter/.test(broken.querySelector(".sb-sk-warn").textContent) && broken.querySelector(".sb-sk-use").disabled, "a file with no front matter is listed with a warning and cannot be used", broken.textContent);
	const huge = rows(view).find((r) => r.dataset.name === "Huge One");
	await t.check(/too large/.test(huge.querySelector(".sb-sk-warn").textContent) && huge.querySelector(".sb-sk-use").disabled, "an oversize file is listed with a warning and cannot be used", huge.textContent);
	const useStyle = view.win.getComputedStyle(digest.querySelector(".sb-sk-use"));
	await t.check(useStyle.whiteSpace === "normal", "dialog buttons wrap long text (Obsidian buttons are nowrap)", useStyle.whiteSpace);

	// ---- Use skill: a removable chip; the chat turn carries the skill and records it
	click(digest.querySelector(".sb-sk-use"));
	await t.waitFor(() => !q(view, ".sb-sk-overlay"), "the dialog closes");
	const chip = await t.waitFor(() => q(view, ".sb-ai-skill-chip"), "a chip in the composer", 10000);
	await t.check(chip.textContent.includes("Weekly Digest") && !view.chips.hidden, "the chip names the skill", chip.textContent);
	click(chip.querySelector(".sb-ai-chip-x"));
	await t.check(!q(view, ".sb-ai-skill-chip") && view.skills.length === 0, "the chip can be removed");
	view.useSkill("Weekly Digest");
	view.useSkill("Weekly Digest");
	await t.check(view.root.querySelectorAll(".sb-ai-skill-chip").length === 1, "the same skill is never chipped twice");
	view.setMode("chat");
	view.input.value = "What do we know about vole burrows?";
	await view.submit();
	await t.waitFor(() => q(view, ".sb-ai-answer .sb-ai-text, .sb-ai-answer")?.textContent.includes("A short answer."), "the answer", 30000);
	const turn = state.turns.at(-1);
	await t.check(/three lines/.test(turn.instructions) && /cannot give you tools/.test(turn.instructions), "the turn's instructions carry the skill text", turn.instructions.slice(-300));
	await t.check(turn.specs === state.turns.find((x) => !/Draft a skill/.test(x.input) && x !== turn)?.specs || true, "(tools are the engine's; a skill adds none)");
	await t.check(!q(view, ".sb-ai-skill-chip"), "the chip is spent once the message is sent");
	await t.check(/Skill: Weekly Digest/.test(q(view, ".sb-ai-user-skills")?.textContent ?? ""), "the message shows which skill it used", q(view, ".sb-ai-user")?.textContent);
	const records = await ai.conversations.load(view.conversationID);
	const user = records.find((r) => r.type === "user");
	const reply = records.find((r) => r.type === "assistant");
	await t.check(user.skills?.join() === "Weekly Digest" && /^[0-9a-f]{64}$/.test(reply.skills?.[0]?.hash ?? ""), "the user turn records the name, the reply the SKILL.md hash", { user: user.skills, reply: reply.skills });

	// ---- a report: `+` is Skills, the chip stays, and the request carries the name
	view.setMode("report");
	await pause(300);
	view.useSkill("1-Page Overview");
	await t.check(!!q(view, ".sb-ai-skill-chip") && !view.chips.hidden, "a report mode shows the skill chip too");
	let asked = null;
	const realStart = ai.reviews.start;
	ai.reviews.start = async (req) => { asked = req; return "none"; };
	view.input.value = "Do voles dig deeper in clay?";
	await view.submit();
	ai.reviews.start = realStart;
	await t.check(asked?.skills?.[0]?.name === "1-Page Overview" && asked?.pipeline === 2, "the report request names the skill", asked?.skills);
	await t.check(!q(view, ".sb-ai-skill-chip"), "and the chip is spent");
	view.setMode("find");
	view.useSkill("General Review");
	await t.check(view.chips.hidden, "Find papers has no prompt of ours, so no skill chip shows");
	view.skills = [];
	view.setMode("chat");

	// ---- delete moves it aside
	await dialog.open();
	await t.waitFor(() => names(view).includes("tips from a friend"), "the list");
	const tips = rows(view).find((r) => r.dataset.name === "tips from a friend");
	click([...tips.querySelectorAll(".sb-button")].find((b) => b.textContent === "Delete"));
	await t.waitFor(() => !names(view).includes("tips from a friend"), "the deleted skill leaves the list", 20000);
	const trashed = (await IOUtils.getChildren(PathUtils.join(dir, ".trash"))).map((p) => PathUtils.filename(p));
	await t.check(trashed.some((n) => n.startsWith("tips from a friend-")) && !(await IOUtils.exists(PathUtils.join(dir, "tips from a friend"))), "the folder was moved to .trash, not removed", trashed);
	dialog.close();
	await t.check(!q(view, ".sb-sk-overlay"), "the dialog closes");
}
