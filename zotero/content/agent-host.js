/* global Zotero, Services, ChromeUtils, Ci, IOUtils, PathUtils, TextDecoder, SecondBrain, SecondBrainAgent */
// Runs the AI core inside Zotero: the Gecko platform (content/agent.js), the library tools served to Codex and
// Claude Code from Zotero's own HTTP server at /second-brain/mcp, and the local runtime. Nothing starts until
// the AI is first used, and shutdown removes the endpoint.
//
// One runtime per machine: when the Second Brain server answers /agent/ping, its runtime owns the conversations
// and this one hands over (adopts) whatever it stored locally. The switch waits until no turn is running here.

SecondBrain.AgentHost = class {
	static MCP_PATH = "/second-brain/mcp";
	static PING_EVERY_MS = 10000;

	constructor(sb) {
		this.sb = sb;
		this.localRuntime = null;
		this.starting = null;
		this.mount = null;
		this.current = null; // the runtime the UI talks to
		this.remote = null;
		this.remoteFactory = SecondBrainAgent.createRemoteRuntime ?? null; // agent-src/src/remote.js, once bundled
		this.busy = 0; // turns streaming right now, on whichever runtime
		this.pinged = { at: 0, ok: false };
		this.wrapped = new WeakMap();
		this.listeners = new Set();
	}

	/** The AgentService for the next action: the server's while it runs, otherwise the one inside Zotero. */
	async ai() {
		const server = await this.serverRuntime();
		const wanted = server ?? await this.local();
		if (wanted !== this.current && (this.busy === 0 || !this.current)) {
			// One switch at a time: callers arriving mid-switch wait for it instead of handing chats over again.
			this.switching ??= (async () => {
				if (server) await this.adoptInto(server).catch((error) => Zotero.logError(error));
				this.current = wanted;
				for (const listener of this.listeners) listener(wanted.where);
			})().finally(() => { this.switching = null; });
			await this.switching;
		}
		return this.tracked(this.current);
	}

	/** Writes a role choice to the runtimes other than `done` (Zotero's own, and the server's while it answers). */
	async mirrorRole(done, role, choice) {
		// Only runtimes that already exist: writing a role must not boot the in-process runtime just to keep a file in step.
		const others = [this.localRuntime, await this.serverRuntime().catch(() => null)];
		if (!this.localRuntime && !this.starting && done !== this.localRuntime) {
			// Not running here: write the file the in-process runtime will read when it does start.
			try { await SecondBrainAgent.createSettingsStore(this.platform().fs, this.dataDir).setRole(role, choice); } catch (error) { Zotero.logError(error); }
		}
		for (const other of others) {
			if (!other || other === done) continue;
			try { await other.providers.setRole(role, choice); } catch (error) { Zotero.logError(error); }
		}
	}

	/** The OpenAlex key lives in the engine's settings.json (agent-src) and in the Zotero pref the content scripts read
	 *  synchronously. `done` is the runtime that already took the change; the others, and the pref, follow it. */
	async mirrorOpenAlexKey(done, key) {
		try { Zotero.Prefs.set("extensions.secondbrain.openalexKey", key ?? "", true); } catch (error) { Zotero.logError(error); }
		for (const other of [this.localRuntime, await this.serverRuntime().catch(() => null)]) {
			if (!other || other === done) continue;
			try { await other.settings.update({ openalex: { apiKey: key } }); } catch (error) { Zotero.logError(error); }
		}
	}

	/** The Sources switches are one state in the chat and the Settings chips; the other runtime's settings file
	 *  follows, so the pills read the same whichever engine answers. Best effort, never fatal. */
	async mirrorSources(done, sources) {
		const copy = { sources };
		if (!this.localRuntime && !this.starting && done !== this.localRuntime) {
			// Not running here: write the file the in-process runtime will read when it does start.
			try { await SecondBrainAgent.createSettingsStore(this.platform().fs, this.dataDir).update(copy); } catch (error) { Zotero.logError(error); }
		}
		for (const other of [this.localRuntime, await this.serverRuntime().catch(() => null)]) {
			if (!other || other === done) continue;
			try { await other.settings.update(copy); } catch (error) { Zotero.logError(error); }
		}
	}

	/** First time a runtime is used with no saved Sources switches: it takes the other runtime's, when that one has them
	 *  (the pills followed the engine that answered before, and must not snap back to the defaults). */
	async syncSources(runtime) {
		try {
			if ((await runtime.settings.get()).sources != null) return;
			for (const other of [this.localRuntime, await this.serverRuntime().catch(() => null)]) {
				if (!other || other === runtime) continue;
				const sources = (await other.settings.get()).sources;
				if (sources) { await runtime.settings.update({ sources }); return; }
			}
		} catch (error) { Zotero.logError(error); }
	}

	/** First time a runtime is used: whichever side already has a key fills the empty one. */
	async syncOpenAlexKey(runtime) {
		try {
			const engine = (await runtime.settings.get()).openalex?.apiKey ?? null;
			const pref = Zotero.Prefs.get("extensions.secondbrain.openalexKey", true) || null;
			if (pref && !engine) await runtime.settings.update({ openalex: { apiKey: pref } });
			else if (engine && !pref) Zotero.Prefs.set("extensions.secondbrain.openalexKey", engine, true);
		} catch (error) { Zotero.logError(error); }
	}

	/** Counts streaming turns, so a runtime switch never cuts one off. */
	tracked(runtime) {
		if (!this.wrapped.has(runtime)) {
			const host = this;
			void this.syncOpenAlexKey(runtime);
			void this.syncSources(runtime);
			const track = async function* (events) {
				host.busy++;
				try { yield* events; } finally { host.busy--; }
			};
			this.wrapped.set(runtime, {
				...runtime,
				conversations: { ...runtime.conversations, send: (id, input, opts) => track(runtime.conversations.send(id, input, opts)) },
				ask: (question, opts) => track(runtime.ask(question, opts)),
				// Two runtimes keep two settings files (the server's and Zotero's own); the chat can answer on either as the
				// server comes and goes, so a role chosen on one is written to the other too (best effort, never fatal).
				settings: { ...runtime.settings, update: async (patch) => {
					const updated = await runtime.settings.update(patch);
					if (patch.openalex && patch.openalex.apiKey !== undefined) await host.mirrorOpenAlexKey(runtime, updated.openalex?.apiKey ?? null);
					if (patch.sources) await host.mirrorSources(runtime, patch.sources);
					return updated;
				} },
				providers: { ...runtime.providers, setRole: async (role, choice) => {
					await runtime.providers.setRole(role, choice);
					await host.mirrorRole(runtime, role, choice);
				} },
			});
		}
		return this.wrapped.get(runtime);
	}

	/** The server's runtime when /agent/ping answers, else null (no server, an older server, or no remote client). */
	async serverRuntime() {
		const create = this.remoteFactory;
		if (!create) return null;
		if (Date.now() - this.pinged.at > SecondBrain.AgentHost.PING_EVERY_MS) {
			let ok = false;
			try {
				const response = await Zotero.HTTP.request("GET", `${this.sb.server}/agent/ping`, { timeout: 3000, successCodes: false });
				ok = response.status === 200;
			} catch (error) { /* connection refused: no server */ }
			this.pinged = { at: Date.now(), ok };
		}
		if (!this.pinged.ok) return null;
		this.remote ??= create(this.remoteTransport());
		return this.remote;
	}

	// GET /agent/events?after= (agentd's real route table, agent-src/src/node/agentd.mjs) answers with a plain
	// JSON array of flattened Sequenced<AgentEvent> records (`{seq, type, ...}`), each call bounded to agentd's
	// own 25s long-poll wait, not `{events, done}`: there is no separate "done" flag on the page itself, since
	// createRemoteRuntime's own streamEvents already stops polling once it sees a done/failed event. This
	// mirrors the Obsidian transport (obsidian-plugin/src/agent-api.ts), the other real client of this route.
	remoteTransport() {
		const call = async (method, path, body) => {
			const response = await Zotero.HTTP.request(method, `${this.sb.server}/agent${path}`, {
				body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" },
				responseType: "json", timeout: 60000, successCodes: false,
			});
			if (response.status >= 400) throw Object.assign(new Error(response.response?.error ?? `HTTP ${response.status}`), { status: response.status });
			return response.response;
		};
		return {
			request: call,
			async *stream(path, after, signal) {
				let cursor = after;
				let backoffMs = 0;
				while (!signal?.aborted) {
					let batch;
					try {
						batch = await call("GET", `${path}${path.includes("?") ? "&" : "?"}after=${cursor}`);
						backoffMs = 0;
					} catch (error) {
						backoffMs = Math.min(backoffMs ? backoffMs * 2 : 1000, 15000);
						await new Promise((resolve) => setTimeout(resolve, backoffMs)); // the sidecar restarting, or a blip
						continue;
					}
					for (const event of batch ?? []) { cursor = event.seq; yield { seq: event.seq, data: event }; }
				}
			},
		};
	}

	/** Hands conversations stored in Zotero to the server's runtime. Adoption is idempotent by id, and a handed-over
	 *  file moves to chats-adopted/ (kept, never deleted), so running this again sends nothing twice. */
	async adoptInto(server) {
		await this.adoptChatsInto(server);
		await this.adoptRoutinesInto(server).catch((error) => Zotero.logError(error));
		await this.adoptProjectsInto(server).catch((error) => Zotero.logError(error));
	}

	/** Projects made while Zotero ran alone go to the server (spec 011 U5). Chats are adopted first, so by the time the
	 *  server lists, both the names and the memberships (records inside each chat) are there. Same rules as routines:
	 *  idempotent by id (the server keeps the later `updated`), and a handed-over file moves to projects-adopted/. */
	async adoptProjectsInto(server) {
		if (typeof server.projects?.adopt !== "function") return;
		const fs = this.platform().fs;
		const dir = PathUtils.join(this.dataDir, "projects");
		const names = (await fs.list(dir)).filter((name) => name.endsWith(".json"));
		if (!names.length) return;
		const records = [];
		for (const name of names) {
			try { records.push(JSON.parse(await fs.read(PathUtils.join(dir, name)))); } catch (error) { /* a torn file stays where it is */ }
		}
		const adopted = new Set(await server.projects.adopt(records.filter(Boolean)));
		const moved = PathUtils.join(this.dataDir, "projects-adopted");
		await IOUtils.makeDirectory(moved, { createAncestors: true });
		for (const record of records) {
			if (record?.id && adopted.has(record.id)) await IOUtils.move(PathUtils.join(dir, `${record.id}.json`), PathUtils.join(moved, `${record.id}.json`));
		}
	}

	/** Routines made while Zotero ran alone go to the server's runtime, which owns the schedule from now on (spec 011 U4,
	 *  D2). Same rules as chats: idempotent by id (the server merges, keeping the later lastSlot, so a slot already run is
	 *  never run twice), and a handed-over file moves to routines-adopted/, never deleted. */
	async adoptRoutinesInto(server) {
		if (typeof server.routines?.adopt !== "function") return;
		const fs = this.platform().fs;
		const dir = PathUtils.join(this.dataDir, "routines");
		const names = (await fs.list(dir)).filter((name) => name.endsWith(".json"));
		if (!names.length) return;
		const records = [];
		for (const name of names) {
			try { records.push(JSON.parse(await fs.read(PathUtils.join(dir, name)))); } catch (error) { /* a torn file stays where it is */ }
		}
		const adopted = new Set(await server.routines.adopt(records.filter(Boolean)));
		const moved = PathUtils.join(this.dataDir, "routines-adopted");
		await IOUtils.makeDirectory(moved, { createAncestors: true });
		for (const record of records) {
			if (record?.id && adopted.has(record.id)) await IOUtils.move(PathUtils.join(dir, `${record.id}.json`), PathUtils.join(moved, `${record.id}.json`));
		}
	}

	async adoptChatsInto(server) {
		const fs = this.platform().fs;
		const dir = PathUtils.join(this.dataDir, "chats");
		const names = (await fs.list(dir)).filter((name) => name.endsWith(".jsonl"));
		if (!names.length) return;
		if (typeof server.conversations.adopt !== "function") {
			Zotero.debug("Second Brain AI: the server can't take over conversations yet; they stay in Zotero");
			return;
		}
		const files = await Promise.all(names.map(async (name) => ({ id: name.slice(0, -".jsonl".length), jsonl: await fs.read(PathUtils.join(dir, name)) })));
		const adopted = new Set(await server.conversations.adopt(files));
		const moved = PathUtils.join(this.dataDir, "chats-adopted");
		await IOUtils.makeDirectory(moved, { createAncestors: true });
		for (const file of files) {
			if (adopted.has(file.id)) await IOUtils.move(PathUtils.join(dir, `${file.id}.jsonl`), PathUtils.join(moved, `${file.id}.jsonl`));
		}
	}

	onSwitch(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get dataDir() {
		return PathUtils.join(Zotero.DataDirectory.dir, "second-brain");
	}

	platform() {
		this.geckoPlatform ??= SecondBrainAgent.createGeckoPlatform({
			Subprocess: ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess,
			IOUtils, PathUtils, Zotero,
			fetch: (...args) => Zotero.getMainWindow().fetch(...args),
			env: (name) => (Services.env.exists(name) ? Services.env.get(name) : undefined),
			homeDir: Services.dirsvc.get("Home", Ci.nsIFile).path,
			isWindows: Zotero.isWin,
		});
		return this.geckoPlatform;
	}

	library() {
		this.zoteroLibrary ??= new SecondBrain.ZoteroLibrary(this.sb,
			SecondBrainAgent.createHttpLibraryBackend(this.platform().fetch, { baseUrl: this.sb.server }));
		return this.zoteroLibrary;
	}

	/** spec 011 U3: skills live in the vault, which only the server can reach; with it down they are kept in this data
	 *  folder, so Create skill still works (the two do not merge: the vault is the one that Obsidian shows). */
	skillSource() {
		const fs = this.platform().fs;
		const folder = SecondBrainAgent.createFolderSkillSource(fs, PathUtils.join(this.dataDir, "skills"));
		const server = SecondBrainAgent.createHttpSkillSource(this.platform().fetch, { baseUrl: this.sb.server });
		const pick = () => (this.sb.online ? server : folder);
		return {
			list: () => pick().list(),
			get: (name) => pick().get(name),
			put: (name, text) => pick().put(name, text),
			remove: (name) => pick().remove(name),
		};
	}

	/** The in-process runtime, built once. */
	async local() {
		if (this.localRuntime) return this.localRuntime;
		this.starting ??= this.startLocal().finally(() => { this.starting = null; });
		return this.starting;
	}

	async startLocal() {
		const platform = this.platform();
		const library = this.library();
		// T6.2: one persisted settings.json under this.dataDir (settings.js), the same file createLocalRuntime's
		// own internal store reads and writes for providers.roles/setRole and mcp.save/remove below, so a saved
		// MCP server is already connected on this very startup, not just from the next one.
		const saved = await SecondBrainAgent.createSettingsStore(platform.fs, this.dataDir).get();
		const settings = { scholarly: ["openalex", "arxiv", "crossref", "europepmc"], mcpUrl: undefined, spawn: platform.spawn, mcp: saved.mcp };
		const gateway = await SecondBrainAgent.createToolGateway(platform.fetch, library, settings);
		this.mount = await platform.serve(SecondBrain.AgentHost.MCP_PATH, SecondBrainAgent.createMcpHttpHandler(gateway));
		settings.mcpUrl = this.mount.url;
		this.gateway = gateway;
		const codexPath = Zotero.Prefs.get("extensions.secondbrain.ai.codexPath", true) || null;
		const providers = SecondBrainAgent.createProviders(platform, { dataDir: this.dataDir, home: platform.homeDir, codex: { binaryPath: codexPath } });
		this.providers = providers;
		// No getRoleModel here: createLocalRuntime's own default reads the same settings.json live on every
		// turn (core.js), which is what makes providers.setRole take effect on the very next message (criterion 10).
		this.localRuntime = await SecondBrainAgent.createLocalRuntime({
			platform, library, notes: new SecondBrain.LocalNoteSink(this.sb), skills: this.skillSource(), dataDir: this.dataDir, providers, gateway,
			// One scheduler per machine: this runtime runs routines only while the server's runtime is not answering
			// (serverRuntime() refreshes the cached /agent/ping, 3 s timeout, at most every PING_EVERY_MS).
			routines: { isOwner: async () => !(await this.serverRuntime()) },
		});
		return this.localRuntime;
	}

	async shutdown() {
		this.listeners.clear();
		this.current = null;
		this.mount?.unmount();
		this.mount = null;
		const runtime = this.localRuntime;
		this.localRuntime = null;
		await runtime?.dispose().catch((error) => Zotero.logError(error));
	}
};

/** The LibraryBackend (agent-src/src/tools.d.ts) for Zotero. With the Second Brain server up, searches go to it,
 *  with the agent header so its privacy rules apply, and cover the vault too. Without it, papers come from the
 *  built-in search model and Zotero's own word and full-text search, and are read from Zotero's full text.
 *  Papers always resolve against Zotero, which is the authority on what is in the library. */
SecondBrain.ZoteroLibrary = class {
	constructor(sb, server) {
		this.sb = sb;
		this.server = server;
	}

	/** Runs the server's version when it is up; a server that has gone away flips Second Brain offline. */
	async viaServer(call) {
		if (!this.sb.online) return undefined;
		try {
			return await call(this.server);
		} catch (error) {
			if (!this.sb.isOffline(error)) throw error;
			this.sb.setOnline(false);
			return undefined;
		}
	}

	citekey(item) {
		return item.getField("citationKey") || item.key;
	}

	paperRef(item) {
		return { kind: "paper", citekey: this.citekey(item) };
	}

	year(item) {
		const year = parseInt(item.getField("year"), 10);
		return Number.isFinite(year) ? year : null;
	}

	snippet(item) {
		const abstract = (item.getField("abstractNote") || "").replace(/\s+/g, " ").trim();
		if (abstract) return abstract.length > 280 ? `${abstract.slice(0, 280)}…` : abstract;
		return [item.getField("firstCreator"), item.getField("publicationTitle")].filter(Boolean).join(" · ");
	}

	/** Item keys in a review's scope, or null for the whole library. Spec 008 Z3: `scope.kind === "collection"`
	 *  (a name, singular) is a pre-Z3 persisted value — an old review's request.json, a saved Find papers search;
	 *  nothing on disk is ever rewritten, so it's still read here and mapped to the matching key(s) by name,
	 *  same as the current "collections" (keys, plural) shape once resolved. */
	async scopeKeys(scope) {
		if (!scope || scope.kind === "library") return null;
		const libraryID = Zotero.Libraries.userLibraryID;
		const search = new Zotero.Search();
		search.libraryID = libraryID;
		if (scope.kind === "collections" || scope.kind === "collection") {
			const keys = scope.kind === "collections" ? scope.keys
				: Zotero.Collections.getByLibrary(libraryID, true).filter((c) => c.name === scope.name).map((c) => c.key);
			if (!keys.length) return new Set();
			search.addCondition("joinMode", "any");
			for (const key of keys) search.addCondition("collection", "is", key);
			search.addCondition("recursive", "true");
		} else if (scope.kind === "tag") {
			search.addCondition("tag", "is", scope.name);
		} else {
			const saved = Zotero.Searches.getByLibrary(libraryID).find((s) => s.name === scope.name);
			if (!saved) return new Set();
			search.addCondition("savedSearch", "is", saved.key);
		}
		return new Set(Zotero.Items.get(await search.search()).map((item) => (item.isRegularItem() ? item : item.parentItem)?.key).filter(Boolean));
	}

	/** Spec 005 §5: `only: "papers"`, or any scope (Zotero-only, the server has no notion of a collection or
	 *  tag), stays entirely local — Zotero is already the authority on its own papers. `only: "notes"` has
	 *  nothing to search here (the vault lives only in the server's index): server, or `[]` offline. Neither
	 *  (a whole-library search with no kind chosen) tries the server first, falling back to local papers. */
	async search({ text, scope, limit, only, years }) {
		if (only === "notes") {
			const remote = await this.viaServer((server) => server.search({ text, scope, limit, only, years }));
			return remote ?? [];
		}
		if (only === "papers" || (scope && scope.kind !== "library")) {
			return this.searchLocalPapers(text, scope, limit, years);
		}
		const remote = await this.viaServer((server) => server.search({ text, scope, limit, years }));
		if (remote) return remote;
		return this.searchLocalPapers(text, scope, limit, years);
	}

	/** With a year range, as on the server, a paper without a year never matches; more are fetched so the
	 *  filter still leaves up to `limit`. */
	async searchLocalPapers(text, scope, limit, years) {
		const within = await this.scopeKeys(scope);
		const ranged = years && (years.from != null || years.to != null);
		const items = await this.sb.searchLocally(text, ranged ? limit * 4 : limit, { words: "quicksearch-everything", within });
		const rows = items.map((item) => ({ ref: this.paperRef(item), title: item.getField("title"), snippet: this.snippet(item), year: this.year(item) }));
		if (!ranged) return rows;
		return rows.filter((row) => row.year != null && (years.from == null || row.year >= years.from)
			&& (years.to == null || row.year <= years.to)).slice(0, limit);
	}

	async read(ref, { heading, maxChars }) {
		if (ref.kind === "note") return (await this.viaServer((server) => server.read(ref, { heading, maxChars }))) ?? null;
		if (ref.kind !== "paper") return null;
		const item = await this.sb.itemByCitekey(ref.citekey);
		if (!item) return null;
		const remote = await this.viaServer((server) => server.read({ kind: "paper", citekey: item.key }, { heading, maxChars }));
		if (remote?.text) return remote;
		return { title: item.getField("title"), text: (await this.paperText(item)).slice(0, maxChars) };
	}

	/** What a reader of the paper would see: its details and abstract, the user's own note, then the full text. */
	async paperText(item) {
		const doi = item.getField("DOI");
		const details = [item.getField("firstCreator"), item.getField("year"), item.getField("publicationTitle"), doi && `doi:${doi}`].filter(Boolean).join(" · ");
		const parts = [details];
		const abstract = item.getField("abstractNote");
		if (abstract) parts.push(`Abstract\n${abstract}`);
		const note = await this.sb.local.load(item).catch(() => null);
		if (note?.text?.trim()) parts.push(`The user's notes on this paper\n${note.text.trim()}`);
		const attachment = await item.getBestAttachment();
		let fullText = "";
		try { fullText = attachment ? (await attachment.attachmentText) || "" : ""; } catch (error) { /* not indexed */ }
		parts.push(fullText ? `Full text\n${fullText.replace(/[ \t]+/g, " ")}` : "Full text isn't available in Zotero for this paper.");
		return parts.join("\n\n");
	}

	async related(ref, { limit }) {
		const remote = await this.viaServer((server) => server.related(ref, { limit }));
		if (remote?.length) return remote;
		if (ref.kind !== "paper") return [];
		const item = await this.sb.itemByCitekey(ref.citekey);
		if (!item) return [];
		return this.sb.localIndex.similar(item.key, limit)
			.map((hit) => Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, hit.key)).filter(Boolean)
			.map((other) => ({ ref: this.paperRef(other), title: other.getField("title"), snippet: this.snippet(other) }));
	}

	async resolve(refs) {
		const map = new Map();
		const notes = refs.filter((ref) => ref.kind === "note");
		const remote = notes.length ? await this.viaServer((server) => server.resolve(notes)) : undefined;
		for (const ref of refs) {
			if (ref.kind === "note") map.set(`note:${ref.path}`, remote?.get(`note:${ref.path}`) ?? null);
			else if (ref.kind === "paper") {
				const item = await this.sb.itemByCitekey(ref.citekey);
				map.set(`paper:${ref.citekey}`, item ? { title: item.getField("title") } : null);
			}
		}
		return map;
	}
};

