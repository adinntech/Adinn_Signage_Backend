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
    ({ code, name, nameKey: name.toLowerCase(), type: 'ORGANIZATION', mobile, district, serviceAreas: areas, skills, ratePerShop: rate, farRatePerShop: far, status: 'ACTIVE' });
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
    expect(c.recommended.channel).toBe('IN_HOUSE'); // the only skilled vendor (₹3500) costs more than the team (about ₹3100)
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
    await Vendor.create({ code: 'VND-T4', name: 'Dindigul Recce Crew', nameKey: 'dindigul recce crew', type: 'ORGANIZATION', mobile: '9000000204', district: 'Dindigul', skills: ['Measurement'], ratePerShop: 300, farRatePerShop: 350, status: 'ACTIVE' });

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
    expect(await Site.countDocuments({ project: p2._id, channel: 'IN_HOUSE' })).toBe(12);
    expect(await Site.countDocuments({ project: p2._id, channel: 'VENDOR' })).toBe(2);

    // The shops table can filter by these clusters
    const st = await api().get(`/api/v1/projects/${p2._id}/sites/stats`).set(as('ADMIN'));
    const cl = st.body.data.clusters as { key: string; name: string; count: number }[];
    expect(cl.map((c) => c.count).sort((a, b) => a - b)).toEqual([2, 12]);
    const big = cl.find((c) => c.count === 12)!;
    expect((await api().get(`/api/v1/projects/${p2._id}/sites?planArea=${encodeURIComponent(big.key)}&limit=50`).set(as('ADMIN'))).body.data).toHaveLength(12);
  });

  it('warns when there is no start point', async () => {
    const { Project } = await import('../src/modules/projects/project.model');
    await Project.updateOne({ _id: projectId }, { $unset: { originLat: 1, originLng: 1 } });
    const r = await api().post(`/api/v1/projects/${projectId}/cost/suggest`).set(as('ADMIN')).send({});
    expect(r.body.data.proposals[0].warnings.join(' ')).toMatch(/start point/i);
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
  });
});
