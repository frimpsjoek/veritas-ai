// Builds a throwaway folder tree of fake model folders for the local-model tests (spec 010). Files are tiny stand-ins:
// the discovery code reads config.json / tokenizer_config.json and stats the .safetensors files, nothing more.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function makeRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sb-local-models-'));
}

/** Removes a root made by makeRoot, and nothing else: the path must be a direct child of the OS temp dir with our prefix. */
export async function removeRoot(root) {
  if (typeof root !== 'string' || path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('sb-local-models-')) {
    throw new Error(`refusing to remove ${String(root)}`);
  }
  await fsp.rm(root, { recursive: true, force: true });
}

/**
 * @param {string} dir the model folder
 * @param {{ arch?: string, template?: boolean | 'file', weights?: number | null, config?: boolean }} [opts]
 */
export async function writeModel(dir, { arch = 'Qwen3ForCausalLM', template = true, weights = 4096, config = true } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  if (config) await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({ architectures: [arch], model_type: 'qwen3' }));
  await fsp.writeFile(path.join(dir, 'tokenizer_config.json'), JSON.stringify(template === true ? { chat_template: '{{ messages }}' } : {}));
  if (template === 'file') await fsp.writeFile(path.join(dir, 'chat_template.jinja'), '{{ messages }}');
  if (weights != null) await fsp.writeFile(path.join(dir, 'model.safetensors'), Buffer.alloc(weights));
}
