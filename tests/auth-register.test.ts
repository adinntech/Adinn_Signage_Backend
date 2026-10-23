import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let User: typeof import('../src/modules/users/user.model').User;
let disconnectDb: () => Promise<unknown>;

const API = '/api/v1/auth';
const web: Record<string, unknown> = { name: 'Ops User', email: 'ops@adinn.test', phone: '9876543210', employeeId: 'emp100', role: 'OPERATIONS', platform: 'web', authMethod: 'MPIN', mpin: '2580' };
const field: Record<string, unknown> = { name: 'Field Exec', email: 'recce@adinn.test', phone: '9876543211', employeeId: 'EMP200', role: 'RECCE_EXECUTIVE', platform: 'mobile', authMethod: 'PASSWORD', password: 'Passw0rd!x' };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  ({ User } = await import('../src/modules/users/user.model'));
  app = (await import('../src/app')).createApp();
  await User.init();
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});
beforeEach(async () => {
  await User.deleteMany({});
});

const post = (path: string, body: object) => request(app).post(`${API}${path}`).send(body);

describe('registration', () => {
  it('registers with name, email, phone, employee ID and MPIN, and signs the user in straight away', async () => {
    const r = await post('/register', web);
    expect(r.status).toBe(201);
    expect(r.body.data.accessToken).toBeTruthy();
    expect(r.body.data.refreshToken).toBeTruthy();
    expect(r.body.data.user).toMatchObject({ role: 'OPERATIONS', employeeId: 'EMP100', phone: '9876543210', authMethod: 'MPIN' });
    expect(r.body.data.user.permissions).toContain('projects:read');
    expect(JSON.stringify(r.body)).not.toMatch(/mpinHash|passwordHash/);
    expect(String(r.headers['set-cookie'])).toContain('HttpOnly');
    const me = await request(app).get(`${API}/me`).set('Authorization', `Bearer ${r.body.data.accessToken}`);
    expect(me.body.data.email).toBe(web.email);
  });

  it('does not store the MPIN in plain text', async () => {
    await post('/register', web);
    const u = await User.findOne({ email: String(web.email) }).select('+mpinHash').lean();
    expect(u!.mpinHash).toBeTruthy();
    expect(u!.mpinHash).not.toContain(web.mpin);
  });

  it('signs in afterwards with the MPIN, by email or by employee ID', async () => {
    await post('/register', web);
    expect((await post('/login', { identifier: web.email, mpin: web.mpin, platform: 'web' })).status).toBe(200);
    expect((await post('/login', { identifier: 'emp100', mpin: web.mpin, platform: 'web' })).status).toBe(200);
    expect((await post('/login', { identifier: web.email, mpin: '9999' })).status).toBe(401);
  });

  it('requires a 10-digit numeric phone number', async () => {
    for (const phone of ['98765', '98765432101', '98765 4321', '98765abcde', '+919876543210', '(987)6543210']) {
      expect((await post('/register', { ...web, phone })).status, phone).toBe(422);
    }
    expect((await post('/register', { ...web, phone: '9876543210' })).status).toBe(201);
  });

  it('requires every field', async () => {
    for (const key of ['name', 'email', 'phone', 'employeeId', 'mpin']) {
      const body: Record<string, unknown> = { ...web };
      delete body[key];
      const r = await post('/register', body);
      expect(r.status, key).toBe(422);
    }
    expect(await User.countDocuments()).toBe(0);
  });

  it('never lets a client self-register a privileged role', async () => {
    for (const role of ['MANAGEMENT', 'RECCE_COORDINATOR']) {
      expect((await post('/register', { ...web, role })).status).toBe(422);
    }
    expect((await post('/register', { ...web, role: 'RECCE_EXECUTIVE' })).status).toBe(422);
    expect((await post('/register', { ...field, role: 'OPERATIONS' })).status).toBe(422);
    expect(await User.countDocuments()).toBe(0);
  });

  it('validates the MPIN', async () => {
    for (const mpin of ['12', '1234', '1111', 'abcd', '12345']) {
      expect((await post('/register', { ...web, mpin })).status, mpin).toBe(422);
    }
  });

  it('registers with a password instead, signs in with it, and rejects weak ones', async () => {
    const r = await post('/register', field);
    expect(r.status).toBe(201);
    expect(r.body.data.user.authMethod).toBe('PASSWORD');
    expect(r.body.data.accessToken).toBeTruthy();
    expect((await post('/login', { identifier: field.email, password: field.password })).status).toBe(200);
    expect((await post('/login', { identifier: field.email, password: 'Wrong-pass1' })).status).toBe(401);
    expect((await post('/login', { identifier: field.email, mpin: '2580' })).status).toBe(401);
    const stored = await User.findOne({ email: String(field.email) }).select('+passwordHash +mpinHash').lean();
    expect(stored!.passwordHash).toBeTruthy();
    expect(stored!.mpinHash).toBeFalsy();
    for (const password of ['short1', 'onlyletters', '12345678']) {
      expect((await post('/register', { ...field, email: 'x@adinn.test', phone: '9000000077', employeeId: 'EMP77', password })).status, password).toBe(422);
    }
  });

  it('an MPIN account cannot sign in with a password and the reverse', async () => {
    await post('/register', web);
    expect((await post('/login', { identifier: web.email, password: '2580' })).status).toBe(401);
  });

  it('rejects duplicate email, phone and employee ID', async () => {
    await post('/register', web);
    expect((await post('/register', { ...field, email: web.email })).status).toBe(409);
    expect((await post('/register', { ...field, phone: web.phone })).status).toBe(409);
    expect((await post('/register', { ...field, employeeId: 'emp100' })).status).toBe(409);
    expect((await post('/register', field)).status).toBe(201);
  });
});

