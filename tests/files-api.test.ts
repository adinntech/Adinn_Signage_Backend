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
let root: string;
const tokens: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
let projectId = '';
let projectCode = '';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const XLSX = Buffer.concat([Buffer.from('PK'), Buffer.alloc(100, 2)]);
const listDir = (p: string) => (fs.existsSync(p) ? fs.readdirSync(p) : []);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-api-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  process.env.MAX_IMAGE_SIZE = '1000';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  for (const role of ['BD', 'FINANCE', 'RECCE_EXECUTIVE']) {
    await User.create({ name: role, email: `${role.toLowerCase()}@t.com`, role: role as 'BD', passwordHash: await hashPassword('Passw0rd!x') });
    tokens[role] = (await api().post('/api/v1/auth/login').send({ email: `${role.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const c = await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Coca Cola', code: 'COCA' });
  const p = await api().post('/api/v1/projects').set(as('BD')).send({ clientId: c.body.data._id, campaign: 'Files', requirement: { source: 'EMAIL', siteDataScenario: 'CLIENT_PROVIDED' } });
  projectId = p.body.data._id;
  projectCode = p.body.data.code;
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (role: string | null, category: string, file: { name: string; data: Buffer; type?: string }) => {
  const r = api().post(`/api/v1/projects/${projectId}/files`);
  if (role) r.set(as(role));
  return r.field('category', category).attach('files', file.data, { filename: file.name, contentType: file.type ?? 'application/octet-stream' });
};

describe('BD client documents', () => {
  let id = '';
  it('stores the Excel under BD/Client_Details/<client>/<project>', async () => {
    const res = await post('BD', 'BD_CLIENT_DETAILS', { name: 'Shop List.xlsx', data: XLSX });
    expect(res.status).toBe(201);
    id = res.body.data[0].id;
    const dir = path.join(root, 'BD', 'Client_Details', 'Coca_Cola', projectCode);
    const files = listDir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/_Shop_List\.xlsx$/);
    expect(fs.readFileSync(path.join(dir, files[0]!)).equals(XLSX)).toBe(true);
  });

  it('lists the file and opens it through a short-lived signed link', async () => {
    const list = await api().get(`/api/v1/projects/${projectId}/files?category=BD_CLIENT_DETAILS`).set(as('BD'));
    expect(list.body.data).toHaveLength(1);
    const u = await api().get(`/api/v1/files/${id}/url`).set(as('BD'));
    expect(u.status).toBe(200);
    const link = new URL(u.body.data.url);
    const ok = await api().get(link.pathname + link.search);
    expect(ok.status).toBe(200);
    const tampered = await api().get(link.pathname + link.search.replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(64)}`));
    expect(tampered.status).toBe(403);
  });

  it('erases the stored object when a normal document is deleted', async () => {
    const del = await api().delete(`/api/v1/files/${id}`).set(as('BD'));
    expect(del.body.data.removed).toBe('erased');
    expect(listDir(path.join(root, 'BD', 'Client_Details', 'Coca_Cola', projectCode))).toHaveLength(0);
    expect((await api().get(`/api/v1/files/${id}/url`).set(as('BD'))).status).toBe(404);
  });
});

describe('Recce images', () => {
  let id = '';
  it('stores originals under Recce/<client>/<project>/Images/Original', async () => {
    const res = await post('RECCE_EXECUTIVE', 'RECCE_IMAGE_ORIGINAL', { name: 'front.jpg', data: JPEG, type: 'image/jpeg' });
    expect(res.status).toBe(201);
    id = res.body.data[0].id;
    expect(listDir(path.join(root, 'Recce', 'Coca_Cola', projectCode, 'Images', 'Original'))).toHaveLength(1);
  });

  it('keeps the original object when evidence is deleted (soft delete only)', async () => {
    const del = await api().delete(`/api/v1/files/${id}`).set(as('RECCE_EXECUTIVE'));
    expect(del.body.data.removed).toBe('hidden');
    expect(listDir(path.join(root, 'Recce', 'Coca_Cola', projectCode, 'Images', 'Original'))).toHaveLength(1);
    const list = await api().get(`/api/v1/projects/${projectId}/files?category=RECCE_IMAGE_ORIGINAL`).set(as('BD'));
    expect(list.body.data).toHaveLength(0);
  });

  it('keeps edited photos separate from originals', async () => {
    const res = await post('RECCE_EXECUTIVE', 'RECCE_IMAGE_EDITED', { name: 'marked.png', data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(50)]), type: 'image/png' });
    expect(res.status).toBe(201);
    expect(listDir(path.join(root, 'Recce', 'Coca_Cola', projectCode, 'Images', 'Edited'))).toHaveLength(1);
  });
});

