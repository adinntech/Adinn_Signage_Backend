/**
 * One-off: moves every record of the old separate `fileassets` collection into its project's `files` array, with the
 * CRM section, and (for Spaces) the full path and URL. Safe to run again (each project's array is rebuilt).
 *   Dry run:                   npx tsx scripts/migrate-files-to-projects.ts
 *   Apply:                     npx tsx scripts/migrate-files-to-projects.ts --apply
 *   Apply and remove the moved rows from the old collection:  add --remove-migrated
 * Rows that belong to another module (no project, e.g. Sales order attachments) are never touched or removed.
 */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db';
import { SECTION_LABEL, type FileCategory } from '../src/modules/files/file.categories';
import { getStorage } from '../src/modules/files/storage';
import { Project } from '../src/modules/projects/project.model';

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDb();
  const storage = getStorage();
  const coll = mongoose.connection.collection('fileassets');
  const rows = await coll.find({ project: { $exists: true } }).sort({ createdAt: 1 }).toArray();
  const existing = new Set((await Project.collection.find({ _id: { $in: [...new Set(rows.map((r) => r.project))] } }, { projection: { _id: 1 } }).toArray()).map((p) => String(p._id)));
  const gone = rows.filter((r) => !existing.has(String(r.project)));
  for (const r of gone) console.log(`project no longer exists, record will be dropped: ${r.key}`);
  const byProject = new Map<string, Record<string, unknown>[]>();
  for (const r of rows.filter((x) => existing.has(String(x.project)))) {
    const loc = r.storage === 'space' && storage.locate ? storage.locate(String(r.key)) : { path: r.path, url: r.url };
    const entry = {
      _id: r._id,
      section: SECTION_LABEL[r.category as FileCategory] ?? r.section,
      category: r.category,
      key: r.key,
      storage: r.storage,
      path: loc.path,
      url: loc.url,
      originalName: r.originalName,
      mimeType: r.mimeType,
      kind: r.kind,
      size: r.size,
      sha256: r.sha256,
      uploadedBy: r.uploadedBy,
      uploadedAt: r.createdAt ?? new Date(),
      deletedAt: r.deletedAt,
      deletedBy: r.deletedBy,
      objectRetained: r.objectRetained,
    };
    const list = byProject.get(String(r.project)) ?? [];
    list.push(entry);
    byProject.set(String(r.project), list);
  }
  let moved = 0;
  for (const [pid, list] of byProject) {
    moved += list.length;
    console.log(`${apply ? 'moved' : 'would move'} ${list.length} file(s) into project ${pid}`);
    if (apply) await Project.collection.updateOne({ _id: new mongoose.Types.ObjectId(pid) }, { $set: { files: list } });
  }
  console.log(`${moved} of ${rows.length} record(s) ${apply ? 'moved' : 'found (dry run, add --apply)'}`);
  if (apply && process.argv.includes('--remove-migrated')) {
    const inProjects = (await Project.aggregate([{ $project: { n: { $size: { $ifNull: ['$files', []] } } } }, { $group: { _id: null, n: { $sum: '$n' } } }]))[0]?.n ?? 0;
    if (inProjects < rows.length - gone.length) throw new Error(`Refusing to remove: only ${inProjects} files are in projects but ${rows.length - gone.length} were expected`);
    const r = await coll.deleteMany({ project: { $exists: true } });
    console.log(`Removed ${r.deletedCount} moved row(s) from the old collection; rows of other modules were left alone.`);
  }
  await disconnectDb();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
