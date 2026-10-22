/**
 * One-time move of BD sales activity from the old per-entity collections into each order's arrays:
 *
 *   salescomments      -> salesorders.salescommentsArray
 *   salesemails        -> salesorders.salesprofile
 *   ratecardrevisions  -> salesorders.rateCardArray (+ currentRevision, rateCardPdf)
 *   approvaldocuments  -> salesorders.approvalDocumentsArray
 *   auditlogs (SalesOrder pipeline actions) -> salesorders.salespipelineLogs
 *
 * Item ids are kept, so file links, "resent from" and "replaces" references stay valid. Items already in an order's
 * array are not duplicated, and each order is marked (arraysMigratedAt) so running the script again skips it.
 * The old collections are NOT deleted; drop them yourself once the data has been checked.
 *
 * Run with the app stopped (or idle):  npm run migrate:sales-arrays
 */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db';

type Doc = Record<string, any>;
const PIPELINE_ACTIONS = ['CREATE', 'STAGE_CHANGE', 'ASSIGN', 'APPROVAL_COMPLETE'];

async function main() {
  await connectDb();
  const db = mongoose.connection.db!;
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  const all = async (name: string, filter: Doc = {}) => (existing.has(name) ? db.collection(name).find(filter).toArray() : []);
  const strip = ({ order: _o, client: _c, __v: _v, ...rest }: Doc) => rest;

  const orders = db.collection('salesorders');
  const pending = await orders.find({ arraysMigratedAt: { $exists: false } }).toArray();
  console.log(`${pending.length} order(s) to migrate`);

  let moved = 0;
  for (const o of pending) {
    const id = o._id;
    const [comments, emails, revisions, docs, logs] = await Promise.all([
      all('salescomments', { order: id }),
      all('salesemails', { order: id }),
      all('ratecardrevisions', { order: id }),
      all('approvaldocuments', { order: id }),
      all('auditlogs', { entity: 'SalesOrder', entityId: id, action: { $in: PIPELINE_ACTIONS } }),
    ]);

    const pipeline = logs.map((l) => {
      const stage = (l.changes ?? []).find((c: Doc) => c.field === 'stage');
      return {
        _id: l._id,
        action: l.action,
        fromStage: stage?.oldValue ?? null,
        toStage: stage?.newValue ?? null,
        movedBy: l.user,
        role: l.role,
        movedAt: l.at,
        notes: l.reason,
      };
    });

    // Keep whatever the order already has; add old items whose id is not there yet.
    const merge = (current: Doc[] | undefined, incoming: Doc[]) => {
      const have = new Set((current ?? []).map((x) => String(x._id)));
      return [...(current ?? []), ...incoming.filter((x) => !have.has(String(x._id)))];
    };
    const rateCardArray = merge(o.rateCardArray, revisions.map(strip)).sort((a, b) => a.revision - b.revision);
    const latest = rateCardArray[rateCardArray.length - 1];

    await orders.updateOne(
      { _id: id, arraysMigratedAt: { $exists: false } },
      {
        $set: {
          salescommentsArray: merge(o.salescommentsArray, comments.map(({ updatedAt: _u, ...c }) => strip(c))),
          salesprofile: merge(o.salesprofile, emails.map(({ createdAt: _c, updatedAt: _u, ...e }) => strip(e))),
          rateCardArray,
          approvalDocumentsArray: merge(o.approvalDocumentsArray, docs.map(strip)),
          salespipelineLogs: merge(o.salespipelineLogs, pipeline),
          currentRevision: latest?.revision ?? 0,
          rateCardPdf: latest?.pdf ? { ...latest.pdf, mimeType: 'application/pdf' } : null,
          arraysMigratedAt: new Date(),
        },
      },
    );
    moved += comments.length + emails.length + revisions.length + docs.length + pipeline.length;
    console.log(`  ${o.orderNo}: ${comments.length} comment(s), ${emails.length} email(s), ${revisions.length} revision(s), ${docs.length} approval doc(s), ${pipeline.length} pipeline log(s)`);
  }
  console.log(`Done. ${moved} item(s) copied into order arrays. Old collections were left in place.`);
  await disconnectDb();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
