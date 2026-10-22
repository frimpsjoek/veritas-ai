// node cdp.mjs <debug-port> <js expression> : evaluates in the first Obsidian page, prints the JSON value.
const [port, expression] = process.argv.slice(2);
const targets = await (await fetch(`http://localhost:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("index.html"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
ws.onmessage = (m) => {
	const d = JSON.parse(m.data);
	if (d.id !== 1) return;
	if (d.result.exceptionDetails) { console.error(JSON.stringify(d.result.exceptionDetails)); process.exit(2); }
	console.log(JSON.stringify(d.result.result.value ?? null));
	process.exit(0);
};
