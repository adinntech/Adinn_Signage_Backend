import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
const tokens: Record<string, string> = {};
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
  const { Project } = await import('../src/modules/projects/project.model');
  const { Site } = await import('../src/modules/sites/site.model');
  const { Vendor } = await import('../src/modules/vendors/vendor.model');
  app = (await import('../src/app')).createApp();
  for (const [key, role] of [['BD', 'BD'], ['ADMIN', 'SUPER_ADMIN']] as const) {
    await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const clientId = (await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Planner Client', code: 'PLN' })).body.data._id;
  const pr = await api().post('/api/v1/projects').set(as('BD')).send({ clientId, campaign: 'Planner', status: 'DRAFT', requirementType: 'SHOP_DETAILS', expectedShops: 20, startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Madurai', contacts: [{ name: 'Suresh Kumar', email: 'suresh@client.example', phone: '9876543210' }] });
  projectId = pr.body.data._id;
  // Start point: Madurai office
  await Project.updateOne({ _id: projectId }, { originName: 'Madurai office', originLat: 9.9252, originLng: 78.1198 });
  const shops = (district: string, n: number, lat: number, lng: number, from: number) =>
    Array.from({ length: n }, (_, i) => ({ project: projectId, siteCode: `PLN-${district}-${from + i}`, seq: from + i, scenario: 'MEASUREMENT_REQUIRED', shopName: `${district} shop ${i + 1}`, address1: '1 Main Road', opsApproval: 'APPROVED', district, lat: lat + i * 0.001, lng: lng + i * 0.001 }));
  await Site.insertMany([...shops('Madurai', 10, 9.93, 78.12, 1), ...shops('Coimbatore', 10, 11.0168, 76.9558, 100)]);
  const v = (code: string, name: string, mobile: string, district: string, rate: number, far: number, skills: string[], areas: string[] = []) =>
    ({ code, name, nameKey: name.toLowerCase(), type: 'ORGANIZATION', mobile, district, serviceAreas: areas, skills, ratePerShop: rate, farRatePerShop: far, status: 'ACTIVE', zohoContactId: `z-${code}` });
  await Vendor.insertMany([
    v('VND-T1', 'Kovai Recce Works', '9000000201', 'Coimbatore', 300, 350, ['Measurement']),
    v('VND-T2', 'Kovai Budget Crew', '9000000202', 'Tiruppur', 220, 250, ['Photos'], ['Coimbatore']),
    v('VND-T3', 'Madurai Crew', '9000000203', 'Madurai', 420, 470, ['Measurement']),
  ]);
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

describe('smart plan suggestion', () => {
  it('keeps a near area in-house and gives a far area to the cheapest covering vendor', async () => {
    const r = await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(as('ADMIN')).send({});
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.data.proposals.map((p: { district: string }) => [p.district, p]));
    expect(by.Madurai.recommended.channel).toBe('IN_HOUSE');
    expect(by.Coimbatore.recommended.channel).toBe('VENDOR');
    expect(by.Coimbatore.recommended.vendorName).toBe('Kovai Budget Crew'); // covers Coimbatore via service area, cheapest
    expect(by.Coimbatore.distanceKm).toBeGreaterThan(150);
    expect(r.body.data.applied).toBe(false);
  });

  it('skills decide the vendor when they are required', async () => {
    const r = await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(as('ADMIN')).send({ skills: ['measurement'], requireSkills: true });
    const c = r.body.data.proposals.find((p: { district: string }) => p.district === 'Coimbatore');
    expect(c.vendors[0].name).toBe('Kovai Recce Works');
    // The skilled vendor is based in Coimbatore, so the far rate (for shops far from ADINN) does not apply to them: cheaper than the team.
    expect(c.recommended.channel).toBe('VENDOR');
    expect(c.vendors.every((o: { skillMatch: boolean }) => o.skillMatch)).toBe(true);
  });

  it('apply saves the choices into the draft plan', async () => {
    const r = await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(as('ADMIN')).send({ apply: true });
    expect(r.status).toBe(200);
    expect(r.body.data.applied).toBe(true);
    const legs = r.body.data.plan.plan.legs as { district: string; name: string; channel: string; vendorName?: string }[];
    expect(legs.find((l) => l.district === 'Madurai')!.channel).toBe('IN_HOUSE');
    expect(legs.find((l) => l.district === 'Coimbatore')!.channel).toBe('VENDOR');
    expect(r.body.data.plan.plan.status).toBe('DRAFT');

    // Everything chosen is marked auto-selected until a person changes it
    const autoLegs = r.body.data.plan.plan.legs as { key: string; name: string; district: string; shops: number; distanceKm: number; channel: string; vendor?: string; autoSelected: boolean }[];
    expect(autoLegs.every((l) => l.autoSelected)).toBe(true);
    const put = (rows: typeof autoLegs) => api().put(`/api/v1/projects/${projectId}/cost`).set(as('ADMIN')).send({ legs: rows.map((l) => ({ key: l.key, name: l.name, district: l.district, shops: l.shops, distanceKm: l.distanceKm, channel: l.channel, vendorId: l.vendor ?? undefined })) });
    const same = await put(autoLegs);
    expect(same.status).toBe(200);
    expect((same.body.data.plan.legs as { autoSelected: boolean }[]).every((l) => l.autoSelected)).toBe(true);
    const edited = await put(autoLegs.map((l) => (l.district === 'Coimbatore' ? { ...l, channel: 'IN_HOUSE', vendor: undefined } : l)));
    const eLegs = edited.body.data.plan.legs as { district: string; autoSelected: boolean; channel: string }[];
    expect(eLegs.find((l) => l.district === 'Coimbatore')).toMatchObject({ channel: 'IN_HOUSE', autoSelected: false });
    expect(eLegs.find((l) => l.district === 'Madurai')!.autoSelected).toBe(true);
  });

  it('splits one district into nearby-shop areas and shows that close shops make the team cheaper', async () => {
    const { Site } = await import('../src/modules/sites/site.model');
    const { Project } = await import('../src/modules/projects/project.model');
    const { Vendor } = await import('../src/modules/vendors/vendor.model');
    // A second project: all shops in Dindigul district, 12 around Dindigul town and 2 in a far town (about 80 km away). Start point: Dindigul.
    const clientId = (await Project.findById(projectId).select('client').lean())!.client;
    const p2 = await Project.create({ code: 'PLN-D2', name: 'Dindigul list', client: clientId, requirementType: 'SHOP_DETAILS', status: 'IN_PROGRESS', expectedShops: 14, originName: 'Dindigul', originLat: 10.3673, originLng: 77.9803 });
    const mk = (n: number, town: string, lat: number, lng: number, from: number) => Array.from({ length: n }, (_, i) => ({ project: p2._id, siteCode: `PLN-D2-${from + i}`, seq: from + i, scenario: 'MEASUREMENT_REQUIRED', shopName: `${town} shop ${i + 1}`, address1: '1 Main Road', opsApproval: 'APPROVED', district: 'Dindigul', location: town, lat: lat + i * 0.002, lng: lng + i * 0.002 }));
    await Site.insertMany([...mk(12, 'Dindigul Town', 10.37, 77.98, 1), ...mk(2, 'Far Town', 9.93, 78.12, 100)]);
    await Vendor.create({ code: 'VND-T4', name: 'Dindigul Recce Crew', nameKey: 'dindigul recce crew', type: 'ORGANIZATION', zohoContactId: 'z-VND-T4', mobile: '9000000204', district: 'Dindigul', skills: ['Measurement'], ratePerShop: 300, farRatePerShop: 350, status: 'ACTIVE' });

    const r = await api().post(`/api/v1/projects/${p2._id}/cost/suggest`).set(as('ADMIN')).send({});
    expect(r.status).toBe(200);
    const areas = r.body.data.proposals as { name: string; shops: number; recommended: { channel: string }; towns: string[]; reasons: string[] }[];
    expect(areas).toHaveLength(2);
    const town = areas.find((a) => a.towns.includes('Dindigul Town'))!;
    const palani = areas.find((a) => a.towns.includes('Far Town'))!;
    expect(town.shops).toBe(12);
    expect(town.recommended.channel).toBe('IN_HOUSE'); // 12 shops in one short trip: the team beats ₹300 per shop
    expect(town.reasons.join(' ')).toMatch(/at least \d+ shops/);
    expect(palani.shops).toBe(2);
    expect(palani.recommended.channel).toBe('VENDOR'); // 2 shops for a ~200 km round trip: the vendor is cheaper

    // Whole district as one area is the coarser view
    const d = await api().post(`/api/v1/projects/${p2._id}/cost/suggest`).set(as('ADMIN')).send({ groupBy: 'district' });
    expect(d.body.data.proposals).toHaveLength(1);

    // Apply, submit, then assign: each area's shops go to its own team
    const ap = await api().post(`/api/v1/projects/${p2._id}/cost/suggest`).set(as('ADMIN')).send({ apply: true });
    expect(ap.body.data.plan.plan.legs.every((l: { clustered: boolean }) => l.clustered)).toBe(true);
    const sub = await api().post(`/api/v1/projects/${p2._id}/cost/submit`).set(as('ADMIN')).send({ justification: 'test' });
    expect(sub.status).toBe(200);
    const as2 = await api().post(`/api/v1/projects/${p2._id}/cost/assign`).set(as('ADMIN'));
    expect(as2.status).toBe(200);
    // Vendors that got shops but have no mobile login are listed, and the project moves on to the recce.
    expect(as2.body.data.vendorsWithoutLogin.length).toBeGreaterThan(0);
    expect(as2.body.data.vendorsWithoutLogin[0]).toHaveProperty('name');
    expect(as2.body.data).toHaveProperty('stage');
    expect(await Site.countDocuments({ project: p2._id, channel: 'IN_HOUSE' })).toBe(12);
    expect(await Site.countDocuments({ project: p2._id, channel: 'VENDOR' })).toBe(2);

    // The shops table can filter by these clusters
    const st = await api().get(`/api/v1/projects/${p2._id}/sites/stats`).set(as('ADMIN'));
    const cl = st.body.data.clusters as { key: string; name: string; count: number }[];
    expect(cl.map((c) => c.count).sort((a, b) => a - b)).toEqual([2, 12]);
    const big = cl.find((c) => c.count === 12)!;
    expect((await api().get(`/api/v1/projects/${p2._id}/sites?planArea=${encodeURIComponent(big.key)}&limit=50`).set(as('ADMIN'))).body.data).toHaveLength(12);
  });

  it('uses the default base when the project has no start point, and saves it on apply', async () => {
    const { Project } = await import('../src/modules/projects/project.model');
    await Project.updateOne({ _id: projectId }, { $unset: { originLat: 1, originLng: 1 } });
    const r = await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(as('ADMIN')).send({});
    // No saved Adinn place yet: the company default (Head Office) is used.
    expect(r.body.data.base).toMatchObject({ name: 'Adinn Head Office', isDefault: true });
    const by = Object.fromEntries(r.body.data.proposals.map((p: { district: string }) => [p.district, p]));
    expect(by.Coimbatore.distanceKm).toBeGreaterThan(150); // travel is counted from the base
    await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(as('ADMIN')).send({ apply: true });
    const p = await Project.findById(projectId).select('originName originLat').lean();
    expect(p?.originName).toBe('Adinn Head Office');
    expect(p?.originLat).toBeCloseTo(9.9252, 3);

    // With saved places, the one nearest to the shops is the start (Coimbatore factory beats the Madurai head office).
    const { BaseLocation } = await import('../src/modules/costing/baseLocation.model');
    await BaseLocation.create({ name: 'Adinn Factory', nameKey: 'adinn factory', lat: 11.0168, lng: 76.9558 });
    await Project.updateOne({ _id: projectId }, { $unset: { originLat: 1, originLng: 1, originName: 1 } });
    const r2 = await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(as('ADMIN')).send({});
    expect(r2.body.data.base.name).toBe('Adinn Factory');
    await BaseLocation.deleteMany({});
  });

  it('is closed to roles that cannot edit the plan', async () => {
    const r = await api().post(`/api/v1/projects/${projectId}/cost/suggest`);
    expect(r.status).toBe(401);
  });
});

describe('shop verification gates the smart plan', () => {
  it('plans only verified shops, says how many wait, and finds Zoho vendors near an area', async () => {
    const { Site } = await import('../src/modules/sites/site.model');
    const { Project } = await import('../src/modules/projects/project.model');
    const { VendorPrice } = await import('../src/modules/vendors/vendorPrice.model');
    const clientId = (await Project.findById(projectId).select('client').lean())!.client;
    const p3 = await Project.create({ code: 'PLN-V3', name: 'Verify list', client: clientId, requirementType: 'SHOP_DETAILS', status: 'IN_PROGRESS', originName: 'Madurai', originLat: 9.9252, originLng: 78.1198 });
    const mk = (n: number, from: number, extra: object) => Array.from({ length: n }, (_, i) => ({ project: p3._id, siteCode: `PLN-V3-${from + i}`, seq: from + i, scenario: 'MEASUREMENT_REQUIRED', shopName: `Verify shop ${from + i}`, district: 'Theni', location: 'Periyakulam', lat: 10.12 + i * 0.001, lng: 77.54 + i * 0.001, ...extra }));
    // none verified yet
    await Site.insertMany(mk(5, 1, { address1: '1 Main Road' }));
    const none = await api().post(`/api/v1/projects/${p3._id}/cost/suggest`).set(as('ADMIN')).send({});
    expect(none.status).toBe(409);
    expect(none.body.error.message).toMatch(/verified/i);
    const ready = await api().get(`/api/v1/projects/${p3._id}/cost/readiness`).set(as('ADMIN'));
    expect(ready.body.data).toMatchObject({ total: 5, verified: 0, unverified: 5, allVerified: false });

    // verify three; one shop has no address and cannot be verified
    const ids = (await Site.find({ project: p3._id }).sort({ seq: 1 }).select('_id').lean()).map((s) => String(s._id));
    for (const id of ids.slice(0, 3)) expect((await api().post(`/api/v1/sites/${id}/approval`).set(as('ADMIN')).send({ level: 'ops', value: 'APPROVED' })).status).toBe(200);
    await Site.updateOne({ _id: ids[3] }, { $unset: { address1: 1, location: 1 } });
    const refused = await api().post(`/api/v1/sites/${ids[3]}/approval`).set(as('ADMIN')).send({ level: 'ops', value: 'APPROVED' });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/address/i);

    // Only Zoho vendors that have a cost are stored, so only those can be suggested.
    await VendorPrice.create({ zohoContactId: 'z-near', name: 'Periyakulam Boards', city: 'Periyakulam', address: 'Theni district', zohoStatus: 'active', ratePerShop: 300 });
    await VendorPrice.create({ zohoContactId: 'z-far', name: 'Chennai Signs', city: 'Chennai', address: 'Anna Salai', zohoStatus: 'active', ratePerShop: 280 });
    const r = await api().post(`/api/v1/projects/${p3._id}/cost/suggest`).set(as('ADMIN')).send({});
    expect(r.status).toBe(200);
    expect(r.body.data.verification).toMatchObject({ total: 5, verified: 3, unverified: 2, noAddress: 1 });
    expect(r.body.data.totals.shops).toBe(3); // only the verified shops are planned
    const near = r.body.data.proposals[0].zohoNearby as { name: string; match: string }[];
    expect(near.map((z) => z.name)).toEqual(['Periyakulam Boards']);
    expect(near[0]!.match).toBe('AREA');
    expect(r.body.data.proposals[0].reasons.join(' ')).toMatch(/Zoho vendors near/);
    await VendorPrice.deleteMany({}); // these two are only for this test
  });
});

describe('planner modes, shop edits and history', () => {
  it('vendors-only and in-house-only modes force the channel; busy vendors are skipped', async () => {
    const { Vendor } = await import('../src/modules/vendors/vendor.model');
    const only = await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(as('ADMIN')).send({ mode: 'IN_HOUSE' });
    expect(only.body.data.proposals.every((p: { recommended: { channel: string } }) => p.recommended.channel === 'IN_HOUSE')).toBe(true);
    const vend = await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(as('ADMIN')).send({ mode: 'VENDOR' });
    const mad = vend.body.data.proposals.find((p: { district: string }) => p.district === 'Madurai');
    expect(mad.recommended.channel).toBe('VENDOR');
    expect(mad.recommended.vendorName).toBe('Madurai Crew');
    await Vendor.updateOne({ code: 'VND-T3' }, { availability: 'BUSY' });
    const busy = await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(as('ADMIN')).send({ mode: 'VENDOR' });
    const mad2 = busy.body.data.proposals.find((p: { district: string }) => p.district === 'Madurai');
    expect(mad2.vendors.map((v: { name: string }) => v.name)).not.toContain('Madurai Crew'); // busy vendors are never offered
    await Vendor.updateOne({ code: 'VND-T3' }, { availability: 'AVAILABLE' });
  });

  it('adds and removes shops of an area, keeps counts right and writes the history', async () => {
    const applied = await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(as('ADMIN')).send({ apply: true });
    expect(applied.status).toBe(200);
    const shops = (await api().get(`/api/v1/projects/${projectId}/cost/shops`).set(as('ADMIN'))).body.data as { id: string; district: string; planArea: string | null }[];
    const mad = shops.filter((s) => s.district === 'Madurai');
    const coi = shops.filter((s) => s.district === 'Coimbatore');
    const madKey = mad[0]!.planArea!;
    const coiKey = coi[0]!.planArea!;
    expect(madKey).not.toBe(coiKey);
    // reason is required
    expect((await api().post(`/api/v1/projects/${projectId}/cost/edit-shops`).set(as('ADMIN')).send({ areaKey: madKey, remove: [mad[0]!.id] })).status).toBe(422);
    const r = await api().post(`/api/v1/projects/${projectId}/cost/edit-shops`).set(as('ADMIN')).send({ areaKey: madKey, remove: [mad[0]!.id], add: [coi[0]!.id], reason: 'Client moved one shop' });
    expect(r.status).toBe(200);
    const legs = r.body.data.plan.legs as { key: string; shops: number }[];
    const total = legs.reduce((a, l) => a + l.shops, 0);
    expect(total).toBe(19); // one removed from Madurai (left out of the plan), one moved from Coimbatore into it
    expect(legs.find((l) => l.key === madKey)!.shops).toBe(10);
    // same change again does nothing
    expect((await api().post(`/api/v1/projects/${projectId}/cost/edit-shops`).set(as('ADMIN')).send({ areaKey: madKey, add: [coi[0]!.id], reason: 'Again' })).status).toBe(409);
    const h = await api().get(`/api/v1/projects/${projectId}/cost/history`).set(as('ADMIN'));
    const edit = (h.body.data as { action: string; reason: string; changes: { field: string }[] }[]).find((x) => x.action === 'PLAN_SHOPS_EDIT');
    expect(edit?.reason).toBe('Client moved one shop');
    expect(edit?.changes.map((c) => c.field).join(' ')).toMatch(/added/);
    expect((await api().get(`/api/v1/projects/${projectId}/cost/history`)).status).toBe(401);
  });
});

describe('choosing who does an area', () => {
  it('switches an area to a vendor or back to the team and records it', async () => {
    const { Vendor } = await import('../src/modules/vendors/vendor.model');
    const view = (await api().get(`/api/v1/projects/${projectId}/cost`).set(as('ADMIN'))).body.data;
    const leg = view.plan.legs[0] as { key: string };
    const v = await Vendor.findOne({ code: 'VND-T1' }).lean();
    expect((await api().post(`/api/v1/projects/${projectId}/cost/choose`).set(as('ADMIN')).send({ areaKey: leg.key, channel: 'VENDOR' })).status).toBe(400);
    const r = await api().post(`/api/v1/projects/${projectId}/cost/choose`).set(as('ADMIN')).send({ areaKey: leg.key, channel: 'VENDOR', vendorId: String(v!._id) });
    expect(r.status).toBe(200);
    const after = r.body.data.plan.legs.find((l: { key: string }) => l.key === leg.key);
    expect(after).toMatchObject({ channel: 'VENDOR', vendorName: 'Kovai Recce Works', autoSelected: false });
    const back = await api().post(`/api/v1/projects/${projectId}/cost/choose`).set(as('ADMIN')).send({ areaKey: leg.key, channel: 'IN_HOUSE' });
    expect(back.body.data.plan.legs.find((l: { key: string }) => l.key === leg.key).channel).toBe('IN_HOUSE');
    const h = (await api().get(`/api/v1/projects/${projectId}/cost/history`).set(as('ADMIN'))).body.data as { action: string }[];
    expect(h.filter((x) => x.action === 'PLAN_CHOOSE')).toHaveLength(2);
  });
});

describe('nearest vendor when nobody works in the area', () => {
  it('offers the nearest vendor that has a cost, with its distance', async () => {
    const { Vendor } = await import('../src/modules/vendors/vendor.model');
    const { Site } = await import('../src/modules/sites/site.model');
    await Vendor.updateMany({}, { $set: { geoAt: new Date() } }); // no address lookups in tests
    await Vendor.updateOne({ code: 'VND-T3' }, { $set: { lat: 9.9252, lng: 78.1198 } });
    await Vendor.updateOne({ code: 'VND-T1' }, { $set: { lat: 11.0168, lng: 76.9558 } });
    await Site.insertMany(Array.from({ length: 3 }, (_, i) => ({ project: projectId, siteCode: `PLN-SVG-${i}`, seq: 900 + i, scenario: 'MEASUREMENT_REQUIRED', shopName: `Sivaganga shop ${i}`, address1: '1 Main Road', opsApproval: 'APPROVED', district: 'Sivaganga', location: 'Sivaganga', lat: 9.8433 + i * 0.001, lng: 78.4809 })));
    const r = await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(as('ADMIN')).send({ mode: 'VENDOR' });
    const d = r.body.data.proposals.find((p: { district: string }) => p.district === 'Sivaganga');
    expect(d.vendors[0].name).toBe('Madurai Crew'); // about 60 km away, nearer than Coimbatore
    expect(d.vendors[0].nearKm).toBeGreaterThan(30);
    expect(d.vendors[0].nearKm).toBeLessThan(120);
    expect(d.recommended).toMatchObject({ channel: 'VENDOR', vendorName: 'Madurai Crew' });
    expect(d.reasons.join(' ')).toMatch(/nearest is Madurai Crew/i);
    expect(d.vendors[0].tags).toContain('Nearest');
  });
});

describe('vendors with a cost in Vendor master that are not registered, and named start points', () => {
  it('suggests a priced Zoho vendor and creates its CRM record only when the plan is used', async () => {
    const { VendorPrice } = await import('../src/modules/vendors/vendorPrice.model');
    const { Vendor } = await import('../src/modules/vendors/vendor.model');
    await VendorPrice.create({ zohoContactId: '5000000000001', name: 'Sivaganga Boards (Zoho)', mobile: '+91 90000 05551', email: 'sb@example.com', city: 'Sivaganga', address: 'Sivaganga', zohoStatus: 'active', ratePerShop: 150, skills: ['Photos'], lat: 9.8433, lng: 78.4809, geoAt: new Date() });
    const r = await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(as('ADMIN')).send({});
    const d = r.body.data.proposals.find((p: { district: string }) => p.district === 'Sivaganga');
    const z = d.vendors.find((v: { name: string }) => v.name === 'Sivaganga Boards (Zoho)');
    expect(z).toMatchObject({ perShopRate: 150, rateSource: 'VENDOR' });
    expect(z.tags).not.toContain('Not registered');
    expect(d.recommended).toMatchObject({ channel: 'VENDOR', vendorId: 'zoho:5000000000001' });
    expect(await Vendor.countDocuments({ zohoContactId: '5000000000001' })).toBe(0); // nothing is created by looking
    const ap = await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(as('ADMIN')).send({ apply: true });
    expect(ap.status).toBe(200);
    const made = await Vendor.findOne({ zohoContactId: '5000000000001' }).lean();
    expect(made).toMatchObject({ name: 'Sivaganga Boards (Zoho)', status: 'ACTIVE', source: 'ZOHO', mobile: '9000005551', ratePerShop: 150 });
    const leg = ap.body.data.plan.plan.legs.find((l: { district: string }) => l.district === 'Sivaganga');
    expect(leg).toMatchObject({ channel: 'VENDOR', vendorName: 'Sivaganga Boards (Zoho)' });
    // the same vendor is not created twice
    await api().post(`/api/v1/projects/${projectId}/cost/choose`).set(as('ADMIN')).send({ areaKey: leg.key, channel: 'VENDOR', vendorId: 'zoho:5000000000001' });
    expect(await Vendor.countDocuments({ zohoContactId: '5000000000001' })).toBe(1);
  });

  it('refuses a Zoho vendor that has no valid mobile number', async () => {
    const { VendorPrice } = await import('../src/modules/vendors/vendorPrice.model');
    await VendorPrice.create({ zohoContactId: '5000000000002', name: 'No Mobile Boards', city: 'Sivaganga', zohoStatus: 'active', ratePerShop: 100 });
    const view = (await api().get(`/api/v1/projects/${projectId}/cost`).set(as('ADMIN'))).body.data;
    const r = await api().post(`/api/v1/projects/${projectId}/cost/choose`).set(as('ADMIN')).send({ areaKey: view.plan.legs[0].key, channel: 'VENDOR', vendorId: 'zoho:5000000000002' });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/mobile/i);
  });

  it('saves a named place once and lists it; a duplicate name is refused', async () => {
    const add = await api().post('/api/v1/base-locations').set(as('ADMIN')).send({ name: 'Adinn Factory', lat: 9.96, lng: 78.05 });
    expect(add.status).toBe(200);
    expect((await api().post('/api/v1/base-locations').set(as('ADMIN')).send({ name: 'adinn  factory', lat: 9.9, lng: 78 })).status).toBe(409);
    expect((await api().post('/api/v1/base-locations').set(as('ADMIN')).send({ name: 'X', lat: 99, lng: 78 })).status).toBe(422);
    const list = (await api().get('/api/v1/base-locations').set(as('ADMIN'))).body.data as { name: string }[];
    expect(list.map((b) => b.name)).toEqual(['Adinn Factory']);
    expect((await api().get('/api/v1/base-locations')).status).toBe(401);
  });
});

describe('finding a typed address', () => {
  it('needs a real address and says clearly when the map cannot find it', async () => {
    expect((await api().post('/api/v1/base-locations/find').set(as('ADMIN')).send({ address: 'ab' })).status).toBe(422);
    const r = await api().post('/api/v1/base-locations/find').set(as('ADMIN')).send({ address: 'Unknown Place, Nowhere Street, Nowhere' });
    expect([404, 200]).toContain(r.status); // 404 when no address service is reachable or nothing is found
    expect((await api().post('/api/v1/base-locations/find').send({ address: 'Some long address here' })).status).toBe(401);
  });
});
