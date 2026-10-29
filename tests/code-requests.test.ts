import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import type { OutgoingMail } from '../src/modules/notifications/mail.service';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let setMailSender: (s: ((m: OutgoingMail) => Promise<void>) | undefined) => void;
let root: string;
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
const sent: OutgoingMail[] = [];
const PDF = Buffer.from('%PDF-1.4\n% test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let seq = 0;

const makeClient = async (extra: Record<string, unknown> = {}) => {
  const { Client } = await import('../src/modules/clients/client.model');
  const n = ++seq;
  return String((await Client.create({ name: `Code Co ${n}`, code: `CODECO${n}`, clientNo: `CLI-8${n}`, contacts: [], status: 'ACTIVE', ...extra }))._id);
};
const makeOrder = async (csKey = 'CS', client?: string) => {
  const { SalesOrder } = await import('../src/modules/sales/sales.model');
  client ??= await makeClient();
  const o = await SalesOrder.create({ orderNo: `2026ORD#${++seq}`, client, clientType: 'NEW', owner: uid.BD, csAssignee: uid[csKey], createdBy: uid.BD });
  return String(o._id);
};
const mail = (kinds: string[], over: Record<string, unknown> = {}) => ({ kinds, to: ['codes@adinn.test'], cc: [], bcc: [], subject: 'Code request', body: '<p>Please create</p>', ...over });
const send = (order: string, mails: unknown[], key: string, role = 'CS', files: [Buffer, string][] = []) => {
  const r = api().post(`/api/v1/sales/orders/${order}/codes/send`).set(as(role)).field('payload', JSON.stringify({ mails, requestKey: key, includeClientDocs: [] }));
  for (const [buf, name] of files) r.attach('files', buf, name);
  return r;
};
const confirm = (order: string, kind: string, code: string, role = 'CS') => api().post(`/api/v1/sales/orders/${order}/codes/confirm`).set(as(role)).send({ kind, code, evidenceNote: 'reply mail' });
const view = async (order: string, role = 'CS') => (await api().get(`/api/v1/sales/orders/${order}/codes`).set(as(role))).body.data;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-codes-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  process.env.MAIL_FROM_IDENTITIES = 'Accounts <accounts@adinn.test>';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  setMailSender = (await import('../src/modules/notifications/mail.service')).setMailSenderForTests;
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  for (const [key, role] of [['BD', 'BD'], ['CS', 'CLIENT_SERVICING'], ['CS2', 'CLIENT_SERVICING'], ['ADMIN', 'SUPER_ADMIN']] as const) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  setMailSender(async (m) => void sent.push(m));
});
afterAll(async () => {
  setMailSender(undefined);
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('code request email', () => {
  it('sends a combined email once, with two linked requests that stay independent', async () => {
    const order = await makeOrder();
    sent.length = 0;
    const res = await send(order, [mail(['CLIENT_CODE', 'PROJECT_CODE'])], 'combined-key-1', 'CS', [[PDF, 'gst.pdf'], [PDF, 'GST.pdf']]);
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.attachments).toHaveLength(1); // the same file picked twice is attached once
    const rows = res.body.data.requests;
    expect(rows).toHaveLength(2);
    expect(rows[0].mailBatchId).toBe(rows[1].mailBatchId);
    expect(rows.map((r: { status: string }) => r.status)).toEqual(['PENDING_CONFIRMATION', 'PENDING_CONFIRMATION']);
    // a sent email confirms nothing
    expect(res.body.data.kinds.CLIENT_CODE.code).toBeNull();
    // confirming one leaves the other pending
    expect((await confirm(order, 'CLIENT_CODE', 'CLI-AB12')).status).toBe(200);
    const after = await view(order);
    expect(after.kinds.CLIENT_CODE.state).toBe('CONFIRMED');
    expect(after.kinds.PROJECT_CODE.state).toBe('PENDING');
  });

  it('sends two separate emails when asked', async () => {
    const order = await makeOrder();
    sent.length = 0;
    const res = await send(order, [mail(['CLIENT_CODE']), mail(['PROJECT_CODE'])], 'separate-key-1');
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(2);
    const [a, b] = res.body.data.requests;
    expect(a.mailBatchId).not.toBe(b.mailBatchId);
  });

  it('a repeated submit with the same key does not email twice', async () => {
    const order = await makeOrder();
    sent.length = 0;
    await send(order, [mail(['PROJECT_CODE'])], 'repeat-key-001');
    const again = await send(order, [mail(['PROJECT_CODE'])], 'repeat-key-001');
    expect(again.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(again.body.data.requests).toHaveLength(1);
  });

  it('refuses a second live request and a code that already exists', async () => {
    const order = await makeOrder();
    await send(order, [mail(['PROJECT_CODE'])], 'first-key-0001');
    const dupe = await send(order, [mail(['PROJECT_CODE'])], 'second-key-001');
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.code).toBe('ALREADY_REQUESTED');
    // client code already confirmed on the client: nothing to request on another order
    const o1 = await makeOrder();
    await send(o1, [mail(['CLIENT_CODE'])], 'client-key-0001');
    await confirm(o1, 'CLIENT_CODE', 'CLI-ZZ99');
    const o2 = await makeOrder('CS', (await (await import('../src/modules/sales/sales.model')).SalesOrder.findById(o1).lean())!.client.toString());
    const again = await send(o2, [mail(['CLIENT_CODE'])], 'client-key-0002');
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('CLI-ZZ99');
  });

  it('shows the BD team email and lets Client Servicing confirm from it', async () => {
    const order = await makeOrder();
    const { SalesOrder } = await import('../src/modules/sales/sales.model');
    await SalesOrder.updateOne({ _id: order }, { $push: { salesprofile: { kind: 'PROJECT_CODE_REQUEST', to: ['x@adinn.test'], cc: [], subject: 'BD asked', body: 'b', status: 'SENT', sentBy: uid.BD, sentAt: new Date() } } });
    const v = await view(order);
    expect(v.kinds.PROJECT_CODE.state).toBe('BD_SENT');
    expect(v.kinds.PROJECT_CODE.bdMail.subject).toBe('BD asked');
    expect(v.kinds.PROJECT_CODE.canRequest).toBe(false);
    expect((await send(order, [mail(['PROJECT_CODE'])], 'bd-key-000001')).status).toBe(409);
    expect((await confirm(order, 'PROJECT_CODE', '22070277')).status).toBe(200);
    expect((await view(order)).kinds.PROJECT_CODE.code).toBe('22070277');
  });

  it('records a failed send, then retries it', async () => {
    const order = await makeOrder();
    setMailSender(async () => {
      throw new Error('smtp down');
    });
    const res = await send(order, [mail(['PROJECT_CODE'])], 'fail-key-00001');
    expect(res.body.data.requests[0].status).toBe('FAILED');
    expect(res.body.data.kinds.PROJECT_CODE.canRequest).toBe(true);
    setMailSender(async (m) => void sent.push(m));
    sent.length = 0;
    const batch = res.body.data.requests[0].mailBatchId;
    const retry = await api().post(`/api/v1/sales/orders/${order}/codes/retry`).set(as('CS')).send({ mailBatchId: batch });
    expect(retry.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(retry.body.data.requests[0].status).toBe('PENDING_CONFIRMATION');
  });

  it('accepts only configured sender identities', async () => {
    const order = await makeOrder();
    expect((await send(order, [mail(['PROJECT_CODE'], { from: 'Boss <boss@evil.test>' })], 'from-key-00001')).status).toBe(422);
    const ok = await send(order, [mail(['PROJECT_CODE'], { from: 'Accounts <accounts@adinn.test>' })], 'from-key-00002');
    expect(ok.status).toBe(201);
  });

  it('keeps Bcc off the stored email', async () => {
    const order = await makeOrder();
    sent.length = 0;
    const res = await send(order, [mail(['PROJECT_CODE'], { bcc: ['hidden@adinn.test'] })], 'bcc-key-000001');
    expect(sent[0]!.bcc).toEqual(['hidden@adinn.test']);
    expect(JSON.stringify(res.body.data)).not.toContain('hidden@adinn.test');
  });
});

describe('code confirmation', () => {
  it('validates the format and uniqueness of codes', async () => {
    const o1 = await makeOrder();
    await send(o1, [mail(['PROJECT_CODE'])], 'conf-key-00001');
    expect((await confirm(o1, 'PROJECT_CODE', '123')).status).toBe(422);
    expect((await confirm(o1, 'PROJECT_CODE', '12345678')).status).toBe(200);
    const o2 = await makeOrder();
    await send(o2, [mail(['PROJECT_CODE'])], 'conf-key-00002');
    const dupe = await confirm(o2, 'PROJECT_CODE', '12345678');
    expect(dupe.status).toBe(422);
    expect(dupe.body.error.message).toContain('already');
  });

  it('refuses to confirm when nothing was requested, and never overwrites a client code', async () => {
    const order = await makeOrder();
    expect((await confirm(order, 'PROJECT_CODE', '87654321')).status).toBe(409);
    const other = await makeClient({ approvedCode: 'CLI-OLD1' });
    const o = await makeOrder('CS', other);
    await send(o, [mail(['CLIENT_CODE'])], 'over-key-000001').then((r) => expect(r.status).toBe(409));
  });

  it('rejects a request with a reason, after which it can be requested again', async () => {
    const order = await makeOrder();
    await send(order, [mail(['PROJECT_CODE'])], 'rej-key-000001');
    const rej = await api().post(`/api/v1/sales/orders/${order}/codes/reject`).set(as('CS')).send({ kind: 'PROJECT_CODE', reason: 'Wrong client' });
    expect(rej.status).toBe(200);
    expect(rej.body.data.kinds.PROJECT_CODE.canRequest).toBe(true);
    expect((await send(order, [mail(['PROJECT_CODE'])], 'rej-key-000002')).status).toBe(201);
    const hist = await api().get(`/api/v1/sales/orders/${order}/codes/history`).set(as('CS'));
    expect(hist.body.data.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['CODE_REQUEST_SENT', 'CODE_REJECTED']));
  });
});

describe('access', () => {
  it('limits requests to the owner Client Servicing person (or Super Admin) and keeps BD out', async () => {
    const order = await makeOrder('CS');
    expect((await api().get(`/api/v1/sales/orders/${order}/codes`).set(as('CS2'))).status).toBe(404);
    expect((await api().get(`/api/v1/sales/orders/${order}/codes`).set(as('BD'))).status).toBe(403);
    expect((await send(order, [mail(['PROJECT_CODE'])], 'acc-key-000001', 'BD')).status).toBe(403);
    expect((await api().get(`/api/v1/sales/orders/${order}/codes`).set(as('ADMIN'))).status).toBe(200);
    const mine = await api().get('/api/v1/sales/codes').set(as('CS'));
    const theirs = await api().get('/api/v1/sales/codes').set(as('CS2'));
    expect(mine.body.data.length).toBeGreaterThan(0);
    expect(theirs.body.data).toEqual([]);
    expect((await api().get('/api/v1/sales/codes').set(as('BD'))).status).toBe(403);
  });
});

describe('cleanup', () => {
  it('deleting a client removes its code requests, their history and the stored attachments', async () => {
    const { Client } = await import('../src/modules/clients/client.model');
    const { CodeRequest } = await import('../src/modules/codeRequests/codeRequest.model');
    const { AuditLog } = await import('../src/modules/audit/auditLog.model');
    const { purgeClientData } = await import('../src/modules/clients/client.cascade');
    const c = await makeClient();
    const keep = await makeOrder('CS');
    const order = await makeOrder('CS', c);
    await send(order, [mail(['PROJECT_CODE'])], 'gone-key-00001', 'CS', [[PDF, 'x.pdf']]);
    await send(keep, [mail(['PROJECT_CODE'])], 'keep-key-00001');
    const files = () => fs.readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith('x.pdf')).length;
    expect(files()).toBe(1);
    const ids = await CodeRequest.find({ order }).distinct('_id');
    expect(await AuditLog.countDocuments({ entity: 'CodeRequest', entityId: { $in: ids } })).toBeGreaterThan(0);
    const res = await purgeClientData(c);
    expect(res.purged).toBe(true);
    expect(await CodeRequest.countDocuments({ order })).toBe(0);
    expect(await AuditLog.countDocuments({ entity: 'CodeRequest', entityId: { $in: ids } })).toBe(0);
    expect(files()).toBe(0);
    expect(await CodeRequest.countDocuments({ order: keep })).toBe(1);
    expect(await Client.exists({ _id: c })).toBeNull();
  });
});

