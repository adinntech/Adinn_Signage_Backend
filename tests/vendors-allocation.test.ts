import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import { buildItinerary, haversineKm, nearestOrder, roadKm, splitSites } from '../src/modules/allocation/allocation.geo';

describe('map maths', () => {
  const madurai = { lat: 9.9252, lng: 78.1198 };
  const chennai = { lat: 13.0827, lng: 80.2707 };
  it('measures distance between places', () => {
    expect(Math.round(haversineKm(madurai, chennai))).toBeGreaterThan(380);
    expect(Math.round(haversineKm(madurai, chennai))).toBeLessThan(440);
    expect(roadKm(madurai, madurai)).toBe(0);
  });
  it('visits the nearest shop first and cuts days', () => {
    const near = { lat: 9.95, lng: 78.13 };
    const mid = { lat: 10.36, lng: 77.98 }; // Dindigul
    const far = { lat: 9.45, lng: 77.8 };
    expect(nearestOrder(madurai, [far, mid, near])[0]).toBe(near);
    const it = buildItinerary(madurai, [near, mid, far, { ...near, lat: 9.96 }], 2);
    expect(it.days).toHaveLength(2);
    expect(it.days[0]!.stops).toHaveLength(2);
    expect(it.totalKm).toBeGreaterThan(0);
    expect(buildItinerary(madurai, [], 5).days).toHaveLength(0);
  });
  it('splits shops between teams by district and by size', () => {
    const sites = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, district: i < 6 ? 'Madurai' : 'Theni', distanceKm: i * 10, seq: i }));
    const g = splitSites(sites, [{ key: 'a', vendorId: 'v1' }, { key: 'b', vendorId: null }], 'district', 6);
    expect(g.map((x) => x.sites.length)).toEqual([6, 4]);
    expect(new Set(g[0]!.sites.map((s) => s.district))).toEqual(new Set(['Madurai']));
    const even = splitSites(sites, [{ key: 'a', vendorId: 'v1' }, { key: 'b', vendorId: null }], 'count');
    expect(even.map((x) => x.sites.length)).toEqual([5, 5]);
    expect(splitSites(sites, [], 'count')).toEqual([]);
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
const siteIds: string[] = [];
const contact = { name: 'Suresh Kumar', email: 'suresh@client.example', phone: '9876543210' };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.ROUTING_URL = ''; // no network in tests: distances fall back to the straight-line estimate
  process.env.GEOCODER_URL = '';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  for (const [key, role] of [['BD', 'BD'], ['OPS', 'OPERATIONS'], ['OPS2', 'OPERATIONS'], ['FIN', 'FINANCE'], ['ADMIN', 'SUPER_ADMIN']] as const) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const clientId = (await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Alloc Client', code: 'ALC' })).body.data._id;
  projectId = (await api().post('/api/v1/projects').set(as('BD')).send({ clientId, campaign: 'Alloc One', status: 'DRAFT', requirementType: 'SHOP_DETAILS', expectedShops: 6, startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Madurai', contacts: [contact] })).body.data._id;
  await api().post(`/api/v1/projects/${projectId}/assign`).set(as('BD')).send({ assigneeId: uid.OPS });
  const shops: [string, string, string][] = [['Anand Stores', 'Madurai', '9843011101'], ['Bala Traders', 'Madurai', '9843011102'], ['Chitra Mart', 'Madurai', '9843011103'], ['Deva Agencies', 'Theni', '9843011104'], ['Eswar Stores', 'Theni', '9843011105'], ['Farook Shop', 'Dindigul', '9843011106']];
  for (const [shopName, district, mobile] of shops) siteIds.push((await api().post(`/api/v1/projects/${projectId}/sites`).set(as('OPS')).send({ shopName, dealerName: shopName, district, mobile })).body.data.site._id);
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

const vendorBody = (over: Record<string, unknown> = {}) => ({ name: 'Balamurugan Signs', type: 'ONE_MAN', mobile: '98765 43210', district: 'Madurai', pan: 'ABCDE1234F', ...over });
let vendorId = '';
let orgId = '';

describe('vendor management', () => {
  it('registers a vendor as KYC pending and rejects bad data and duplicates', async () => {
    const bad = await api().post('/api/v1/vendors').set(as('OPS')).send(vendorBody({ mobile: '123', gstin: 'XYZ' }));
    expect(bad.status).toBe(422);
    const r = await api().post('/api/v1/vendors').set(as('OPS')).send(vendorBody());
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('PENDING_KYC');
    expect(r.body.data.code).toBe('VND-0001');
    expect(r.body.data.mobile).toBe('9876543210');
    vendorId = r.body.data._id;
    expect((await api().post('/api/v1/vendors').set(as('OPS')).send(vendorBody({ name: 'Someone Else' }))).status).toBe(409);
    expect((await api().post('/api/v1/vendors').set(as('BD')).send(vendorBody({ name: 'X Y Z', mobile: '9000000001' }))).status).toBe(403);
    orgId = (await api().post('/api/v1/vendors').set(as('OPS')).send(vendorBody({ name: 'SRN Media Pvt Ltd', type: 'ORGANIZATION', mobile: '9000000002', district: 'Theni', ratePerShop: 220, farRatePerShop: 300 }))).body.data._id;
  });

  it('activates only after the KYC checklist is complete', async () => {
    expect((await api().post(`/api/v1/vendors/${vendorId}/status`).set(as('OPS')).send({ status: 'ACTIVE' })).status).toBe(409);
    await api().put(`/api/v1/vendors/${vendorId}/kyc`).set(as('OPS')).send({ pan: true, bank: true, address: true });
    expect((await api().post(`/api/v1/vendors/${vendorId}/status`).set(as('OPS')).send({ status: 'ACTIVE' })).body.data.status).toBe('ACTIVE');
    // an organization also needs GST
    await api().put(`/api/v1/vendors/${orgId}/kyc`).set(as('OPS')).send({ pan: true, bank: true, address: true });
    expect((await api().post(`/api/v1/vendors/${orgId}/status`).set(as('OPS')).send({ status: 'ACTIVE' })).status).toBe(409);
    await api().put(`/api/v1/vendors/${orgId}/kyc`).set(as('OPS')).send({ gst: true });
    expect((await api().post(`/api/v1/vendors/${orgId}/status`).set(as('OPS')).send({ status: 'ACTIVE' })).status).toBe(200);
    expect((await api().post(`/api/v1/vendors/${orgId}/status`).set(as('OPS')).send({ status: 'BLACKLISTED' })).status).toBe(422); // reason needed
  });

  it('lists, searches and summarises', async () => {
    const r = await api().get('/api/v1/vendors?q=bala').set(as('OPS'));
    expect(r.body.data).toHaveLength(1);
    expect(r.body.meta.summary).toMatchObject({ ACTIVE: 2, ALL: 2 });
    expect((await api().get('/api/v1/vendors/active').set(as('OPS'))).body.data).toHaveLength(2);
    expect((await api().get('/api/v1/vendors').set(as('FIN'))).status).toBe(200);
  });

  it('previews an Excel import, then creates only the valid, non-duplicate rows', async () => {
    const tpl = await api().get('/api/v1/vendors/template').set(as('OPS')).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(tpl.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Vendors');
    ws.addRow(['Vendor Name', 'Type (One-man / Organization)', 'Mobile', 'District', 'Rate per Shop', 'GST No']);
    ws.addRow(['Karthik Ads', 'One-man', '9111111111', 'Salem', 240, '']);
    ws.addRow(['Dup Mobile', 'One-man', '9876543210', 'Salem', '', '']); // duplicates Balamurugan
    ws.addRow(['Bad Row', 'Alien', '12', 'Salem', '', 'nope']);
    ws.addRow(['Sky Boards Pvt Ltd', 'Organization', '9222222222', 'Erode', '', '']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const preview = await api().post('/api/v1/vendors/import').set(as('OPS')).attach('file', buf, 'vendors.xlsx');
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ total: 4, valid: 2, created: 0 });
    expect(preview.body.data.rows[1].duplicate).toContain('already belongs');
    expect((await api().get('/api/v1/vendors').set(as('OPS'))).body.meta.summary.ALL).toBe(2);
    const done = await api().post('/api/v1/vendors/import?commit=true').set(as('OPS')).attach('file', buf, 'vendors.xlsx');
    expect(done.body.data.created).toBe(2);
    expect((await api().get('/api/v1/vendors').set(as('OPS'))).body.meta.summary).toMatchObject({ PENDING_KYC: 2, ALL: 4 });
    expect((await api().get('/api/v1/vendors/export').set(as('OPS')).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); })).status).toBe(200);
  });
});

describe('shop allocation', () => {
  const A = () => `/api/v1/projects/${projectId}/allocation`;

  it('needs a start point before distances exist, then measures from it', async () => {
    const before = await api().get(`${A()}/shops?sort=distance`).set(as('OPS'));
    expect(before.body.data[0].distanceKm).toBeNull();
    expect((await api().put(`${A()}/origin`).set(as('OPS')).send({ name: 'Madurai office', lat: 95, lng: 78 })).status).toBe(422);
    expect((await api().put(`${A()}/origin`).set(as('OPS')).send({ name: 'Madurai office', lat: 9.9252, lng: 78.1198 })).status).toBe(200);
    const coords: [number, number][] = [[9.95, 78.13], [9.9, 78.1], [9.93, 78.15], [10.0, 77.48], [10.02, 77.5], [10.36, 77.98]];
    for (const [i, [lat, lng]] of coords.entries()) expect((await api().put(`/api/v1/sites/${siteIds[i]}/coords`).set(as('OPS')).send({ lat, lng })).status).toBe(200);
    expect((await api().put(`/api/v1/sites/${siteIds[0]}/coords`).set(as('OPS')).send({ lat: 10 })).status).toBe(422);
    const after = await api().get(`${A()}/shops?sort=-distance`).set(as('OPS'));
    expect(after.body.data[0].distanceKm).toBeGreaterThan(after.body.data[5].distanceKm);
    expect((await api().get(A()).set(as('OPS'))).body.data).toMatchObject({ total: 6, unassigned: 6, withoutCoords: 0 });
  });

  it('gives shops only to an active vendor, or to the in-house team', async () => {
    const pending = (await api().get('/api/v1/vendors?status=PENDING_KYC').set(as('OPS'))).body.data[0]._id;
    expect((await api().post(`${A()}/assign`).set(as('OPS')).send({ siteIds: [siteIds[0]], channel: 'VENDOR', vendorId: pending })).status).toBe(409);
    expect((await api().post(`${A()}/assign`).set(as('OPS')).send({ siteIds: [siteIds[0]], channel: 'VENDOR' })).status).toBe(422);
    expect((await api().post(`${A()}/assign`).set(as('BD')).send({ siteIds: [siteIds[0]], channel: 'IN_HOUSE' })).status).toBe(403);
    expect((await api().post(`${A()}/assign`).set(as('OPS2')).send({ siteIds: [siteIds[0]], channel: 'IN_HOUSE' })).status).toBe(404);
    const r = await api().post(`${A()}/assign`).set(as('OPS')).send({ siteIds: [siteIds[0], siteIds[1]], channel: 'VENDOR', vendorId });
    expect(r.body.data.affected).toBe(2);
    expect(r.body.data.overview.teams[0]).toMatchObject({ name: 'Balamurugan Signs', shops: 2 });
    // a vendor holding shops cannot be deleted
    expect((await api().delete(`/api/v1/vendors/${vendorId}`).set(as('OPS'))).status).toBe(409);
  });

  it('suggests a split and applies it', async () => {
    const preview = await api().post(`${A()}/split/preview`).set(as('OPS')).send({ by: 'district', maxPerTeam: 2, teams: [{ vendorId: orgId }, { vendorId: null }, { vendorId: null }] });
    expect(preview.status).toBe(200);
    expect(preview.body.data.totalShops).toBe(4); // only the unassigned ones
    const groups = preview.body.data.groups;
    expect(groups.reduce((a: number, g: { shops: number }) => a + g.shops, 0)).toBe(4);
    const applied = await api().post(`${A()}/split/apply`).set(as('OPS')).send({ groups: groups.map((g: { vendorId: string | null; siteIds: string[] }) => ({ vendorId: g.vendorId, siteIds: g.siteIds })) });
    expect(applied.body.data.affected).toBe(4);
    expect(applied.body.data.overview.unassigned).toBe(0);
  });

  it('plans the in-house days as round trips from the start point', async () => {
    const it = await api().get(`${A()}/itinerary?shopsPerDay=1`).set(as('OPS'));
    expect(it.status).toBe(200);
    expect(it.body.data.totalShops).toBeGreaterThan(0);
    expect(it.body.data.days.length).toBe(it.body.data.totalShops);
    expect(it.body.data.estimate.days).toBe(it.body.data.days.length);
    expect(it.body.data.estimate.fuel).toBe(Math.round(it.body.data.totalKm * 3));
    expect(it.body.data.days[0].googleUrl).toContain('https://www.google.com/maps/dir/');
  });

  it('prices an area with a registered vendor\'s own rate card', async () => {
    const district = 'Madurai';
    const plan = await api().post(`/api/v1/projects/${projectId}/cost/sync`).set(as('OPS'));
    expect(plan.status).toBe(200);
    const leg = plan.body.data.plan.legs.find((l: { name: string }) => l.name === district);
    const r = await api().put(`/api/v1/projects/${projectId}/cost`).set(as('OPS')).send({ legs: [{ key: leg.key, name: leg.name, district, shops: leg.shops, distanceKm: 10, channel: 'VENDOR', vendorId: orgId }] });
    expect(r.status).toBe(200);
    const saved = r.body.data.plan.legs[0];
    expect(saved.vendorName).toBe('SRN Media Pvt Ltd');
    expect(saved.calc.vendor.perShopRate).toBe(220);
    const pending = (await api().get('/api/v1/vendors?status=PENDING_KYC').set(as('OPS'))).body.data[0]._id;
    expect((await api().put(`/api/v1/projects/${projectId}/cost`).set(as('OPS')).send({ legs: [{ key: leg.key, name: leg.name, district, shops: leg.shops, channel: 'VENDOR', vendorId: pending }] })).status).toBe(409);
  });

  it('is removed with the project, and the vendor survives', async () => {
    const { Site } = await import('../src/modules/sites/site.model');
    expect((await api().delete(`/api/v1/projects/${projectId}`).set(as('ADMIN'))).status).toBe(200);
    expect(await Site.countDocuments({ project: projectId })).toBe(0);
    expect((await api().get(`/api/v1/vendors/${vendorId}`).set(as('OPS'))).body.data.allocatedShops).toBe(0);
  });
});
