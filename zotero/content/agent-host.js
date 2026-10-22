/* global Zotero, SecondBrain, SecondBrainAgent */
// The assistant in Zotero is a client of the Veritas server, like the Obsidian plugin: one runtime on the server owns
// the conversations, routines, projects and settings, and Zotero talks to it over HTTP (content/agent.js bundles
// agent/src/remote.js's createRemoteRuntime). Nothing runs an agent, an MCP endpoint or a search index inside Zotero.
// When the server is not running, every call fails with "Veritas server is not running" instead of anything else.

SecondBrain.AgentHost = class {
	static PING_EVERY_MS = 10000;

	constructor(sb) {
		this.sb = sb;
		this.remote = null;
		this.busy = 0; // turns streaming right now (the updater waits for them)
		this.pinged = { at: 0, ok: false };
		this.wrapped = new WeakMap();
		this.listeners = new Set();
	}

	/** The server's AgentService. It never throws: with the server down its calls fail one by one with unreachable(). */
	async ai() {
		await this.ping();
		this.remote ??= SecondBrainAgent.createRemoteRuntime(this.remoteTransport());
		return this.tracked(this.remote);
	}

	/** The runtime the UI talks to: always the server's, once ai() has been asked for it. */
	get current() {
		return this.remote;
	}

	/** Asks /agent/ping at most every PING_EVERY_MS and records the answer as the server's online state. */
	async ping() {
		if (Date.now() - this.pinged.at <= SecondBrain.AgentHost.PING_EVERY_MS) return this.pinged.ok;
		let ok = false;
		try {
			const response = await Zotero.HTTP.request("GET", `${this.sb.server}/agent/ping`, { headers: this.sb.serverHeaders(), timeout: 3000, successCodes: false });
			ok = response.status === 200;
		} catch (error) { /* connection refused: the server is not running */ }
		this.pinged = { at: Date.now(), ok };
		this.sb.setOnline(ok);
		return ok;
	}

	/** Pings again on the next ai(), and tells the UI (where()) that the connection changed. */
	connectionChanged() {
		this.pinged.at = 0;
		for (const listener of this.listeners) {
			try { listener(this.sb.online ? "server" : "offline"); } catch (error) { Zotero.logError(error); }
		}
	}

	/** The OpenAlex key lives in the server's settings and in the Zotero pref the content scripts read synchronously. */
	async syncOpenAlexKey(runtime) {
		try {
			const engine = (await runtime.settings.get()).openalex?.apiKey ?? null;
			const pref = Zotero.Prefs.get("extensions.secondbrain.openalexKey", true) || null;
			if (pref && !engine) await runtime.settings.update({ openalex: { apiKey: pref } });
			else if (engine && !pref) Zotero.Prefs.set("extensions.secondbrain.openalexKey", engine, true);
		} catch (error) { /* the server is not running; next time */ }
	}

	/** Counts streaming turns, and keeps the OpenAlex pref in step with the server's settings. */
	tracked(runtime) {
		if (!this.wrapped.has(runtime)) {
			const host = this;
			void this.syncOpenAlexKey(runtime);
			const track = async function* (events) {
				host.busy++;
				try { yield* events; } finally { host.busy--; }
			};
			this.wrapped.set(runtime, {
				...runtime,
				conversations: { ...runtime.conversations, send: (id, input, opts) => track(runtime.conversations.send(id, input, opts)) },
				ask: (question, opts) => track(runtime.ask(question, opts)),
				settings: { ...runtime.settings, update: async (patch) => {
					const updated = await runtime.settings.update(patch);
					if (patch.openalex && patch.openalex.apiKey !== undefined) {
						try { Zotero.Prefs.set("extensions.secondbrain.openalexKey", updated.openalex?.apiKey ?? "", true); } catch (error) { Zotero.logError(error); }
					}
					return updated;
				} },
			});
		}
		return this.wrapped.get(runtime);
	}

	// GET /agent/events?after= (agentd's route table, agent/src/node/agentd.mjs) answers with a plain JSON array of
	// flattened Sequenced<AgentEvent> records (`{seq, type, ...}`), each call bounded to agentd's own 25s long-poll
	// wait; createRemoteRuntime's streamEvents stops polling once it sees a done/failed event. This mirrors the
	// Obsidian transport (obsidian/src/agent-api.ts), the other client of this route.
	remoteTransport() {
		const sb = this.sb;
		const call = async (method, path, body) => {
			let response;
			try {
				response = await Zotero.HTTP.request(method, `${sb.server}/agent${path}`, {
					body: body === undefined ? undefined : JSON.stringify(body), headers: sb.serverHeaders({ "Content-Type": "application/json" }),
					responseType: "json", timeout: 60000, successCodes: false,
				});
			} catch (error) {
				sb.setOnline(false);
				throw Object.assign(new Error(sb.unreachable(error)), { status: 0, cause: error });
			}
			if (response.status >= 400) {
				const error = Object.assign(new Error(response.response?.error ?? `HTTP ${response.status}`), { status: response.status });
				throw response.status === 401 ? Object.assign(new Error(sb.unreachable(error)), { status: 401 }) : error;
			}
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
						await new Promise((resolve) => setTimeout(resolve, backoffMs)); // the server restarting, or a blip
						continue;
					}
					for (const event of batch ?? []) { cursor = event.seq; yield { seq: event.seq, data: event }; }
				}
			},
		};
	}

	onSwitch(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	library() {
		this.zoteroLibrary ??= new SecondBrain.ZoteroLibrary(this.sb);
		return this.zoteroLibrary;
	}

	shutdown() {
		this.listeners.clear();
		this.remote = null;
	}
};