describe('already sent', () => {
  it('records a request sent outside the CRM without emailing, and it can then be confirmed', async () => {
    const order = await makeOrder();
    sent.length = 0;
    const res = await api().post(`/api/v1/sales/orders/${order}/codes/already-sent`).set(as('CS')).send({ kinds: ['CLIENT_CODE', 'PROJECT_CODE'], note: 'Phoned accounts on 29 Oct' });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(res.body.data.kinds.CLIENT_CODE.state).toBe('PENDING');
    expect((await api().post(`/api/v1/sales/orders/${order}/codes/already-sent`).set(as('CS')).send({ kinds: ['CLIENT_CODE'], note: 'again please' })).status).toBe(409);
    expect((await api().post(`/api/v1/sales/orders/${order}/codes/already-sent`).set(as('CS')).send({ kinds: ['PROJECT_CODE'], note: 'x' })).status).toBe(422);
    expect((await confirm(order, 'PROJECT_CODE', '55667788')).status).toBe(200);
  });
});

describe('order states (Code Requests page)', () => {
  it('shows where each order stands, filters by what is left to do, and stays inside the own orders of the person', async () => {
    const todo = await makeOrder();
    const waiting = await makeOrder();
    await send(waiting, [mail(['CLIENT_CODE', 'PROJECT_CODE'])], 'states-key-0001');
    const done = await makeOrder();
    await send(done, [mail(['CLIENT_CODE', 'PROJECT_CODE'])], 'states-key-0002');
    await confirm(done, 'CLIENT_CODE', 'CLI-ST01');
    await confirm(done, 'PROJECT_CODE', '31313131');
    const list = async (qs: string, role = 'CS') => (await api().get('/api/v1/sales/codes/orders' + qs).set(as(role))).body;
    const all = await list('?limit=50');
    const by = (id: string) => all.data.find((i: { orderId: string }) => i.orderId === id);
    expect(by(todo)).toMatchObject({ bucket: 'TODO', codes: { CLIENT_CODE: { state: 'NOT_REQUESTED' }, PROJECT_CODE: { state: 'NOT_REQUESTED' } } });
    expect(by(waiting)).toMatchObject({ bucket: 'WAITING', codes: { CLIENT_CODE: { state: 'PENDING' }, PROJECT_CODE: { state: 'PENDING' } } });
    expect(by(done)).toMatchObject({ bucket: 'DONE', codes: { CLIENT_CODE: { state: 'CONFIRMED', code: 'CLI-ST01' }, PROJECT_CODE: { state: 'CONFIRMED', code: '31313131' } } });
    expect(all.meta.counts.ALL).toBe(all.data.length);
    const onlyTodo = await list('?bucket=TODO&limit=50');
    expect(onlyTodo.data.every((i: { bucket: string }) => i.bucket === 'TODO')).toBe(true);
    expect(onlyTodo.data.map((i: { orderId: string }) => i.orderId)).toContain(todo);
    expect((await list('?q=' + by(done).orderNo)).data.map((i: { orderId: string }) => i.orderId)).toContain(done);
    expect((await list('?q=zzzz-nothing')).data).toEqual([]);
    expect((await list('?limit=50', 'CS2')).data).toEqual([]);
    expect((await api().get('/api/v1/sales/codes/orders').set(as('BD'))).status).toBe(403);
    expect((await api().get('/api/v1/sales/codes/orders?bucket=NOPE').set(as('CS'))).status).toBe(422);
  });
});
