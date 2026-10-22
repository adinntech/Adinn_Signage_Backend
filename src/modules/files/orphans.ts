import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env';
import { Project } from '../projects/project.model';
import { getStorageFor } from './storage';
import { sweepOrphanRecords } from '../projects/project.cascade';

/**
 * Only folders this module writes to are ever swept. The same bucket and database also hold other modules' files
 * (e.g. BD/Sales/...), which must never be mistaken for orphans.
 */
const OWNED = ['BD/Client_Details/', 'Recce/', 'Operations/'];
const owned = (key: string) => OWNED.some((p) => key.startsWith(p));

/** Every storage key some project still records (including hidden evidence, whose object is kept on purpose). */
export async function recordedKeys(): Promise<Set<string>> {
  const rows = await Project.aggregate<{ k: string }>([{ $unwind: '$files' }, { $project: { _id: 0, k: '$files.key' } }]);
  return new Set(rows.map((r) => r.k));
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

async function sweepLocal(recorded: Set<string>, cutoff: number, apply: boolean): Promise<string[]> {
  const root = path.resolve(process.cwd(), env.LOCAL_UPLOAD_PATH);
  const found: string[] = [];
  for (const f of await walk(root)) {
    const key = path.relative(root, f).split(path.sep).join('/');
    if (!owned(key) || recorded.has(key) || (await fs.stat(f)).mtimeMs > cutoff) continue;
    found.push(key);
    if (apply) await fs.rm(f, { force: true });
  }
  if (apply && found.length) {
    for (const d of (await fs.readdir(root, { recursive: true }).catch(() => [] as string[])).sort((x, y) => y.length - x.length)) await fs.rmdir(path.join(root, d)).catch(() => undefined);
  }
  return found;
}

const spacesConfigured = () => !!(env.DO_SPACES_BUCKET && env.DO_SPACES_ENDPOINT && env.DO_SPACES_REGION && env.DO_SPACES_KEY && env.DO_SPACES_SECRET);

async function sweepSpaces(recorded: Set<string>, cutoff: number, apply: boolean): Promise<string[]> {
  const c = new S3Client({ region: env.DO_SPACES_REGION!, endpoint: env.DO_SPACES_ENDPOINT!, credentials: { accessKeyId: env.DO_SPACES_KEY!, secretAccessKey: env.DO_SPACES_SECRET! } });
  const prefix = `${env.STORAGE_PREFIX}/`; // only this app's folder; other apps sharing the bucket are never touched
  const found: string[] = [];
  let token: string | undefined;
  do {
    const r = await c.send(new ListObjectsV2Command({ Bucket: env.DO_SPACES_BUCKET!, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) {
      if (!o.Key || !owned(o.Key.slice(prefix.length)) || recorded.has(o.Key.slice(prefix.length)) || (o.LastModified?.getTime() ?? 0) > cutoff) continue;
      found.push(o.Key);
    }
    token = r.NextContinuationToken;
  } while (token);
  if (apply) for (let i = 0; i < found.length; i += 500) await c.send(new DeleteObjectsCommand({ Bucket: env.DO_SPACES_BUCKET!, Delete: { Objects: found.slice(i, i + 500).map((Key) => ({ Key })) } }));
  return found;
}

/**
 * Stored files that no project records, e.g. after data was deleted straight from MongoDB. Looks in BOTH places files can
 * live (the local folder, and Spaces when it is configured), whatever STORAGE_TYPE is. Anything newer than `graceMs` is left
 * alone so a file that is being uploaded right now is never treated as an orphan. Deletes only when `apply` is true.
 * Automated tests never touch the real bucket.
 */
export async function sweepOrphans(opts: { apply: boolean; graceMs: number }): Promise<string[]> {
  const recorded = await recordedKeys();
  const cutoff = Date.now() - opts.graceMs;
  const found = await sweepLocal(recorded, cutoff, opts.apply);
  if (spacesConfigured() && env.NODE_ENV !== 'test') found.push(...(await sweepSpaces(recorded, cutoff, opts.apply)));
  return found;
}

/** Runs the clean-up on a timer when STORAGE_ORPHAN_CLEANUP_HOURS is above 0 (it is off by default). */
export function startOrphanCleanup(everyHours = env.STORAGE_ORPHAN_CLEANUP_HOURS) {
  if (!everyHours || everyHours <= 0) return undefined;
  const run = () =>
    void sweepOrphanRecords(true)
      .then((r) => Object.keys(r).length && console.log('Removed records of deleted projects:', r))
      .then(() => sweepOrphans({ apply: true, graceMs: env.STORAGE_ORPHAN_GRACE_MINUTES * 60_000 }))
      .then((f) => f.length && console.log(`Removed ${f.length} stored file(s) that no project records`))
      .catch((e) => console.error('orphan clean-up failed', e));
  run();
  const t = setInterval(run, everyHours * 60 * 60_000);
  t.unref();
  return t;
}

/** Everything left behind by deleted projects: their records first, then their stored files. */
export async function clearDeletedProjectLeftovers(): Promise<{ records: Record<string, number>; files: number }> {
  const records = await sweepOrphanRecords(true);
  const files = (await sweepOrphans({ apply: true, graceMs: env.STORAGE_ORPHAN_GRACE_MINUTES * 60_000 })).length;
  return { records, files };
}

/** Collection setting that lets a delete event carry the deleted document (MongoDB 6+). Needs permission to modify the collection. */
async function enablePreImages() {
  try {
    await mongoose.connection.db!.command({ collMod: Project.collection.collectionName, changeStreamPreAndPostImages: { enabled: true } });
    return true;
  } catch (e) {
    console.warn('Could not enable delete pre-images; Spaces files of directly deleted projects are not cleared on the spot:', (e as Error).message);
    return false;
  }
}

/** Erases the stored files listed in a deleted project's own document, from whichever storage each one was saved in. */
async function eraseFilesOf(files: { key: string; storage: 'local' | 'space' }[]) {
  let n = 0;
  for (const f of files) {
    try {
      await getStorageFor(f.storage).remove(f.key);
      n++;
    } catch (e) {
      console.error('could not erase', f.key, (e as Error).message);
    }
  }
  return n;
}

/**
 * Watches the projects collection. The moment a project is deleted, even straight in MongoDB / Atlas where the app's
 * own delete never runs, its stored files (local AND Spaces, exactly the ones its own record lists), notifications,
 * chat, shops and history are cleared a few seconds later. Nothing else in the bucket is ever touched.
 * Needs a replica set (Atlas is one); where change streams are unavailable it logs once and the timed sweep still covers local files.
 */
export function watchProjectDeletes(onCleared?: (r: Awaited<ReturnType<typeof clearDeletedProjectLeftovers>> & { erased: number }) => void) {
  let timer: NodeJS.Timeout | undefined;
  let close: (() => void) | undefined;
  const pending: { key: string; storage: 'local' | 'space' }[] = [];
  void enablePreImages().then(() => {
    try {
      const stream = Project.watch([{ $match: { operationType: 'delete' } }], { fullDocumentBeforeChange: 'whenAvailable' });
      stream.on('change', (ev: { fullDocumentBeforeChange?: { files?: { key: string; storage: 'local' | 'space' }[] } }) => {
        pending.push(...(ev.fullDocumentBeforeChange?.files ?? []));
        clearTimeout(timer); // several deletes in a row are cleaned in one go
        timer = setTimeout(() => {
          const batch = pending.splice(0);
          eraseFilesOf(batch)
            .then(async (erased) => ({ ...(await clearDeletedProjectLeftovers()), erased }))
            .then((r) => {
              if (Object.keys(r.records).length || r.files || r.erased) console.log('Cleared leftovers of deleted project(s):', r);
              onCleared?.(r);
            })
            .catch((e) => console.error('leftover clean-up failed', e));
        }, 3000);
      });
      stream.on('error', (e) => console.warn('Project delete watcher stopped (the timed clean-up still runs):', (e as Error).message));
      close = () => void stream.close();
    } catch (e) {
      console.warn('Project delete watcher unavailable:', (e as Error).message);
    }
  });
  return () => {
    clearTimeout(timer);
    close?.();
  };
}
