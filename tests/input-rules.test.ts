import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
let projectId = '';
const contact = { name: 'Suresh Kumar', email: 'suresh@client.example', phone: '9876543210' };

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
  for (const [key, role] of [['BD', 'BD'], ['OPS', 'OPERATIONS']] as const) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const clientId = (await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Rules Client', code: 'RUL' })).body.data._id;
  projectId = (await api().post('/api/v1/projects').set(as('BD')).send({ clientId, campaign: 'Rules', status: 'DRAFT', requirementType: 'SHOP_DETAILS', expectedShops: 5, startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Madurai', contacts: [contact] })).body.data._id;
  await api().post(`/api/v1/projects/${projectId}/assign`).set(as('BD')).send({ assigneeId: uid.OPS });
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

const site = (over: Record<string, unknown>) => api().post(`/api/v1/projects/${projectId}/sites`).set(as('OPS')).send({ shopName: 'Rule Shop', dealerName: 'Dealer', district: 'Madurai', mobile: '9843011122', ...over });
const fieldOf = (r: { body: { error?: { details?: { path: string }[] } } }) => (r.body.error?.details ?? []).map((d) => d.path);

describe('typed input is checked on the server too', () => {
  it('a shop phone must be exactly 10 digits', async () => {
    for (const mobile of ['98430111', '98430111223', '98430abc22', '1843011122']) {
      const r = await site({ mobile, shopName: `S ${mobile}` });
      expect(r.status, mobile).toBe(422);
      expect(fieldOf(r)).toContain('mobile');
    }
    expect((await site({ mobile: '9843011122' })).status).toBe(201);
  });

  it('a pincode must be 6 digits, GST 15 characters, sizes positive numbers', async () => {
    expect(fieldOf(await site({ pincode: '6292', shopName: 'P1' }))).toContain('pincode');
    expect(fieldOf(await site({ pincode: '62925a', shopName: 'P2' }))).toContain('pincode');
    expect(fieldOf(await site({ gstin: '33AAACA2094M1Z', shopName: 'G1', mobile: '9843011123' }))).toContain('gstin');
    expect((await site({ width: 'abc', height: 4, scenario: 'CLIENT_PROVIDED', shopName: 'W1', mobile: '9843011124' })).status).toBe(422);
    expect((await site({ pincode: '629251', gstin: '33AAACA2094M1ZK', shopName: 'Good', mobile: '9843011125' })).status).toBe(201);
  });

  it('a vendor needs a valid phone, PAN, GST, IFSC and a 9 to 18 digit account number', async () => {
    const base = { name: 'Rule Vendor', type: 'ONE_MAN', mobile: '9000000021', district: 'Madurai' };
    const bad = async (over: Record<string, unknown>, path: string) => {
      const r = await api().post('/api/v1/vendors').set(as('OPS')).send({ ...base, ...over });
      expect(r.status, path).toBe(422);
      expect(fieldOf(r)).toContain(path);
    };
    await bad({ mobile: '90000' }, 'mobile');
    await bad({ pan: 'ABC123' }, 'pan');
    await bad({ gstin: '33AAACA2094M1Z' }, 'gstin');
    await bad({ bank: { ifsc: 'SBIN123' } }, 'bank.ifsc');
    await bad({ bank: { accountNo: '1234' } }, 'bank.accountNo');
    expect((await api().post('/api/v1/vendors').set(as('OPS')).send({ ...base, pan: 'ABCDE1234F', gstin: '33AAACA2094M1ZK', bank: { accountNo: '123456789012', ifsc: 'SBIN0001234' } })).status).toBe(201);
  });

  it('a project contact phone must be 10 digits', async () => {
    const clientId = (await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Another', code: 'ANO' })).body.data._id;
    const mk = (phone: string) => api().post('/api/v1/projects').set(as('BD')).send({ clientId, campaign: 'Phones', status: 'DRAFT', requirementType: 'SHOP_DETAILS', expectedShops: 5, startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Madurai', contacts: [{ ...contact, phone }] });
    expect((await mk('98765')).status).toBe(422);
    expect((await mk('98765432101')).status).toBe(422);
    expect((await mk('98765abcde')).status).toBe(422);
    expect((await mk('9876543211')).status).toBe(201);
  });
});
