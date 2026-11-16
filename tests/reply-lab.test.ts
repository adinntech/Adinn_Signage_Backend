import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
const tokens: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
const LAB = '/api/v1/mail-settings/reply-lab';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-lab-'));
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  for (const [key, role] of [['ADMIN', 'SUPER_ADMIN'], ['CS', 'CLIENT_SERVICING']] as const) {
    await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

describe('Email Reply Test Lab API', () => {
  it('is for the Super Admin only', async () => {
    expect((await api().get(`${LAB}/cases`)).status).toBe(401);
    for (const [m, p] of [['get', '/cases'], ['get', '/rules'], ['post', '/analyze'], ['post', '/run']] as const) expect((await api()[m](`${LAB}${p}`).set(as('CS')).send({})).status).toBe(403);
  });

  it('analyzes one reply and compares it with what was expected', async () => {
    const res = await api().post(`${LAB}/analyze`).set(as('ADMIN')).send({ workflow: 'VENDOR_ID', body: 'Vendor ID - AB12345\n> Vendor ID: 99999', expectStatus: 'EXTRACTED', expectValue: '12345' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ pass: true, result: { status: 'EXTRACTED', value: '12345', raw: 'AB12345', normalized: '12345' } });
    expect(res.body.data.result.cleanedText).toBe('Vendor ID - AB12345');
    const bad = await api().post(`${LAB}/analyze`).set(as('ADMIN')).send({ workflow: 'RATE_APPROVAL', body: 'Waiting for approval', expectStatus: 'APPROVED' });
    expect(bad.body.data).toMatchObject({ pass: false, result: { status: 'PENDING' } });
    expect((await api().post(`${LAB}/analyze`).set(as('ADMIN')).send({ workflow: 'NOPE', body: 'x' })).status).toBe(422);
  });

  it('runs the whole suite (180+ cases) and every case passes, without touching any record', async () => {
    const { Vendor } = await import('../src/modules/vendors/vendor.model');
    const { VendorRateApproval } = await import('../src/modules/vendors/vendorRateApproval.model');
    const before = [await Vendor.countDocuments(), await VendorRateApproval.countDocuments()];
    const res = await api().post(`${LAB}/run`).set(as('ADMIN')).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBeGreaterThanOrEqual(180);
    expect(res.body.data.rows.filter((r: { pass: boolean }) => !r.pass)).toEqual([]);
    expect(res.body.data.failed).toBe(0);
    const one = await api().post(`${LAB}/run`).set(as('ADMIN')).send({ group: 'CROSS' });
    expect(one.body.data.total).toBe(30);
    expect([await Vendor.countDocuments(), await VendorRateApproval.countDocuments()]).toEqual(before);
  });
});
