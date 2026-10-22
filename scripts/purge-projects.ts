/**
 * Deletes projects AND everything linked to them (stored files, shops, notifications, chat, audit history), using the
 * same cascade the app uses. For clearing test data without leaving anything behind.
 *   Dry run, one project:   npx tsx scripts/purge-projects.ts --code 22070301
 *   Delete it:              npx tsx scripts/purge-projects.ts --code 22070301 --apply
 *   Every project:          npx tsx scripts/purge-projects.ts --all --apply     (TEST DATABASES ONLY)
 */
import { connectDb, disconnectDb } from '../src/config/db';
import { env } from '../src/config/env';
import { removeProjectFiles } from '../src/modules/files/file.service';
import { purgeProjectData } from '../src/modules/projects/project.cascade';
import { Project } from '../src/modules/projects/project.model';

async function main() {
  const arg = (n: string) => process.argv[process.argv.indexOf(n) + 1];
  const apply = process.argv.includes('--apply');
  const all = process.argv.includes('--all');
  const code = process.argv.includes('--code') ? arg('--code') : undefined;
  if (!all && !code) throw new Error('Give --code <project code> or --all');
  if (all && env.isProd) throw new Error('--all is refused when NODE_ENV=production');
  await connectDb();
  const projects = await Project.find(all ? {} : { code }).select('code campaign').lean();
  if (!projects.length) console.log('No matching project.');
  for (const p of projects) {
    if (!apply) {
      console.log(`would delete project ${p.code} (${p.campaign}) with all its data`);
      continue;
    }
    const { failed } = await removeProjectFiles(String(p._id));
    if (failed.length) {
      console.error(`${p.code}: could not erase ${failed.join(', ')}; project kept`);
      continue;
    }
    console.log(`${p.code}:`, await purgeProjectData(String(p._id)));
  }
  if (!apply && projects.length) console.log('Dry run only. Add --apply to delete.');
  await disconnectDb();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
