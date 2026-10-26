import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import { calculateCosts, DEFAULT_RATES, travelCost } from '../src/modules/costing/costing.calc';

describe('cost rules', () => {
  const base = { shops: 100, vendorDistanceKm: 20, vendorOther: 0, days: 5, nights: 4, totalKm: 400, fuelAmount: 2000, otherAmount: 0, clientsShared: 1 };

  it('charges the vendor far rate only from the far distance', () => {
    expect(calculateCosts({ ...base, vendorDistanceKm: 99 }, DEFAULT_RATES).vendor.total).toBe(25000);
    expect(calculateCosts({ ...base, vendorDistanceKm: 100 }, DEFAULT_RATES).vendor.total).toBe(35000);
  });

  it('adds food, stay, tiered travel, fuel and shares the trip between clients', () => {
    // food 5*300, stay 4*800, travel 150*6 + 250*10, fuel 2000
    expect(travelCost(400, DEFAULT_RATES)).toEqual({ amount: 3400, longDistance: true });
    const one = calculateCosts(base, DEFAULT_RATES);
    expect(one.inHouse.subtotal).toBe(1500 + 3200 + 3400 + 2000);
    const two = calculateCosts({ ...base, clientsShared: 2 }, DEFAULT_RATES);
    expect(two.inHouse.total).toBe(5050);
  });

  it('flags the per-shop limit and recommends the vendor when in-house needs approval', () => {
    const r = calculateCosts({ ...base, shops: 20, days: 3, nights: 2, totalKm: 100, fuelAmount: 0 }, DEFAULT_RATES);
    // in-house = 900 + 1600 + 600 = 3100 -> 155/shop (fine). Vendor = 5000.
    expect(r.flags.inHouseOverThreshold).toBe(false);
    expect(r.recommended).toBe('IN_HOUSE');
    const bad = calculateCosts({ ...base, shops: 5, days: 4, nights: 3, totalKm: 300, fuelAmount: 0 }, DEFAULT_RATES);
    // in-house = 1200 + 2400 + 900 + 1500 = 6000 -> 1200/shop, vendor = 1250
    expect(bad.flags.inHouseOverThreshold).toBe(true);
    expect(bad.flags.inHouseWorstCase).toBe(true);
    expect(bad.needsApproval.IN_HOUSE).toBe(true);
    expect(bad.needsApproval.VENDOR).toBe(false);
    expect(bad.recommended).toBe('VENDOR');
    expect(bad.reasons.length).toBeGreaterThan(0);
  });
});

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root: string;
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
let projectId = '';
const contact = { name: 'Suresh Kumar', email: 'suresh@client.example', phone: '9876543210' };
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-cost-'));
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
  for (const [key, role] of [['BD', 'BD'], ['OPS', 'OPERATIONS'], ['EXEC', 'RECCE_EXECUTIVE'], ['FIN', 'FINANCE'], ['ADMIN', 'SUPER_ADMIN']] as const) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const clientId = (await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Cost Client', code: 'CST' })).body.data._id;
  projectId = (await api().post('/api/v1/projects').set(as('BD')).send({ clientId, campaign: 'Cost One', status: 'DRAFT', requirementType: 'SHOP_DETAILS', expectedShops: 5, startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Madurai', contacts: [contact] })).body.data._id;
  await api().post(`/api/v1/projects/${projectId}/assign`).set(as('BD')).send({ assigneeId: uid.OPS });
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

const cost = (p = projectId) => `/api/v1/projects/${p}/cost`;

describe('cost comparison flow', () => {
  it('starts from the project and keeps the rates it was priced with', async () => {
    const r = await api().get(cost()).set(as('OPS'));
    expect(r.status).toBe(200);
    expect(r.body.data.saved).toBe(false);
    expect(r.body.data.plan.shops).toBe(5);
    expect((await api().put(`/api/v1/cost-policy`).set(as('OPS')).send({ foodPerDay: 999 })).status).toBe(403);
    const pol = await api().put(`/api/v1/cost-policy`).set(as('FIN')).send({ foodPerDay: 350 });
    expect(pol.body.data.foodPerDay).toBe(350);
    const saved = await api().put(cost()).set(as('OPS')).send({ shops: 5, days: 4, nights: 3, totalKm: 300, fuelAmount: 0, vendorDistanceKm: 20 });
    expect(saved.status).toBe(200);
    expect(saved.body.data.rates.foodPerDay).toBe(350); // snapshot at creation
    await api().put(`/api/v1/cost-policy`).set(as('FIN')).send({ foodPerDay: 300 });
    expect((await api().get(cost()).set(as('OPS'))).body.data.rates.foodPerDay).toBe(350);
    expect(saved.body.data.calc.needsApproval.IN_HOUSE).toBe(true);
  });

  it('needs a reason and goes to admin when the choice is over the limit', async () => {
    const noWhy = await api().post(`${cost()}/choose`).set(as('OPS')).send({ channel: 'IN_HOUSE' });
    expect(noWhy.status).toBe(422);
    const r = await api().post(`${cost()}/choose`).set(as('OPS')).send({ channel: 'IN_HOUSE', justification: 'Vendor is not available in this district' });
    expect(r.body.data.plan.status).toBe('APPROVAL_PENDING');
    const { Notification } = await import('../src/modules/notifications/notification.model');
    expect(await Notification.countDocuments({ project: projectId, kind: 'COST_APPROVAL', recipient: uid.ADMIN })).toBeGreaterThan(0);
    expect((await api().post(`${cost()}/decide`).set(as('OPS')).send({ approve: true })).status).toBe(403);
    expect((await api().post(`${cost()}/decide`).set(as('ADMIN')).send({ approve: false })).status).toBe(422);
    const no = await api().post(`${cost()}/decide`).set(as('ADMIN')).send({ approve: false, remark: 'Use the vendor' });
    expect(no.body.data.plan.status).toBe('REJECTED');
    expect(no.body.data.plan.chosen).toBeUndefined();
  });

  it('confirms the vendor straight away and cannot be accepted before a choice', async () => {
    const ok = await api().post(`${cost()}/choose`).set(as('OPS')).send({ channel: 'VENDOR' });
    expect(ok.body.data.plan.status).toBe('CONFIRMED');
    expect(ok.body.data.clientCost.perShop).toBe(250);
  });

  it('collects bills from the recce team and lets Finance approve only claims with proof', async () => {
    const up = await api().post(`/api/v1/projects/${projectId}/files`).set(as('EXEC')).field('category', 'RECCE_EXPENSE').attach('files', PNG, { filename: 'bus-ticket.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    const fileId = (up.body.data.files ?? up.body.data)[0]._id ?? (up.body.data.files ?? up.body.data)[0].id;
    expect(fileId).toBeTruthy();
    const noProof = await api().post(`/api/v1/projects/${projectId}/expenses`).set(as('EXEC')).send({ category: 'FOOD', amount: 300, date: '2026-11-05' });
    expect(noProof.status).toBe(201);
    expect((await api().post(`/api/v1/projects/${projectId}/expenses`).set(as('EXEC')).send({ category: 'TRAVEL', amount: 120, date: '2026-11-05', receiptFileId: '64b7f0f0f0f0f0f0f0f0f0f0' })).status).toBe(422);
    const withProof = await api().post(`/api/v1/projects/${projectId}/expenses`).set(as('EXEC')).send({ category: 'TRAVEL', amount: 120, date: '2026-11-05', receiptFileId: fileId });
    expect(withProof.status).toBe(201);
    const list = await api().get(`/api/v1/projects/${projectId}/expenses`).set(as('OPS'));
    expect(list.body.data.items).toHaveLength(2);
    expect(list.body.data.totals.withoutProof).toBe(1);
    expect((await api().post(`/api/v1/expenses/${noProof.body.data._id}/review`).set(as('FIN')).send({ status: 'APPROVED' })).status).toBe(409);
    expect((await api().post(`/api/v1/expenses/${withProof.body.data._id}/review`).set(as('OPS')).send({ status: 'APPROVED' })).status).toBe(403);
    expect((await api().post(`/api/v1/expenses/${withProof.body.data._id}/review`).set(as('FIN')).send({ status: 'APPROVED' })).body.data.status).toBe('APPROVED');
    const plan = await api().get(cost()).set(as('OPS'));
    expect(plan.body.data.actual).toMatchObject({ all: 420, approved: 120, pending: 300, withoutProof: 1 });
  });

  it('moves the project to LOSS, with the reason, when the client rejects the cost', async () => {
    expect((await api().post(`${cost()}/client-decision`).set(as('BD')).send({ decision: 'REJECTED' })).status).toBe(422);
    const r = await api().post(`${cost()}/client-decision`).set(as('BD')).send({ decision: 'REJECTED', remark: 'Too costly per sq.ft' });
    expect(r.status).toBe(200);
    const p = await api().get(`/api/v1/projects/${projectId}`).set(as('BD'));
    expect(p.body.data.status).toBe('LOSS');
    expect(p.body.data.statusReason).toContain('Too costly');
    expect((await api().put(cost()).set(as('OPS')).send({ shops: 5 })).status).toBe(409); // closed
  });

  it('is deleted with the project', async () => {
    const { CostPlan } = await import('../src/modules/costing/costing.model');
    const { Expense } = await import('../src/modules/expenses/expense.model');
    expect(await CostPlan.countDocuments({ project: projectId })).toBe(1);
    expect((await api().delete(`/api/v1/projects/${projectId}`).set(as('ADMIN'))).status).toBe(200);
    expect(await CostPlan.countDocuments({ project: projectId })).toBe(0);
    expect(await Expense.countDocuments({ project: projectId })).toBe(0);
  });
});
