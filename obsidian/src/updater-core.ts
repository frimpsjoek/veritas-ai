// src/updater-core.ts. Pure logic for the auto-updater (spec 006): no `obsidian` import, so it can be unit
// tested with plain `node --experimental-strip-types` and reused unchanged by updater.ts.

/** a.b.c only, matching manifest.json and the server's semver filenames. A non-numeric version compares as not
 *  newer, so a corrupt or dev version string never triggers an update. */
export function isNewer(current: string, candidate: string): boolean {
	const parse = (v: string): number[] | null => {
		const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || "");
		return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
	};
	const a = parse(current);
	const b = parse(candidate);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) if (b[i] !== a[i]) return b[i] > a[i];
	return false;
}

export interface IdleState {
	/** A chat turn is streaming right now. */
	chatRunning: boolean;
	/** A report-plan or chat-composer field has focus. */
	fieldFocused: boolean;
}

/** Conservative on purpose: any of these being true means "wait", the same rule the spec gives for Zotero. */
export function isIdle(state: IdleState): boolean {
	return !state.chatRunning && !state.fieldFocused;
}

/** SHA-256 of `data` as lowercase hex, compared against `expected` (also lowercase hex expected). Uses
 *  WebCrypto's subtle.digest, available both in Obsidian's renderer and in plain Node (globalThis.crypto). */
export async function verifySha256(data: ArrayBuffer, expected: string): Promise<boolean> {
	const digest = await (globalThis.crypto.subtle as SubtleCrypto).digest("SHA-256", data);
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return hex === expected.toLowerCase();
}
