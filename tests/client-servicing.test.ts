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

describe('Client Servicing (handed-over orders only)', () => {
  it('reads sales orders and clients (plus Adinn Connect) only, and lands on its own page', () => {
    expect(ROLE_PERMISSIONS.CLIENT_SERVICING).toEqual(['sales:read', 'clients:read', 'connect:use']);
    expect(ROLE_HOME.CLIENT_SERVICING).toBe('/client-servicing/dashboard');
  });

  it('cannot reach projects, the BD Kanban, templates or any write', async () => {
    const as = { Authorization: `Bearer ${token}` };
    for (const url of ['/api/v1/projects', '/api/v1/projects/summary', '/api/v1/sales/orders/board', '/api/v1/email-templates/company-profile']) {
      expect((await api().get(url).set(as)).status, url).toBe(403);
    }
    expect((await api().post('/api/v1/clients').set(as).send({ name: 'X', code: 'XX' })).status).toBe(403);
    expect((await api().post('/api/v1/sales/orders').set(as).send({})).status).toBe(403);
  });

  it('sees only the orders handed over to them', async () => {
    const as = { Authorization: `Bearer ${token}` };
    const list = await api().get('/api/v1/sales/orders').set(as);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
  });

  it('gets dashboard counts for their own orders only; BD gets 403', async () => {
    const res = await api().get('/api/v1/sales/cs/summary').set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 0, unseen: 0, newClient: 0, existingClient: 0, thisWeek: 0, recent: [] });
    expect((await api().get('/api/v1/sales/cs/summary').set({ Authorization: `Bearer ${bdToken}` })).status).toBe(403);
  });

  it('finds a client by client ID, GST number or PAN', async () => {
    const { Client } = await import('../src/modules/clients/client.model');
    await Client.create({ name: 'Finder Co', code: 'FIND1', clientNo: 'CLI-9001', gstin: '33AAACU5678G1Z2', onboarding: { pan: 'AAACU5678G' }, contacts: [], status: 'ACTIVE' });
    const as = { Authorization: `Bearer ${token}` };
    for (const q of ['CLI-9001', '33AAACU5678G1Z2', 'AAACU5678G', 'finder']) {
      const res = await api().get(`/api/v1/clients?q=${q}`).set(as);
      expect(res.body.data.map((c: { code: string }) => c.code), q).toContain('FIND1');
    }
    expect((await api().get('/api/v1/clients?q=ZZZNOPE').set(as)).body.data).toEqual([]);
  });

  it('leaves BD untouched', async () => {
    const as = { Authorization: `Bearer ${bdToken}` };
    expect((await api().get('/api/v1/clients').set(as)).status).toBe(200);
    expect((await api().get('/api/v1/sales/orders/board').set(as)).status).toBe(200);
  });
});
