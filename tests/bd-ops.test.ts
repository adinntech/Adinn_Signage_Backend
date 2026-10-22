import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root: string;
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
let clientId = '';

const contact = (over: Record<string, unknown> = {}) => ({ name: 'Suresh Kumar', email: 'suresh@client.example', phone: '9876543210', ...over });
let seq = 0;
const projectBody = (over: Record<string, unknown> = {}) => ({
  clientId,
  campaign: `Campaign ${++seq}`,
  status: 'DRAFT',
  requirementType: 'SHOP_DETAILS',
  expectedShops: 50,
  startDate: '2026-11-01',
  targetDate: '2026-11-30',
  district: 'Dindigul',
  contacts: [contact()],
  ...over,
});
const create = (over: Record<string, unknown> = {}, role = 'BD') => api().post('/api/v1/projects').set(as(role)).send(projectBody(over));
const assign = (id: string, assigneeId = uid.OPERATIONS!, role = 'BD') => api().post(`/api/v1/projects/${id}/assign`).set(as(role)).send({ assigneeId });
const stage = (id: string, s: string, role = 'OPERATIONS') => api().post(`/api/v1/projects/${id}/stage`).set(as(role)).send({ stage: s });
const addSite = (pid: string, over: Record<string, unknown> = {}, role = 'OPERATIONS') =>
  api().post(`/api/v1/projects/${pid}/sites`).set(as(role)).send({ shopName: `Shop ${++seq}`, dealerName: 'Dealer', district: 'Dindigul', mobile: '9843011122', ...over });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-bdops-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  const users: [string, string][] = [['BD', 'BD'], ['OPS1', 'OPERATIONS'], ['OPERATIONS', 'OPERATIONS'], ['FINANCE', 'FINANCE'], ['RECCE_EXECUTIVE', 'RECCE_EXECUTIVE']];
  for (const [key, role] of users) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role: role as 'BD', passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  clientId = (await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Amul Dairy', code: 'AMUL' })).body.data._id;
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('mobile number validation (10 digits)', () => {
  const clientWith = (phone: string, name = `C${++seq}`) =>
    api().post('/api/v1/clients').set(as('BD')).send({ name, code: `X${seq}`.slice(0, 8), contacts: [{ name: 'A Person', phone }] });

  it('rejects numbers that are not exactly 10 digits or do not start with 6-9', async () => {
    for (const bad of ['12345', '98765432', '987654321012', '5876543210', 'abcdefghij', '98765 4321']) {
      const r = await clientWith(bad);
      expect(r.status, bad).toBe(422);
      expect(JSON.stringify(r.body.error.details)).toContain('10 digits');
    }
  });

  it('accepts and normalises common ways of typing a number', async () => {
    for (const good of ['9876543210', '+91 98765 43210', '098765-43210', '91 9876543210']) {
      const r = await clientWith(good);
      expect(r.status, good).toBe(201);
      expect(r.body.data.contacts[0].phone).toBe('9876543210');
    }
  });

  it('treats a blank phone as not provided', async () => {
    expect((await clientWith('')).status).toBe(201);
  });

  it('requires a valid mobile and email on every project contact', async () => {
    expect((await create({ contacts: [contact({ phone: '12345' })] })).status).toBe(422);
    expect((await create({ contacts: [contact({ phone: '' })] })).status).toBe(422);
    expect((await create({ contacts: [contact({ email: 'not-an-email' })] })).status).toBe(422);
    expect((await create({ contacts: [contact({ name: 'A' })] })).status).toBe(422);
  });

  it('rejects the same mobile or email twice in one project', async () => {
    const r = await create({ contacts: [contact(), contact({ name: 'Other Person', email: 'other@client.example' })] });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body.error.details)).toMatch(/contacts\.1\.phone/);
    const e = await create({ contacts: [contact(), contact({ name: 'Other Person', phone: '9123456780' })] });
    expect(e.status).toBe(422);
    expect(JSON.stringify(e.body.error.details)).toMatch(/contacts\.1\.email/);
  });

  it('applies the same rule to communication participants', async () => {
    const p = await create();
    const put = (phone: string) =>
      api().put(`/api/v1/communications/projects/${p.body.data._id}/channels/INTERNAL`).set(as('BD')).send({ participants: [{ name: 'Raj', phone }] });
    const bad = await put('123');
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body.error.details)).toContain('10 digits');
    expect((await put('+91 98765 43210')).status).toBe(200);
  });
});

