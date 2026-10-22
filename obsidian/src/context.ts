import { App, Notice, TFile, TFolder } from "obsidian";
import type { Api, NoteText, Related } from "./api";

// "Copy for AI": one note plus the notes it links to (to a chosen depth), or a whole folder, as a single block
// of Markdown to paste into ChatGPT or claude.ai. Runs on the vault itself, so it works on the phone too.

const LIMIT = 200_000; // characters; about 50k tokens, enough for any chat window without drowning it

interface Part { title: string; path: string; text: string }

function format(parts: Part[], intro: string): { text: string; used: number; skipped: number } {
	let total = 0;
	const kept: string[] = [];
	for (const part of parts) {
		const block = `## ${part.title}\nSource: ${part.path}\n\n${part.text.trim()}\n`;
		if (total + block.length > LIMIT && kept.length) break;
		kept.push(block);
		total += block.length;
	}
	return { text: `# ${intro}\n\n${kept.join("\n---\n\n")}`, used: kept.length, skipped: parts.length - kept.length };
}

async function copy(parts: Part[], intro: string) {
	const { text, used, skipped } = format(parts, intro);
	await navigator.clipboard.writeText(text);
	new Notice(`Copied ${used} note${used === 1 ? "" : "s"} for AI` +
		(skipped ? ` (${skipped} left out to stay under ${LIMIT / 1000}k characters)` : ""));
}

/** The note first, then linked notes breadth-first: nearer links before farther ones. */
export async function copyNoteContext(app: App, api: Api, file: TFile, depth: number, withSimilar: boolean) {
	const seen = new Set([file.path]);
	let frontier = [file];
	const files = [file];
	for (let level = 0; level < depth; level++) {
		const next: TFile[] = [];
		for (const f of frontier) {
			for (const target of Object.keys(app.metadataCache.resolvedLinks[f.path] ?? {})) {
				const linked = app.vault.getAbstractFileByPath(target);
				if (linked instanceof TFile && linked.extension === "md" && !seen.has(target)) {
					seen.add(target);
					next.push(linked);
				}
			}
		}
		files.push(...next);
		frontier = next;
	}
	const parts: Part[] = [];
	for (const f of files) parts.push({ title: f.basename, path: f.path, text: await app.vault.cachedRead(f) });

	if (withSimilar) { // needs the index; skipped quietly when the Mac can't be reached
		try {
			const related = await api.call<Related>(`/related?${new URLSearchParams({ path: file.path, limit: "5" })}`);
			for (const s of related.similar.filter((s) => !seen.has(s.path))) {
				const note = await api.call<NoteText>(`/note?${new URLSearchParams({ path: s.path })}`);
				parts.push({ title: s.title, path: s.path, text: note.text });
			}
		} catch { /* similar notes are optional */ }
	}
	await copy(parts, `Context: "${file.basename}" and ${depth === 1 ? "the notes it links to" : `linked notes (${depth} levels)`}`);
}

export async function copyFolderContext(app: App, folder: TFolder) {
	const files: TFile[] = [];
	const walk = (f: TFolder) => {
		for (const child of f.children) {
			if (child instanceof TFolder) walk(child);
			else if (child instanceof TFile && child.extension === "md") files.push(child);
		}
	};
	walk(folder);
	files.sort((a, b) => a.path.localeCompare(b.path));
	const parts: Part[] = [];
	for (const f of files) parts.push({ title: f.basename, path: f.path, text: await app.vault.cachedRead(f) });
	await copy(parts, `Context: folder "${folder.path}"`);
}
