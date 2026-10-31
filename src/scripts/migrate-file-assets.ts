/**
 * One-time copy of BD CRM file details out of the `fileassets` collection into the records that own the files:
 *
 *   salesorders.salescommentsArray[].attachments[]   (SALES_COMMENT_ATTACHMENT)
 *   salesorders.approvalDocumentsArray[].file        (SALES_APPROVAL_PROOF)
 *   salesorders.rateCardArray[].pdf + rateCardPdf    (SALES_RATE_CARD_PDF)
 *   salesorders.salesprofile[].attachments[]         (sent email attachments)
 *   emailtemplates.pdf                               (TEMPLATE_COMPANY_PROFILE)
 *
 * Each file reference gets key, storage, kind, sha256, uploadedBy and uploadedAt. `fileId` is kept, so links the apps
 * already hold keep working. References that already have a key are skipped, so running the script again is safe.
 * Nothing is deleted: the stored files stay where they are, and the old `fileassets` rows are left for you to remove
 * once the data has been checked (the command is printed at the end).
 *
 * Run with the app stopped (or idle):  npm run migrate:file-assets
 */
import mongoose, { type Types } from 'mongoose';
import { connectDb, disconnectDb } from '../config/db';

type Doc = Record<string, any>;
const BD_CATEGORIES = ['SALES_COMMENT_ATTACHMENT', 'SALES_APPROVAL_PROOF', 'SALES_RATE_CARD_PDF', 'TEMPLATE_COMPANY_PROFILE'];

const needsCopy = (ref: Doc | null | undefined) => !!ref?.fileId && !ref.key;

/** Every file reference inside an order. */
function refsOf(o: Doc): Doc[] {
  return [
    ...(o.salescommentsArray ?? []).flatMap((c: Doc) => c.attachments ?? []),
    ...(o.salesprofile ?? []).flatMap((e: Doc) => e.attachments ?? []),
    ...(o.rateCardArray ?? []).map((r: Doc) => r.pdf),
    o.rateCardPdf,
    ...(o.approvalDocumentsArray ?? []).map((d: Doc) => d.file),
  ].filter(Boolean);
}

async function main() {
  await connectDb();
  const db = mongoose.connection.db!;
  const assets = db.collection('fileassets');
  const missing: string[] = [];
  let copied = 0;

  /** Fills one reference in place from its FileAsset row. */
  const fill = (ref: Doc, byId: Map<string, Doc>) => {
    const a = byId.get(String(ref.fileId));
    if (!a) {
      missing.push(String(ref.fileId));
      return;
    }
    Object.assign(ref, {
      key: a.key,
      storage: a.storage,
      name: ref.name ?? a.originalName,
      size: ref.size ?? a.size,
      mimeType: ref.mimeType ?? a.mimeType,
      kind: a.kind,
      sha256: a.sha256,
      uploadedBy: a.uploadedBy,
      uploadedAt: ref.uploadedAt ?? a.createdAt,
    });
    copied++;
  };
  const load = async (ids: Types.ObjectId[]) => new Map((await assets.find({ _id: { $in: ids } }).toArray()).map((a) => [String(a._id), a as Doc]));

  const orders = db.collection('orders');
  let touchedOrders = 0;
  for await (const o of orders.find({}, { projection: { orderNo: 1, salescommentsArray: 1, salesprofile: 1, rateCardArray: 1, rateCardPdf: 1, approvalDocumentsArray: 1 } })) {
    const pending = refsOf(o).filter(needsCopy);
    if (!pending.length) continue;
    const byId = await load(pending.map((r) => r.fileId));
    for (const ref of pending) fill(ref, byId);
    await orders.updateOne(
      { _id: o._id },
      { $set: { salescommentsArray: o.salescommentsArray ?? [], salesprofile: o.salesprofile ?? [], rateCardArray: o.rateCardArray ?? [], rateCardPdf: o.rateCardPdf ?? null, approvalDocumentsArray: o.approvalDocumentsArray ?? [] } },
    );
    touchedOrders++;
    console.log(`  ${o.orderNo}: ${pending.length} file reference(s)`);
  }

  const templates = db.collection('emailtemplates');
  let touchedTemplates = 0;
  for await (const t of templates.find({ 'pdf.fileId': { $exists: true } }, { projection: { key: 1, pdf: 1 } })) {
    if (!needsCopy(t.pdf)) continue;
    fill(t.pdf, await load([t.pdf.fileId]));
    await templates.updateOne({ _id: t._id }, { $set: { pdf: t.pdf } });
    touchedTemplates++;
    console.log(`  template ${t.key}: PDF`);
  }

  console.log(`Done. ${copied} file reference(s) copied (${touchedOrders} order(s), ${touchedTemplates} template(s)).`);
  if (missing.length) {
    console.warn(`${missing.length} reference(s) had no fileassets row and were left as they are: ${[...new Set(missing)].join(', ')}`);
  }
  const left = await assets.countDocuments({ category: { $in: BD_CATEGORIES } });
  console.log(`${left} BD CRM row(s) remain in fileassets. After checking the app, remove them with:`);
  console.log(`  db.fileassets.deleteMany({ category: { $in: ${JSON.stringify(BD_CATEGORIES)} } })`);
  console.log('Project files (BD client details, Recce, Operations) still use fileassets: do not delete those.');
  await disconnectDb();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
