// src/context-sources.ts. What the chat's composer learns from Obsidian (spec 008 C1-C3), kept free of any
// `obsidian` import so it runs under plain Node tests: the debounced "what the user is looking at changed"
// signal, the selection chip's label, and the `+`/`@` picker's rows from the vault's files.
import type { Attachment, Citekey, NotePath } from "../../zotero-plugin/agent-src/src/domain";
import type { ContextCandidate } from "../../zotero-plugin/ui-src/src/host";

/** A change source: subscribes `changed` and returns its unsubscribe. */
export type ChangeSource = (changed: () => void) => () => void;

/** Calls `listener` once, `ms` after the last change in a burst from any source (Copilot waits 100 ms after
 *  active-leaf-change; a selection drag fires selectionchange dozens of times). */
export function debouncedChanges(sources: ChangeSource[], listener: () => void, ms = 100): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const changed = () => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => { timer = null; listener(); }, ms);
	};
	const unsubscribe = sources.map((subscribe) => subscribe(changed));
	return () => {
		if (timer !== null) clearTimeout(timer);
		for (const off of unsubscribe) off();
	};
}

/** The selection chip's label: its first words on one line. */
export function selectionLabel(text: string, max = 48): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The vault facts one picker row needs; `zoteroKey` is the note's `zotero-key` frontmatter, if any. */
export interface VaultFile { path: string; basename: string; folder: string; zoteroKey: string | null }

/** A paper note (one with a `zotero-key`) is offered as that paper, every other note as itself. */
export function candidatesFromFiles(files: VaultFile[]): ContextCandidate[] {
	return files.map((file) => {
		const detail = file.folder && file.folder !== "/" ? file.folder : undefined;
		const attachment: Attachment = file.zoteroKey
			? { kind: "zoteroItem", citekey: file.zoteroKey as Citekey }
			: { kind: "note", path: file.path as NotePath };
		return { category: file.zoteroKey ? "paper" : "note", label: file.basename, detail, attachment };
	});
}