describe('duplicate checks against the database', () => {
  it('rejects a client name that already exists, ignoring case, spacing and punctuation', async () => {
    for (const name of ['AMUL DAIRY', 'amul  dairy', 'Amul-Dairy']) {
      const r = await api().post('/api/v1/clients').set(as('BD')).send({ name, code: `D${++seq}` });
      expect(r.status, name).toBe(409);
      expect(r.body.error.message).toContain('already exists');
    }
  });

  it('rejects a duplicate client code and a duplicate GSTIN', async () => {
    expect((await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Other Name', code: 'AMUL' })).status).toBe(409);
    const g = '33AAACA2094M1ZK';
    expect((await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Gst One', code: 'GST1', gstin: g })).status).toBe(201);
    const dup = await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Gst Two', code: 'GST2', gstin: g });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toContain('GSTIN');
  });

  it('rejects renaming a client to another client\'s name but allows keeping its own', async () => {
    const a = await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Rename Me', code: 'RNM' });
    const id = a.body.data._id;
    expect((await api().patch(`/api/v1/clients/${id}`).set(as('BD')).send({ name: 'Amul Dairy' })).status).toBe(409);
    expect((await api().patch(`/api/v1/clients/${id}`).set(as('BD')).send({ name: 'Rename Me' })).status).toBe(200);
  });

  it('rejects a duplicate project code and a duplicate campaign for the same client', async () => {
    const a = await create({ code: 'p-2207-0001', campaign: 'Unique Launch' });
    expect(a.status).toBe(201);
    expect(a.body.data.code).toBe('P-2207-0001');
    expect((await create({ code: 'P-2207-0001' })).status).toBe(409);
    const camp = await create({ campaign: 'unique   LAUNCH' });
    expect(camp.status).toBe(409);
    expect(camp.body.error.message).toContain('Unique Launch');
  });

  it('lets a cancelled project\'s campaign name be reused', async () => {
    const a = await create({ campaign: 'Reusable Name' });
    await api().patch(`/api/v1/projects/${a.body.data._id}/status`).set(as('BD')).send({ status: 'CANCELLED', reason: 'client withdrew' });
    expect((await create({ campaign: 'Reusable Name' })).status).toBe(201);
  });

  it('rejects an invalid project code and an end date before the start date', async () => {
    expect((await create({ code: 'a b' })).status).toBe(422);
    expect((await create({ code: '12' })).status).toBe(422);
    const d = await create({ startDate: '2026-12-10', targetDate: '2026-12-01' });
    expect(d.status).toBe(422);
    expect(JSON.stringify(d.body.error.details)).toContain('End date');
  });

  it('rejects editing a campaign into a duplicate', async () => {
    const a = await create({ campaign: 'Edit Dup A' });
    await create({ campaign: 'Edit Dup B' });
    expect((await api().patch(`/api/v1/projects/${a.body.data._id}`).set(as('BD')).send({ campaign: 'Edit Dup B' })).status).toBe(409);
  });

  it('rejects the same site twice and editing a site into a duplicate', async () => {
    const p = await create();
    const pid = p.body.data._id;
    expect((await addSite(pid, { shopName: 'Dup Shop', dealerName: 'Raj', district: 'Salem' }, 'BD')).status).toBe(201);
    expect((await addSite(pid, { shopName: 'dup shop', dealerName: 'RAJ', district: 'salem' }, 'BD')).status).toBe(409);
    const other = await addSite(pid, { shopName: 'Other Shop', dealerName: 'Raj', district: 'Salem' }, 'BD');
    const r = await api().patch(`/api/v1/sites/${other.body.data.site._id}`).set(as('BD')).send({ shopName: 'Dup Shop' });
    expect(r.status).toBe(409);
  });

  it('rejects a site with a bad mobile number', async () => {
    const p = await create();
    const r = await addSite(p.body.data._id, { mobile: '12345' }, 'BD');
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body.error.details)).toMatch(/mobile/i);
  });

  it('rejects uploading the same file twice to the same project', async () => {
    const p = await create();
    const pid = p.body.data._id;
    const xlsx = Buffer.concat([Buffer.from('PK'), Buffer.alloc(80, 7)]);
    const up = (buf: Buffer, name: string) => api().post(`/api/v1/projects/${pid}/files`).set(as('BD')).field('category', 'BD_CLIENT_DETAILS').attach('files', buf, { filename: name });
    expect((await up(xlsx, 'a.xlsx')).status).toBe(201);
    const dup = await up(xlsx, 'renamed-copy.xlsx');
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toContain('already uploaded');
    expect((await up(Buffer.concat([Buffer.from('PK'), Buffer.alloc(80, 9)]), 'b.xlsx')).status).toBe(201);
  });
});

describe('BD -> Operations assignment', () => {
  it('lets BD save an incomplete draft but refuses to assign it', async () => {
    const d = await api().post('/api/v1/projects').set(as('BD')).send({ clientId, campaign: 'Bare draft', status: 'DRAFT' });
    expect(d.status).toBe(201);
    expect(d.body.data.status).toBe('DRAFT');
    const r = await assign(d.body.data._id);
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/requirement type.*start date.*end date.*district.*contact/);
  });

  it('requires a shop count for shop projects but not for ASO', async () => {
    const shops = await create({ expectedShops: undefined });
    expect((await assign(shops.body.data._id)).status).toBe(422);
    const aso = await create({ requirementType: 'ASO', expectedShops: undefined });
    expect(aso.body.data.expectedShops ?? null).toBeNull();
    expect((await assign(aso.body.data._id)).status).toBe(200);
  });

  it('assigns to an Operations user, moves the status and is idempotent', async () => {
    const p = await create();
    const id = p.body.data._id;
    const a = await assign(id);
    expect(a.status).toBe(200);
    expect(a.body.data.status).toBe('RECCE_ASSIGNED');
    expect(a.body.data.assignedTo.name).toBe('OPERATIONS');
    const again = await assign(id);
    expect(again.status).toBe(200);
    const audit = await api().get(`/api/v1/projects/${id}/history`).set(as('BD'));
    expect(audit.body.data.filter((x: { action: string }) => x.action === 'ASSIGN')).toHaveLength(1);
  });

  it('only allows active Operations / Coordinator users as assignees, and only BD can assign', async () => {
    const p = await create();
    const id = p.body.data._id;
    expect((await assign(id, uid.FINANCE)).status).toBe(400);
    expect((await assign(id, uid.RECCE_EXECUTIVE)).status).toBe(400);
    expect((await assign(id, uid.OPS1, 'OPERATIONS')).status).toBe(403);
    expect((await assign(id, uid.OPS1, 'FINANCE')).status).toBe(403);
    expect((await assign('64b000000000000000000000')).status).toBe(404);
  });

  it('lists assignees for BD only', async () => {
    const r = await api().get('/api/v1/projects/assignees').set(as('BD'));
    expect(r.status).toBe(200);
    expect(r.body.data.map((u: { name: string }) => u.name).sort()).toEqual(['OPERATIONS', 'OPS1']);
    expect((await api().get('/api/v1/projects/assignees').set(as('OPERATIONS'))).status).toBe(403);
  });

  it('shows assigned projects to Operations through the list filters', async () => {
    const r = await api().get('/api/v1/projects?assigned=true&limit=100').set(as('OPERATIONS'));
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThan(0);
    expect(r.body.data.every((p: { assignedTo: unknown }) => !!p.assignedTo)).toBe(true);
    const mine = await api().get(`/api/v1/projects?assigneeId=${uid.OPERATIONS}&statuses=RECCE_ASSIGNED,PLANNING&limit=100`).set(as('OPERATIONS'));
    expect(mine.body.data.every((p: { status: string }) => ['RECCE_ASSIGNED', 'PLANNING'].includes(p.status))).toBe(true);
  });

  it('deletes only unassigned drafts', async () => {
    const draft = await create();
    expect((await api().delete(`/api/v1/projects/${draft.body.data._id}`).set(as('BD'))).status).toBe(200);
    expect((await api().get(`/api/v1/projects/${draft.body.data._id}`).set(as('BD'))).status).toBe(404);
    const assigned = await create();
    await assign(assigned.body.data._id);
    const r = await api().delete(`/api/v1/projects/${assigned.body.data._id}`).set(as('BD'));
    expect(r.status).toBe(409);
    expect((await api().delete(`/api/v1/projects/${draft.body.data._id}`).set(as('OPERATIONS'))).status).toBe(403);
  });

});

describe('Operations stages', () => {
  const assigned = async (over: Record<string, unknown> = {}) => {
    const p = await create(over);
    await assign(p.body.data._id);
    return p.body.data._id as string;
  };

  it('moves one step at a time and refuses to skip', async () => {
    const id = await assigned();
    expect((await stage(id, 'COMPLETED')).status).toBe(409);
    expect((await stage(id, 'PLANNING')).body.data.status).toBe('PLANNING');
    expect((await stage(id, 'PLANNING')).status).toBe(200); // idempotent
    expect((await stage(id, 'CLIENT_APPROVAL')).status).toBe(409);
  });

  it('only users who can verify may move the stage', async () => {
    const id = await assigned();
    expect((await stage(id, 'PLANNING', 'BD')).status).toBe(403);
    expect((await stage(id, 'PLANNING', 'FINANCE')).status).toBe(403);
  });

  it('will not start the recce without shops, and does start once shops exist', async () => {
    const id = await assigned();
    await stage(id, 'PLANNING');
    const none = await stage(id, 'IN_PROGRESS');
    expect(none.status).toBe(409);
    expect(none.body.error.message).toContain('shops');
    await addSite(id);
    expect((await stage(id, 'IN_PROGRESS')).body.data.status).toBe('IN_PROGRESS');
    expect((await stage(id, 'CLIENT_APPROVAL')).body.data.status).toBe('CLIENT_APPROVAL');
    expect((await stage(id, 'COMPLETED')).body.data.status).toBe('COMPLETED');
  });

  it('ASO projects need a survey area instead of shops', async () => {
    const id = await assigned({ requirementType: 'ASO', expectedShops: undefined });
    await stage(id, 'PLANNING');
    expect((await stage(id, 'IN_PROGRESS')).status).toBe(409);
    const a = await api().post(`/api/v1/projects/${id}/survey-areas`).set(as('OPERATIONS')).send({ area: 'Srirangam', shopsFound: 12, notes: 'Met the ASO' });
    expect(a.status).toBe(201);
    expect((await stage(id, 'IN_PROGRESS')).status).toBe(200);
  });

  it('shop + measurement projects need both approvals on every shop before the recce', async () => {
    const id = await assigned({ requirementType: 'SHOP_MEASUREMENT' });
    await stage(id, 'PLANNING');
    const s = await addSite(id, { width: 10, height: 4, scenario: 'CLIENT_PROVIDED' });
    const sid = s.body.data.site._id;
    const blocked = await stage(id, 'IN_PROGRESS');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('both approvals');
    const ops = await api().post(`/api/v1/sites/${sid}/approval`).set(as('OPERATIONS')).send({ level: 'ops', value: 'APPROVED' });
    expect(ops.status).toBe(200);
    expect((await stage(id, 'IN_PROGRESS')).status).toBe(409); // BD level still pending
    const bd = await api().post(`/api/v1/sites/${sid}/approval`).set(as('BD')).send({ level: 'bd', value: 'APPROVED' });
    expect(bd.status).toBe(200);
    expect((await stage(id, 'IN_PROGRESS')).status).toBe(200);
  });
});

describe('two-level shop approvals', () => {
  let pid = '';
  const shop = async (over: Record<string, unknown> = {}) =>
    (await addSite(pid, { width: 10, height: 4, boardType: 'GSB', scenario: 'CLIENT_PROVIDED', ...over })).body.data.site._id as string;
  const approve = (sid: string, level: string, value: string, role: string, note?: string) =>
    api().post(`/api/v1/sites/${sid}/approval`).set(as(role)).send({ level, value, ...(note ? { note } : {}) });

  beforeAll(async () => {
    const p = await create({ requirementType: 'SHOP_MEASUREMENT' });
    pid = p.body.data._id;
    await assign(pid);
  });

  it('keeps the levels independent: each side can approve only its own', async () => {
    const sid = await shop();
    expect((await approve(sid, 'bd', 'APPROVED', 'OPERATIONS')).status).toBe(403);
    expect((await approve(sid, 'ops', 'APPROVED', 'BD')).status).toBe(403);
    expect((await approve(sid, 'ops', 'APPROVED', 'FINANCE')).status).toBe(403);
    expect((await approve(sid, 'ops', 'APPROVED', 'OPERATIONS')).body.data.opsApproval).toBe('APPROVED');
    const list = await api().get(`/api/v1/projects/${pid}/sites`).set(as('BD'));
    const row = list.body.data.find((s: { _id: string }) => s._id === sid);
    expect(row.opsApproval).toBe('APPROVED');
    expect(row.bdApproval).toBe('PENDING');
  });

  it('needs a note to request a correction and a measurement to approve', async () => {
    const sid = await shop();
    expect((await approve(sid, 'ops', 'CORRECTION', 'OPERATIONS')).status).toBe(422);
    const c = await approve(sid, 'ops', 'CORRECTION', 'OPERATIONS', 'Width looks wrong');
    expect(c.body.data.opsApproval).toBe('CORRECTION');
    expect(c.body.data.approvalNote).toBe('Width looks wrong');
    // A shop that was never measured cannot be approved either.
    const noSize = (await addSite(pid, { scenario: 'MEASUREMENT_REQUIRED' })).body.data.site._id;
    const unmeasured = await approve(noSize, 'ops', 'APPROVED', 'OPERATIONS');
    expect(unmeasured.status).toBe(200); // measured-on-site shops may be approved before measurement
  });

  it('sends a shop back to pending on both levels when its size changes', async () => {
    const sid = await shop();
    await approve(sid, 'ops', 'APPROVED', 'OPERATIONS');
    await approve(sid, 'bd', 'APPROVED', 'BD');
    const r = await api().patch(`/api/v1/sites/${sid}`).set(as('OPERATIONS')).send({ width: 12 });
    expect(r.body.data.site.opsApproval).toBe('PENDING');
    expect(r.body.data.site.bdApproval).toBe('PENDING');
    // changing only the remarks does not reset an approval
    await approve(sid, 'ops', 'APPROVED', 'OPERATIONS');
    const same = await api().patch(`/api/v1/sites/${sid}`).set(as('OPERATIONS')).send({ remarks: 'note only' });
    expect(same.body.data.site.opsApproval).toBe('APPROVED');
  });

  it('approves all pending shops that have a measurement, leaving corrections alone', async () => {
    const p = await create({ requirementType: 'SHOP_MEASUREMENT' });
    const id = p.body.data._id;
    await assign(id);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await addSite(id, { width: 8, height: 3, scenario: 'CLIENT_PROVIDED' })).body.data.site._id);
    await approve(ids[2], 'ops', 'CORRECTION', 'OPERATIONS', 'recheck');
    const r = await api().post(`/api/v1/projects/${id}/sites/approve-all`).set(as('OPERATIONS')).send({ level: 'ops' });
    expect(r.body.data.approved).toBe(2);
    expect((await api().post(`/api/v1/projects/${id}/sites/approve-all`).set(as('OPERATIONS')).send({ level: 'bd' })).status).toBe(403);
  });
});

