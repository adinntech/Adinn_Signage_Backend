import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root = '';
let token = '';
const api = () => request(app);
const GSTIN = '33AAGCA2094M1ZK';
const REPLY = {
  success: true, sandbox: false, cached: false, credits_remaining: 499,
  data: { gstin: GSTIN, legal_name: 'EXAMPLE COMPANY PRIVATE LIMITED', trade_name: 'Example Co', status: 'Active', constitution: 'Private Limited Company', taxpayer_type: 'Regular', registration_date: '01/07/2017', state: 'Tamil Nadu', state_code: '33', pan: 'AAGCA2094M', tan: null, address: '12 Main Road, Chennai, 600001', district: 'Chennai', pincode: '600001', nature_of_business: ['Supplier of Services'] },
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gst-lookup-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  process.env.GST_VERIFY_KEY = 'test-key-123';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  await User.create({ name: 'OPS', email: 'ops@t.com', role: 'OPERATIONS', passwordHash: await hashPassword('Passw0rd!x') });
  token = (await api().post('/api/v1/auth/login').send({ email: 'ops@t.com', password: 'Passw0rd!x' })).body.data.accessToken;
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  (await import('../src/modules/vendors/gstPortal.service')).clearGstCache();
});

const check = () => api().get(`/api/v1/vendors/gst/${GSTIN}`).set({ Authorization: `Bearer ${token}` });
const stub = (status: number, json: unknown) => {
  const f = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => json }));
  vi.stubGlobal('fetch', f);
  return f;
};

describe('GST lookup (paid service)', () => {
  it('returns the legal name, status, address and PAN, and sends the key in X-API-Key', async () => {
    const f = stub(200, REPLY);
    const r = await check();
    expect(r.status).toBe(200);
    expect(r.body.data.portal).toMatchObject({ available: true, error: null, details: { legalName: 'EXAMPLE COMPANY PRIVATE LIMITED', tradeName: 'Example Co', status: 'Active', pan: 'AAGCA2094M', state: 'Tamil Nadu', pincode: '600001', district: 'Chennai', natureOfBusiness: ['Supplier of Services'] } });
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe(`https://gst.getbusiness.co.in/api/v1/verify/${GSTIN}`);
    expect(init.headers['X-API-Key']).toBe('test-key-123');
    expect(JSON.stringify(r.body)).not.toContain('test-key-123');
  });

  it('asks the service once a day for the same number (each call costs a credit)', async () => {
    const f = stub(200, REPLY);
    await check();
    await check();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('turns a refused key, used-up credits, an unknown number and an outage into readable messages, and the check still works', async () => {
    const msg = async (status: number, json: unknown = {}) => { stub(status, json); const r = await check(); expect(r.status).toBe(200); expect(r.body.data.portal.details).toBeNull(); expect(r.body.data).toHaveProperty('zoho'); return r.body.data.portal.error as string; };
    expect(await msg(401)).toMatch(/GST_VERIFY_KEY/);
    expect(await msg(402)).toMatch(/credits/i);
    expect(await msg(404)).toMatch(/not found/i);
    expect(await msg(200, { success: false, message: 'Invalid GSTIN' })).toBe('Invalid GSTIN');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const r = await check();
    expect(r.body.data.portal.error).toMatch(/did not answer/i);
  });

  it('is off without a key', async () => {
    const { env } = await import('../src/config/env');
    const keep = env.GST_VERIFY_KEY;
    (env as { GST_VERIFY_KEY?: string }).GST_VERIFY_KEY = undefined;
    try {
      const f = stub(200, REPLY);
      const r = await check();
      expect(r.body.data.portal).toEqual({ available: false, reason: 'NOT_CONFIGURED' });
      expect(f).not.toHaveBeenCalled();
    } finally { (env as { GST_VERIFY_KEY?: string }).GST_VERIFY_KEY = keep; }
  });
});
