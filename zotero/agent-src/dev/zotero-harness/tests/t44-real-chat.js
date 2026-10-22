/* global SB, Zotero, IOUtils, PathUtils */
// T4.4 checkpoint: one real Chat turn through the tab, with Codex. Run once with the Second Brain server up
// (criterion 1) and once with SB_SERVER at a dead port (criterion 2: Zotero alone). Needs Codex signed in.

const QUESTION = "What does my library say about equivariant graph neural networks for molecules? Cite at least three sources.";

async function snapshot(win, path) {
	const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
	canvas.width = win.innerWidth;
	canvas.height = win.innerHeight;
	canvas.getContext("2d").drawWindow(win, 0, 0, canvas.width, canvas.height, "white");
	await IOUtils.write(path, Uint8Array.from(win.atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0)));
}

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	const mode = SB.online ? "server" : "alone";
	await t.log(`Second Brain server ${SB.online ? "running" : "not running"}; built-in model: ${SB.localIndex.state}`);
	const win = Zotero.getMainWindow();
	win.resizeTo(1280, 900);
	const view = SB.openChat();
	view.input.value = QUESTION;
	const started = Date.now();
	view.send.click();
	await t.waitFor(() => view.running, "the turn to start", 10000);
	await t.waitFor(() => !view.running, "the answer", 300000);
	await t.log(`answered in ${Math.round((Date.now() - started) / 1000)} s`);

	const records = await (await SB.ai()).conversations.load(view.conversationID);
	const answer = records.find((r) => r.type === "assistant")?.answer;
	const failed = records.find((r) => r.type === "failed");
	await t.check(!!answer && !failed, "the chat turn finished", failed?.error);
	if (!answer) return;
	await t.log("activity:", records.find((r) => r.type === "assistant").activities);
	await t.log("answer:", answer.text);
	const citations = answer.citations;
	const resolved = citations.filter((c) => c.status === "resolved");
	await t.check(citations.length >= 3, "at least 3 citations", citations.length);
	await t.check(resolved.length === citations.length, "every citation resolves", citations.filter((c) => c.status !== "resolved").map((c) => c.ref));
	for (const c of citations) {
		const item = c.ref.kind === "paper" ? await SB.itemByCitekey(c.ref.citekey) : null;
		await t.log(`  ${c.status} ${JSON.stringify(c.ref)} -> ${item ? `${item.getField("firstCreator")} ${item.getField("year")}: ${item.getField("title")}` : c.title ?? ""}`);
	}
	await t.check(view.thread.querySelectorAll(".sb-ai-md .cite.missing").length === 0, "no citation shows as missing in the tab");
	await snapshot(win, PathUtils.join(PathUtils.parent(Zotero.DataDirectory.dir), `t44-${mode}.png`)).then(() => t.log("snapshot written"), (error) => t.log(`no snapshot: ${error.message}`));
	await SB.agent.shutdown();
}
