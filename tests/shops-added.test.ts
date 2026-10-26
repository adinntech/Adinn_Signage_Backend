import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
let clientId = '';
let vendorId = '';
const contact = { name: 'Suresh Kumar', email: 'suresh@client.example', phone: '9876543210' };
const base = { status: 'DRAFT', startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Madurai', contacts: [contact] };

const waitFor = async (cond: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting');
};
const feed = async (who: string) => (await api().get('/api/v1/notifications').set(as(who))).body.data as { items: { kind: string; title: string; text: string; projectId: string; read: boolean }[]; unread: number };
const added = async (who: string) => (await feed(who)).items.filter((i) => i.kind === 'imported' && /shops? added|New shops assigned/.test(i.title));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  for (const [key, role] of [['BD', 'BD'], ['OPS', 'OPERATIONS'], ['REC', 'RECCE_EXECUTIVE'], ['REC2', 'RECCE_EXECUTIVE'], ['VEND', 'VENDOR'], ['VEND2', 'VENDOR']] as const) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  clientId = (await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Notify Client', code: 'NTF' })).body.data._id;
  vendorId = (await api().post('/api/v1/vendors').set(as('OPS')).send({ name: 'Madurai Boards', type: 'ORGANIZATION', mobile: '9000000031', district: 'Madurai' })).body.data._id;
  await api().put(`/api/v1/vendors/${vendorId}/kyc`).set(as('OPS')).send({ pan: true, gst: true, bank: true, address: true });
  await api().post(`/api/v1/vendors/${vendorId}/status`).set(as('OPS')).send({ status: 'ACTIVE' });
  await User.updateOne({ _id: uid.VEND }, { vendorId }); // this vendor login belongs to Madurai Boards; VEND2 belongs to nobody
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

describe('more shops for a job the recce person or vendor already has', () => {
  it('tells a recce person when Operations / BD add shops to their ASO job', async () => {
    const aso = (await api().post('/api/v1/projects').set(as('BD')).send({ ...base, clientId, campaign: 'Survey', requirementType: 'ASO' })).body.data._id as string;
    await api().post(`/api/v1/projects/${aso}/assign`).set(as('BD')).send({ assigneeId: uid.REC });
    for (let i = 1; i <= 3; i++) await api().post(`/api/v1/projects/${aso}/sites`).set(as('BD')).send({ shopName: `Shop ${i}`, dealerName: `Dealer ${i}`, district: 'Madurai', mobile: `98430111${20 + i}` });
    await waitFor(async () => (await added('REC')).length >= 3);
    const items = await added('REC');
    const latest = items[0]!;
    expect(latest.kind).toBe('imported');
    expect(latest.title).toContain('1 shop added');
    expect(latest.text).toContain('You now have 3 shops');
    expect(latest.projectId).toBe(aso);
    expect(items.some((i) => i.title.startsWith('New shops assigned'))).toBe(true);
    expect((await feed('REC')).unread).toBeGreaterThan(0);
    // the recce person's own entries are not news to them, and nobody else hears
    await api().post(`/api/v1/projects/${aso}/sites`).set(as('REC')).send({ shopName: 'Mine', dealerName: 'Me', district: 'Madurai', mobile: '9843011199' });
    await new Promise((r) => setTimeout(r, 150));
    expect((await added('REC')).length).toBe(3);
    expect((await added('REC2')).length).toBe(0);
  });

  it('tells a vendor "5 more shops, you now have 13" when more are allocated to them', async () => {
    const pid = (await api().post('/api/v1/projects').set(as('BD')).send({ ...base, clientId, campaign: 'Shop list', requirementType: 'SHOP_DETAILS', expectedShops: 13 })).body.data._id as string;
    await api().post(`/api/v1/projects/${pid}/assign`).set(as('BD')).send({ assigneeId: uid.OPS });
    const ids: string[] = [];
    for (let i = 1; i <= 13; i++) ids.push((await api().post(`/api/v1/projects/${pid}/sites`).set(as('OPS')).send({ shopName: `List ${i}`, dealerName: `Dealer L${i}`, district: 'Madurai', mobile: `98430122${String(10 + i)}` })).body.data.site._id);
    const alloc = (siteIds: string[], body: Record<string, unknown>) => api().post(`/api/v1/projects/${pid}/allocation/assign`).set(as('OPS')).send({ siteIds, ...body });

    expect((await alloc(ids.slice(0, 8), { channel: 'VENDOR', vendorId })).status).toBe(200);
    await waitFor(async () => (await added('VEND')).length >= 1);
    expect((await added('VEND'))[0]!.title).toBe('New shops assigned: ' + (await feed('VEND')).items[0]!.title.split(': ')[1]);
    expect((await added('VEND'))[0]!.text).toContain('8 shops');

    expect((await alloc(ids.slice(0, 13), { channel: 'VENDOR', vendorId })).status).toBe(200); // 8 of these already theirs
    await waitFor(async () => (await added('VEND')).length >= 2);
    const latest = (await added('VEND'))[0]!;
    expect(latest.title).toContain('5 shops added');
    expect(latest.text).toContain('You now have 13 shops');
    expect(latest.projectId).toBe(pid);
    // nothing new: no second message
    await alloc(ids.slice(0, 13), { channel: 'VENDOR', vendorId });
    await new Promise((r) => setTimeout(r, 150));
    expect((await added('VEND')).length).toBe(2);
    // a vendor login that belongs to another vendor hears nothing
    expect((await added('VEND2')).length).toBe(0);
  });

  it('tells the in-house recce team when shops are allocated to them', async () => {
    const pid = (await api().post('/api/v1/projects').set(as('BD')).send({ ...base, clientId, campaign: 'In-house', requirementType: 'SHOP_DETAILS', expectedShops: 4 })).body.data._id as string;
    await api().post(`/api/v1/projects/${pid}/assign`).set(as('BD')).send({ assigneeId: uid.OPS });
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) ids.push((await api().post(`/api/v1/projects/${pid}/sites`).set(as('OPS')).send({ shopName: `In ${i}`, dealerName: `Dealer I${i}`, district: 'Theni', mobile: `98430133${String(10 + i)}` })).body.data.site._id);
    expect((await api().post(`/api/v1/projects/${pid}/allocation/assign`).set(as('OPS')).send({ siteIds: ids, channel: 'IN_HOUSE' })).status).toBe(200);
    await waitFor(async () => (await added('REC2')).some((i) => i.projectId === pid));
    expect((await added('REC')).some((i) => i.projectId === pid)).toBe(true);
    expect((await added('OPS')).length).toBe(0); // the person who allocated is not told
  });
});
