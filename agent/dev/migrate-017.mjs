#!/usr/bin/env node
// agent-src/dev/migrate-017.mjs. Spec 017 K5 (D5 a): fold the weekly "equivariant networks for molecules" search into the
// daily reading radar as a user topic, and retire the weekly routine. Run once with agentd stopped:
//   node agent-src/dev/migrate-017.mjs <routinesDir>
// Both files are copied to <routinesDir>/../routines.bak-017/ first (an existing backup is never overwritten). Running it
// again changes nothing.
import { readFile, writeFile, mkdir, copyFile, access, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { phraseKey } from '../src/radar-phrases.js';

export const RADAR_ID = '01M4NT2MDKC3FK0QVP0GAF3V6B';
export const WEEKLY_ID = '01M4CC03Q3WGPK8ST9DNJKCPJB';
export const TOPIC = 'equivariant graph neural networks';

const exists = (p) => access(p).then(() => true, () => false);
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const writeJson = async (p, data) => { await writeFile(`${p}.tmp`, `${JSON.stringify(data, null, 2)}\n`); await rename(`${p}.tmp`, p); };

/** @param {string} dir the routines directory @param {{ now?: string }} [opts] @returns {Promise<{ changed: string[], backup: string }>} */
export async function migrate(dir, { now = new Date().toISOString() } = {}) {
  const radarFile = join(dir, `${RADAR_ID}.json`), weeklyFile = join(dir, `${WEEKLY_ID}.json`);
  for (const f of [radarFile, weeklyFile]) if (!(await exists(f))) throw new Error(`Missing ${f}. Nothing was changed.`);
  const radar = await readJson(radarFile), weekly = await readJson(weeklyFile);
  if (radar.kind !== 'radar' || !radar.radar?.profile?.topics) throw new Error(`${RADAR_ID} is not a reading radar. Nothing was changed.`);

  const needTopic = !radar.radar.profile.topics.some((t) => phraseKey(t.text) === phraseKey(TOPIC));
  const needRetire = weekly.status !== 'archived';
  const backup = resolve(dir, '..', 'routines.bak-017');
  if (!needTopic && !needRetire) return { changed: [], backup };

  await mkdir(backup, { recursive: true });
  for (const f of [radarFile, weeklyFile]) {
    const copy = join(backup, f.slice(dir.length + 1));
    if (!(await exists(copy))) await copyFile(f, copy);
  }
  const changed = [];
  if (needTopic) {
    radar.radar.profile.topics = [...radar.radar.profile.topics, { text: TOPIC, weight: 1, origin: 'user' }];
    radar.updated = now;
    await writeJson(radarFile, radar);
    changed.push(RADAR_ID);
  }
  if (needRetire) {
    weekly.status = 'archived';
    weekly.updated = now;
    await writeJson(weeklyFile, weekly);
    changed.push(WEEKLY_ID);
  }
  return { changed, backup };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir) { console.error('Usage: node migrate-017.mjs <routinesDir>'); process.exit(2); }
  migrate(resolve(dir)).then(
    (r) => console.log(r.changed.length ? `Changed ${r.changed.join(', ')}. Backup in ${r.backup}.` : 'Already migrated. Nothing changed.'),
    (e) => { console.error(String(e.message ?? e)); process.exit(1); },
  );
}
