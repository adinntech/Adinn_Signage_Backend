import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import { ROLE_HOME, ROLE_PERMISSIONS } from '../src/modules/roles/roles';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let token = '';
let bdToken = '';
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
  app = (await import('../src/app')).createApp();
  for (const [key, role] of [['BD', 'BD'], ['CS', 'CLIENT_SERVICING']] as const) {
    await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    const t = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
    if (key === 'BD') bdToken = t;
    else token = t;
  }
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

describe('Client Servicing has no modules yet', () => {
  it('holds no permissions and lands on its own empty page', () => {
    expect(ROLE_PERMISSIONS.CLIENT_SERVICING).toEqual([]);
    expect(ROLE_HOME.CLIENT_SERVICING).toBe('/client-servicing/dashboard');
  });

  it('can sign in but cannot reach the BD dashboard data, clients, projects or sales', async () => {
    const as = { Authorization: `Bearer ${token}` };
    for (const url of ['/api/v1/clients', '/api/v1/projects', '/api/v1/projects/summary', '/api/v1/sales/orders/board', '/api/v1/email-templates/company-profile']) {
      expect((await api().get(url).set(as)).status, url).toBe(403);
    }
    expect((await api().post('/api/v1/clients').set(as).send({ name: 'X', code: 'XX' })).status).toBe(403);
  });

  it('leaves BD untouched', async () => {
    const as = { Authorization: `Bearer ${bdToken}` };
    expect((await api().get('/api/v1/clients').set(as)).status).toBe(200);
    expect((await api().get('/api/v1/sales/orders/board').set(as)).status).toBe(200);
  });
});
