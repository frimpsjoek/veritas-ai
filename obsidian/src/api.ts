import { Platform, requestUrl } from "obsidian";
import type { ChildProcess } from "child_process";

// Talks to the index server (kb.py serve). On the Mac it is 127.0.0.1 and needs no token; on the phone it is the
// Mac's Tailscale address and every request carries the token.

export interface Settings {
	kbDir: string;
	python: string;
	port: number;
	startServer: boolean;
	remoteUrl: string;
	token: string;
	contextDepth: number;
	contextSimilar: boolean;
	chatHistoryCollapsed: boolean;
	chatMode: "chat" | "ask" | "find" | "report";
	/** Auto-update from the Second Brain server (spec 006): "server" checks at load and every 15 min plus the
	 *  Settings button; "off" checks never. There is no "github" choice here (unlike Zotero) -- Obsidian has no
	 *  update mechanism of its own to fall back to, so "off" is the safe default for a copy that isn't wired to
	 *  a server at all yet. */
	updates: "server" | "off";
	/** The shared chat's four source pills (spec 005 C2/C3): `{ papers, notes, scholarly, web }`, or the pre-005
	 *  `{ library, scholarly, web }` shape from an older version — ui-src's ChatView.savedSources() reads either,
	 *  read-time only, nothing here is rewritten. Undefined until the user first touches a pill. */
	chatSources?: Record<string, boolean>;
	chatProject?: string | null;
	/** Everything else the shared UI remembers through host.prefs (Home's columns, the Sources intro put off). */
	ui?: Record<string, unknown>;
}

export const HOME = (window as any).process?.env?.HOME ?? "";
export const DEFAULTS: Settings = {
	kbDir: `${HOME}/obsidian-kb`,
	python: `${HOME}/obsidian-kb/.venv/bin/python`,
	port: 27182,
	startServer: true,
	remoteUrl: "http://example.ts.net:27182",
	token: "",
	contextDepth: 1,
	contextSimilar: false,
	chatHistoryCollapsed: false,
	chatMode: "chat",
	updates: "server",
};

import type { NoteRef as SharedNoteRef, ZoteroMeta as SharedZoteroMeta } from "../../ui/src/index.js";

// The shared panels (ui-src) define these shapes; one definition keeps rows passed between them assignable.
export type ZoteroMeta = SharedZoteroMeta;
export type NoteRef = SharedNoteRef;
export interface Passage { heading: string; snippet: string }
export interface Hit extends NoteRef { tags: string[]; modified: string; passages: Passage[] }
export interface Similar extends NoteRef { score: number }
export interface TagMatch extends NoteRef { tags: string[] }
export interface SectionMatch extends NoteRef { heading: string; score: number; snippet: string }
export interface Related {
	path: string;
	links_to: string[];
	linked_from: string[];
	refs: Record<string, NoteRef>; // titles and Zotero details for everything in links_to and linked_from
	similar: Similar[];
	shared_tags: TagMatch[];
}
export interface NoteText extends NoteRef { text: string; truncated: boolean }
export interface Duplicates { exact: string[][]; near: { paths: string[]; score: number }[]; zotero: NoteRef[][] }
export interface ConflictEntry { copy: string; original: string; copy_chars: number; original_chars: number; copy_newer: boolean }
export interface Conflicts { total: number; identical: ConflictEntry[]; different: ConflictEntry[]; no_original: { copy: string }[] }

export class ApiError extends Error {
	constructor(public status: number, message: string) { super(message); }
}

export class Api {
	private server: ChildProcess | null = null;
	/** When a request last succeeded. Within 30 s of that, actions skip the "is it up?" check entirely. */
	private lastOk = 0;

	constructor(private settings: () => Settings) {}

	/** The server's address, for links into the web app (server spec 018). */
	serverBase(): string {
		return this.base();
	}

	private base(): string {
		const s = this.settings();
		return Platform.isDesktopApp ? `http://127.0.0.1:${s.port}` : s.remoteUrl.replace(/\/+$/, "");
	}

	async call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
		const headers: Record<string, string> = {};
		if (!Platform.isDesktopApp) headers.Authorization = `Bearer ${this.settings().token}`;
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const response = await requestUrl({
			url: `${this.base()}${path}`, method, headers, throw: false,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (response.status < 400) this.lastOk = Date.now();
		if (response.status >= 400) {
			let message = `HTTP ${response.status}`;
			try { message = response.json?.error ?? message; } catch { /* not JSON */ }
			throw new ApiError(response.status, message);
		}
		return response.json as T;
	}

	/** Raw bytes, unlike `call` (which always expects JSON) -- used for the plugin auto-updater (spec 006), which
	 *  must hash the exact bytes it writes to disk before trusting them. */
	async rawBinary(path: string): Promise<ArrayBuffer> {
		const headers: Record<string, string> = {};
		if (!Platform.isDesktopApp) headers.Authorization = `Bearer ${this.settings().token}`;
		const response = await requestUrl({ url: `${this.base()}${path}`, method: "GET", headers, throw: false });
		if (response.status >= 400) throw new ApiError(response.status, `HTTP ${response.status}`);
		return response.arrayBuffer;
	}

	/** Why the last check failed, for messages: no token, wrong token, or the Mac can't be reached at all. */
	lastProblem: "token" | "network" | null = null;

	async up(): Promise<boolean> {
		try {
			await this.call("/ping");
			this.lastProblem = null;
			return true;
		} catch (error) {
			this.lastProblem = error instanceof ApiError && error.status === 401 ? "token" : "network";
			return false;
		}
	}

	/** On the Mac: reuse a running server, otherwise start one. On the phone: just check the Mac is reachable. */
	async ensure(): Promise<boolean> {
		if (Date.now() - this.lastOk < 30_000) return true;
		if (await this.up()) return true;
		const s = this.settings();
		if (!Platform.isDesktopApp || !s.startServer) return false;
		if (!this.server) {
			const { spawn } = require("child_process") as typeof import("child_process");
			this.server = spawn(s.python, ["kb.py", "serve", "--port", String(s.port)], { cwd: s.kbDir, stdio: "ignore" });
			this.server.on("exit", () => { this.server = null; });
			this.server.on("error", () => { this.server = null; });
		}
		for (let i = 0; i < 60; i++) {
			if (await this.up()) return true;
			await sleep(500);
		}
		return false;
	}

	stop() {
		this.server?.kill();
	}

	/** The token the phone needs, read from the index folder (Mac only). */
	readToken(): string {
		if (!Platform.isDesktopApp) return this.settings().token;
		try {
			const fs = require("fs") as typeof import("fs");
			return fs.readFileSync(`${this.settings().kbDir}/data/api-token`, "utf8").trim();
		} catch {
			return "";
		}
	}

	unreachableMessage(): string {
		if (Platform.isDesktopApp) return "The search index isn't running. Check the plugin settings.";
		if (this.lastProblem === "token") {
			return this.settings().token
				? "Your Mac refused the access token. Scan the setup QR code again (Mac: Settings → Second Brain Search)."
				: "Not set up yet: scan the setup QR code from your Mac (Settings → Second Brain Search).";
		}
		return "Can't reach your Mac. Make sure Tailscale is on here and the Mac is awake with the index running.";
	}
}
