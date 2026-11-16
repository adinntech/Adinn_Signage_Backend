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

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-settings-'));
  delete process.env.CODE_REQUEST_PROJECT_RECIPIENTS;
  delete process.env.VENDOR_REGISTRATION_RECIPIENTS;
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

describe('mail routing (admin panel)', () => {
  it('only the Super Admin may open or change it', async () => {
    expect((await api().get('/api/v1/mail-settings/routing').set(as('CS'))).status).toBe(403);
    expect((await api().put('/api/v1/mail-settings/routing/PROJECT_CODE').set(as('CS')).send({ to: ['a@b.com'] })).status).toBe(403);
  });

  it('has no address built into the code: recipients are empty until the admin saves them', async () => {
    const res = await api().get('/api/v1/mail-settings/routing').set(as('ADMIN'));
    const by = Object.fromEntries(res.body.data.map((r: { key: string }) => [r.key, r]));
    expect(by.PROJECT_CODE).toMatchObject({ to: [], cc: [], isDefault: true });
    expect(by.VENDOR_REGISTRATION).toMatchObject({ to: [], cc: [], isDefault: true });
  });

  it('saves, lower-cases and validates the addresses', async () => {
    const bad = await api().put('/api/v1/mail-settings/routing/PROJECT_CODE').set(as('ADMIN')).send({ to: ['nope'], cc: [] });
    expect(bad.status).toBe(422);
    expect((await api().put('/api/v1/mail-settings/routing/NOPE').set(as('ADMIN')).send({ to: ['a@b.com'] })).status).toBeGreaterThanOrEqual(400);
    const ok = await api().put('/api/v1/mail-settings/routing/PROJECT_CODE').set(as('ADMIN')).send({ to: ['Project@Adinn.co.in'], cc: ['sm@adinn.co.in'], replyTo: 'codes@adinn.co.in' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ key: 'PROJECT_CODE', to: ['project@adinn.co.in'], cc: ['sm@adinn.co.in'], replyTo: 'codes@adinn.co.in', isDefault: false });
    const list = (await api().get('/api/v1/mail-settings/routing').set(as('ADMIN'))).body.data;
    expect(list.find((r: { key: string }) => r.key === 'PROJECT_CODE').cc).toEqual(['sm@adinn.co.in']);
  });
});
