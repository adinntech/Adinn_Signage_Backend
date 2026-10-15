import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let User: typeof import('../src/modules/users/user.model').User;
let hashMpin: typeof import('../src/modules/auth/auth.service').hashMpin;
let disconnectDb: () => Promise<unknown>;

const AUTH = '/api/v1/auth';
const USERS = '/api/v1/users';
const newUser = { name: 'Priya BD', email: 'priya@adinn.test', phone: '9000000001', employeeId: 'EMP301', role: 'BD', authMethod: 'MPIN', mpin: '4826' };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  ({ User } = await import('../src/modules/users/user.model'));
  ({ hashMpin } = await import('../src/modules/auth/auth.service'));
  app = (await import('../src/app')).createApp();
  await User.init();
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

let adminToken = '';
let adminId = '';
beforeEach(async () => {
  await User.deleteMany({});
  const admin = await User.create({ name: 'Admin', email: 'admin@adinn.test', role: 'SUPER_ADMIN', authMethod: 'MPIN', mpinHash: await hashMpin('2580') });
  adminId = String(admin._id);
  adminToken = (await request(app).post(`${AUTH}/login`).send({ identifier: 'admin@adinn.test', mpin: '2580' })).body.data.accessToken;
});

const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const create = (body: object = newUser) => request(app).post(USERS).set(as(adminToken)).send(body);
const loginAs = (identifier: string, mpin: string) => request(app).post(`${AUTH}/login`).send({ identifier, mpin });
const loginPw = (identifier: string, password: string) => request(app).post(`${AUTH}/login`).send({ identifier, password });

