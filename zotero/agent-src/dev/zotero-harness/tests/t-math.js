/* global SB, Zotero, IOUtils, PathUtils */
// Equations render as math in real Zotero (Gecko), and a user message can be copied and edited.
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
	win.resizeTo(1200, 900);
	const view = SB.openChat();
	view.thread.replaceChildren();
	view.addUser("For the SAM, what was the conductance?\nAnd in solution?");
	const turn = view.addAnswer();
	view.finish(turn, "The SAM conductance was \\(9.0 \\times 10^{-7}G_0\\), versus \\(3.3 \\times 10^{-6}G_0\\) in solution.\n\n$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$\n\nMoney: $5 and $10 stay.", []);
	await new Promise((r) => win.setTimeout(r, 300));
	const maths = [...view.thread.querySelectorAll(".sb-math")];
	await t.check(maths.length === 3, "three equations became math elements", maths.length);
	await t.check(maths.every((m) => m.querySelector("math")), "each holds a MathML <math> element");
	const sizes = maths.map((m) => { const r = m.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
	await t.check(sizes.every(([w, h]) => w > 20 && h > 8), "and Gecko laid them out with a real size", JSON.stringify(sizes));
	const answerText = view.thread.querySelector(".sb-ai-answer .sb-md").textContent;
	await t.check(!/\\\(|\\times/.test(answerText.split("Money")[0]), "no raw \\( or \\times shows in the visible answer", answerText.slice(0, 120));
	await t.check(/Money: \$5 and \$10 stay\./.test(answerText), "money keeps its dollars");
	await snapshot(win, "math-zotero.png").catch(() => {});

	const user = view.thread.querySelector(".sb-ai-user");
	const buttons = [...user.querySelectorAll(".sb-ai-msg-action")].map((b) => b.textContent);
	await t.check(buttons.join() === "Copy,Edit", "the user message has Copy and Edit", buttons.join());
	user.querySelector(".sb-ai-msg-action").click();
	await new Promise((r) => win.setTimeout(r, 300));
	const label = user.querySelector(".sb-ai-msg-action").textContent;
	await t.check(label === "Copied", "Copy reports Copied", label);
	const clip = Zotero.Utilities.Internal.getClipboard?.("text/plain") ?? null;
	await t.check(clip === "For the SAM, what was the conductance?\nAnd in solution?", "the text is on the real clipboard", String(clip));
	[...user.querySelectorAll(".sb-ai-msg-action")][1].click();
	await t.check(view.input.value === "For the SAM, what was the conductance?\nAnd in solution?", "Edit puts it back in the box");
}