/** Find papers' direct library search (ui-host-zotero.js searchLibrary), over the server's /search. Collections and
 *  tags narrow it on the server; a saved search exists only in Zotero, so its items filter the server's hits here. */
SecondBrain.ZoteroLibrary = class {
	constructor(sb) {
		this.sb = sb;
	}

	/** Item keys of a saved search, or null when the scope is not one. */
	async savedSearchKeys(scope) {
		if (scope?.kind !== "savedSearch") return null;
		const libraryID = Zotero.Libraries.userLibraryID;
		const saved = Zotero.Searches.getByLibrary(libraryID).find((s) => s.name === scope.name);
		if (!saved) return new Set();
		const search = new Zotero.Search();
		search.libraryID = libraryID;
		search.addCondition("savedSearch", "is", saved.key);
		return new Set(Zotero.Items.get(await search.search()).map((item) => (item.isRegularItem() ? item : item.parentItem)?.key).filter(Boolean));
	}

	/** Rows as the agent's LibraryBackend.search returns them (agent/src/library-http.js). A pre-Z3 `{ kind: "collection",
	 *  name }` scope (an old saved Find papers search) is mapped to its collection keys by name. */
	async search({ text, scope, limit, only, years }) {
		const within = await this.savedSearchKeys(scope);
		const params = new URLSearchParams({ q: text, limit: String(within ? limit * 4 : limit) });
		if (only === "notes") params.set("exclude_source", "zotero");
		else if (only === "papers" || (scope && scope.kind !== "library")) params.set("source", "zotero");
		if (scope?.kind === "collections" && scope.keys?.length) params.set("collections", scope.keys.join(","));
		else if (scope?.kind === "collection" && scope.name) {
			const keys = Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID, true).filter((c) => c.name === scope.name).map((c) => c.key);
			if (!keys.length) return [];
			params.set("collections", keys.join(","));
		} else if (scope?.kind === "tag") params.set("tag", scope.name);
		if (years?.from != null) params.set("year_from", String(years.from));
		if (years?.to != null) params.set("year_to", String(years.to));
		let hits;
		try {
			hits = await this.sb.api(`/search?${params}`);
			this.sb.setOnline(true);
		} catch (error) {
			if (this.sb.isOffline(error)) this.sb.setOnline(false);
			throw new Error(this.sb.unreachable(error));
		}
		const rows = [];
		for (const hit of hits ?? []) {
			const paper = hit.path.startsWith("zotero/");
			if (paper && within && !within.has(hit.path.slice(7))) continue;
			const year = parseInt(hit.zotero?.year, 10);
			rows.push({
				ref: paper ? { kind: "paper", citekey: hit.path.slice(7) } : { kind: "note", path: hit.path },
				title: hit.title ?? hit.path, snippet: hit.passages?.[0]?.snippet ?? "", year: Number.isFinite(year) ? year : null,
			});
		}
		return rows.slice(0, limit);
	}
};
