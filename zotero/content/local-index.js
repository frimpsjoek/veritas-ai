/* global Zotero, IOUtils, PathUtils, Services, Cc, Ci, Cu, SecondBrain */
// Similar papers and meaning-based search without the Second Brain server: the same model the server uses
// (snowflake-arctic-embed-s, here the int8 ONNX build) runs inside Zotero on onnxruntime-web. The model is
// downloaded once from the project's GitHub release into Zotero's data directory; each paper's title and abstract
// become one vector, kept in second-brain/index/ and updated as items change.

SecondBrain.LocalIndex = class {
	static RELEASE = "https://github.com/frimpsjoek/zotero-second-brain/releases/download/model-arctic-s-v1/";
	static FILES = [
		// [path under second-brain/, release asset name, sha256, bytes, fallback URL]
		["model/config.json", "config.json", "4e519aa92ec40943356032afe458c8829d70c5766b109e4a57490b82f72dcfb7", 703,
			"https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/config.json"],
		["model/tokenizer.json", "tokenizer.json", "91f1def9b9391fdabe028cd3f3fcc4efd34e5d1f08c3bf2de513ebb5911a1854", 711649,
			"https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/tokenizer.json"],
		["model/tokenizer_config.json", "tokenizer_config.json", "9ca59277519f6e3692c8685e26b94d4afca2d5438deff66483db495e48735810", 1433,
			"https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/tokenizer_config.json"],
		["model/special_tokens_map.json", "special_tokens_map.json", "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a", 695,
			"https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/special_tokens_map.json"],
		["model/onnx/model_quantized.onnx", "model_quantized.onnx", "f93ff225320628d2e88baf2a395cae791b0e3b27edf5c70bf7b312a4d3260c14", 34015111,
			"https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/onnx/model_quantized.onnx"],
		["runtime/ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.mjs", "43c25054b6b9ac000f786c65545ff83a45f871e0e310e8c2f4d48a363bb66db4", 20856,
			"https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/ort-wasm-simd-threaded.mjs"],
		["runtime/ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.wasm", "f061472c6e77d6d50d079aacdc0ff9b63fee287ddd2cbf46cf62438d3891de2b", 11133407,
			"https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/ort-wasm-simd-threaded.wasm"],
	];
	static DIM = 384;
	static VERSION = 1; // bump when the text that goes into a vector changes

	constructor(sb) {
		this.sb = sb;
		this.dir = PathUtils.join(Zotero.DataDirectory.dir, "second-brain");
		this.state = "absent"; // absent | downloading | loading | indexing | ready | error
		this.detail = "";
		this.keys = [];
		this.hashes = [];
		this.vectors = new Float32Array(0);
		this.listeners = new Set();
	}

	get totalBytes() { return SecondBrain.LocalIndex.FILES.reduce((sum, f) => sum + f[3], 0); }

	setState(state, detail = "") {
		this.state = state;
		this.detail = detail;
		for (const listener of this.listeners) try { listener(state, detail); } catch (error) { /* a closed settings page */ }
	}

	async installed() {
		for (const [path, , , size] of SecondBrain.LocalIndex.FILES) {
			const full = PathUtils.join(this.dir, ...path.split("/"));
			if (!(await IOUtils.exists(full)) || (await IOUtils.stat(full)).size !== size) return false;
		}
		return true;
	}

	/** Start at launch if the model is already here; otherwise wait for the user to download it. */
	/** At launch: load the saved vectors (enough for similar papers). The model itself only starts when it has
	 *  work: reading new papers while the Second Brain server is off, or a search by meaning. While the server
	 *  runs, it indexes the same library, so this one waits and catches up later instead of doubling the work. */
	async start() {
		if (!(await this.installed())) return;
		this.installedFiles = true;
		await this.readIndex();
		if (this.keys.length) this.setState("ready", `${this.keys.length} papers`);
		this.stale = true;
		this.updateSoon();
	}

	fail(error) {
		Zotero.logError(error);
		this.setState("error", String(error?.message ?? error));
	}

	// ------------------------------------------------------------------ download

	async download() {
		if (["downloading", "loading", "indexing"].includes(this.state)) return;
		const base = (Zotero.Prefs.get("extensions.secondbrain.modelBase", true) || SecondBrain.LocalIndex.RELEASE).replace(/\/?$/, "/");
		let done = 0;
		try {
			for (const [path, asset, sha256, size, fallback] of SecondBrain.LocalIndex.FILES) {
				const full = PathUtils.join(this.dir, ...path.split("/"));
				if (await IOUtils.exists(full) && (await IOUtils.stat(full)).size === size) { done += size; continue; }
				let bytes = null;
				for (const url of [base + asset, fallback]) {
					try {
						bytes = await this.fetch(url, (loaded) => this.setState("downloading", this.percent(done + loaded)));
						if (bytes.byteLength === size && (await this.sha256(bytes)) === sha256) break;
						bytes = null;
					} catch (error) {
						bytes = null;
					}
				}
				if (!bytes) throw new Error(`couldn't download ${asset}`);
				await IOUtils.makeDirectory(PathUtils.parent(full), { createAncestors: true });
				await IOUtils.write(full, bytes, { tmpPath: full + ".part" });
				done += size;
				this.setState("downloading", this.percent(done));
			}
		} catch (error) {
			return this.fail(error);
		}
		this.installedFiles = true;
		this.setState("loading");
		await this.open().catch((error) => this.fail(error));
	}

	percent(bytes) { return `${Math.floor((bytes / this.totalBytes) * 100)}%`; }

	async fetch(url, onProgress) {
		const response = await Zotero.HTTP.request("GET", url, {
			responseType: "arraybuffer", timeout: 600000,
			requestObserver: (xhr) => { xhr.onprogress = (event) => onProgress(event.loaded); },
		});
		return new Uint8Array(response.response);
	}

	async sha256(bytes) {
		const digest = await Zotero.getMainWindow().crypto.subtle.digest("SHA-256", bytes);
		return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	}

	async remove() {
		this.close();
		await IOUtils.remove(PathUtils.join(this.dir, "model"), { recursive: true, ignoreAbsent: true });
		await IOUtils.remove(PathUtils.join(this.dir, "runtime"), { recursive: true, ignoreAbsent: true });
		await IOUtils.remove(PathUtils.join(this.dir, "index"), { recursive: true, ignoreAbsent: true });
		this.keys = [];
		this.hashes = [];
		this.vectors = new Float32Array(0);
		this.index = null;
		this.installedFiles = false;
		this.setState("absent");
	}

	// ------------------------------------------------------------------ the engine page

	async open() {
		await this.readIndex();
		this.update().catch((error) => this.fail(error));
	}

	async ensureEngine() {
		if (this.engine) return;
		this.starting ??= this.openEngine().finally(() => { this.starting = null; });
		await this.starting;
	}

	async openEngine() {
		const resource = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
		resource.setSubstitution("second-brain-data", Services.io.newFileURI(Zotero.File.pathToFile(this.dir)));
		const win = Zotero.getMainWindow();
		this.frame?.remove();
		this.frame = win.document.createXULElement("iframe");
		this.frame.setAttribute("src", "chrome://second-brain/content/engine.html");
		this.frame.setAttribute("style", "width: 0; height: 0; visibility: collapse; position: fixed;");
		// a XUL iframe reports DOMContentLoaded (not load) to its embedder; engine.js runs before it fires
		const loaded = new Promise((resolve) => this.frame.addEventListener("DOMContentLoaded", resolve, { once: true }));
		win.document.documentElement.append(this.frame);
		await loaded;
		this.window = this.frame.contentWindow;
		this.engine = this.window.SecondBrainEngine;
		await this.engine.load("resource://second-brain-data/", 1);
	}

	/** Stop the model's workers and free their memory; the vectors stay loaded. */
	closeEngine() {
		this.frame?.remove();
		this.frame = null;
		this.engine = null;
	}

	close() {
		clearTimeout(this.updateTimer);
		this.frame?.remove();
		this.frame = null;
		this.engine = null;
		try {
			const resource = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
			resource.setSubstitution("second-brain-data", null);
		} catch (error) { /* already gone */ }
	}

	async embed(texts, query = false) {
		await this.ensureEngine();
		const vectors = await this.engine.embed(Cu.cloneInto(texts, this.window), query);
		return vectors.map((v) => Float32Array.from(v)); // copy out of the engine page's compartment
	}

	// ------------------------------------------------------------------ the index

	text(item) {
		const abstract = (item.getField("abstractNote") || "").replace(/\s+/g, " ").trim();
		return `${item.getField("title")}\n\n${abstract}`.slice(0, 1200);
	}

	async readIndex() {
		const folder = PathUtils.join(this.dir, "index");
		try {
			const meta = await IOUtils.readJSON(PathUtils.join(folder, "meta.json"));
			if (meta.version !== SecondBrain.LocalIndex.VERSION) return;
			const bytes = await IOUtils.read(PathUtils.join(folder, "vectors.bin"));
			this.vectors = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
			this.keys = meta.keys;
			this.hashes = meta.hashes;
			this.calibration = meta.calibration;
			this.index = new Map(this.keys.map((key, i) => [key, i]));
		} catch (error) { /* first run */ }
	}

	async writeIndex() {
		const folder = PathUtils.join(this.dir, "index");
		await IOUtils.makeDirectory(folder, { createAncestors: true });
		await IOUtils.write(PathUtils.join(folder, "vectors.bin"), new Uint8Array(this.vectors.buffer, 0, this.keys.length * SecondBrain.LocalIndex.DIM * 4));
		await IOUtils.writeJSON(PathUtils.join(folder, "meta.json"),
			{ version: SecondBrain.LocalIndex.VERSION, keys: this.keys, hashes: this.hashes, calibration: this.calibration });
	}

	/** Embed papers that are new or changed, drop ones that are gone. Runs in small batches so Zotero stays responsive. */
	async update() {
		if (this.updating || !this.installedFiles) return;
		this.updating = true;
		try {
			const DIM = SecondBrain.LocalIndex.DIM;
			const all = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true);
			await Zotero.Items.loadDataTypes(all, ["itemData"]);
			const items = all.filter((item) => item.isRegularItem() && !item.deleted);
			const wanted = new Map(items.map((item) => [item.key, item]));
			const texts = new Map(items.map((item) => [item.key, this.text(item)]));
			const old = new Map(this.keys.map((key, i) => [key, i]));
			const keys = [];
			const hashes = [];
			const vectors = new Float32Array(items.length * DIM);
			const todo = [];
			for (const [key] of wanted) {
				const hash = SecondBrain.hashText(texts.get(key));
				const i = old.get(key);
				const row = keys.length;
				keys.push(key);
				hashes.push(hash);
				if (i !== undefined && this.hashes[i] === hash) vectors.set(this.vectors.subarray(i * DIM, (i + 1) * DIM), row * DIM);
				else todo.push(row);
			}
			const changed = todo.length > 0 || keys.length !== this.keys.length;
			todo.sort((a, b) => texts.get(keys[a]).length - texts.get(keys[b]).length); // batches of similar length pad less
			if (todo.length) {
				this.setState("indexing", `0 of ${todo.length} papers`);
				await this.ensureEngine();
			}
			// a whole library is read by several workers at once, then it drops back to one for searching
			const cores = Zotero.getMainWindow().navigator.hardwareConcurrency || 2;
			if (todo.length > 100) await this.engine?.resize(Math.max(1, Math.min(4, Math.floor(cores / 2))));
			try {
				const step = 8 * (this.engine?.size ?? 1);
				for (let n = 0; n < todo.length; n += step) {
					const batch = todo.slice(n, n + step);
					const out = await this.embed(batch.map((row) => texts.get(keys[row])));
					batch.forEach((row, j) => vectors.set(out[j], row * DIM));
					this.setState("indexing", `${Math.min(n + step, todo.length)} of ${todo.length} papers`);
				}
			} finally {
				await this.engine?.resize(1);
				// with the server running, searches go to it; don't keep the model's memory for nothing
				if (this.sb.online) this.closeEngine();
			}
			this.keys = keys;
			this.hashes = hashes;
			this.vectors = vectors;
			this.index = new Map(keys.map((key, i) => [key, i]));
			if (changed || !this.calibration) {
				this.calibration = this.calibrate();
				await this.writeIndex();
			}
			this.setState("ready", `${keys.length} papers`);
		} finally {
			this.updating = false;
		}
	}

	/** Library changed: catch up now if the server is off, otherwise remember and catch up when it goes off. */
	updateSoon() {
		if (!this.installedFiles) return;
		if (this.sb.online && this.keys.length) {
			this.stale = true;
			return;
		}
		this.stale = false;
		clearTimeout(this.updateTimer);
		this.updateTimer = setTimeout(() => this.update().catch((error) => this.fail(error)), 15000);
	}

	/** How similar two unrelated papers are in this library, so scores can be graded the same way anywhere. */
	calibrate() {
		const DIM = SecondBrain.LocalIndex.DIM;
		const n = this.keys.length;
		if (n < 20) return null;
		const scores = new Float32Array(100000);
		for (let s = 0; s < scores.length; s++) {
			const a = Math.floor(Math.random() * n) * DIM;
			let b = Math.floor(Math.random() * n) * DIM;
			if (a === b) b = ((b / DIM + 1) % n) * DIM;
			let dot = 0;
			for (let d = 0; d < DIM; d++) dot += this.vectors[a + d] * this.vectors[b + d];
			scores[s] = dot;
		}
		scores.sort();
		const at = (p) => scores[Math.min(scores.length - 1, Math.floor(p * scores.length))];
		return { p50: at(0.5), p90: at(0.9), p99: at(0.99), p999: at(0.999), p9999: at(0.9999) };
	}

	scores(vector) {
		const DIM = SecondBrain.LocalIndex.DIM;
		const out = new Float32Array(this.keys.length);
		for (let i = 0; i < out.length; i++) {
			let dot = 0;
			const base = i * DIM;
			for (let d = 0; d < DIM; d++) dot += this.vectors[base + d] * vector[d];
			out[i] = dot;
		}
		return out;
	}

	top(scores, limit, skip = -1) {
		const order = [...scores.keys()].filter((i) => i !== skip).sort((a, b) => scores[b] - scores[a]).slice(0, limit);
		return order.map((i) => ({ key: this.keys[i], score: scores[i] }));
	}

	get ready() { return this.keys.length > 0 && !!this.index && ["ready", "indexing", "loading"].includes(this.state); }

	/** The server just went away: read whatever changed in the library meanwhile. */
	serverGone() {
		if (this.stale) this.updateSoon();
	}

	similar(key, limit = 10) {
		const i = this.index?.get(key);
		if (i === undefined) return [];
		const DIM = SecondBrain.LocalIndex.DIM;
		return this.top(this.scores(this.vectors.subarray(i * DIM, (i + 1) * DIM)), limit, i);
	}

	async search(query, limit = 30) {
		const [vector] = await this.embed([query], true);
		return this.top(this.scores(vector), limit);
	}
};
