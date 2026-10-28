import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import { calculateLeg, DEFAULT_RATES, totalsOf, tripSpan } from '../src/modules/costing/costing.calc';

describe('trip time -> meals, days and nights', () => {
  it('counts the meals between start and end (breakfast 8:00, lunch 13:00, dinner 20:00)', () => {
    expect(tripSpan('2026-11-05T08:00', '2026-11-05T21:00')).toEqual({ valid: true, meals: 3, days: 1, nights: 0 });
    expect(tripSpan('2026-11-05T09:00', '2026-11-05T14:00')).toMatchObject({ meals: 1 }); // only lunch
    expect(tripSpan('2026-11-05T09:00', '2026-11-06T18:00')).toEqual({ valid: true, meals: 4, days: 2, nights: 1 });
    expect(tripSpan('2026-11-05T07:00', '2026-11-07T21:00')).toEqual({ valid: true, meals: 9, days: 3, nights: 2 });
  });
  it('treats a missing or reversed time as one ordinary day', () => {
    expect(tripSpan(undefined, undefined)).toEqual({ valid: false, meals: 3, days: 1, nights: 0 });
    expect(tripSpan('2026-11-06T09:00', '2026-11-05T09:00').valid).toBe(false);
  });
});

describe('cost of one area', () => {
  const leg = { shops: 10, distanceKm: 140, routeKm: 280, tripStart: '2026-11-05T08:00', tripEnd: '2026-11-06T20:00' };

  it('in-house = food by meals + stay by nights + fuel at ₹3 per km', () => {
    const r = calculateLeg(leg, DEFAULT_RATES);
    // 6 meals x 100, 1 night x 450, 280 km x 3
    expect(r.inHouse).toMatchObject({ meals: 6, nights: 1, food: 600, stay: 450, fuel: 840, total: 1890, perShop: 189 });
    expect(r.inHouse.datesAssumed).toBe(false);
  });

  it('shares the trip between clients and assumes a round trip when no route km is known', () => {
    expect(calculateLeg({ ...leg, clientsShared: 2 }, DEFAULT_RATES).inHouse.total).toBe(945);
    const noRoute = calculateLeg({ shops: 4, distanceKm: 50 }, DEFAULT_RATES);
    expect(noRoute.inHouse).toMatchObject({ routeKm: 100, fuel: 300, datesAssumed: true, meals: 3, stay: 0 });
  });

  it('vendor = ₹300 a shop (far rate from the far distance); a bargained price above ₹400 needs approval', () => {
    expect(calculateLeg({ shops: 10, distanceKm: 50 }, DEFAULT_RATES).vendor).toMatchObject({ perShopRate: 300, total: 3000, far: false });
    expect(calculateLeg({ shops: 10, distanceKm: 150 }, DEFAULT_RATES).vendor).toMatchObject({ perShopRate: 350, far: true });
    const ok = calculateLeg({ shops: 10, distanceKm: 50, vendorRate: 400 }, DEFAULT_RATES);
    expect(ok.vendor).toMatchObject({ perShop: 400, negotiated: true });
    expect(ok.needsApproval.VENDOR).toBe(false);
    const over = calculateLeg({ shops: 10, distanceKm: 50, vendorRate: 420 }, DEFAULT_RATES);
    expect(over.needsApproval.VENDOR).toBe(true);
    expect(over.reasons.join(' ')).toContain('Vendor price per shop');
    expect(calculateLeg({ shops: 10, distanceKm: 50, cardRate: 260 }, DEFAULT_RATES).vendor.perShopRate).toBe(260); // vendor's own rate card
  });

  it('flags an in-house trip that costs too much per shop, and then recommends the vendor', () => {
    const r = calculateLeg({ shops: 2, distanceKm: 150, routeKm: 300, tripStart: '2026-11-05T08:00', tripEnd: '2026-11-07T20:00' }, DEFAULT_RATES);
    expect(r.flags.inHouseOverThreshold).toBe(true);
    expect(r.flags.inHouseWorstCase).toBe(true);
    expect(r.needsApproval.IN_HOUSE).toBe(true);
    expect(r.needsApproval.VENDOR).toBe(false);
    expect(r.recommended).toBe('VENDOR');
  });

  it('adds up the areas that were chosen', () => {
    const a = { name: 'Madurai', shops: 10, channel: 'IN_HOUSE' as const, calc: calculateLeg(leg, DEFAULT_RATES) };
    const b = { name: 'Coimbatore', shops: 10, channel: 'VENDOR' as const, calc: calculateLeg({ shops: 10, distanceKm: 200, vendorRate: 420 }, DEFAULT_RATES) };
    const c = { name: 'Trichy', shops: 10, channel: null, calc: calculateLeg({ shops: 10, distanceKm: 60 }, DEFAULT_RATES) };
    const t = totalsOf([a, b, c]);
    expect(t).toMatchObject({ shops: 30, legs: 3, chosenLegs: 2, inHouseShops: 10, vendorShops: 10, needsApproval: true });
    expect(t.chosenTotal).toBe(1890 + 4200);
    expect(t.perShop).toBe(0); // not every area is chosen yet
    expect(totalsOf([{ ...c, channel: 'VENDOR' as const }]).perShop).toBe(300);
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
const siteIds: Record<string, string[]> = { Madurai: [], Coimbatore: [], Trichy: [] };
const vendor: Record<string, string> = {};
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
  process.env.ROUTING_URL = '';
  process.env.GEOCODER_URL = '';
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
  projectId = (await api().post('/api/v1/projects').set(as('BD')).send({ clientId, campaign: 'Three districts', status: 'DRAFT', requirementType: 'SHOP_DETAILS', expectedShops: 30, startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Madurai', contacts: [contact] })).body.data._id;
  await api().post(`/api/v1/projects/${projectId}/assign`).set(as('BD')).send({ assigneeId: uid.OPS });
  // 30 shops: 10 in each of three districts
  let n = 0;
  for (const district of ['Madurai', 'Coimbatore', 'Trichy']) {
    for (let i = 0; i < 10; i++) {
      n++;
      const r = await api().post(`/api/v1/projects/${projectId}/sites`).set(as('OPS')).send({ shopName: `${district} Store ${i + 1}`, dealerName: `Dealer ${n}`, district, mobile: `98430${String(10000 + n)}` });
      siteIds[district]!.push(r.body.data.site._id);
    }
  }
  // two active vendors
  for (const [key, name, mobile] of [['A', 'Coimbatore Signs', '9000000011'], ['B', 'Trichy Boards', '9000000012']] as const) {
    const v = (await api().post('/api/v1/vendors').set(as('OPS')).send({ name, type: 'ORGANIZATION', mobile, district: 'Coimbatore' })).body.data._id;
    await api().put(`/api/v1/vendors/${v}/kyc`).set(as('OPS')).send({ pan: true, gst: true, bank: true, address: true });
    await api().post(`/api/v1/vendors/${v}/status`).set(as('OPS')).send({ status: 'ACTIVE' });
    vendor[key] = v;
  }
}, 120_000);
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

const cost = (p = projectId) => `/api/v1/projects/${p}/cost`;
type Leg = { key: string; name: string; shops: number; channel?: string | null; deadline?: string; distanceKm: number; calc: { needsApproval: Record<string, boolean>; inHouse: { total: number; perShop: number }; vendor: { total: number; perShop: number; perShopRate: number } } };
const legsOf = (r: { body: { data: { plan: { legs: Leg[] } } } }) => r.body.data.plan.legs;
const body = (legs: Record<string, unknown>[]) => ({ legs });

describe('recce plan for a project with shops in three districts', () => {
  let legs: Leg[] = [];

  it('shows the shops by district before any plan exists', async () => {
    const r = await api().get(cost()).set(as('OPS'));
    expect(r.status).toBe(200);
    expect(r.body.data.saved).toBe(false);
    expect(r.body.data.districts.map((d: { name: string; shops: number }) => `${d.name}:${d.shops}`).sort()).toEqual(['Coimbatore:10', 'Madurai:10', 'Trichy:10']);
    expect(r.body.data.project.deadline).toBe('2026-12-01');
  });

  it('creates one area per district from the shops', async () => {
    const r = await api().post(`${cost()}/sync`).set(as('OPS'));
    expect(r.status).toBe(200);
    legs = legsOf(r);
    expect(legs).toHaveLength(3);
    expect(legs.map((l) => l.shops)).toEqual([10, 10, 10]);
    expect(legs[0]!.deadline).toBe('2026-12-01');
    expect(r.body.data.totals).toMatchObject({ shops: 30, legs: 3, chosenLegs: 0 });
  });

  it('prices each area both ways, with admin\'s rates', async () => {
    const mk = (l: Leg, over: Record<string, unknown>) => ({ key: l.key, name: l.name, district: l.name, shops: l.shops, distanceKm: 100, ...over });
    const [mad, coi, tri] = ['madurai', 'coimbatore', 'trichy'].map((k) => legs.find((l) => l.key === k)!);
    const r = await api().put(cost()).set(as('OPS')).send(body([
      mk(mad!, { distanceKm: 140, routeKm: 280, channel: 'IN_HOUSE', tripStart: '2026-11-05T08:00', tripEnd: '2026-11-06T20:00' }),
      mk(coi!, { distanceKm: 200, channel: 'VENDOR', vendorId: vendor.A, vendorRate: 420 }),
      mk(tri!, { distanceKm: 60, channel: 'VENDOR', vendorId: vendor.B }),
    ]));
    expect(r.status).toBe(200);
    const saved = legsOf(r);
    expect(saved.find((l) => l.key === 'madurai')!.calc.inHouse).toMatchObject({ total: 1890, perShop: 189 });
    expect(saved.find((l) => l.key === 'coimbatore')!.calc.vendor).toMatchObject({ total: 4200, perShop: 420 });
    expect(saved.find((l) => l.key === 'trichy')!.calc.vendor).toMatchObject({ total: 3000, perShopRate: 300 });
    expect(r.body.data.totals).toMatchObject({ chosenLegs: 3, inHouseShops: 10, vendorShops: 20, chosenTotal: 9090, perShop: 303, needsApproval: true });
    expect(r.body.data.clientCost).toMatchObject({ total: 9090, perShop: 303 });
  });

  it('refuses a vendor choice without a vendor, and an inactive vendor', async () => {
    const bad = await api().put(cost()).set(as('OPS')).send(body([{ key: 'x', name: 'X', shops: 3, channel: 'VENDOR' }]));
    expect(bad.status).toBe(422);
    const v = (await api().post('/api/v1/vendors').set(as('OPS')).send({ name: 'Pending Vendor', type: 'ONE_MAN', mobile: '9000000013' })).body.data._id;
    expect((await api().put(cost()).set(as('OPS')).send(body([{ key: 'x', name: 'X', shops: 3, channel: 'VENDOR', vendorId: v }]))).status).toBe(409);
    expect((await api().put(cost()).set(as('OPS')).send(body([{ key: 'x', name: 'X', shops: 3, tripStart: '2026-11-06T09:00', tripEnd: '2026-11-05T09:00' }]))).status).toBe(422);
  });

  it('sends a plan that breaks a limit to admin, and nothing is assigned until it is approved', async () => {
    // restore the three-area plan (the previous test used throw-away bodies that failed validation, so it is unchanged)
    const noWhy = await api().post(`${cost()}/submit`).set(as('OPS')).send({});
    expect(noWhy.status).toBe(422);
    const sub = await api().post(`${cost()}/submit`).set(as('OPS')).send({ justification: 'Only this vendor covers Coimbatore' });
    expect(sub.body.data.plan.status).toBe('APPROVAL_PENDING');
    const { Notification } = await import('../src/modules/notifications/notification.model');
    expect(await Notification.countDocuments({ project: projectId, kind: 'COST_APPROVAL', recipient: uid.ADMIN })).toBeGreaterThan(0);
    expect((await api().post(`${cost()}/assign`).set(as('OPS'))).status).toBe(409);
    expect((await api().post(`${cost()}/decide`).set(as('OPS')).send({ approve: true })).status).toBe(403);
    expect((await api().post(`${cost()}/decide`).set(as('ADMIN')).send({ approve: false })).status).toBe(422);
  });

  it('assigns each district\'s shops to its in-house team or vendor after approval', async () => {
    const ok = await api().post(`${cost()}/decide`).set(as('ADMIN')).send({ approve: true, remark: 'Fine for Coimbatore' });
    expect(ok.body.data.plan.status).toBe('APPROVED');
    const done = await api().post(`${cost()}/assign`).set(as('OPS'));
    expect(done.status).toBe(200);
    expect(done.body.data.assigned).toBe(30);
    expect(done.body.data.plan.status).toBe('ASSIGNED');
    const ov = (await api().get(`/api/v1/projects/${projectId}/allocation`).set(as('OPS'))).body.data;
    expect(ov.unassigned).toBe(0);
    const names = ov.teams.map((t: { name: string; shops: number }) => `${t.name}:${t.shops}`).sort();
    expect(names).toEqual(['Coimbatore Signs:10', 'In-house team:10', 'Trichy Boards:10']);
  });

  it('confirms straight away when everything is within the limits, and re-opens on any edit', async () => {
    const cur = legsOf(await api().get(cost()).set(as('OPS')));
    const fix = cur.map((l) => ({ key: l.key, name: l.name, district: l.name, shops: l.shops, distanceKm: l.distanceKm, channel: l.channel, vendorId: (l as unknown as { vendor?: string }).vendor ?? undefined, vendorRate: l.key === 'coimbatore' ? 380 : undefined, routeKm: l.key === 'madurai' ? 280 : undefined, tripStart: l.key === 'madurai' ? '2026-11-05T08:00' : undefined, tripEnd: l.key === 'madurai' ? '2026-11-06T20:00' : undefined }));
    const r = await api().put(cost()).set(as('OPS')).send(body(fix));
    expect(r.body.data.plan.status).toBe('DRAFT');
    expect(r.body.data.totals.needsApproval).toBe(false);
    const sub = await api().post(`${cost()}/submit`).set(as('OPS')).send({});
    expect(sub.body.data.plan.status).toBe('CONFIRMED');
    expect((await api().post(`${cost()}/assign`).set(as('OPS'))).body.data.plan.status).toBe('ASSIGNED');
  });

  it('works out the road route of one area from its shops', async () => {
    expect((await api().post(`${cost()}/legs/madurai/route`).set(as('OPS'))).status).toBe(409); // no start point yet
    await api().put(`/api/v1/projects/${projectId}/allocation/origin`).set(as('OPS')).send({ name: 'Madurai office', lat: 9.9252, lng: 78.1198 });
    expect((await api().post(`${cost()}/legs/madurai/route`).set(as('OPS'))).status).toBe(409); // shops have no position yet
    for (const [i, id] of siteIds.Madurai!.entries()) await api().put(`/api/v1/sites/${id}/coords`).set(as('OPS')).send({ lat: 9.9 + i * 0.02, lng: 78.1 + i * 0.01 });
    const r = await api().post(`${cost()}/legs/madurai/route`).set(as('OPS'));
    expect(r.status).toBe(200);
    expect(r.body.data.route).toMatchObject({ located: 10, missing: 0 });
    expect(r.body.data.route.days).toHaveLength(2); // 10 shops, 8 a day
    expect(r.body.data.route.days[0].googleUrl).toContain('https://www.google.com/maps/dir/');
    const madurai = legsOf(r).find((l) => l.key === 'madurai') as Leg & { routeKm: number };
    expect(madurai.routeKm).toBe(r.body.data.route.totalKm);
    expect(r.body.data.plan.status).toBe('DRAFT');
  });

  it('keeps the rates a plan started with until it is told to use the new ones', async () => {
    expect((await api().put('/api/v1/cost-policy').set(as('OPS')).send({ stayPerNight: 500 })).status).toBe(403);
    expect((await api().put('/api/v1/cost-policy').set(as('ADMIN')).send({ stayPerNight: 500, fuelRatePerKm: 4 })).body.data).toMatchObject({ stayPerNight: 500, fuelRatePerKm: 4 });
    expect((await api().get(cost()).set(as('OPS'))).body.data.rates.stayPerNight).toBe(450);
    const cur = legsOf(await api().get(cost()).set(as('OPS')));
    const re = await api().put(cost()).set(as('OPS')).send({ ...body(cur.map((l) => ({ key: l.key, name: l.name, district: l.name, shops: l.shops, distanceKm: l.distanceKm, channel: l.channel, vendorId: (l as unknown as { vendor?: string }).vendor ?? undefined }))), refreshRates: true });
    expect(re.body.data.rates).toMatchObject({ stayPerNight: 500, fuelRatePerKm: 4 });
  });
});

describe('bills from the recce team', () => {
  it('collects them and lets Finance approve only claims with proof', async () => {
    const up = await api().post(`/api/v1/projects/${projectId}/files`).set(as('ADMIN')).field('category', 'RECCE_EXPENSE').attach('files', PNG, { filename: 'bus-ticket.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    const first = (up.body.data.files ?? up.body.data)[0];
    const fileId = first._id ?? first.id;
    const noProof = await api().post(`/api/v1/projects/${projectId}/expenses`).set(as('OPS')).send({ category: 'FOOD', amount: 300, date: '2026-11-05' });
    expect(noProof.status).toBe(201);
    expect((await api().post(`/api/v1/projects/${projectId}/expenses`).set(as('OPS')).send({ category: 'TRAVEL', amount: 120, date: '2026-11-05', receiptFileId: '64b7f0f0f0f0f0f0f0f0f0f0' })).status).toBe(422);
    const withProof = await api().post(`/api/v1/projects/${projectId}/expenses`).set(as('OPS')).send({ category: 'TRAVEL', amount: 120, date: '2026-11-05', receiptFileId: fileId });
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
});

describe('the client\'s decision', () => {
  it('moves the project to LOSS, with the reason, when the client rejects the cost', async () => {
    const cur = legsOf(await api().get(cost()).set(as('OPS')));
    await api().put(cost()).set(as('OPS')).send(body(cur.map((l) => ({ key: l.key, name: l.name, district: l.name, shops: l.shops, distanceKm: l.distanceKm, channel: l.channel, vendorId: (l as unknown as { vendor?: string }).vendor ?? undefined }))));
    expect((await api().post(`${cost()}/client-decision`).set(as('BD')).send({ decision: 'ACCEPTED' })).status).toBe(409); // not confirmed yet
    expect((await api().post(`${cost()}/client-decision`).set(as('BD')).send({ decision: 'REJECTED' })).status).toBe(422);
    // BD talks to the client, so BD records the answer
    const ok = await api().post(`${cost()}/client-decision`).set(as('BD')).send({ decision: 'REJECTED', remark: 'Too costly per sq.ft' });
    expect(ok.status).toBe(200);
    const p = await api().get(`/api/v1/projects/${projectId}`).set(as('BD'));
    expect(p.body.data.status).toBe('LOSS');
    expect(p.body.data.statusReason).toContain('Too costly');
    expect((await api().post(`${cost()}/sync`).set(as('OPS'))).status).toBe(409); // closed
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
