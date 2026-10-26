import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
const tokens: Record<string, string> = {};
const as = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` });
const api = () => request(app);
let projectId = '';
let vendorB = '';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  const { User } = await import('../src/modules/users/user.model');
  const { Vendor } = await import('../src/modules/vendors/vendor.model');
  const { Client } = await import('../src/modules/clients/client.model');
  const { Project } = await import('../src/modules/projects/project.model');
  const { Site } = await import('../src/modules/sites/site.model');
  app = (await import('../src/app')).createApp();

  const kyc = { pan: true, gst: true, bank: true, address: true };
  const mk = (code: string) => Vendor.create({ code, name: code, nameKey: code, type: 'ORGANIZATION', mobile: '9000000000', status: 'ACTIVE', kyc });
  const a = await mk('VND-A');
  const b = await mk('VND-B');
  vendorB = String(b._id);
  const passwordHash = await hashPassword('Passw0rd!x');
  for (const [key, role, vendorId] of [['VA', 'VENDOR', a._id], ['VB', 'VENDOR', b._id], ['VNONE', 'VENDOR', undefined], ['ADMIN', 'SUPER_ADMIN', undefined]] as const) {
    await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash, ...(vendorId ? { vendorId } : {}) });
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const client = await Client.create({ name: 'C', code: 'CC' });
  const p = await Project.create({ code: 'P-1', name: 'P', client: client._id, status: 'IN_PROGRESS' });
  projectId = String(p._id);
  for (let i = 1; i <= 5; i++) {
    await Site.create({ project: p._id, seq: i, siteCode: `P-1-S${i}`, scenario: 'MEASUREMENT_REQUIRED', shopName: `Shop ${i}`, channel: 'VENDOR', vendor: i <= 3 ? a._id : b._id });
  }
  await Site.create({ project: p._id, seq: 6, siteCode: 'P-1-S6', scenario: 'MEASUREMENT_REQUIRED', shopName: 'Unassigned' });
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

describe('vendor jobs', () => {
  it('lists only the projects and shops of the vendor this login belongs to', async () => {
    const jobs = await api().get('/api/v1/vendor/jobs').set(as('VA'));
    expect(jobs.status).toBe(200);
    expect(jobs.body.data).toHaveLength(1);
    expect(jobs.body.data[0].shops).toBe(3);
    const a = await api().get(`/api/v1/vendor/jobs/${projectId}/shops`).set(as('VA'));
    expect(a.body.data.map((s: { shopName: string }) => s.shopName).sort()).toEqual(['Shop 1', 'Shop 2', 'Shop 3']);
    const b = await api().get(`/api/v1/vendor/jobs/${projectId}/shops`).set(as('VB'));
    expect(b.body.data).toHaveLength(2);
  });

  it('does not let a vendor read project shops through the CRM routes', async () => {
    expect((await api().get(`/api/v1/projects/${projectId}/sites`).set(as('VA'))).status).toBe(403);
  });

  it('is closed to a vendor login with no vendor link, to other roles, and to anonymous callers', async () => {
    expect((await api().get('/api/v1/vendor/jobs').set(as('VNONE'))).status).toBe(403);
    expect((await api().get('/api/v1/vendor/jobs').set(as('ADMIN'))).status).toBe(403);
    expect((await api().get('/api/v1/vendor/jobs')).status).toBe(401);
  });

  it('an admin must link a vendor login to a real vendor', async () => {
    const body = { name: 'New Vendor', email: 'nv@x.test', phone: '9111111111', employeeId: 'EMP901', role: 'VENDOR', authMethod: 'MPIN', mpin: '2580' };
    const post = (b: object) => api().post('/api/v1/users').set(as('ADMIN')).send(b);
    expect((await post(body)).status).toBe(422);
    const created = await post({ ...body, vendorId: vendorB });
    expect(created.status).toBe(201);
    expect(created.body.data.vendorId).toBe(vendorB);
    expect((await post({ ...body, email: 'nv2@x.test', phone: '9111111112', employeeId: 'EMP902', vendorId: '64b000000000000000000000' })).status).toBe(404);
  });
});

describe('vendor logins from the vendor page', () => {
  it('Operations-side route creates a login linked to that vendor and lists it', async () => {
    const body = { name: 'Via Page', email: 'vp@x.test', phone: '9222222222', employeeId: 'EMP911', mpin: '2580', authMethod: 'MPIN' };
    const made = await api().post(`/api/v1/vendors/${vendorB}/logins`).set(as('ADMIN')).send(body);
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ role: 'VENDOR', vendorId: vendorB });
    const list = await api().get(`/api/v1/vendors/${vendorB}/logins`).set(as('ADMIN'));
    expect(list.body.data.map((u: { name: string }) => u.name)).toContain('Via Page');
    expect((await api().post('/api/v1/vendors/64b000000000000000000000/logins').set(as('ADMIN')).send({ ...body, email: 'z@x.test', phone: '9222222223', employeeId: 'EMP912' })).status).toBe(404);
    expect((await api().post(`/api/v1/vendors/${vendorB}/logins`).set(as('VA')).send(body)).status).toBe(403);
  });
});
