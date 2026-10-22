/* global SecondBrain */
// Where a paper's notes live: a note in the Veritas server's notes folder (Papers/), read and written over HTTP.
// Without the server the editor keeps unsaved text and says the server is not running; there is no local copy.

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