describe('guards', () => {
  it('requires login', async () => {
    expect((await post(null, 'BD_CLIENT_DETAILS', { name: 'a.xlsx', data: XLSX })).status).toBe(401);
  });

  it('enforces who may write to each category', async () => {
    expect((await post('RECCE_EXECUTIVE', 'BD_CLIENT_DETAILS', { name: 'a.xlsx', data: XLSX })).status).toBe(403);
    expect((await post('BD', 'RECCE_IMAGE_ORIGINAL', { name: 'a.jpg', data: JPEG })).status).toBe(403);
    expect((await post('FINANCE', 'BD_CLIENT_DETAILS', { name: 'a.xlsx', data: XLSX })).status).toBe(403);
  });

  it('limits who can read each category (Finance sees expenses, not recce photos or BD documents it did not need)', async () => {
    const photo = await post('RECCE_EXECUTIVE', 'RECCE_IMAGE_ORIGINAL', { name: 'guard.jpg', data: JPEG, type: 'image/jpeg' });
    const photoId = photo.body.data[0].id;
    expect((await api().get(`/api/v1/projects/${projectId}/files?category=RECCE_IMAGE_ORIGINAL`).set(as('FINANCE'))).status).toBe(403);
    expect((await api().get(`/api/v1/files/${photoId}/url`).set(as('FINANCE'))).status).toBe(403);
    const all = await api().get(`/api/v1/projects/${projectId}/files`).set(as('FINANCE'));
    expect(all.status).toBe(200);
    expect(all.body.data.every((f: { category: string }) => f.category !== 'RECCE_IMAGE_ORIGINAL')).toBe(true);
    // Recce staff cannot read BD client documents either.
    expect((await api().get(`/api/v1/projects/${projectId}/files?category=BD_CLIENT_DETAILS`).set(as('RECCE_EXECUTIVE'))).status).toBe(403);
    expect((await api().get(`/api/v1/files/${photoId}/url`).set(as('RECCE_EXECUTIVE'))).status).toBe(200);
  });

  it('rejects wrong types, spoofed content, unknown categories and oversize images', async () => {
    expect((await post('BD', 'BD_CLIENT_DETAILS', { name: 'run.exe', data: XLSX })).status).toBe(400);
    expect((await post('BD', 'BD_CLIENT_DETAILS', { name: 'fake.jpg', data: XLSX })).status).toBe(400);
    expect((await post('RECCE_EXECUTIVE', 'RECCE_IMAGE_ORIGINAL', { name: 'sheet.xlsx', data: XLSX })).status).toBe(400);
    expect((await post('BD', '../../hack', { name: 'a.xlsx', data: XLSX })).status).toBe(422);
    const big = await post('RECCE_EXECUTIVE', 'RECCE_IMAGE_ORIGINAL', { name: 'big.jpg', data: Buffer.concat([JPEG, Buffer.alloc(2000)]), type: 'image/jpeg' });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('returns 404 for an unknown project and never writes a file for it', async () => {
    const before = fs.readdirSync(root).length;
    const res = await api()
      .post('/api/v1/projects/64b000000000000000000000/files')
      .set(as('BD'))
      .field('category', 'BD_CLIENT_DETAILS')
      .attach('files', XLSX, { filename: 'a.xlsx' });
    expect(res.status).toBe(404);
    expect(fs.readdirSync(root).length).toBe(before);
  });
});