describe('admin bootstrap', () => {
  const admin = { ...web, role: 'SUPER_ADMIN', email: 'admin@adinn.test', phone: '9000000100', employeeId: 'ADM1' };

  it('lets the first admin register, then closes admin registration', async () => {
    expect((await request(app).get(`${API}/register-options`)).body.data.adminAvailable).toBe(true);
    const first = await post('/register', admin);
    expect(first.status).toBe(201);
    expect(first.body.data.user.role).toBe('SUPER_ADMIN');
    expect((await request(app).get(`${API}/register-options`)).body.data.adminAvailable).toBe(false);
    const second = await post('/register', { ...admin, email: 'admin2@adinn.test', phone: '9000000101', employeeId: 'ADM2' });
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe('ADMIN_EXISTS');
  });

  it('never allows an admin from the mobile app', async () => {
    expect((await post('/register', { ...admin, platform: 'mobile' })).status).toBe(422);
  });
});

describe('platform separation', () => {
  it('recce and vendor accounts cannot sign in on web; web roles cannot sign in on mobile', async () => {
    await post('/register', field);
    await post('/register', web);
    const a = await post('/login', { identifier: field.email, password: field.password, platform: 'web' });
    expect(a.status).toBe(403);
    expect(a.body.error.code).toBe('PLATFORM_NOT_ALLOWED');
    const b = await post('/login', { identifier: web.email, mpin: web.mpin, platform: 'mobile' });
    expect(b.body.error.code).toBe('PLATFORM_NOT_ALLOWED');
    expect((await post('/login', { identifier: field.email, password: field.password, platform: 'mobile' })).status).toBe(200);
  });
});

describe('role card must match the registered role', () => {
  it('operations account only signs in under Operations; every other card says "User not found"', async () => {
    await post('/register', web);
    for (const loginRole of ['BD', 'CLIENT_SERVICING', 'ADMIN', 'RECCE', 'VENDOR']) {
      const r = await post('/login', { identifier: web.email, mpin: web.mpin, loginRole, platform: 'web' });
      expect(r.status, loginRole).toBe(404);
      expect(r.body.error.code).toBe('USER_NOT_FOUND');
      expect(r.body.error.message).toBe('User not found');
    }
    const ok = await post('/login', { identifier: web.email, mpin: web.mpin, loginRole: 'OPERATIONS', platform: 'web' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.role).toBe('OPERATIONS');
  });

  it('works with the employee ID too', async () => {
    await post('/register', web);
    expect((await post('/login', { identifier: 'EMP100', mpin: web.mpin, loginRole: 'BD' })).status).toBe(404);
    expect((await post('/login', { identifier: 'EMP100', mpin: web.mpin, loginRole: 'OPERATIONS' })).status).toBe(200);
  });

  it('a Recce account cannot sign in as Vendor on mobile, and a Vendor cannot sign in as Recce', async () => {
    const recce: Record<string, unknown> = { ...field, authMethod: 'MPIN', password: undefined, mpin: '7391' };
    const vendor: Record<string, unknown> = { ...field, role: 'VENDOR', email: 'vendor@adinn.test', phone: '9000000500', employeeId: 'VEN1', authMethod: 'MPIN', password: undefined, mpin: '8264' };
    expect((await post('/register', recce)).status).toBe(201);
    expect((await post('/register', vendor)).status).toBe(201);
    const asVendor = await post('/login', { identifier: recce.email, mpin: '7391', loginRole: 'VENDOR', platform: 'mobile' });
    expect(asVendor.status).toBe(404);
    expect(asVendor.body.error.code).toBe('USER_NOT_FOUND');
    expect((await post('/login', { identifier: recce.email, mpin: '7391', loginRole: 'RECCE', platform: 'mobile' })).status).toBe(200);
    expect((await post('/login', { identifier: vendor.email, mpin: '8264', loginRole: 'RECCE', platform: 'mobile' })).status).toBe(404);
    expect((await post('/login', { identifier: vendor.email, mpin: '8264', loginRole: 'VENDOR', platform: 'mobile' })).status).toBe(200);
  });

  it('a wrong credential is still a normal credential error, not "User not found"', async () => {
    await post('/register', web);
    const r = await post('/login', { identifier: web.email, mpin: '9999', loginRole: 'BD' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('picking the wrong card never locks the account', async () => {
    await post('/register', web);
    for (let i = 0; i < 8; i++) expect((await post('/login', { identifier: web.email, mpin: web.mpin, loginRole: 'BD' })).status).toBe(404);
    expect((await post('/login', { identifier: web.email, mpin: web.mpin, loginRole: 'OPERATIONS' })).status).toBe(200);
  });

  it('an unknown card value is rejected', async () => {
    await post('/register', web);
    expect((await post('/login', { identifier: web.email, mpin: web.mpin, loginRole: 'SUPER_ADMIN' })).status).toBe(422);
  });

  it('logins without a card (older clients) still work', async () => {
    await post('/register', web);
    expect((await post('/login', { identifier: web.email, mpin: web.mpin })).status).toBe(200);
  });
});

describe('lockout', () => {
  it('locks the account after 5 wrong MPINs, even for the right one', async () => {
    await post('/register', web);
    for (let i = 0; i < 5; i++) expect((await post('/login', { identifier: web.email, mpin: '9999' })).status).toBe(401);
    const locked = await post('/login', { identifier: web.email, mpin: web.mpin });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });
});
