import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import fs from 'node:fs';
import type { Express } from 'express';

/**
 * The real test workbook (src/Madurai_Recce_Vendor_Allocation_Test.xlsx) through the whole path:
 * extract -> import -> verify -> smart plan, with vendors that have their own saved price.
 */
let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let token = '';
let projectId = '';
const auth = () => ({ Authorization: `Bearer ${token}` });
const api = () => request(app);

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
  const { Vendor } = await import('../src/modules/vendors/vendor.model');
  app = (await import('../src/app')).createApp();
  await User.create({ name: 'Admin', email: 'admin@t.com', role: 'SUPER_ADMIN', passwordHash: await hashPassword('Passw0rd!x') });
  token = (await api().post('/api/v1/auth/login').send({ email: 'admin@t.com', password: 'Passw0rd!x' })).body.data.accessToken;
  const clientId = (await api().post('/api/v1/clients').set(auth()).send({ name: 'Madurai Client', code: 'MDU' })).body.data._id;
  projectId = (await api().post('/api/v1/projects').set(auth()).send({ clientId, campaign: 'Madurai recce', status: 'DRAFT', requirementType: 'SHOP_DETAILS', expectedShops: 8, startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Madurai', requirement: { source: 'EMAIL', siteDataScenario: 'MEASUREMENT_REQUIRED' } })).body.data._id;
  const v = (code: string, name: string, mobile: string, district: string, rate: number | undefined, lat: number, lng: number) =>
    ({ code, name, nameKey: name.toLowerCase(), type: 'ORGANIZATION', mobile, district, serviceAreas: [], skills: ['Photos'], ratePerShop: rate, status: 'ACTIVE', zohoContactId: `z-${code}`, lat, lng, geoAt: new Date() });
  await Vendor.insertMany([
    v('VND-M1', 'Madurai Own Rate Crew', '9000000301', 'Madurai', 180, 9.93, 78.12), // cheaper than the company rate
    v('VND-M2', 'Theni Crew', '9000000302', 'Theni', 210, 10.0104, 77.4768),
    v('VND-M3', 'No Price Crew', '9000000303', 'Madurai', undefined, 9.92, 78.11), // no price: company rate
  ]);
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

describe('Madurai test workbook, extract to smart plan', () => {
  it('extracts the 8 shops with Area / Town as the location', async () => {
    const buf = fs.readFileSync('src/Madurai_Recce_Vendor_Allocation_Test.xlsx');
    const up = await api().post(`/api/v1/projects/${projectId}/sites/imports`).set(auth()).attach('file', buf, 'Madurai.xlsx');
    expect(up.status).toBe(201);
    const mapping = up.body.data.suggestedMapping as Record<string, string>;
    expect(mapping['Area / Town']).toBe('location');
    expect(mapping['Allocation Status']).toBe('extra');
    const batch = up.body.data.batch._id as string;
    const pv = await api().post(`/api/v1/projects/${projectId}/sites/imports/${batch}/preview`).set(auth()).send({ mapping, defaultUnit: 'ft', duplicatePolicy: 'skip' });
    expect(pv.status).toBe(200);
    const cm = await api().post(`/api/v1/projects/${projectId}/sites/imports/${batch}/commit`).set(auth()).send({});
    expect(cm.status).toBe(200);
    const list = await api().get(`/api/v1/projects/${projectId}/cost/shops`).set(auth());
    expect(list.body.data).toHaveLength(8);
    expect(list.body.data.map((s: { location: string }) => s.location)).not.toContain('Not Assigned');
  });

  it('after verification the plan names real areas and uses each vendor\'s own saved price', async () => {
    const shops = (await api().get(`/api/v1/projects/${projectId}/cost/shops`).set(auth())).body.data as { id: string }[];
    for (const s of shops) expect((await api().post(`/api/v1/sites/${s.id}/approval`).set(auth()).send({ level: 'ops', value: 'APPROVED' })).status).toBe(200);
    const r = await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(auth()).send({ mode: 'VENDOR' });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totals.shops).toBe(8);
    expect(d.base).toMatchObject({ name: 'Adinn Head Office', isDefault: true });
    for (const p of d.proposals as { name: string; vendors: { name: string; perShopRate: number; rateSource: string }[]; recommended: { channel: string } }[]) {
      expect(p.name).not.toMatch(/Not Assigned/i);
      expect(p.recommended.channel).toBe('VENDOR');
      const own = p.vendors.find((v) => v.name === 'Madurai Own Rate Crew');
      if (own) { expect(own.perShopRate).toBe(180); expect(own.rateSource).toBe('VENDOR'); } // the vendor's price, not the company rate
      const none = p.vendors.find((v) => v.name === 'No Price Crew');
      if (none) expect(none.rateSource).toBe('COMPANY');
    }
    // the cheapest saved price wins: 180 a shop for the whole workbook
    const best = d.proposals[0].vendors[0];
    expect(best.name).toBe('Madurai Own Rate Crew');
    expect(d.totals.suggested).toBe(8 * 180);
  });

  it('both ways are priced, so the gap between the team and the vendor can be shown', async () => {
    const d = (await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(auth()).send({})).body.data;
    expect(d.totals.allInHouse).toBeGreaterThan(0);
    expect(d.totals.allVendor).toBe(8 * 180);
    for (const p of d.proposals as { inHouse: { total: number }; vendors: { total: number }[] }[]) {
      expect(p.inHouse.total).toBeGreaterThan(0);
      expect(p.vendors[0]!.total).toBeGreaterThan(0);
    }
  });
});

describe('only vendors listed in Vendor master with a cost are offered', () => {
  it('ignores a registered vendor that has a price but no Zoho vendor in Vendor master, and tells the approval answer', async () => {
    const { Vendor } = await import('../src/modules/vendors/vendor.model');
    const { VendorRateApproval } = await import('../src/modules/vendors/vendorRateApproval.model');
    await Vendor.create({ code: 'VND-M9', name: 'Registered Only Crew', nameKey: 'registered only crew', type: 'ORGANIZATION', mobile: '9000000399', district: 'Madurai', skills: ['Photos'], ratePerShop: 100, status: 'ACTIVE' });
    await VendorRateApproval.create({ requestId: 'ADN-Signage-vap-10112601', zohoContactId: 'z-VND-M1', vendorName: 'Madurai Own Rate Crew', requested: { ratePerShop: 400 }, limit: { ratePerShop: 250 }, current: { ratePerShop: 180 }, status: 'PENDING', requestedBy: new (await import('mongoose')).Types.ObjectId() });
    const d = (await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(auth()).send({})).body.data;
    for (const p of d.proposals as { vendors: { name: string; tags?: string[] }[] }[]) expect(p.vendors.map((v) => v.name)).not.toContain('Registered Only Crew');
    const own = d.proposals[0].vendors.find((v: { name: string }) => v.name === 'Madurai Own Rate Crew');
    expect(own.tags).toContain('Waiting for approval');
  });
});
