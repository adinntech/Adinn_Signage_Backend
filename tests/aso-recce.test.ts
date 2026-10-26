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
let aso = '';
let other = '';
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
  for (const [key, role] of [['BD', 'BD'], ['REC', 'RECCE_EXECUTIVE'], ['REC2', 'RECCE_EXECUTIVE']] as const) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  clientId = (await api().post('/api/v1/clients').set(as('BD')).send({ name: 'ASO Client', code: 'ASC' })).body.data._id;
  aso = (await api().post('/api/v1/projects').set(as('BD')).send({ ...base, clientId, campaign: 'Area survey', requirementType: 'ASO' })).body.data._id;
  other = (await api().post('/api/v1/projects').set(as('BD')).send({ ...base, clientId, campaign: 'Shop list', requirementType: 'SHOP_DETAILS', expectedShops: 5 })).body.data._id;
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

describe('an ASO survey goes straight to the recce team', () => {
  it('can be given to a recce executive, with a notification, but only for ASO', async () => {
    expect((await api().post(`/api/v1/projects/${other}/assign`).set(as('BD')).send({ assigneeId: uid.REC })).status).toBe(400);
    const r = await api().post(`/api/v1/projects/${aso}/assign`).set(as('BD')).send({ assigneeId: uid.REC });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('RECCE_ASSIGNED');
    const { Notification } = await import('../src/modules/notifications/notification.model');
    await waitFor(async () => (await Notification.countDocuments({ project: aso, kind: 'PROJECT_ASSIGNED' })) > 0);
    const n = await Notification.findOne({ project: aso, kind: 'PROJECT_ASSIGNED' }).lean();
    expect(n?.title).toBe('New Recce Job Assigned');
    expect(String(n?.recipient)).toBe(uid.REC);
    expect(n?.body).toContain('add each shop');
    const a = await api().get('/api/v1/projects/assignees').set(as('BD'));
    expect(a.body.data.some((u: { role: string }) => u.role === 'RECCE_EXECUTIVE')).toBe(true);
  });

  it('shows the recce person only their own job, with an empty shop list to start', async () => {
    const mine = await api().get('/api/v1/projects').set(as('REC'));
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((p: { _id: string }) => p._id)).toEqual([aso]);
    expect((await api().get(`/api/v1/projects/${aso}/sites`).set(as('REC'))).body.data).toHaveLength(0);
    expect((await api().get(`/api/v1/projects/${aso}`).set(as('REC2'))).status).toBe(404);
    expect((await api().get('/api/v1/projects').set(as('REC2'))).body.data).toHaveLength(0);
  });

  it('lets them add each shop as they reach it, with their position', async () => {
    const r = await api().post(`/api/v1/projects/${aso}/sites`).set(as('REC')).send({ shopName: 'Murugan Stores', dealerName: 'Murugan', district: 'Madurai', mobile: '9843011122', gstin: '33AAACA2094M1ZK', lat: 9.9252, lng: 78.1198 });
    expect(r.status).toBe(201);
    const site = r.body.data.site;
    expect(site).toMatchObject({ lat: 9.9252, lng: 78.1198, geoQuality: 'GPS', scenario: 'MEASUREMENT_REQUIRED' });
    expect((await api().get(`/api/v1/projects/${aso}/sites`).set(as('REC'))).body.data).toHaveLength(1);
    expect((await api().patch(`/api/v1/sites/${site._id}`).set(as('REC')).send({ shopName: 'Murugan Stores & Co' })).status).toBe(200);
    expect((await api().post(`/api/v1/projects/${aso}/sites`).set(as('REC')).send({ shopName: 'No Phone', district: 'Madurai' })).status).toBe(201); // phone is only a warning, as in the web app
  });

  it('keeps them to their own project and their own shops', async () => {
    expect((await api().post(`/api/v1/projects/${aso}/sites`).set(as('REC2')).send({ shopName: 'X', dealerName: 'X', mobile: '9843011199' })).status).toBe(404);
    const bdSite = (await api().post(`/api/v1/projects/${aso}/sites`).set(as('BD')).send({ shopName: 'BD Added', dealerName: 'BD', mobile: '9843011188' })).body.data.site;
    expect((await api().patch(`/api/v1/sites/${bdSite._id}`).set(as('REC')).send({ shopName: 'Hijack' })).status).toBe(403);
    expect((await api().delete(`/api/v1/sites/${bdSite._id}`).set(as('REC')).send()).status).toBe(403);
    expect((await api().post(`/api/v1/projects/${aso}/sites/bulk`).set(as('REC')).send({ action: 'delete', ids: [bdSite._id] })).status).toBe(403);
    expect((await api().post(`/api/v1/projects/${other}/sites`).set(as('REC')).send({ shopName: 'X', dealerName: 'X', mobile: '9843011177' })).status).toBe(404);
  });
});

describe('recce staff see the job, not the commercial side', () => {
  it('cannot open costs, bills, board decisions, allocation or BD documents', async () => {
    for (const url of [`/api/v1/projects/${aso}/cost`, `/api/v1/projects/${aso}/expenses`, `/api/v1/projects/${aso}/boards`, `/api/v1/projects/${aso}/allocation`, `/api/v1/projects/${aso}/files?category=BD_CLIENT_DETAILS`, '/api/v1/cost-policy']) {
      expect((await api().get(url).set(as('REC'))).status, url).toBe(403);
    }
  });

  it('also sees a project that has in-house shops to visit', async () => {
    const { Site } = await import('../src/modules/sites/site.model');
    await Site.create({ project: other, siteCode: 'OTH-S001', seq: 1, scenario: 'MEASUREMENT_REQUIRED', shopName: 'In-house shop', channel: 'IN_HOUSE' });
    const ids = (await api().get('/api/v1/projects').set(as('REC2'))).body.data.map((p: { _id: string }) => p._id);
    expect(ids).toEqual([other]);
    expect((await api().get(`/api/v1/projects/${aso}`).set(as('REC2'))).status).toBe(404);
  });
});

describe('where to go', () => {
  it('BD gives the location and approximate shops, and the recce person sees them', async () => {
    const a = await api().post(`/api/v1/projects/${aso}/survey-areas`).set(as('BD')).send({ area: 'Theppakulam', address: 'Near Theppakulam bus stop, Madurai', approxShops: 25 });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ address: 'Near Theppakulam bus stop, Madurai', approxShops: 25, shopsFound: 0 });
    const mine = await api().get(`/api/v1/projects/${aso}/survey-areas`).set(as('REC'));
    expect(mine.status).toBe(200);
    expect(mine.body.data[0]).toMatchObject({ area: 'Theppakulam', address: 'Near Theppakulam bus stop, Madurai', approxShops: 25 });
    expect((await api().get(`/api/v1/projects/${aso}/survey-areas`).set(as('REC2'))).status).toBe(404);
    expect((await api().post(`/api/v1/projects/${aso}/survey-areas`).set(as('REC')).send({ area: 'Other' })).status).toBe(403); // recce staff only read the places
  });
});
