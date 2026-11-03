import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../lib/log.js';
import { measureStore } from './measures.js';
import { store } from './store.js';

const log = logger('persist');
const file = () => path.join(config.dataDir, 'state.json');

/** Load the last saved state so a restart mid-night keeps news history, BoP history and data. */
export async function loadState() {
  try {
    const raw = await readFile(file(), 'utf8');
    const parsed = JSON.parse(raw);
    store.loadPersisted(parsed);
    measureStore.loadPersisted(parsed.measureState);
    log.info(`restored state from ${file()}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('could not restore state', err);
  }
}

let saving = false;
export async function saveState() {
  if (saving) return;
  saving = true;
  try {
    await mkdir(config.dataDir, { recursive: true });
    const tmp = `${file()}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...store.toPersisted(), measureState: measureStore.toPersisted() }));
    await rename(tmp, file()); // atomic replace
  } catch (err) {
    log.warn('save failed', err);
  } finally {
    saving = false;
  }
}

export function startAutosave(intervalMs = 30_000) {
  return setInterval(() => void saveState(), intervalMs);
}
