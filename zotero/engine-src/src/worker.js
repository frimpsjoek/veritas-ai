// One copy of the model on its own thread. engine.js keeps a few of these and splits each batch between them:
// WebAssembly here runs one thread per worker (no SharedArrayBuffer), so parallel workers are the speed-up.
import { pipeline, env } from "@huggingface/transformers";

const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
let extract = null;

self.onmessage = async ({ data }) => {
	const { id, type } = data;
	try {
		if (type === "load") {
			const base = data.base;
			env.allowRemoteModels = false;
			env.allowLocalModels = true;
			env.useBrowserCache = false;
			env.localModelPath = base;
			env.backends.onnx.wasm.numThreads = 1;
			env.backends.onnx.wasm.proxy = false;
			env.backends.onnx.wasm.wasmPaths = { mjs: base + "runtime/ort-wasm-simd-threaded.mjs", wasm: base + "runtime/ort-wasm-simd-threaded.wasm" };
			extract = await pipeline("feature-extraction", "model", { dtype: data.dtype || "q8", device: "wasm" });
			self.postMessage({ id, ok: true });
		} else if (type === "embed") {
			const input = data.query ? data.texts.map((t) => QUERY_PREFIX + t) : data.texts;
			const out = await extract(input, { pooling: "cls", normalize: true });
			const [n, dim] = out.dims;
			const vectors = Array.from({ length: n }, (_, i) => out.data.slice(i * dim, (i + 1) * dim));
			self.postMessage({ id, ok: true, vectors }, vectors.map((v) => v.buffer));
		}
	} catch (error) {
		self.postMessage({ id, ok: false, error: String(error?.message ?? error) });
	}
};