describe('ASO survey areas', () => {
  it('records areas, rejects duplicates and bad counts, and is ASO only', async () => {
    const p = await create({ requirementType: 'ASO', expectedShops: undefined });
    const id = p.body.data._id;
    await assign(id); // Operations can only work on a project assigned to them
    const ok = await api().post(`/api/v1/projects/${id}/survey-areas`).set(as('OPERATIONS')).send({ area: 'Srirangam', shopsFound: 4 });
    expect(ok.status).toBe(201);
    expect((await api().post(`/api/v1/projects/${id}/survey-areas`).set(as('OPERATIONS')).send({ area: ' srirangam ', shopsFound: 2 })).status).toBe(409);
    expect((await api().post(`/api/v1/projects/${id}/survey-areas`).set(as('OPERATIONS')).send({ area: 'Woraiyur', shopsFound: 2.5 })).status).toBe(422);
    expect((await api().post(`/api/v1/projects/${id}/survey-areas`).set(as('OPERATIONS')).send({ area: 'Woraiyur', shopsFound: -1 })).status).toBe(422);
    expect((await api().post(`/api/v1/projects/${id}/survey-areas`).set(as('BD')).send({ area: 'Woraiyur', shopsFound: 1 })).status).toBe(201);
    const upd = await api().patch(`/api/v1/projects/${id}/survey-areas/${ok.body.data._id}`).set(as('OPERATIONS')).send({ area: 'Srirangam', shopsFound: 9 });
    expect(upd.body.data.shopsFound).toBe(9);
    const dupEdit = await api().patch(`/api/v1/projects/${id}/survey-areas/${ok.body.data._id}`).set(as('OPERATIONS')).send({ area: 'Woraiyur', shopsFound: 9 });
    expect(dupEdit.status).toBe(409);
    expect((await api().get(`/api/v1/projects/${id}/survey-areas`).set(as('BD'))).body.data).toHaveLength(2);
    expect((await api().delete(`/api/v1/projects/${id}/survey-areas/${ok.body.data._id}`).set(as('OPERATIONS'))).status).toBe(200);
    const shopProject = await create();
    await assign(shopProject.body.data._id);
    expect((await api().post(`/api/v1/projects/${shopProject.body.data._id}/survey-areas`).set(as('OPERATIONS')).send({ area: 'X Area', shopsFound: 1 })).status).toBe(400);
  });
});

