import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let opsToken = '';
const api = () => request(app);
const ops = () => ({ Authorization: `Bearer ${opsToken}` });
const ids: Record<string, string> = {};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { User } = await import('../src/modules/users/user.model');
  const { Vendor } = await import('../src/modules/vendors/vendor.model');
  const { hashMpin } = await import('../src/modules/auth/auth.service');
  await User.create({ name: 'Ops', email: 'ops@x.example', employeeId: 'OPS1', role: 'SUPER_ADMIN', authMethod: 'MPIN', mpinHash: await hashMpin('4827') });
  const mk = (name: string, no: string, extra: object = {}) =>
    Vendor.create({ code: `VND-${no}`, name, nameKey: name.toLowerCase(), type: 'ORGANIZATION', mobile: `98765${no}`, zohoVendorNo: no, status: 'ACTIVE', ...extra });
  ids.glass = String((await mk('S R Glass', '11001'))._id);
  ids.glass2 = String((await mk('S R Glass', '21001', { email: 'glass2@v.example' }))._id);
  ids.noId = String((await Vendor.create({ code: 'VND-9', name: 'No Id Vendor', nameKey: 'no id vendor', type: 'ONE_MAN', mobile: '9876500009', status: 'ACTIVE' }))._id);
  app = (await import('../src/app')).createApp();
  const login = await request(app).post('/api/v1/auth/login').send({ identifier: 'OPS1', mpin: '4827' });
  opsToken = login.body.data.accessToken;
});

afterAll(async () => {
  await disconnectDb?.();
  await mongod?.stop();
});

describe('vendor login: pure rules', () => {
  it('builds the username from name letters and the vendor ID tail', async () => {
    const { vendorIdTail, vendorUsernameBase } = await import('../src/modules/users/vendorLogin.service');
    expect(vendorIdTail('11001')).toBe('1001');
    expect(vendorIdTail('123')).toBeNull();
    expect(vendorUsernameBase('S R Glass', '1001')).toBe('srglass1001');
    expect(vendorUsernameBase('A.B. Very Long Company Name', '5566')).toBe('abverylong5566');
  });
});

describe('vendor login: create once, reset by operations', () => {
  it('creates the default login with an unusable placeholder email', async () => {
    const r = await api().post(`/api/v1/vendors/${ids.glass}/logins/ensure`).set(ops());
    expect(r.status).toBe(200);
    expect(r.body.data.created).toBe(true);
    expect(r.body.data.username).toBe('SRGLASS1001');
    expect(r.body.data.user.mustChangeMpin).toBe(true);
    expect(r.body.data.user.hasEmail).toBe(false);
  });

  it('does not create a second login for the same vendor (another job)', async () => {
    const { User } = await import('../src/modules/users/user.model');
    const r = await api().post(`/api/v1/vendors/${ids.glass}/logins/ensure`).set(ops());
    expect(r.body.data.created).toBe(false);
    expect(await User.countDocuments({ role: 'VENDOR', vendorId: ids.glass })).toBe(1);
  });

  it('gives another vendor with the same name and ID tail a different username, and uses its real email', async () => {
    const r = await api().post(`/api/v1/vendors/${ids.glass2}/logins/ensure`).set(ops());
    expect(r.body.data.username).toBe('SRGLASS1001-2');
    expect(r.body.data.user.hasEmail).toBe(true);
  });

  it('makes no login while the vendor has no vendor ID', async () => {
    const r = await api().post(`/api/v1/vendors/${ids.noId}/logins/ensure`).set(ops());
    expect(r.body.data.created).toBe(false);
    expect(r.body.data.skipped).toBe('NO_VENDOR_ID');
  });

  it('signs in with the default MPIN and reports mustChangeMpin; changing it clears the flag', async () => {
    const login = await api().post('/api/v1/auth/login').send({ identifier: 'srglass1001', mpin: '1001', platform: 'mobile' });
    expect(login.status).toBe(200);
    expect(login.body.data.user.mustChangeMpin).toBe(true);
    const token = login.body.data.accessToken;
    const change = await api().post('/api/v1/users/me/change-credential').set({ Authorization: `Bearer ${token}` }).send({ currentSecret: '1001', authMethod: 'MPIN', mpin: '7391' });
    expect([200, 204]).toContain(change.status);
    const again = await api().post('/api/v1/auth/login').send({ identifier: 'srglass1001', mpin: '7391', platform: 'mobile' });
    expect(again.body.data.user.mustChangeMpin).toBe(false);
  });

  it('operations reset puts the default MPIN back and forces a change', async () => {
    const { User } = await import('../src/modules/users/user.model');
    const u = await User.findOne({ employeeId: 'SRGLASS1001' });
    const r = await api().post(`/api/v1/vendors/${ids.glass}/logins/${u!._id}/reset-mpin`).set(ops());
    expect(r.status).toBe(200);
    const login = await api().post('/api/v1/auth/login').send({ identifier: 'SRGLASS1001', mpin: '1001', platform: 'mobile' });
    expect(login.body.data.user.mustChangeMpin).toBe(true);
  });

  it('sends no forgot-MPIN mail to a placeholder address', async () => {
    const { User } = await import('../src/modules/users/user.model');
    const r = await api().post('/api/v1/auth/forgot').send({ identifier: 'SRGLASS1001' });
    expect(r.status).toBe(200);
    const u = await User.findOne({ employeeId: 'SRGLASS1001' }).select('+resetCodeHash');
    expect(u!.resetCodeHash).toBeUndefined();
  });
});

