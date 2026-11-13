import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { config } from '../config.js';
import { logger } from '../lib/log.js';
import { countyStore } from './counties.js';
import { measureStore } from './measures.js';
import { stateRaceStore } from './stateRaces.js';
import { store } from './store.js';

/**
 * Saved data, all in DATA_DIR:
 *   state.json     races (every provider's inputs), news, seats history, measures, markets, ratings
 *   counties.json  county-level results per race (several MB; written only when changed)
 *   statewide.json the Statewide view's other offices and local races (written only when changed)
 *   backups/       gzip snapshots of those files: one at startup, then hourly, newest BACKUP_KEEP kept
 *
 * A file that exists but can't be parsed is renamed aside (`<name>.unreadable-<time>`) rather than
 * left for the next autosave to overwrite with the empty state the server started with; one that
 * can't be read at all (permissions) is never written over.
 */
const log = logger('persist');
const FILES = ['state.json', 'counties.json', 'statewide.json'] as const;
type DataFile = (typeof FILES)[number];
const file = (name: DataFile) => path.join(config.dataDir, name);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Files that exist but couldn't be read (not a parse error): never written over. */
const doNotWrite = new Set<DataFile>();

/** Read and apply one data file. False if it doesn't exist or was set aside as unreadable. */
async function readData<T>(name: DataFile, apply: (data: T) => void): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(file(name), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    doNotWrite.add(name);
    log.error(`could not read ${name}; starting without it and NOT saving over it (fix the file's permissions and restart)`, err);
    return false;
  }
  try {
    apply(JSON.parse(raw) as T);
    return true;
  } catch (err) {
    const aside = `${file(name)}.unreadable-${stamp()}`;
    try {
      await rename(file(name), aside);
      log.error(`${name} could not be loaded; moved it to ${path.basename(aside)} and started without it`, err);
    } catch (renameErr) {
      doNotWrite.add(name);
      log.error(`${name} could not be loaded or moved aside; starting without it and NOT saving over it`, renameErr);
    }
    return false;
  }
}

/** Load the last saved state so a restart keeps results, news, history and county data. */
export async function loadState() {
  await backupNow('startup');
  type StateFile = ReturnType<typeof store.toPersisted> & { measureState?: ReturnType<typeof measureStore.toPersisted> };
  if (
    await readData<StateFile>('state.json', (p) => {
      store.loadPersisted(p);
      measureStore.loadPersisted(p.measureState);
    })
  )
    log.info(`restored state from ${file('state.json')}`);
  if (await readData<Parameters<typeof countyStore.loadPersisted>[0]>('counties.json', (p) => countyStore.loadPersisted(p)))
    log.info(`restored county results for ${countyStore.size} races`);
  if (await readData<Parameters<typeof stateRaceStore.loadPersisted>[0]>('statewide.json', (p) => stateRaceStore.loadPersisted(p)))
    log.info(`restored statewide races for ${stateRaceStore.size} states`);
}

async function writeAtomic(name: DataFile, data: unknown) {
  if (doNotWrite.has(name)) return;
  const tmp = `${file(name)}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file(name)); // atomic replace
}

let saving = false;
export async function saveState() {
  if (saving) return;
  saving = true;
  try {
    await mkdir(config.dataDir, { recursive: true });
    await writeAtomic('state.json', { ...store.toPersisted(), measureState: measureStore.toPersisted() });
    if (countyStore.dirty) {
      countyStore.dirty = false;
      await writeAtomic('counties.json', countyStore.toPersisted());
    }
    if (stateRaceStore.dirty) {
      stateRaceStore.dirty = false;
      await writeAtomic('statewide.json', stateRaceStore.toPersisted());
    }
  } catch (err) {
    log.warn('save failed', err);
  } finally {
    saving = false;
  }
}

// ------------------------------------------------------------------ backups

const backupDir = () => path.join(config.dataDir, 'backups');

/** Gzip a snapshot of each data file into backups/, then keep only the newest BACKUP_KEEP per file. */
export async function backupNow(reason: string) {
  if (config.backups.keep <= 0) return;
  try {
    await mkdir(backupDir(), { recursive: true });
    const when = stamp();
    let n = 0;
    for (const name of FILES) {
      const src = file(name);
      const info = await stat(src).catch(() => null);
      if (!info?.size) continue;
      const base = name.replace(/\.json$/, '');
      await pipeline(createReadStream(src), createGzip(), createWriteStream(path.join(backupDir(), `${base}-${when}.json.gz`)));
      n++;
      // Prune: the ISO stamp sorts by time, so the oldest come first.
      const mine = (await readdir(backupDir())).filter((f) => f.startsWith(`${base}-`) && f.endsWith('.json.gz')).sort();
      for (const old of mine.slice(0, Math.max(0, mine.length - config.backups.keep))) await unlink(path.join(backupDir(), old)).catch(() => {});
    }
    if (n) log.info(`backed up ${n} data file(s) to ${backupDir()} (${reason})`);
  } catch (err) {
    log.warn('backup failed', err);
  }
}

export function startAutosave(intervalMs = 30_000) {
  if (config.backups.keep > 0) setInterval(() => void backupNow('hourly'), config.backups.intervalMs).unref();
  return setInterval(() => void saveState(), intervalMs);
}