describe('Excel/CSV import never imports a row that is still in error', () => {
  const csv = (rows: string[]) => ['Shop Name,Dealer Name,District,Mobile,Width,Height', ...rows].join('\n');
  const stage = async (pid: string, body: string) => {
    const up = await api().post(`/api/v1/projects/${pid}/sites/imports`).set(as('OPERATIONS')).attach('file', Buffer.from(body), { filename: 's.csv' });
    expect(up.status).toBe(201);
    const batch = up.body.data.batch._id as string;
    const pv = await api().post(`/api/v1/projects/${pid}/sites/imports/${batch}/preview`).set(as('OPERATIONS')).send({ mapping: up.body.data.suggestedMapping, scenario: 'CLIENT_PROVIDED', defaultUnit: 'ft', duplicatePolicy: 'skip' });
    expect(pv.status).toBe(200);
    return { batch, summary: pv.body.data.summary };
  };
  const base = ['Good Shop,Raj,Salem,9843011122,10,4', 'Another Good,Raj,Salem,9843011133,8,3'];

  it('skips a row with an invalid mobile instead of importing it without one', async () => {
    const p = await create({ requirementType: 'SHOP_MEASUREMENT' });
    const pid = p.body.data._id;
    await assign(pid);
    const { batch, summary } = await stage(pid, csv([...base, 'Bad Mobile Shop,Raj,Salem,12345,5,5', 'Short Number Shop,Raj,Salem,98765,5,5']));
    expect(summary.error).toBe(2);
    const done = await api().post(`/api/v1/projects/${pid}/sites/imports/${batch}/commit`).set(as('OPERATIONS')).send({});
    expect(done.body.data.result).toMatchObject({ created: 2, errorRows: 2 });
    const sites = await api().get(`/api/v1/projects/${pid}/sites`).set(as('OPERATIONS'));
    const names = sites.body.data.map((s: { shopName: string }) => s.shopName);
    expect(names).toEqual(expect.arrayContaining(['Good Shop', 'Another Good']));
    expect(names).not.toContain('Bad Mobile Shop');
    expect(names).not.toContain('Short Number Shop');
  });

  it('imports the row once its mobile is corrected in the review step', async () => {
    const p = await create({ requirementType: 'SHOP_MEASUREMENT' });
    const pid = p.body.data._id;
    await assign(pid);
    const { batch } = await stage(pid, csv([...base, 'Fixed Later,Raj,Salem,12345,5,5']));
    const rows = await api().get(`/api/v1/projects/${pid}/sites/imports/${batch}/rows?state=ERROR`).set(as('OPERATIONS'));
    expect(rows.body.data).toHaveLength(1);
    const fix = await api().patch(`/api/v1/projects/${pid}/sites/imports/${batch}/rows/${rows.body.data[0]._id}`).set(as('OPERATIONS')).send({ mapped: { mobile: '9123456780' } });
    expect(fix.status).toBe(200);
    const done = await api().post(`/api/v1/projects/${pid}/sites/imports/${batch}/commit`).set(as('OPERATIONS')).send({});
    expect(done.body.data.result).toMatchObject({ created: 3, errorRows: 0 });
    const sites = await api().get(`/api/v1/projects/${pid}/sites`).set(as('OPERATIONS'));
    expect(sites.body.data.find((s: { shopName: string }) => s.shopName === 'Fixed Later').mobile).toBe('9123456780');
  });
});

