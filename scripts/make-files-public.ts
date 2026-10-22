/**
 * Makes files that were uploaded while DO_SPACES_ACL was private open to anyone with the URL, and fills in their stored
 * path/url. Only objects recorded in the database (under this app's prefix) are touched.
 *   Dry run:  npx tsx scripts/make-files-public.ts
 *   Apply:    npx tsx scripts/make-files-public.ts --apply
 */
import { PutObjectAclCommand, S3Client } from '@aws-sdk/client-s3';
import { connectDb, disconnectDb } from '../src/config/db';
import { env } from '../src/config/env';
import { Project } from '../src/modules/projects/project.model';
import { getStorage } from '../src/modules/files/storage';

async function main() {
  const apply = process.argv.includes('--apply');
  if (env.storage !== 'space') throw new Error('STORAGE_TYPE is local; nothing to do');
  await connectDb();
  const storage = getStorage();
  const client = new S3Client({
    region: env.DO_SPACES_REGION!,
    endpoint: env.DO_SPACES_ENDPOINT!,
    credentials: { accessKeyId: env.DO_SPACES_KEY!, secretAccessKey: env.DO_SPACES_SECRET! },
  });
  const projects = await Project.find({ 'files.storage': 'space' }).select('files');
  const files = projects.flatMap((p) => (p.files ?? []).filter((f) => f.storage === 'space' && !f.deletedAt).map((f) => ({ projectId: p._id, id: f._id, key: f.key })));
  let done = 0;
  for (const f of files) {
    const loc = storage.locate!(f.key);
    if (apply) {
      await client.send(new PutObjectAclCommand({ Bucket: env.DO_SPACES_BUCKET!, Key: loc.path, ACL: 'public-read' }));
      await Project.updateOne({ _id: f.projectId, 'files._id': f.id }, { $set: { 'files.$.path': loc.path, 'files.$.url': loc.url } });
    }
    done++;
    console.log(`${apply ? 'public' : 'would make public'}: ${loc.url}`);
  }
  console.log(`${done} file(s) ${apply ? 'updated' : 'found (dry run, add --apply to change them)'}`);
  await disconnectDb();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
