/**
 * Deletes the handover data the chat-style Communication replaced: Additional Notes, Voice Notes and the client
 * Documents of every order (stored files erased too). Shop list uploads (SHOP_LIST) and shop row images are kept.
 *   Dry run (counts only):  npx tsx scripts/purge-legacy-handover.ts
 *   Delete:                 npx tsx scripts/purge-legacy-handover.ts --apply
 */
import { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db';
import { eraseStoredFile } from '../src/modules/files/file.service';
import type { StoredFile } from '../src/modules/files/storedFile.schema';
import { SalesOrder } from '../src/modules/sales/sales.model';

const SYSTEM = { id: new Types.ObjectId().toHexString(), role: 'SUPER_ADMIN' } as const;

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDb();
  const orders = await SalesOrder.find({
    $or: [{ handoverNotes: { $nin: [null, ''] } }, { 'handoverVoiceNotesArray.0': { $exists: true } }, { 'handoverDocumentsArray.kind': 'DOCUMENT' }],
  })
    .select('orderNo handoverNotes handoverVoiceNotesArray handoverDocumentsArray')
    .lean();
  const totals = { orders: orders.length, notes: 0, voiceNotes: 0, documents: 0, files: 0 };
  for (const o of orders) {
    const docs = (o.handoverDocumentsArray ?? []).filter((d) => d.kind === 'DOCUMENT');
    const voices = o.handoverVoiceNotesArray ?? [];
    const files = [...voices.map((v) => v.file), ...docs.map((d) => d.file)].filter(Boolean) as StoredFile[];
    totals.notes += o.handoverNotes ? 1 : 0;
    totals.voiceNotes += voices.length;
    totals.documents += docs.length;
    totals.files += files.length;
    console.log(`${o.orderNo}: notes ${o.handoverNotes ? 'yes' : 'no'}, ${voices.length} voice note(s), ${docs.length} document(s)`);
    if (!apply) continue;
    await SalesOrder.updateOne({ _id: o._id }, { $set: { handoverNotes: null, handoverVoiceNotesArray: [] }, $pull: { handoverDocumentsArray: { kind: 'DOCUMENT' } } });
    for (const f of files) await eraseStoredFile(f, SYSTEM, { entity: 'SalesOrder', id: o._id });
  }
  console.log(JSON.stringify(totals));
  if (!apply) console.log(totals.orders ? 'Dry run only. Add --apply to delete.' : 'Nothing to delete.');
  await disconnectDb();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
