/* global SB, Zotero */
// Spec 009 layer 5: Zotero timings for the weekly perf run. Chat open (until the composer is usable), a scripted
// ~400-token answer rendered in the chat (send to first token painted, and total render), and the switch to the
// Routines view; 5 repeats each. Prints ONE line `PERF {"scenarios": {...}}` that perf/run.sh passes to report.py.
// totalRenderMs includes the scripted stream's own pacing (about 50 deltas x 5 ms), so read it as a trend, not an absolute.
// Run with SB_SERVER at a dead port (Zotero's own runtime), scripted provider, no model calls.

const REPEATS = 5;
const TOKENS = 400;
const ANSWER = Array.from({ length: TOKENS }, (_, i) => `word${i}`).join(" ");

function scriptedProvider(state) {
	return {
		id: "fake", caps: {},
		async status() { return { provider: "fake", state: "ready" }; },
		async models() { return []; },
		async dispose() {},
		async *turn() {
			// 8 words per delta with a short pause, so the chat renders a stream and not one blob
			const words = ANSWER.split(" ");
			for (let i = 0; i < words.length; i += 8) {
				yield { type: "text", delta: words.slice(i, i + 8).join(" ") + (i + 8 < words.length ? " " : "") };
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			state.turns += 1;
			yield { type: "final", text: ANSWER, json: null, usage: {} };
		},
	};
}

const winOf = (el) => el.ownerGlobal ?? el.ownerDocument.defaultView;
const fire = (el, type) => el.dispatchEvent(new (winOf(el).Event)(type, { bubbles: true }));
const click = (el) => el.dispatchEvent(new (winOf(el).MouseEvent)("click", { bubbles: true }));
const round = (x) => Math.round(x * 100) / 100;
const summary = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return { median: round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2), min: round(s[0]), max: round(s.at(-1)) };
};

// Resolves with performance.now() taken in the frame after `cond()` first holds (the change has been laid out and painted).
function paintedWhen(win, cond, ms = 30000) {
	return new Promise((resolve, reject) => {
		const end = win.performance.now() + ms;
		const tick = () => {
			if (cond()) return win.requestAnimationFrame(() => resolve(win.performance.now()));
			if (win.performance.now() > end) return reject(new Error("timed out waiting for a painted change"));
			win.requestAnimationFrame(tick);
		};
		tick();
	});
}

const usable = (view) => !view.composer.hidden && !view.input.disabled && view.input.getBoundingClientRect().height > 0;

async function closeChat(t, win) {
	if (SB.chatTab) win.Zotero_Tabs.close(SB.chatTab.tabID);
	await t.waitFor(() => !SB.chatTab, "the chat tab to close", 10000);
}

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 900);
	const ai = await SB.ai();
	const state = { turns: 0 };
	SB.agent.providers.set("fake", scriptedProvider(state));
	for (const role of ["chat", "ask", "lead", "researcher", "writer"]) await ai.providers.setRole(role, { provider: "fake", model: null }).catch(() => {});
	Zotero.Prefs.clear("extensions.secondbrain.chatMode", true);

	const open = [], first = [], total = [], routines = [];
	let answered = 0;
	// warm-up round (not counted): JIT, style sheets, the first turn's lazy setup
	for (let i = -1; i < REPEATS; i++) {
		const counted = i >= 0;
		await closeChat(t, win);
		await t.sleep(300);

		// chat open: call to a usable composer, painted
		const t0 = win.performance.now();
		const view = SB.openChat();
		const tOpen = await paintedWhen(win, () => usable(view));
		if (counted) open.push(tOpen - t0);
		await t.sleep(300);

		// a streamed ~400-token answer: send to first token painted, and to the whole answer painted
		view.setMode("chat");
		view.input.value = `Perf question ${i}`;
		fire(view.input, "input");
		const s0 = win.performance.now();
		click(view.send);
		const tFirst = await paintedWhen(win, () => (view.thread.querySelector(".sb-ai-md")?.textContent.length ?? 0) > 0);
		const tTotal = await paintedWhen(win, () => !view.running && (view.thread.querySelector(".sb-ai-md")?.textContent ?? "").includes(`word${TOKENS - 1}`));
		if (counted) { first.push(tFirst - s0); total.push(tTotal - s0); }
		const text = [...view.thread.querySelectorAll(".sb-ai-md")].at(-1)?.textContent ?? "";
		if (text.includes("word0") && text.includes(`word${TOKENS - 1}`)) answered += 1;
		await t.sleep(300);

		// the switch to Routines: the mode menu's change to the view painted
		view.modePick.value = "routines";
		const r0 = win.performance.now();
		fire(view.modePick, "change");
		const tRoutines = await paintedWhen(win, () => view.mode === "routines" && view.root.querySelector(".sb-rt"));
		if (counted) routines.push(tRoutines - r0);
		view.setMode("chat");
	}

	await t.check(open.length === REPEATS && routines.length === REPEATS, "every repeat ran", { open: open.length, routines: routines.length });
	await t.check(answered === REPEATS + 1, "each scripted answer rendered whole in the chat (first and last word present)", { answered, turns: state.turns });
	await t.check(state.turns === REPEATS + 1, "the scripted provider answered every question", state.turns);
	await t.check(total.every((x) => x > 0) && first.every((x, k) => x <= total[k]), "first token comes before the whole answer", { first, total });

	const perf = { scenarios: {
		chatOpen: { composerUsableMs: summary(open) },
		streamAnswer: { firstTokenMs: summary(first), totalRenderMs: summary(total) },
		routinesSwitch: { viewMs: summary(routines) },
	} };
	await t.log("PERF " + JSON.stringify(perf));
	await SB.agent.shutdown();
}
