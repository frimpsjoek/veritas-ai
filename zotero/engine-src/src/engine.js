// The search model inside Zotero: snowflake-arctic-embed-s (int8 ONNX) on onnxruntime-web, in a small pool of
// workers started from a hidden chrome page (engine.html). Model files are downloaded into Zotero's data
// directory and served under resource://second-brain-data/, so nothing is fetched from the network here.
let workers = [];
let base = null;
let dtype = "q8";
let next = 0;
const pending = new Map();

function start() {
	const worker = new Worker("engine-worker.js");
	worker.onmessage = ({ data }) => {
		const job = pending.get(data.id);
		pending.delete(data.id);
		if (data.ok) job.resolve(data.vectors);
		else job.reject(new Error(data.error));
	};
	return worker;
}

function call(worker, message) {
	const id = ++next;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject, worker });
		worker.postMessage({ ...message, id });
	});
}

window.SecondBrainEngine = {
	/** Start `count` workers (one is enough for searching; more while a whole library is being read). */
	async load(url, count = 1, type = "q8") {
		base = url;
		dtype = type;
		await this.resize(count);
	},

	async resize(count) {
		while (workers.length > count) {
			const worker = workers.pop();
			worker.terminate();
			// a terminated worker never answers; fail its jobs instead of leaving them waiting
			for (const [id, job] of pending) if (job.worker === worker) { pending.delete(id); job.reject(new Error("worker stopped")); }
		}
		const added = [];
		while (workers.length + added.length < count) added.push(start());
		await Promise.all(added.map((worker) => call(worker, { type: "load", base, dtype })));
		workers.push(...added);
	},

	get size() { return workers.length; },

	/** Unit vectors (CLS pooling), one Float32Array per text, split across the workers. */
	async embed(texts, query = false) {
		if (!workers.length) throw new Error("model not loaded");
		const share = Math.ceil(texts.length / workers.length);
		const parts = await Promise.all(workers.map((worker, i) => {
			const slice = texts.slice(i * share, (i + 1) * share);
			return slice.length ? call(worker, { type: "embed", texts: slice, query }) : [];
		}));
		return parts.flat();
	},
};
