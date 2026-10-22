/* global SB, Zotero */
// Final integration check (d): with the real Second Brain server running and answering /agent/ping, and this
// integration pass's seam-3 fix in place (createRemoteRuntime exported from gecko/entry.js, remoteTransport()
// matching agentd's real route shapes), SecondBrain.ai() must pick the REMOTE runtime, not fall back to local.
// Run against the scratch harness only (never the user's real Zotero window).

const QUESTION = "In one sentence, what does my library say about embeddings?";

async function run(t) {
	await t.waitFor(() => SB.checkedOnce, "the first server check");
	await t.check(SB.online === true, "the real Second Brain server is reachable", { online: SB.online });

	const runtime = await SB.ai();
	await t.check(runtime.where === "server", "SecondBrain.ai() picked the remote runtime", { where: runtime.where });
	if (runtime.where !== "server") return;

	const id = await runtime.conversations.create("chat");
	const events = [];
	const started = Date.now();
	for await (const ev of runtime.conversations.send(id, { text: QUESTION })) {
		events.push(ev);
		if (Date.now() - started > 120000) break; // 120s ceiling; a real Codex/Claude turn, not a fake one
	}
	const done = events.find((ev) => ev.type === "done");
	const failed = events.find((ev) => ev.type === "failed");
	await t.check(!!done && !failed, "a Chat turn succeeded through the remote runtime", failed?.error ?? { eventTypes: events.map((e) => e.type) });
	if (done) await t.log("answer:", done.answer.text.slice(0, 300));

	await SB.agent.shutdown();
}