describe('a cancelled project is read-only', () => {
  let pid = '';
  let siteId = '';
  const xlsx = () => Buffer.concat([Buffer.from('PK'), Buffer.alloc(60, 55)]);

  beforeAll(async () => {
    const p = await create({ requirementType: 'ASO', expectedShops: undefined });
    pid = p.body.data._id;
    await assign(pid);
    await api().post(`/api/v1/projects/${pid}/survey-areas`).set(as('OPERATIONS')).send({ area: 'Before cancel', shopsFound: 3 });
    siteId = (await addSite(pid, { shopName: 'Before Cancel Shop', dealerName: 'Raj', district: 'Salem' })).body.data.site._id;
    const c = await api().patch(`/api/v1/projects/${pid}/status`).set(as('BD')).send({ status: 'CANCELLED', reason: 'Client withdrew the campaign' });
    expect(c.status).toBe(200);
  });

  it('keeps the reason and shows up as its own status, with the assignee still able to read it', async () => {
    const g = await api().get(`/api/v1/projects/${pid}`).set(as('OPERATIONS'));
    expect(g.status).toBe(200);
    expect(g.body.data).toMatchObject({ status: 'CANCELLED', statusReason: 'Client withdrew the campaign' });
    const list = await api().get('/api/v1/projects?status=CANCELLED&assigned=true&limit=100').set(as('OPERATIONS'));
    expect(list.body.data.map((p: { _id: string }) => p._id)).toContain(pid);
    const s = await api().get('/api/v1/projects/summary').set(as('OPERATIONS'));
    expect(s.body.data.byStatus.CANCELLED).toBeGreaterThan(0);
  });

  it('refuses every change: stage, shops, imports, approvals, survey areas and uploads', async () => {
    const r = [
      await api().post(`/api/v1/projects/${pid}/stage`).set(as('OPERATIONS')).send({ stage: 'PLANNING' }),
      await addSite(pid, { shopName: 'After Cancel' }),
      await api().patch(`/api/v1/sites/${siteId}`).set(as('OPERATIONS')).send({ remarks: 'late edit' }),
      await api().delete(`/api/v1/sites/${siteId}`).set(as('OPERATIONS')),
      await api().post(`/api/v1/sites/${siteId}/duplicate`).set(as('OPERATIONS')),
      await api().post(`/api/v1/sites/${siteId}/approval`).set(as('OPERATIONS')).send({ level: 'ops', value: 'APPROVED' }),
      await api().post(`/api/v1/projects/${pid}/sites/approve-all`).set(as('OPERATIONS')).send({ level: 'ops' }),
      await api().post(`/api/v1/projects/${pid}/sites/imports`).set(as('OPERATIONS')).attach('file', Buffer.from('Shop Name\nX'), { filename: 'x.csv' }),
      await api().post(`/api/v1/projects/${pid}/survey-areas`).set(as('OPERATIONS')).send({ area: 'After cancel', shopsFound: 1 }),
      await api().post(`/api/v1/projects/${pid}/files`).set(as('BD')).field('category', 'BD_CLIENT_DETAILS').attach('files', xlsx(), { filename: 'late.xlsx' }),
    ];
    r.forEach((res, i) => {
      expect(res.status, `change ${i}`).toBe(409);
      expect(res.body.error.message, `change ${i}`).toMatch(/cancel/i);
    });
  });

  it('still lets people read what was recorded before the cancellation', async () => {
    expect((await api().get(`/api/v1/projects/${pid}/sites`).set(as('OPERATIONS'))).body.data).toHaveLength(1);
    expect((await api().get(`/api/v1/projects/${pid}/survey-areas`).set(as('OPERATIONS'))).body.data).toHaveLength(1);
  });
});
