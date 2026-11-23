import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Physical boards (2026-11-23): one item per physical board with its own permanent key, a readable number (media type + seq),
 * photos tied to ONE board through `mediaKey`, and boards made before numbers existed still working.
 */
let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root: string;
let token = '';
let siteId = '';
const api = () => request(app);
const auth = () => ({ Authorization: `Bearer ${token}` });

let n = 0;
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`board-${++n}-${Math.random()}`)]);
const meta = (category: string, mediaKey: string) => JSON.stringify([{ category, mediaKey, capturedAt: new Date().toISOString(), lat: 9.9, lng: 78.1, width: 1600, height: 1200, clientId: `cid-${Math.random().toString(36).slice(2)}-${n}` }]);
const upload = (category: string, mediaKey: string) => api().post(`/api/v1/recce/shops/${siteId}/photos`).set(auth()).attach('photos', png(), 'p.png').field('meta', meta(category, mediaKey));
const saveBoards = (mediaItems: Record<string, unknown>[]) => api().put(`/api/v1/recce/shops/${siteId}/draft`).set(auth()).send({ mediaItems });
const detail = async () => (await api().get(`/api/v1/recce/shops/${siteId}`).set(auth())).body.data;

const GSB1 = { key: 'b1', name: 'GSB Board (Glow Sign Board)', mediaType: 'GSB', seq: 1, quantity: 1, width: 6, height: 4, unit: 'FT' };
const GSB2 = { key: 'b2', name: 'GSB Board (Glow Sign Board)', mediaType: 'GSB', seq: 2, quantity: 1, width: 8, height: 4, unit: 'FT' };
const ACR1 = { key: 'b3', name: 'Clear Acrylic', mediaType: 'Acrylic', seq: 1, quantity: 1, width: 3, height: 2, unit: 'FT' };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recce-boards-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  const { User } = await import('../src/modules/users/user.model');
  const { Vendor } = await import('../src/modules/vendors/vendor.model');
  const { Client } = await import('../src/modules/clients/client.model');
  const { Project } = await import('../src/modules/projects/project.model');
  const { Site } = await import('../src/modules/sites/site.model');
  app = (await import('../src/app')).createApp();

  const vendor = await Vendor.create({ code: 'VND-B', name: 'VND-B', nameKey: 'VND-B', type: 'ORGANIZATION', mobile: '9000000002', status: 'ACTIVE', kyc: { pan: true, gst: true, bank: true, address: true } });
  const ops = await User.create({ name: 'OPS', email: 'ops@t.com', role: 'OPERATIONS', passwordHash: await hashPassword('Passw0rd!x') });
  await User.create({ name: 'VA', email: 'va@t.com', role: 'VENDOR', vendorId: vendor._id, passwordHash: await hashPassword('Passw0rd!x') });
  token = (await api().post('/api/v1/auth/login').send({ email: 'va@t.com', password: 'Passw0rd!x' })).body.data.accessToken;
  const client = await Client.create({ name: 'Amul', code: 'AM' });
  const project = await Project.create({ code: 'P-BOARDS', name: 'Boards', client: client._id, status: 'IN_PROGRESS', assignedTo: ops._id, createdBy: ops._id, requirementType: 'SHOP_DETAILS' });
  siteId = String((await Site.create({ project: project._id, seq: 1, siteCode: 'P-BOARDS-S1', scenario: 'MEASUREMENT_REQUIRED', shopName: 'Shop B1', boardType: 'GSB Single Side', quantity: 2, district: 'Madurai', lat: 9.9, lng: 78.1, channel: 'VENDOR', vendor: vendor._id }))._id);
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('physical boards', () => {
  it('shows a board made before numbers existed by its name, with no media type and no number', async () => {
    const d = await detail(); // the shop's own line, seeded from what BD recorded (key m1, quantity 2)
    const old = d.mediaItems[0];
    expect(old.key).toBe('m1');
    expect(old.quantity).toBe(2);
    expect(old.mediaType).toBeNull();
    expect(old.seq).toBeNull();
    expect(old.label).toBe(old.name);
  });

  it('stores one item per physical board with its own key, type, number and size', async () => {
    const res = await saveBoards([GSB1, GSB2, ACR1]);
    expect(res.status).toBe(200);
    const items = res.body.data.mediaItems;
    expect(items.map((i: { label: string }) => i.label)).toEqual(['GSB-01', 'GSB-02', 'Acrylic-01']);
    expect(items.map((i: { key: string }) => i.key)).toEqual(['b1', 'b2', 'b3']);
    expect(items[0]).toMatchObject({ mediaType: 'GSB', seq: 1, width: 6, height: 4, quantity: 1 });
    expect(items[1]).toMatchObject({ mediaType: 'GSB', seq: 2, width: 8, height: 4, quantity: 1 }); // same type, its own size
  });

  it('refuses two boards with the same number, or the same key', async () => {
    expect((await saveBoards([GSB1, { ...GSB2, seq: 1 }])).status).toBe(400);
    expect((await saveBoards([GSB1, { ...GSB2, key: 'b1' }])).status).toBe(400);
  });

  it('ties a photo to ONE board and tracks what each board still lacks', async () => {
    expect((await upload('SHOP_FRONT', 'b1')).status).toBe(201);
    const d = await detail();
    const front = d.photos.filter((p: { category: string }) => p.category === 'SHOP_FRONT');
    expect(front).toHaveLength(1);
    expect(front[0].mediaKey).toBe('b1');
    const lacks = (key: string) => d.progress.missing.filter((m: { mediaKey: string; category: string }) => m.mediaKey === key && m.category === 'SHOP_FRONT');
    expect(lacks('b1')).toHaveLength(0); // GSB-01 has its front photo
    expect(lacks('b2')).toHaveLength(1); // GSB-02 and the acrylic board still need theirs
    expect(lacks('b3')).toHaveLength(1);
  });

  it('refuses a photo for a board that does not exist, and keeps a board with photos from being removed', async () => {
    expect((await upload('SHOP_FRONT', 'b9')).status).toBe(400);
    const res = await saveBoards([GSB2, ACR1]); // GSB-01 (b1) has a photo
    expect(res.status).toBe(409);
  });

  it('lets a second board of the same type take the same angle without touching the first', async () => {
    expect((await upload('SHOP_FRONT', 'b2')).status).toBe(201);
    const d = await detail();
    const byBoard = Object.fromEntries(d.photos.filter((p: { category: string }) => p.category === 'SHOP_FRONT').map((p: { mediaKey: string; id: string }) => [p.mediaKey, p.id]));
    expect(Object.keys(byBoard).sort()).toEqual(['b1', 'b2']);
    expect(byBoard.b1).not.toBe(byBoard.b2);
  });
});
