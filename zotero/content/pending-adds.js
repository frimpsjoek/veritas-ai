/* global Zotero, SecondBrain, IOUtils, PathUtils */
// Papers, tags and highlights queued by the Second Brain server (the web app's "Add to Zotero", "Read later" and the
// web reader's highlights). The server
// asks for them to be applied at once through APPLY_PATH when Zotero is open; otherwise they are applied at startup and every minute; an entry that fails stays queued and the server gives up on
// it after five attempts. Each entry looks the paper up in the library first, so a retry never adds it twice; a
// highlight carries the Zotero key it is saved under, so a retry finds it instead of adding another. A PDF saved in the
// desktop app's Browse view (an `attach` entry, spec 027) is attached once per file: its MD5 is compared with the
// hashes Zotero keeps for the item's PDFs.

SecondBrain.PendingAdds = class {
	static EVERY_MS = 60000;

	constructor(sb) {
		this.sb = sb;
	}

	static APPLY_PATH = "/second-brain/pending-adds/apply";

	start() {
		this.first = setTimeout(() => this.run(), 3000);
		this.timer = setInterval(() => this.run(), SecondBrain.PendingAdds.EVERY_MS);
		// The server calls this right after queueing, so an add made while Zotero is open lands at once. Zotero's own
		// server drops requests that carry an Origin header, so a web page cannot reach it; the check below repeats that.
		const apply = this;
		const Endpoint = function () {};
		Endpoint.prototype = {
			supportedMethods: ["POST"],
			supportedDataTypes: ["application/json"],
			permitBookmarklet: false,
			async init(req) {
				if (req.headers?.Origin || req.headers?.origin) return [403, "application/json", JSON.stringify({ error: "not allowed" })];
				const ids = Array.isArray(req.data?.ids) ? req.data.ids.filter((id) => typeof id === "string") : [];
				return [200, "application/json", JSON.stringify({ results: await apply.run(ids) })];
			},
		};
		this.endpoint = Endpoint;
		Zotero.Server.Endpoints[SecondBrain.PendingAdds.APPLY_PATH] = Endpoint;
	}

	stop() {
		clearTimeout(this.first);
		clearInterval(this.timer);
		if (Zotero.Server.Endpoints[SecondBrain.PendingAdds.APPLY_PATH] === this.endpoint) delete Zotero.Server.Endpoints[SecondBrain.PendingAdds.APPLY_PATH];
	}

	/** Applies the queued entries (only those in `only` when given) one run at a time; resolves to [{id, ok, key?, message?}]. */
	run(only) {
		this.last = (this.last ?? Promise.resolve()).then(() => this.runNow(only));
		return this.last;
	}

	async runNow(only) {
		const results = [];
		let entries;
		try {
			entries = await this.sb.api("/zotero/pending-adds");
		} catch (error) {
			return results; // server not running; try again next time
		}
		const finished = [];
		for (const entry of entries.filter((e) => !only || only.includes(e.id))) {
			try {
				const item = await this.apply(entry);
				finished.push(entry.id);
				results.push({ id: entry.id, ok: true, key: item.key, ...(item.already ? { already: true } : {}) });
			} catch (error) {
				Zotero.logError(error);
				const message = String(error?.message ?? error);
				results.push({ id: entry.id, ok: false, message });
				await this.sb.post("/zotero/pending-adds/attempt", { id: entry.id, message }).catch(() => {});
			}
		}
		if (finished.length) await this.sb.post("/zotero/pending-adds/done", { ids: finished });
		return results;
	}

	async apply(entry) {
		if (entry.kind === "annotation") return this.annotate(entry);
		if (entry.kind === "attach") return this.attach(entry);
		const libraryID = Zotero.Libraries.userLibraryID;
		const paper = entry.paper ?? { title: entry.title, doi: entry.doi };
		paper.authors ??= [];
		let item = (entry.key && Zotero.Items.getByLibraryAndKey(libraryID, entry.key)) || (await this.find(paper));
		if (!item && entry.kind !== "add") throw new Error(`not in the library: ${paper.title ?? paper.doi ?? entry.key}`);
		const collection = (entry.collection && Zotero.Collections.getByLibraryAndKey(libraryID, entry.collection))
			|| (entry.collection_name ? await SecondBrain.PendingAdds.collectionNamed(entry.collection_name) : null);
		if (entry.collection && !collection) Zotero.debug(`Second Brain: collection ${entry.collection} is gone; adding without it`);
		if (!item) {
			const discover = new SecondBrain.Discover(this.sb);
			item = await discover.add(paper, { collections: collection ? [collection.id] : [] });
		}
		let changed = false;
		if (collection && !item.inCollection(collection.id)) {
			item.addToCollection(collection.id);
			changed = true;
		}
		if (entry.tag && !item.hasTag(entry.tag)) {
			item.addTag(entry.tag);
			changed = true;
		}
		if (changed) await item.saveTx();
		return item;
	}

	/** The top-level collection with this name in the user's library, made when there is none (a liked paper's
	 *  "To classify", where it waits to be filed). */
	static async collectionNamed(name) {
		const libraryID = Zotero.Libraries.userLibraryID;
		const found = Zotero.Collections.getByLibrary(libraryID).find((c) => !c.deleted && !c.parentID && c.name === name);
		if (found) return found;
		const collection = new Zotero.Collection();
		collection.libraryID = libraryID;
		collection.name = name;
		await collection.saveTx();
		return collection;
	}

	/** Saves a highlight from the web reader on its PDF; the annotation item, or the one an earlier attempt saved. */
	async annotate({ key, annotation }) {
		const libraryID = Zotero.Libraries.userLibraryID;
		const attachment = Zotero.Items.getByLibraryAndKey(libraryID, key);
		if (!attachment || attachment.deleted || !attachment.isPDFAttachment()) throw new Error(`no PDF attachment ${key} in the library`);
		// already saved (the server never heard back): leave it, the user may have edited it in Zotero since
		const saved = Zotero.Items.getByLibraryAndKey(libraryID, annotation.key);
		if (saved) return saved;
		return Zotero.Annotations.saveFromJSON(attachment, {
			key: annotation.key,
			type: annotation.type,
			text: annotation.text,
			comment: annotation.comment,
			color: annotation.color,
			pageLabel: annotation.pageLabel,
			sortIndex: annotation.sortIndex,
			position: annotation.position,
			tags: [],
		});
	}

	/** Attaches a PDF saved in Browse under its paper's item (added first when missing); {key, already?}. An item that
	 *  already has this very file (same MD5) is left as it is; any other PDF it has stays, and this one is added beside
	 *  it as "Publisher PDF". */
	async attach(entry) {
		const paper = { title: entry.title, doi: entry.doi, authors: [] };
		const item = (await this.find(paper)) || (await new SecondBrain.Discover(this.sb).add(paper, { collections: [] }));
		for (const id of item.getAttachments()) {
			const existing = Zotero.Items.get(id);
			if (existing && !existing.deleted && existing.isPDFAttachment() && (await existing.attachmentHash) === entry.md5) {
				return { key: existing.key, already: true };
			}
		}
		const response = await Zotero.HTTP.request("GET", `${this.sb.server}/zotero/pending-adds/file?id=${encodeURIComponent(entry.id)}`, {
			headers: this.sb.serverHeaders(), responseType: "arraybuffer", timeout: 120000, successCodes: false,
		});
		if (response.status !== 200 || !response.response) throw new Error("the PDF is no longer on the server");
		const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "sb-attach");
		const name = `${String(entry.doi || entry.title || "paper").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)}.pdf`;
		const file = PathUtils.join(dir, name);
		try {
			await IOUtils.write(file, new Uint8Array(response.response));
			const made = await Zotero.Attachments.importFromFile({ file, parentItemID: item.id, title: "Publisher PDF", contentType: "application/pdf" });
			if (entry.url) {
				made.setField("url", entry.url);
				await made.saveTx();
			}
			return { key: made.key };
		} finally {
			await IOUtils.remove(dir, { recursive: true }).catch(() => {});
		}
	}

	/** The library item with this DOI or title, searched fresh: the connector may have saved it a moment ago. */
	async find({ doi, title }) {
		const wantedDOI = String(doi ?? "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();
		const byField = async (field, value, same) => {
			if (!value) return null;
			const search = new Zotero.Search();
			search.libraryID = Zotero.Libraries.userLibraryID;
			search.addCondition(field, "contains", value); // LIKE: case-insensitive, then compared exactly below
			search.addCondition("itemType", "isNot", "attachment");
			search.addCondition("itemType", "isNot", "note");
			search.addCondition("itemType", "isNot", "annotation");
			for (const item of await Zotero.Items.getAsync(await search.search())) {
				if (!item.deleted && same(item)) return item;
			}
			return null;
		};
		const wanted = this.sb.normalizeTitle(title ?? "");
		return (await byField("DOI", wantedDOI, (item) => (item.getField("DOI") || "").toLowerCase() === wantedDOI))
			|| (await byField("title", title, (item) => this.sb.normalizeTitle(item.getField("title")) === wanted));
	}
};
