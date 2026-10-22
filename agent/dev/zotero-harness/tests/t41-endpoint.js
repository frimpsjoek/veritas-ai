/* global SB, Zotero, IOUtils, PathUtils */
// T4.1: the Gecko platform and the /second-brain/mcp endpoint, driven by real Codex and Claude Code calls.
// Needs the Second Brain server (the library backend here is the HTTP one) and signed-in Codex and Claude.

async function curl(platform, args) {
	const child = await platform.spawn({ cmd: "/usr/bin/curl", args: ["-s", "-w", "\n%{http_code}", ...args], env: {}, cwd: "/tmp" });
	const lines = [];
	for await (const line of child.lines()) lines.push(line);
	return { status: Number(lines.pop()), body: lines.join("\n") };
}

async function run(t) {
	const host = SB.agent;
	const runtime = await host.local();
	const platform = host.platform();
	await t.check(!!runtime && runtime.where === "local", "local runtime starts inside Zotero");
	await t.check(host.mount.url === `http://127.0.0.1:${Zotero.Prefs.get("httpServer.port")}/second-brain/mcp`, "endpoint URL on Zotero's port", host.mount.url);

	const codex = await platform.which(["/Applications/ChatGPT.app/Contents/Resources/codex", "codex"]);
	const claude = await platform.which(["claude"]);
	await t.check(!!codex, "Codex binary found", codex);
	await t.check(!!claude, "Claude binary found despite Zotero's minimal PATH", claude);

	const ctx = { scope: { kind: "library" }, web: "off", sources: { papers: true, notes: true, scholarly: false, web: false }, audit: "harness:t41" };
	const session = host.gateway.open(ctx);
	const init = await curl(platform, ["-X", "POST", host.mount.url, "-H", "Content-Type: application/json", "-H", `Authorization: Bearer ${session.mcp.token}`,
		"-d", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })]);
	const tools = JSON.parse(init.body || "{}").result?.tools ?? [];
	await t.check(init.status === 200 && tools.length >= 3 && tools.every((tool) => tool.annotations?.readOnlyHint === true),
		"tools/list over Zotero.Server: every tool read-only", tools.map((tool) => tool.name));
	const wrong = await curl(platform, ["-X", "POST", host.mount.url, "-H", "Content-Type: application/json", "-H", "Authorization: Bearer nope",
		"-d", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })]);
	await t.check(wrong.status === 401, "a wrong token gets 401", wrong.status);
	const note = await curl(platform, ["-X", "POST", host.mount.url, "-H", "Content-Type: application/json",
		"-d", JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })]);
	await t.check(note.status === 202 && note.body === "", "a notification gets 202 with an empty body", note);

	// Claude Code, spawned through the Gecko platform, calling our tool on the endpoint.
	const work = PathUtils.join(host.dataDir, "harness-claude");
	await IOUtils.makeDirectory(work, { createAncestors: true });
	const mcpConfig = PathUtils.join(work, "mcp.json");
	await IOUtils.writeUTF8(mcpConfig, JSON.stringify({ mcpServers: { lib: { type: "http", url: host.mount.url, headers: { Authorization: `Bearer ${session.mcp.token}` } } } }));
	const started = Date.now();
	const child = await platform.spawn({
		cmd: claude,
		args: ["-p", "Call the search_library tool once with the query \"sleep\". Then reply with only the title of the first result.",
			"--output-format", "stream-json", "--verbose", "--mcp-config", mcpConfig, "--strict-mcp-config", "--tools", "",
			"--allowedTools", "mcp__lib__search_library", "--setting-sources", "", "--no-session-persistence", "--model", "haiku"],
		env: {}, cwd: work,
	});
	let toolUse = null;
	let toolResult = null;
	let result = null;
	for await (const line of child.lines()) {
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		for (const block of msg.message?.content ?? []) {
			if (block.type === "tool_use") toolUse = block;
			if (block.type === "tool_result") toolResult = block;
		}
		if (msg.type === "result") result = msg;
	}
	await t.check(toolUse?.name === "mcp__lib__search_library", "Claude called search_library through Zotero", toolUse?.input);
	const resultText = JSON.stringify(toolResult?.content ?? "");
	await t.check(!!toolResult && !toolResult.is_error && /\[@|\[\[/.test(resultText), "the tool result came back with library refs", resultText.slice(0, 200));
	await t.log(`claude: ${Math.round((Date.now() - started) / 1000)} s, answer: ${String(result?.result ?? "").slice(0, 160)}`);
	session.close();

	// Codex through the real local runtime: provider, tool gateway and endpoint together.
	const events = [];
	const codexStart = Date.now();
	for await (const ev of runtime.ask("Use search_library once with the query \"sleep and memory\", then answer in one sentence citing one result.")) {
		if (ev.type !== "text") events.push(ev);
	}
	const activity = events.filter((ev) => ev.type === "activity" && ev.phase === "end");
	const done = events.find((ev) => ev.type === "done");
	const failed = events.find((ev) => ev.type === "failed");
	await t.check(activity.some((ev) => ev.kind === "library" && ev.ok), "Codex called search_library through Zotero", activity.map((ev) => ev.label));
	await t.check(!!done && !failed, "Codex turn finished", failed?.error ?? done?.answer.structured);
	await t.log(`codex: ${Math.round((Date.now() - codexStart) / 1000)} s, citations: ${JSON.stringify(done?.answer.citations ?? [])}`);

	await host.shutdown();
	const gone = await curl(platform, ["-X", "POST", `http://127.0.0.1:${Zotero.Prefs.get("httpServer.port")}/second-brain/mcp`, "-H", "Content-Type: application/json",
		"-d", JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })]);
	await t.check(gone.status === 404, "shutdown removes the endpoint", gone.status);
}
