/* global Zotero, IOUtils, PathUtils, TextDecoder, SecondBrain */
// Where a paper's notes live. With the Second Brain server running they are a note in the Obsidian vault
// (Papers/, synced both ways); without it, a Markdown file in a folder on this computer, written in the same
// shape so it can be moved into a vault later. Both stores answer load/save with the same fields.

SecondBrain.hashText = (text) => {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	return (h >>> 0).toString(16);
};

SecondBrain.ObsidianStore = class {
	constructor(sb) { this.sb = sb; this.kind = "obsidian"; }

	load(item) { return this.sb.api(`/paper-note/body?key=${item.key}`); }

	save(item, text, baseHash, force) {
		return this.sb.post("/paper-note/body", { key: item.key, text, base_hash: baseHash, force });
	}

	imageURL(target, embed, notePath) {
		const q = embed ? `name=${encodeURIComponent(target)}`
			: `path=${encodeURIComponent(target)}&note=${encodeURIComponent(notePath ?? "")}`;
		return `${this.sb.server}/file?${q}`;
	}

	async saveImage(name, base64) {
		return (await this.sb.post("/attachment", { name, data: base64 })).name;
	}
};

SecondBrain.LocalStore = class {
	constructor(sb) { this.sb = sb; this.kind = "local"; this.paths = new Map(); this.queues = new Map(); }

	get folder() {
		return Zotero.Prefs.get("extensions.secondbrain.notesFolder", true)
			|| PathUtils.join(Zotero.DataDirectory.dir, "second-brain", "notes");
	}

	/** The note file for a paper, found by the zotero-key in its front matter (file names can be renamed). */
	async find(key) {
		const known = this.paths.get(key);
		if (known && await IOUtils.exists(known)) return known;
		if (!(await IOUtils.exists(this.folder))) return null;
		this.paths.clear();
		for (const path of await IOUtils.getChildren(this.folder)) {
			if (!path.endsWith(".md")) continue;
			const head = new TextDecoder().decode(await IOUtils.read(path, { maxBytes: 600 }));
			const match = /^zotero-key:\s*"?([A-Z0-9]{8})/m.exec(head);
			if (match) this.paths.set(match[1], path);
		}
		return this.paths.get(key) ?? null;
	}

	split(raw) {
		const front = /^---\n[\s\S]*?\n---\n/.exec(raw.replace(/\r\n/g, "\n"));
		const text = raw.replace(/\r\n/g, "\n");
		return front ? [front[0], text.slice(front[0].length)] : ["", text];
	}

	frontMatter(item) {
		const quote = (s) => JSON.stringify(String(s ?? ""));
		return ["---", `zotero-key: ${item.key}`, `citekey: ${quote(item.getField("citationKey"))}`,
			`title: ${quote(item.getField("title"))}`, `year: ${quote(item.getField("year"))}`,
			`zotero: ${quote(`zotero://select/library/items/${item.key}`)}`, "---", ""].join("\n");
	}

	fileName(item) {
		const name = `${item.getField("citationKey") || item.key} ${item.getField("title")}`
			.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
		return `${name || item.key}.md`;
	}

	async load(item) {
		const path = await this.find(item.key);
		if (!path) return { text: "", hash: null, path: null, references: [] };
		const [, text] = this.split(await IOUtils.readUTF8(path));
		return { text, hash: SecondBrain.hashText(text), path, references: await this.sb.references(text) };
	}

	/** Saves to one paper's file run one after another, so two editors (side pane and full page) can't both
	 *  create it and have the second overwrite the first; the second then sees the file and gets a conflict. */
	save(item, text, baseHash, force) {
		const previous = this.queues.get(item.key) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(() => this.write(item, text, baseHash, force));
		this.queues.set(item.key, next);
		next.finally(() => { if (this.queues.get(item.key) === next) this.queues.delete(item.key); }).catch(() => {});
		return next;
	}

	async write(item, text, baseHash, force) {
		let path = await this.find(item.key);
		let front;
		if (path) {
			const [head, current] = this.split(await IOUtils.readUTF8(path));
			const hash = SecondBrain.hashText(current);
			if (!force && hash !== baseHash && current !== text) {
				const error = new Error("changed on disk");
				error.status = 409;
				error.body = { text: current, hash, path, references: await this.sb.references(current) };
				throw error;
			}
			front = head;
		} else {
			await IOUtils.makeDirectory(this.folder, { createAncestors: true });
			path = PathUtils.join(this.folder, this.fileName(item));
			front = this.frontMatter(item);
			this.paths.set(item.key, path);
		}
		await IOUtils.writeUTF8(path, front + text, { tmpPath: path + ".tmp" });
		return { hash: SecondBrain.hashText(text), path, references: await this.sb.references(text) };
	}

	/** Once a note has moved into the vault, keep the local file out of the way but don't delete it. It goes to
	 *  Zotero's data folder, never under the notes folder: that may sit inside the vault, where a second file
	 *  with the same zotero-key would show up in Obsidian and could be taken for the paper's note. */
	async retire(key) {
		const path = await this.find(key);
		if (!path) return;
		const done = PathUtils.join(Zotero.DataDirectory.dir, "second-brain", "moved-to-obsidian");
		await IOUtils.makeDirectory(done, { createAncestors: true });
		await IOUtils.move(path, PathUtils.join(done, PathUtils.filename(path)));
		this.paths.delete(key);
	}

	imageURL(target, embed, notePath) {
		const annotation = /^zotero-([A-Z0-9]{8})\.png$/.exec(target);
		let path;
		if (annotation) path = Zotero.Annotations.getCacheImagePath({ libraryID: Zotero.Libraries.userLibraryID, key: annotation[1] });
		else if (embed || !notePath) path = PathUtils.join(this.folder, "attachments", target);
		else path = PathUtils.join(PathUtils.parent(notePath), ...target.split("/"));
		return PathUtils.toFileURI(path);
	}

	async saveImage(name, base64) {
		const dir = PathUtils.join(this.folder, "attachments");
		await IOUtils.makeDirectory(dir, { createAncestors: true });
		const clean = name.replace(/[\\/:*?"<>|#^[\]]/g, "") || "pasted.png";
		const dot = clean.lastIndexOf(".");
		const unique = `${dot > 0 ? clean.slice(0, dot) : clean} ${Date.now()}${dot > 0 ? clean.slice(dot) : ".png"}`;
		const bytes = Uint8Array.from(Zotero.getMainWindow().atob(base64), (c) => c.charCodeAt(0));
		await IOUtils.write(PathUtils.join(dir, unique), bytes);
		return unique;
	}
};
