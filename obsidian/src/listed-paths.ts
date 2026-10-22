// src/listed-paths.ts. Paths of folders the server reads besides this vault (server spec 018): "papers:/review.md".
// Obsidian cannot open them, so they open in the Second Brain web app: notes in its reader, PDFs and images as files.

/** A path in a listed folder, as opposed to a vault path or a Zotero item. */
export function isListedPath(path: string): boolean {
	return /^[a-z0-9][a-z0-9-]{0,31}:\//.test(path);
}

/** Where a listed-folder path opens on the server at `base` (no trailing slash). */
export function listedUrl(base: string, path: string): string {
	return /\.(pdf|png|jpe?g|webp|heic|gif|tiff?|bmp)$/i.test(path)
		? `${base}/folder-file?path=${encodeURIComponent(path)}`
		: `${base}/app/#/note/${path.split("/").map(encodeURIComponent).join("/")}`;
}
