import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import { DEFAULT_RATES, calcTrip, calcVendorCost, foodSuggestion, stayEligibility } from '../src/modules/recce-cost/recceCost.calc';

const ist = (d: string, t: string) => new Date(`${d}T${t}:00+05:30`);

describe('recce cost calculations', () => {
  it('8am to 2pm gives only breakfast', () => {
    const f = foodSuggestion(ist('2026-11-10', '08:00'), ist('2026-11-10', '14:00'), DEFAULT_RATES);
    expect(f.days[0]!.meals.map((m) => m.meal)).toEqual(['breakfast']);
    expect(f.suggested).toBe(100);
  });
  it('multi-day trip is counted per calendar day and capped at the daily maximum', () => {
    const f = foodSuggestion(ist('2026-11-10', '06:00'), ist('2026-11-11', '15:00'), DEFAULT_RATES);
    expect(f.days).toHaveLength(2);
    expect(f.days[0]!.suggested).toBe(300);
    expect(f.days[1]!.suggested).toBe(200);
    expect(foodSuggestion(ist('2026-11-10', '06:00'), ist('2026-11-10', '23:00'), { ...DEFAULT_RATES, dailyFoodMax: 250 }).suggested).toBe(250);
  });
  it('stay boundaries: 200 km and 6 hours are eligible, just below is not', () => {
    expect(stayEligibility({ distanceKm: 200 }, DEFAULT_RATES).eligible).toBe(true);
    expect(stayEligibility({ distanceKm: 199.9, hours: 5.9 }, DEFAULT_RATES).eligible).toBe(false);
    expect(stayEligibility({ hours: 6 }, DEFAULT_RATES).eligible).toBe(true);
    expect(stayEligibility({ hours: 5 }, { ...DEFAULT_RATES, stayDurationHours: 5 }).eligible).toBe(true);
  });
  it('private vehicle: 150 km x ₹3 = ₹450, plus misc and food', () => {
    const c = calcTrip({ transportType: 'PRIVATE', startAt: ist('2026-11-10', '08:00'), endAt: ist('2026-11-10', '14:00'), legs: [], odoStart: { reading: 1000 }, odoEnd: { reading: 1150 }, misc: [{ amount: 60 }] }, DEFAULT_RATES);
    expect(c.distanceKm).toBe(150);
    expect(c.transport).toBe(450);
    expect(c.total).toBe(450 + 60 + 100);
  });
  it('flags negative distance and an odometer shorter than the GPS line', () => {
    const neg = calcTrip({ transportType: 'PRIVATE', startAt: ist('2026-11-10', '08:00'), legs: [], odoStart: { reading: 500 }, odoEnd: { reading: 400 }, misc: [] }, DEFAULT_RATES);
    expect(neg.flags).toContain('END_BELOW_START');
    const gps = calcTrip({ transportType: 'PRIVATE', startAt: ist('2026-11-10', '08:00'), legs: [], odoStart: { reading: 100, gps: { lat: 13.08, lng: 80.27 } }, odoEnd: { reading: 110, gps: { lat: 8.71, lng: 77.76 } }, misc: [] }, DEFAULT_RATES);
    expect(gps.flags).toContain('ODOMETER_SHORTER_THAN_GPS');
  });
  it('public transport sums all legs', () => {
    const c = calcTrip({ transportType: 'PUBLIC', startAt: ist('2026-11-10', '08:00'), endAt: ist('2026-11-10', '09:00'), legs: [{ amount: 30 }, { amount: 620 }, { amount: 120 }, { amount: 80 }], misc: [] }, DEFAULT_RATES);
    expect(c.transport).toBe(850);
  });
  it('vendor cost: fixed rate replaces per-unit rates; extras are added', () => {
    const base = { ratePerShop: 100, ratePerDay: 0, ratePerLocation: 0, fixedProjectRate: 0, travelCharges: 200, stayCharges: 0, otherCharges: 50 };
    expect(calcVendorCost(base, { shops: 10, days: 1, locations: 0 }).total).toBe(1250);
    expect(calcVendorCost({ ...base, fixedProjectRate: 5000 }, { shops: 10, days: 1, locations: 0 }).total).toBe(5250);
  });
});

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
let projectId = '';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  for (const [key, role] of [['BD', 'BD'], ['REC', 'RECCE_EXECUTIVE'], ['OPS', 'OPERATIONS'], ['FIN', 'FINANCE'], ['ADMIN', 'SUPER_ADMIN']] as const) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const clientId = (await api().post('/api/v1/clients').set(as('BD')).send({ name: 'GM Modular', code: 'GMM' })).body.data._id;
  const contact = { name: 'Suresh Kumar', email: 'suresh@client.example', phone: '9876543210' };
  const pr = await api().post('/api/v1/projects').set(as('BD')).send({ clientId, campaign: 'Tirunelveli Lot 2', status: 'DRAFT', requirementType: 'SHOP_DETAILS', expectedShops: 5, startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Salem', contacts: [contact] }); if (pr.status !== 201) throw new Error(JSON.stringify(pr.body)); projectId = pr.body.data._id as string;
  if (!projectId) throw new Error('project create failed');
  const { Project } = await import('../src/modules/projects/project.model');
  await Project.updateOne({ _id: projectId }, { assignedTo: uid.REC });
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

const trip = (over: Record<string, unknown> = {}) => ({
  projectId, transportType: 'PUBLIC', startAt: '2026-11-10T02:30:00.000Z', endAt: '2026-11-10T08:30:00.000Z',
  legs: [{ from: 'Office', to: 'Bus Stand', mode: 'BIKE', at: '2026-11-10T02:40:00.000Z', amount: 30 }, { from: 'Chennai', to: 'Tirunelveli', mode: 'BUS', at: '2026-11-10T03:00:00.000Z', amount: 620 }],
  misc: [{ type: 'PARKING', date: '2026-11-10', amount: 60 }],
  ...over,
});
const rates = { effectiveFrom: '2026-01-01', kmRate: 3, breakfast: { from: '07:00', to: '10:00', amount: 100 }, lunch: { from: '14:00', to: '16:00', amount: 100 }, dinner: { from: '20:00', to: '22:00', amount: 100 }, dailyFoodMax: 300, mealMinOverlapMinutes: 60, stayDistanceKm: 200, stayDurationHours: 6, stayPerNight: 800, stayMaxAmount: 4000, receiptRequiredAbove: 1000, adminApprovalAbove: 5000, maxTripKm: 1000 };

describe('recce cost API', () => {
  it('only Admin / Finance change rates; a new version never alters a submitted claim', async () => {
    expect((await api().post('/api/v1/recce-cost/rates').set(as('REC')).send(rates)).status).toBe(403);
    expect((await api().post('/api/v1/recce-cost/rates').set(as('FIN')).send(rates)).status).toBe(201);

    const t = await api().post('/api/v1/recce-cost/trips').set(as('REC')).send(trip());
    if (t.status !== 201) throw new Error(JSON.stringify(t.body));
    expect(t.status).toBe(201);
    expect(t.body.data.calc.transport).toBe(650);
    expect(t.body.data.calc.total).toBe(650 + 60 + 100);
    expect((await api().post(`/api/v1/recce-cost/trips/${t.body.data._id}/submit`).set(as('REC'))).status).toBe(200);

    await api().post('/api/v1/recce-cost/rates').set(as('ADMIN')).send({ ...rates, effectiveFrom: '2026-11-01', kmRate: 5, breakfast: { ...rates.breakfast, amount: 200 } });
    const again = await api().get(`/api/v1/recce-cost/trips/${t.body.data._id}`).set(as('REC'));
    expect(again.body.data.calc.food.suggested).toBe(100);
    expect(again.body.data.rateSnapshot.rates.kmRate).toBe(3);
    expect((await api().get('/api/v1/recce-cost/rates').set(as('REC'))).body.data.rates.kmRate).toBe(5);
    expect((await api().get('/api/v1/recce-cost/rates/history').set(as('FIN'))).body.data).toHaveLength(2);
  });

  it('review flow: Ops takes it, only Finance / Admin decide, remark needed when amounts change, settled is locked', async () => {
    const t = (await api().post('/api/v1/recce-cost/trips').set(as('REC')).send(trip({ startAt: '2026-10-10T02:30:00.000Z', endAt: '2026-10-10T08:30:00.000Z' }))).body.data;
    await api().post(`/api/v1/recce-cost/trips/${t._id}/submit`).set(as('REC'));
    const rv = (who: string, b: object) => api().post(`/api/v1/recce-cost/trips/${t._id}/review`).set(as(who)).send(b);
    expect((await rv('OPS', { action: 'START_REVIEW' })).body.data.status).toBe('UNDER_REVIEW');
    expect((await rv('OPS', { action: 'APPROVE' })).status).toBe(403);
    expect((await rv('REC', { action: 'APPROVE' })).status).toBe(403);
    expect((await rv('FIN', { action: 'APPROVE', approved: { misc: 0 } })).status).toBe(422);
    const ap = await rv('FIN', { action: 'APPROVE', approved: { misc: 0 }, remark: 'Parking without bill' });
    expect(ap.body.data.approved.total).toBe(650 + 100);
    expect((await rv('FIN', { action: 'SETTLE' })).body.data.status).toBe('SETTLED');
    expect((await rv('FIN', { action: 'REJECT', remark: 'x' })).status).toBe(409);
    expect((await api().put(`/api/v1/recce-cost/trips/${t._id}`).set(as('REC')).send(trip())).status).toBe(409);
  });

  it('private vehicle needs the ending photo and GPS before it can be submitted', async () => {
    const gps = { lat: 8.7139, lng: 77.7567, accuracy: 20 };
    const draft = await api().post('/api/v1/recce-cost/trips').set(as('REC')).send(trip({ transportType: 'PRIVATE', legs: [], misc: [], vehicle: { type: 'BIKE', regNo: 'tn72ab1234' }, odoStart: { reading: 1000, gps }, odoEnd: { reading: 1150, gps } }));
    expect(draft.status).toBe(201);
    expect(draft.body.data.calc.transport).toBe(750); // 150 km x ₹5 (the rate version in force on that date)
    const sub = await api().post(`/api/v1/recce-cost/trips/${draft.body.data._id}/submit`).set(as('REC'));
    expect(sub.status).toBe(422);
    expect(JSON.stringify(sub.body)).toContain('odoEnd');
    expect(JSON.stringify(sub.body)).toContain('odoStart');
    const neg = await api().post('/api/v1/recce-cost/trips').set(as('REC')).send(trip({ transportType: 'PRIVATE', legs: [], misc: [], vehicle: { type: 'BIKE' }, odoStart: { reading: 500, gps }, odoEnd: { reading: 400, gps } }));
    expect(neg.body.data.flags).toContain('END_BELOW_START');
  });

  it('vendor rate plans cannot overlap and the applied rate is stored per project', async () => {
    const { Vendor } = await import('../src/modules/vendors/vendor.model');
    const v = await Vendor.collection.insertOne({ name: 'ABC Recce', createdAt: new Date() });
    const body = { vendorId: String(v.insertedId), recceType: 'Standard', ratePerShop: 150, travelCharges: 200, effectiveFrom: '2026-01-01' };
    expect((await api().post('/api/v1/recce-cost/vendor-rates').set(as('FIN')).send(body)).status).toBe(201);
    expect((await api().post('/api/v1/recce-cost/vendor-rates').set(as('FIN')).send({ ...body, effectiveFrom: '2026-06-01' })).status).toBe(409);
    const ap = await api().post(`/api/v1/recce-cost/projects/${projectId}/vendor-cost`).set(as('OPS')).send({ vendorId: body.vendorId, recceType: 'Standard', shops: 10 });
    expect(ap.status).toBe(201);
    expect(ap.body.data.total).toBe(1700);
  });

  it('cost report is internal, per client, and counts only approved claims', async () => {
    const r = await api().get('/api/v1/recce-cost/report').set(as('FIN'));
    expect(r.body.data.internalOnly).toBe(true);
    expect(r.body.data.totals.inHouse).toBe(750);
    expect(r.body.data.totals.vendor).toBe(1700);
    expect(r.body.data.byClient[0].key).toBe('GMM');
    expect((await api().get('/api/v1/recce-cost/report').set(as('REC'))).status).toBe(403);
  });
});