describe('users CRUD', () => {
  it('creates a user with a password who can sign in with it', async () => {
    const r = await create({ ...newUser, authMethod: 'PASSWORD', password: 'Passw0rd!x', mpin: undefined });
    expect(r.status).toBe(201);
    expect(r.body.data.authMethod).toBe('PASSWORD');
    expect((await loginPw(newUser.email, 'Passw0rd!x')).status).toBe(200);
    expect((await create({ ...newUser, email: 'b@adinn.test', phone: '9000000050', employeeId: 'EMP350', authMethod: 'PASSWORD', password: 'weak' })).status).toBe(422);
  });

  it('creates a user who can sign in with the given MPIN', async () => {
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ email: newUser.email, role: 'BD', employeeId: 'EMP301' });
    expect(JSON.stringify(r.body)).not.toMatch(/mpinHash|passwordHash/);
    expect((await loginAs(newUser.email, newUser.mpin)).status).toBe(200);
  });

  it('lists with search, role filter and pagination', async () => {
    await create();
    await create({ ...newUser, email: 'ravi@adinn.test', name: 'Ravi Ops', phone: '9000000002', employeeId: 'EMP302', role: 'OPERATIONS' });
    const all = await request(app).get(USERS).set(as(adminToken));
    expect(all.body.data).toHaveLength(3);
    expect(all.body.meta.total).toBe(3);
    const search = await request(app).get(`${USERS}?q=ravi`).set(as(adminToken));
    expect(search.body.data.map((u: { email: string }) => u.email)).toEqual(['ravi@adinn.test']);
    const byRole = await request(app).get(`${USERS}?role=BD`).set(as(adminToken));
    expect(byRole.body.meta.total).toBe(1);
    const page = await request(app).get(`${USERS}?limit=2&page=2`).set(as(adminToken));
    expect(page.body.data).toHaveLength(1);
  });

  it('gets one user and 404s for unknown or malformed ids', async () => {
    const id = (await create()).body.data.id;
    expect((await request(app).get(`${USERS}/${id}`).set(as(adminToken))).body.data.name).toBe('Priya BD');
    expect((await request(app).get(`${USERS}/64b000000000000000000000`).set(as(adminToken))).status).toBe(404);
    expect((await request(app).get(`${USERS}/not-an-id`).set(as(adminToken))).status).toBe(400);
  });

  it('updates fields and rejects duplicates', async () => {
    const id = (await create()).body.data.id;
    const ok = await request(app).patch(`${USERS}/${id}`).set(as(adminToken)).send({ name: 'Priya S', phone: '9000000099' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ name: 'Priya S', phone: '9000000099' });
    await create({ ...newUser, email: 'second@adinn.test', phone: '9000000003', employeeId: 'EMP303' });
    expect((await request(app).patch(`${USERS}/${id}`).set(as(adminToken)).send({ email: 'second@adinn.test' })).status).toBe(409);
    expect((await request(app).patch(`${USERS}/${id}`).set(as(adminToken)).send({})).status).toBe(422);
  });

  it('disabling a user blocks sign-in and ends their sessions', async () => {
    const id = (await create()).body.data.id;
    const session = await loginAs(newUser.email, newUser.mpin);
    await request(app).patch(`${USERS}/${id}`).set(as(adminToken)).send({ isActive: false });
    expect((await loginAs(newUser.email, newUser.mpin)).status).toBe(403);
    expect((await request(app).post(`${AUTH}/refresh`).send({ refreshToken: session.body.data.refreshToken })).status).toBe(401);
  });

  it('resets the credential (MPIN or password), clears lockout and signs the user out', async () => {
    const id = (await create()).body.data.id;
    for (let i = 0; i < 5; i++) await loginAs(newUser.email, '9999');
    expect((await loginAs(newUser.email, newUser.mpin)).status).toBe(429);
    const r = await request(app).post(`${USERS}/${id}/reset-credential`).set(as(adminToken)).send({ authMethod: 'MPIN', mpin: '6137' });
    expect(r.status).toBe(200);
    expect((await loginAs(newUser.email, newUser.mpin)).status).toBe(401);
    expect((await loginAs(newUser.email, '6137')).status).toBe(200);
    expect((await request(app).post(`${USERS}/${id}/reset-credential`).set(as(adminToken)).send({ authMethod: 'MPIN', mpin: '1111' })).status).toBe(422);
    // switching to a password works too, and the MPIN stops working
    const sw = await request(app).post(`${USERS}/${id}/reset-credential`).set(as(adminToken)).send({ authMethod: 'PASSWORD', password: 'NewPassw0rd' });
    expect(sw.status).toBe(200);
    expect((await loginAs(newUser.email, '6137')).status).toBe(401);
    expect((await loginPw(newUser.email, 'NewPassw0rd')).status).toBe(200);
  });

  it('soft-deletes: user disappears, cannot sign in, and the email can be registered again', async () => {
    const id = (await create()).body.data.id;
    expect((await request(app).delete(`${USERS}/${id}`).set(as(adminToken))).status).toBe(200);
    expect((await request(app).get(`${USERS}/${id}`).set(as(adminToken))).status).toBe(404);
    expect((await request(app).get(USERS).set(as(adminToken))).body.meta.total).toBe(1);
    expect((await loginAs(newUser.email, newUser.mpin)).status).toBe(401);
    expect((await create()).status).toBe(201);
    expect(await User.countDocuments({ deletedAt: { $ne: null } })).toBe(1);
  });

  it('protects the last super admin and the caller from self-harm', async () => {
    expect((await request(app).delete(`${USERS}/${adminId}`).set(as(adminToken))).status).toBe(409);
    expect((await request(app).patch(`${USERS}/${adminId}`).set(as(adminToken)).send({ isActive: false })).status).toBe(409);
    expect((await request(app).patch(`${USERS}/${adminId}`).set(as(adminToken)).send({ role: 'BD' })).status).toBe(409);
  });

  it('is admin-only', async () => {
    await create();
    const token = (await loginAs(newUser.email, newUser.mpin)).body.data.accessToken;
    expect((await request(app).get(USERS).set(as(token))).status).toBe(403);
    expect((await request(app).post(USERS).set(as(token)).send(newUser)).status).toBe(403);
    expect((await request(app).delete(`${USERS}/${adminId}`).set(as(token))).status).toBe(403);
    expect((await request(app).get(USERS)).status).toBe(401);
  });
});

describe('change own credential', () => {
  it('changes with the correct current MPIN and invalidates other sessions', async () => {
    await create();
    const first = await loginAs(newUser.email, newUser.mpin);
    const token = first.body.data.accessToken;
    const change = (body: object) => request(app).post(`${USERS}/me/change-credential`).set(as(token)).send(body);
    const bad = await change({ currentSecret: '0001', authMethod: 'MPIN', mpin: '5927' });
    expect(bad.status).toBe(400);
        const ok = await change({ currentSecret: newUser.mpin, authMethod: 'MPIN', mpin: '5927' });
    expect(ok.status).toBe(200);
    expect((await loginAs(newUser.email, newUser.mpin)).status).toBe(401);
    expect((await loginAs(newUser.email, '5927')).status).toBe(200);
    expect((await request(app).post(`${AUTH}/refresh`).send({ refreshToken: first.body.data.refreshToken })).status).toBe(401);
  });
});
