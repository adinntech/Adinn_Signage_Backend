import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let User: typeof import('../src/modules/users/user.model').User;
let hashPassword: typeof import('../src/modules/auth/auth.service').hashPassword;
let RefreshToken: typeof import('../src/modules/auth/refreshToken.model').RefreshToken;
let disconnectDb: () => Promise<unknown>;

const API = '/api/v1/auth';
const creds = { email: 'bd@adinn.test', password: 'Passw0rd!x' };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  ({ User } = await import('../src/modules/users/user.model'));
  ({ RefreshToken } = await import('../src/modules/auth/refreshToken.model'));
  ({ hashPassword } = await import('../src/modules/auth/auth.service'));
  app = (await import('../src/app')).createApp();
  await User.init();
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});
beforeEach(async () => {
  await User.deleteMany({});
  await RefreshToken.deleteMany({});
  await User.create({ name: 'BD User', email: creds.email, role: 'BD', passwordHash: await hashPassword(creds.password) });
});

const login = () => request(app).post(`${API}/login`).send(creds);

describe('auth', () => {
  it('logs in and returns tokens, user and permissions', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(res.body.data.user.role).toBe('BD');
    expect(res.body.data.user.permissions).toContain('projects:write');
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  it('logs in with an employee ID (case-insensitive) and returns the role home', async () => {
    await User.updateOne({ email: creds.email }, { employeeId: 'emp001' });
    const res = await request(app).post(`${API}/login`).send({ identifier: 'Emp001', password: creds.password });
    expect(res.status).toBe(200);
    expect(res.body.data.user.employeeId).toBe('EMP001');
    expect(res.body.data.user.home).toBe('/dashboard');
    const bad = await request(app).post(`${API}/login`).send({ identifier: 'EMP999', password: creds.password });
    expect(bad.status).toBe(401);
  });

  it('ignores any client-supplied role (no privilege escalation)', async () => {
    const res = await request(app)
      .post(`${API}/login`)
      .send({ ...creds, role: 'SUPER_ADMIN', selectedRole: 'SUPER_ADMIN' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('BD');
    expect(res.body.data.user.permissions).not.toContain('users:manage');
  });

  it('remember=false gives a session cookie and a short-lived refresh token that survives rotation', async () => {
    const res = await request(app).post(`${API}/login`).send({ ...creds, remember: false });
    expect(res.status).toBe(200);
    expect(res.body.data.remember).toBe(false);
    expect(String(res.headers['set-cookie'])).not.toMatch(/Max-Age|Expires=(?!Thu, 01 Jan 1970)/i);
    const stored = await RefreshToken.findOne({}).lean();
    expect(stored!.expiresAt.getTime() - Date.now()).toBeLessThan(25 * 3600_000);
    const r = await request(app).post(`${API}/refresh`).send({ refreshToken: res.body.data.refreshToken });
    expect(r.body.data.remember).toBe(false);

    const keep = await login();
    expect(String(keep.headers['set-cookie'])).toMatch(/Max-Age/i);
  });

  it('rejects an expired refresh token', async () => {
    const token = (await login()).body.data.refreshToken;
    await RefreshToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    const r = await request(app).post(`${API}/refresh`).send({ refreshToken: token });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('REFRESH_EXPIRED');
  });

  it('inactive account cannot refresh an existing session', async () => {
    const token = (await login()).body.data.refreshToken;
    await User.updateOne({ email: creds.email }, { isActive: false });
    expect((await request(app).post(`${API}/refresh`).send({ refreshToken: token })).status).toBe(401);
  });

  it('rejects wrong password and unknown email identically', async () => {
    const a = await request(app).post(`${API}/login`).send({ ...creds, password: 'nope' });
    const b = await request(app).post(`${API}/login`).send({ ...creds, email: 'x@y.com' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.code).toBe(b.body.error.code);
  });

  it('validates input', async () => {
    const res = await request(app).post(`${API}/login`).send({ identifier: 'bad@' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('blocks disabled accounts', async () => {
    await User.updateOne({ email: creds.email }, { isActive: false });
    expect((await login()).status).toBe(403);
  });

  it('GET /me requires a valid token', async () => {
    expect((await request(app).get(`${API}/me`)).status).toBe(401);
    expect((await request(app).get(`${API}/me`).set('Authorization', 'Bearer junk')).status).toBe(401);
    const { body } = await login();
    const me = await request(app).get(`${API}/me`).set('Authorization', `Bearer ${body.data.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(creds.email);
  });

  it('rotates refresh tokens and detects re-use', async () => {
    const first = (await login()).body.data.refreshToken;
    const r1 = await request(app).post(`${API}/refresh`).send({ refreshToken: first });
    expect(r1.status).toBe(200);
    const second = r1.body.data.refreshToken;
    expect(second).not.toBe(first);

    const reuse = await request(app).post(`${API}/refresh`).send({ refreshToken: first });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_REUSED');

    // chain revoked: the legitimate newest token no longer works
    expect((await request(app).post(`${API}/refresh`).send({ refreshToken: second })).status).toBe(401);
  });

  it('concurrent refresh with same token yields only one success', async () => {
    const token = (await login()).body.data.refreshToken;
    const results = await Promise.all([1, 2, 3].map(() => request(app).post(`${API}/refresh`).send({ refreshToken: token })));
    expect(results.filter((r) => r.status === 200).length).toBe(1);
  });

  it('logout revokes the refresh token', async () => {
    const token = (await login()).body.data.refreshToken;
    expect((await request(app).post(`${API}/logout`).send({ refreshToken: token })).status).toBe(200);
    expect((await request(app).post(`${API}/refresh`).send({ refreshToken: token })).status).toBe(401);
  });

  it('refresh works from the httpOnly cookie', async () => {
    const res = await login();
    const cookie = res.headers['set-cookie'];
    expect(String(cookie)).toContain('HttpOnly');
    const r = await request(app).post(`${API}/refresh`).set('Cookie', cookie!).send({});
    expect(r.status).toBe(200);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const r = await request(app).get('/api/v1/nope');
    expect(r.status).toBe(404);
    expect(r.body.success).toBe(false);
  });
});