describe('vendor card: sign in with the vendor ID digits', () => {
  const vendorLogin = (identifier: string, mpin: string) => api().post('/api/v1/auth/login').send({ identifier, mpin, loginRole: 'VENDOR', platform: 'mobile' });

  it('asks for the full vendor ID when two vendors share the last 4 digits and both still use the default MPIN', async () => {
    const r = await vendorLogin('1001', '1001');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('VENDOR_ID_AMBIGUOUS');
  });

  it('signs in with the full vendor ID and returns the vendor profile as held in the master', async () => {
    const r = await vendorLogin('21001', '1001');
    expect(r.status).toBe(200);
    expect(r.body.data.user.vendor).toMatchObject({ name: 'S R Glass', vendorNo: '21001', phone: '9876521001', email: 'glass2@v.example' });
    const me = await api().get('/api/v1/auth/me').set({ Authorization: `Bearer ${r.body.data.accessToken}` });
    expect(me.body.data.vendor.vendorNo).toBe('21001');
  });

  it('once one vendor changes the MPIN, the 4 digits + MPIN pick the right vendor', async () => {
    const first = await vendorLogin('21001', '1001');
    const change = await api().post('/api/v1/users/me/change-credential').set({ Authorization: `Bearer ${first.body.data.accessToken}` }).send({ currentSecret: '1001', authMethod: 'MPIN', mpin: '5528' });
    expect([200, 204]).toContain(change.status);
    const two = await vendorLogin('1001', '5528');
    expect(two.status).toBe(200);
    expect(two.body.data.user.vendor.vendorNo).toBe('21001');
    const one = await vendorLogin('1001', '1001');
    expect(one.status).toBe(200);
    expect(one.body.data.user.vendor.vendorNo).toBe('11001');
    expect((await vendorLogin('1001', '9264')).status).toBe(401);
  });
});

describe('vendor login backfill', () => {
  it('dry run reports without writing; apply creates only the missing logins; a second run changes nothing', async () => {
    const { User } = await import('../src/modules/users/user.model');
    const { Vendor } = await import('../src/modules/vendors/vendor.model');
    await Vendor.create({ code: 'VND-31', name: 'Late Vendor', nameKey: 'late vendor', type: 'ORGANIZATION', mobile: '9876531001', zohoVendorNo: '31001', status: 'ACTIVE' });
    const before = await User.countDocuments({ role: 'VENDOR' });

    const dry = await api().post('/api/v1/vendors/logins/backfill').set(ops()).send({});
    expect(dry.status).toBe(200);
    expect(dry.body.data.applied).toBe(false);
    expect(dry.body.data.summary.wouldCreate).toBe(1);
    expect(dry.body.data.summary.noVendorId).toBe(1);
    expect(dry.body.data.summary.sharedTail).toBe(3);
    expect(await User.countDocuments({ role: 'VENDOR' })).toBe(before);

    const run = await api().post('/api/v1/vendors/logins/backfill').set(ops()).send({ apply: true });
    expect(run.body.data.summary.created).toBe(1);
    expect(await User.countDocuments({ role: 'VENDOR' })).toBe(before + 1);

    const again = await api().post('/api/v1/vendors/logins/backfill').set(ops()).send({ apply: true });
    expect(again.body.data.summary.created).toBe(0);
    expect(again.body.data.summary.wouldCreate).toBe(0);
  });
});

describe('vendor sign-in with the vendor ID only', () => {
  const byId = (vendorId: string) => api().post('/api/v1/auth/vendor-login').send({ vendorId });

  it('signs in without an MPIN, returns the vendor profile and never asks for an MPIN change', async () => {
    const r = await byId('31001');
    expect(r.status).toBe(200);
    expect(r.body.data.user.role).toBe('VENDOR');
    expect(r.body.data.user.mustChangeMpin).toBe(false);
    expect(r.body.data.user.vendor.name).toBe('Late Vendor');
  });

  it('asks for the full vendor ID when the last 4 digits belong to two vendors, then accepts the full ID', async () => {
    const r = await byId('1001');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('VENDOR_ID_AMBIGUOUS');
    expect((await byId('21001')).status).toBe(200);
  });

  it('rejects an unknown or malformed vendor ID', async () => {
    expect((await byId('9999')).status).toBe(404);
    expect((await byId('12')).status).toBe(422);
    expect((await byId('abcd')).status).toBe(422);
  });
});
