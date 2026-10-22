// @ts-check
// agent-src/src/local/memory.js (spec 010 §3). A plain-language "is there room for this model?" check from `vm_stat`,
// run through platform.spawn so the sidecar and Zotero's in-process engine behave the same. A failed read never blocks.

const GB = 1024 ** 3;

/** @param {string} text vm_stat output @returns {{ pageSize: number, free: number, inactive: number, speculative: number, purgeable: number } | null} */
export function parseVmStat(text) {
  const size = /page size of (\d+) bytes/.exec(text);
  if (!size) return null;
  const pages = (label) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  return { pageSize: Number(size[1]), free: pages('free'), inactive: pages('inactive'), speculative: pages('speculative'), purgeable: pages('purgeable') };
}

/** Bytes the system can hand out without swapping much: free + inactive + speculative + purgeable pages. Inactive
 *  pages are only as good as the swap left to push them into: with swap nearly full (one 2026-10-11 evening: 15 of
 *  16 GB) a model "fits" on paper and then loads into compressed memory for minutes, so they count up to `swapFree`.
 *  @param {string} text @param {number | null} [swapFree] bytes of swap still free, null when unknown @returns {number | null} */
export function availableFromVmStat(text, swapFree = null) {
  const v = parseVmStat(text);
  if (!v) return null;
  const inactive = v.inactive * v.pageSize;
  return (v.free + v.speculative + v.purgeable) * v.pageSize + (swapFree == null ? inactive : Math.min(inactive, swapFree));
}

/** "total = 16384.00M  used = 15076.38M  free = 1307.62M  (encrypted)" -> free bytes. @param {string} text @returns {number | null} */
export function swapFreeFrom(text) {
  const m = /free = ([\d.]+)([KMG])/.exec(text);
  return m ? Math.round(Number(m[1]) * { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[/** @type {'K'|'M'|'G'} */ (m[2])]) : null;
}

/** @param {Pick<import("../platform").Platform, "spawn">} platform @param {string} cmd @param {string[]} args */
async function readCommand(platform, cmd, args) {
  const child = await platform.spawn({ cmd, args, env: {}, cwd: '/' });
  let text = '';
  for await (const line of child.lines()) text += `${line}\n`;
  return text;
}

/** @param {Pick<import("../platform").Platform, "spawn">} platform @returns {Promise<number | null>} null when it cannot be read */
export async function availableBytes(platform) {
  try {
    const swap = await readCommand(platform, '/usr/sbin/sysctl', ['-n', 'vm.swapusage']).then(swapFreeFrom, () => null);
    return availableFromVmStat(await readCommand(platform, '/usr/bin/vm_stat', []), swap);
  } catch { return null; }
}

/** What loading a model of this size needs: the weights plus ~20% and 0.6 GB of working space. @param {number} modelBytes */
export function neededBytes(modelBytes) { return Math.round(modelBytes * 1.2 + 0.6 * GB); }

const gb = (n) => `${(n / GB).toFixed(1)} GB`;

/**
 * @param {{ label: string, modelBytes: number | null, availableBytes: number | null }} args
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function memoryVerdict({ label, modelBytes, availableBytes: avail }) {
  if (modelBytes == null || avail == null) return { ok: true };
  const need = neededBytes(modelBytes);
  if (need <= avail) return { ok: true };
  return { ok: false, message: `There isn't enough free memory to open ${label} (it needs about ${gb(need)}, about ${gb(avail)} is free). Close some apps and try again.` };
}
