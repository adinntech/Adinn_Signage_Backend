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
