/* global SB */
// Spec 011 U1 (+ the Fastest stop) in real Zotero: the depth slider drives the stored depth and shows what each stop costs in model turns.
// A fake `ai` answers `reviews.estimate`; the real chat view, real slider and real option labels are what is checked.

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(t) {
	const view = SB.openChat();
	await pause(300);
	const asked = [];
	view.sb.ai = async () => ({
		where: "local",
		conversations: { list: async () => [], load: async () => [] },
		reviews: {
			list: async () => [],
			estimate: async (req) => { asked.push(req); const turns = { fastest: 8, quick: 12, standard: 22, deep: 38 }[req.depth]; return { turns, low: 9, high: 40, ...(req.depth === "deep" ? { range: "30-46" } : {}) }; },
		},
	});
	view.setMode("report");
	await pause(400);

	const slider = view.depthSlider;
	await t.check(!!slider && slider.type === "range" && slider.min === "0" && slider.max === "3", "the depth control is a four-stop range slider", { type: slider?.type, min: slider?.min, max: slider?.max });
	await t.check(view.depth.value === "standard" && slider.value === "2", "it starts on Balanced, stored as standard", { stored: view.depth.value, slider: slider.value });
	await t.check(view.depthLabel.textContent === "Balanced · about 22 turns", "the label shows the stop and its estimated turns", view.depthLabel.textContent);
	await t.check(slider.isConnected && !view.depth.isConnected, "the old select is not in the page; the slider is", { slider: slider.isConnected, select: view.depth.isConnected });

	slider.value = "3";
	slider.dispatchEvent(new (slider.ownerGlobal ?? slider.ownerDocument.defaultView).Event("input", { bubbles: true }));
	await pause(300);
	await t.check(view.depth.value === "deep" && view.depthLabel.textContent === "Smart · about 30-46 turns", "the last stop is Smart, stored as deep, and shows the engine range when it sends one", { stored: view.depth.value, label: view.depthLabel.textContent });
	await t.check(slider.getAttribute("aria-valuetext") === "Smart · about 30-46 turns", "the slider announces the same text to screen readers", slider.getAttribute("aria-valuetext"));
	await t.check(view.optionsButton.textContent.includes("Smart"), "the options button names a non-default depth", view.optionsButton.textContent);

	slider.value = "1";
	slider.dispatchEvent(new (slider.ownerGlobal ?? slider.ownerDocument.defaultView).Event("input", { bubbles: true }));
	await pause(300);
	await t.check(view.depth.value === "quick" && view.depthLabel.textContent === "Fast · about 12 turns", "the second stop is Fast, stored as quick, 12 turns", { stored: view.depth.value, label: view.depthLabel.textContent });

	slider.value = "0";
	slider.dispatchEvent(new (slider.ownerGlobal ?? slider.ownerDocument.defaultView).Event("input", { bubbles: true }));
	await pause(300);
	await t.check(view.depth.value === "fastest" && view.depthLabel.textContent === "Fastest · about 8 turns", "the first stop is Fastest, stored as fastest, 8 turns", { stored: view.depth.value, label: view.depthLabel.textContent });
	await t.check(view.optionsButton.textContent.includes("Fastest"), "the options button names it", view.optionsButton.textContent);
	await t.check(["standard", "deep", "quick", "fastest"].every((d) => asked.some((r) => r.depth === d)), "each stop asked the engine for its own estimate", asked.map((r) => r.depth));

	view.setMode("systematic");
	await pause(300);
	await t.check(asked.at(-1)?.systematic === true, "a systematic review asks for the systematic estimate", asked.at(-1));
}