/** Where finished literature reviews are written when Zotero runs alone: "Literature Reviews" in the local notes
 *  folder, one Markdown file per review. Publishing the same review again rewrites its own file (found by the
 *  review-id in its front matter); a different review with the same title gets a numbered name. */
SecondBrain.LocalNoteSink = class {
	constructor(sb) {
		this.sb = sb;
		this.queue = Promise.resolve();
	}

	get folder() {
		return PathUtils.join(this.sb.local.folder, "Literature Reviews");
	}

	/** @param {{ reviewId: string, title: string, markdown: string, frontMatter?: Record<string, unknown> }} note */
	publish(note) {
		const next = this.queue.catch(() => {}).then(() => this.write(note));
		this.queue = next;
		return next;
	}

	async existing(reviewId) {
		if (!(await IOUtils.exists(this.folder))) return null;
		for (const path of await IOUtils.getChildren(this.folder)) {
			if (!path.endsWith(".md")) continue;
			const head = new TextDecoder().decode(await IOUtils.read(path, { maxBytes: 800 }));
			const match = /^review-id:\s*"?([^"\n]+)"?$/m.exec(head);
			if (match?.[1] === reviewId) return path;
		}
		return null;
	}

	async write({ reviewId, title, markdown, frontMatter = {} }) {
		const date = new Date().toISOString().slice(0, 10);
		const fields = { type: "literature-review", "review-id": reviewId, title, date, ...frontMatter };
		const front = ["---", ...Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), "---", ""].join("\n");
		let path = await this.existing(reviewId);
		if (!path) {
			await IOUtils.makeDirectory(this.folder, { createAncestors: true });
			const base = `${date} ${title}`.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || `${date} Literature review`;
			path = PathUtils.join(this.folder, `${base}.md`);
			for (let n = 2; await IOUtils.exists(path); n++) path = PathUtils.join(this.folder, `${base} ${n}.md`);
		}
		await IOUtils.writeUTF8(path, `${front}\n${markdown.trim()}\n`, { tmpPath: `${path}.tmp` });
		return { path };
	}
};
