// The Settings view reads and writes rows through host.prefs. Some of Obsidian's rows are fields of the plugin's own
// settings (the server switch, port, Mac address, ...), the rest belong to the shared UI's pref store.

export const OWN_FIELDS = ["startServer", "kbDir", "python", "port", "remoteUrl", "token", "updates", "contextDepth", "contextSimilar"] as const;
export type OwnField = (typeof OWN_FIELDS)[number];
const isOwn = (key: string): key is OwnField => (OWN_FIELDS as readonly string[]).includes(key);

/** What an emptied field falls back to: text fields to "", the rest to their usual value. */
const EMPTY: Record<OwnField, unknown> = { startServer: true, kbDir: "", python: "", port: 27182, remoteUrl: "", token: "", updates: "server", contextDepth: 1, contextSimilar: false };

export interface PrefStore { get(key: string): unknown; set(key: string, value: unknown): void }

export function ownPrefs(settings: object, shared: PrefStore, save: () => void): PrefStore {
	const own = settings as Record<string, unknown>;
	return {
		get: (key) => (isOwn(key) ? own[key] : shared.get(key)),
		set: (key, value) => {
			if (!isOwn(key)) { shared.set(key, value); return; }
			// a port is a whole number; the table's range check alone lets 1025.5 through
			if (key === "port" && !Number.isInteger(value)) return;
			own[key] = value ?? EMPTY[key];
			save();
		},
	};
}
