import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1']);
import 'dotenv/config';
process.env.STORAGE_TYPE = 'local';
for (const k of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN']) delete process.env[k];
process.env.MONGODB_URI = process.env.MONGODB_URI!.replace('/signage_recce?', '/smoke_phase_b_' + Date.now() + '?');

async function main() {
  const { connectDb } = await import('./src/config/db');
  const mongoose = (await import('mongoose')).default;
  const cs = await import('./src/modules/clients/client.service');
  const { Client } = await import('./src/modules/clients/client.model');
  const orders = await import('./src/modules/sales/order.service');
  const leads = await import('./src/modules/sales/lead.service');
  const zoho = await import('./src/modules/zoho/zoho.service');
  const v = await import('./src/modules/sales/sales.validators');
  const { SalesOrder } = await import('./src/modules/sales/sales.model');
  await connectDb(process.env.MONGODB_URI);
  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: unknown) => {
    if (cond) pass++;
    else fail++;
    console.log(cond ? 'PASS' : 'FAIL', name);
  };
  const actor = { id: new mongoose.Types.ObjectId().toString(), role: 'BD' };
  const key = () => 'rk-' + Math.random().toString(36).slice(2, 12);
  try {
    const lc = new mongoose.Types.ObjectId();
    const legacyRow = await SalesOrder.create({ orderNo: '20260101ORD#99', client: lc, clientType: 'NEW', stage: 'NEW_ORDER', lead: { stage: 'RATE_CARD', status: 'OPEN', startedAt: new Date() } });
    const doneRow = await SalesOrder.create({ orderNo: '20260101ORD#98', client: lc, clientType: 'NEW', stage: 'NEW_ORDER', lead: { stage: 'CLIENT_APPROVAL', status: 'COMPLETED', startedAt: new Date() } });
    check('sample mode', zoho.zohoMode() === 'sample');
    const all = await zoho.searchZohoClients('');
    check('sample list 12', all.length === 12);
    check('search ramco', (await zoho.searchZohoClients('ramco')).length === 1);
    check('search by gst', (await zoho.searchZohoClients('33AAACT5131A')).length === 1);
    check('body needs one of clientId/zohoId', !v.createOrderBody.safeParse({ clientType: 'NEW' }).success && !v.createOrderBody.safeParse({ clientId: new mongoose.Types.ObjectId().toString(), zohoId: 'x' }).success);

    const c = await cs.registerCompany({ name: 'Fresh Signs Pvt Ltd', email: 'hi@fresh.example.com', phone: '9876543210', contacts: [], customFields: [] } as never, actor);
    const r1 = await orders.createOrderForClient({ clientId: String(c._id), clientType: 'NEW', requestKey: key() }, actor);
    check('new order flag', r1.order.clientType === 'NEW');
    const o1 = await SalesOrder.findById(r1.order._id).lean();
    check('lead auto at PROJECT_ASSIGN', o1?.lead?.stage === 'PROJECT_ASSIGN' && o1.lead.status === 'OPEN');
    check('lead logs start+complete', o1?.leadLogsArray?.length === 2 && o1.leadLogsArray[1]!.toStage === 'PROJECT_ASSIGN');
    check('order no format', /^\d{8}ORD#\d+$/.test(r1.order.orderNo));
    const g1 = await leads.getLead(String(r1.order._id));
    check('getLead flow 2 stages', g1.stages.length === 2 && g1.stages[0]!.status === 'DONE' && g1.stages[1]!.status === 'CURRENT');
    check('no previous stage', g1.previousStage === null);
    check('handover unlocked', g1.handover.unlocked === true);
    check('missing assign', g1.missing[0]?.includes('Assign'));
    let err: any = null;
    try {
      await leads.previousStage(String(r1.order._id), 'PROJECT_ASSIGN', undefined, actor);
    } catch (e) {
      err = e;
    }
    check('cannot go back to New Lead', err?.statusCode === 409);
    err = null;
    try {
      await leads.completeStage(String(r1.order._id), 'PROJECT_ASSIGN', undefined, actor);
    } catch (e) {
      err = e;
    }
    check('cannot complete without assign', err?.statusCode === 422);

    const z = all.find((x) => x.name.startsWith('Ramco'))!;
    const r2 = await orders.createOrderForClient({ zohoId: z.zohoId, clientType: 'EXISTING', requestKey: key() }, actor);
    const zc = await Client.findById(r2.client._id).lean();
    check('zoho client imported', zc?.source === 'ZOHO' && zc.zohoId === z.zohoId && zc.clientType === 'EXISTING' && /^CLI-/.test(zc.clientNo ?? ''));
    check('zoho fields copied', zc?.gstin === z.gstin && zc?.phone === z.phone && zc?.email === z.email);
    check('existing order flag', r2.order.clientType === 'EXISTING');
    const r3 = await orders.createOrderForClient({ zohoId: z.zohoId, clientType: 'EXISTING', requestKey: key() }, actor);
    check('second zoho order reuses client', String(r3.client._id) === String(zc!._id));
    check('one ramco client', (await Client.countDocuments({ zohoId: z.zohoId })) === 1);
    const linked = await cs.linkedZohoClients([z.zohoId, 'sample-1001']);
    check('linked map', linked.get(z.zohoId)?.clientId === String(zc!._id) && !linked.has('sample-1001'));

    const tvs = all.find((x) => x.name.startsWith('TVS'))!;
    const crmTvs = await cs.registerCompany({ name: 'TVS Motor Co', email: 'x@tvs.example.org', phone: '9876543211', gstin: tvs.gstin, contacts: [], customFields: [] } as never, actor);
    const r4 = await orders.createOrderForClient({ zohoId: tvs.zohoId, clientType: 'EXISTING', requestKey: key() }, actor);
    check('linked by GST to CRM client', String(r4.client._id) === String(crmTvs._id));
    const tvsAfter = await Client.findById(crmTvs._id).lean();
    check('CRM client got zohoId, kept source', tvsAfter?.zohoId === tvs.zohoId && tvsAfter.source === 'CRM');

    const crmList = await cs.listClients({ page: 1, limit: 50, source: 'CRM' } as never);
    check('CRM list excludes zoho-only clients', crmList.items.every((x) => x.source !== 'ZOHO') && crmList.items.length === 2);

    const k = key();
    const a = await orders.createOrderForClient({ zohoId: z.zohoId, requestKey: k }, actor);
    const b = await orders.createOrderForClient({ zohoId: z.zohoId, requestKey: k }, actor);
    check('same request key -> same order', String(a.order._id) === String(b.order._id) && b.replayed === true);
    check('zoho default flag EXISTING', a.order.clientType === 'EXISTING');

    err = null;
    try {
      await orders.createOrderForClient({ zohoId: 'nope', requestKey: key() }, actor);
    } catch (e) {
      err = e;
    }
    check('unknown zoho id 404', err?.statusCode === 404);

    const legacy = legacyRow;
    const _x = ({ orderNo: '20260101ORD#99', client: c._id, clientType: 'NEW', stage: 'NEW_ORDER', lead: { stage: 'RATE_CARD', status: 'OPEN', startedAt: new Date() } });
    const done = doneRow;
    const _y = ({ orderNo: '20260101ORD#98', client: c._id, clientType: 'NEW', stage: 'NEW_ORDER', lead: { stage: 'CLIENT_APPROVAL', status: 'COMPLETED', startedAt: new Date() } });
    const sum = await leads.leadSummary();
    const l = await SalesOrder.findById(legacy._id).lean();
    check('legacy open lead -> PROJECT_ASSIGN', l?.lead?.stage === 'PROJECT_ASSIGN' && l.lead.legacyStage === 'RATE_CARD');
    check('completed legacy lead untouched', (await SalesOrder.findById(done._id).lean())?.lead?.stage === 'CLIENT_APPROVAL');
    check('summary stages flow only', Object.keys(sum.stages).join() === 'NEW_LEAD,PROJECT_ASSIGN' && sum.stages.PROJECT_ASSIGN === 6 - 0);
    const gl = await leads.getLead(String(done._id));
    check('completed legacy getLead ok', gl.stages.every((s) => s.status === 'DONE'));

    await SalesOrder.updateOne({ _id: r1.order._id }, { csAssignee: new mongoose.Types.ObjectId() });
    const fin = await leads.completeStage(String(r1.order._id), 'PROJECT_ASSIGN', undefined, actor);
    check('lead completed after assign', fin.lead.status === 'COMPLETED');
    const o1b = await SalesOrder.findById(r1.order._id).lean();
    check('approval not touched', o1b?.approvalStatus !== 'COMPLETED');
  } finally {
    await mongoose.connection.db?.dropDatabase();
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
