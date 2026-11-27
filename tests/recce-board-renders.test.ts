import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Board 2D drawing / 3D preview: stored inside the shop's document with the board they belong to (category DRAWING_2D / VIEW_3D, mediaKey = board),
 * one live picture of each kind per board, and shown nested under the board in the shop detail.
 */
let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root: string;
let token = '';
let siteId = '';
const api = () => request(app);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const png = (s: string) => Buffer.concat([PNG, Buffer.from(`${s}-${Math.random()}`)]);
const auth = () => ({ Authorization: `Bearer ${token}` });

const send = (data: Buffer, name: string, category: string) =>
  api().post(`/api/v1/recce/shops/${siteId}/photos`).set(auth()).attach('photos', data, name)
    .field('meta', JSON.stringify([{ category, mediaKey: 'm1', capturedAt: new Date().toISOString(), lat: 9.9, lng: 78.1, width: 1600, height: 1200, clientId: `cid-${Math.random().toString(36).slice(2)}` }]));
const put = (key: string, kind: string, data: Buffer) => api().put(`/api/v1/recce/shops/${siteId}/boards/${key}/renders/${kind}`).set(auth()).attach('file', data, 'render.png');
const detail = async () => (await api().get(`/api/v1/recce/shops/${siteId}`).set(auth())).body.data;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recce-board-renders-'));
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

  const vendor = await Vendor.create({ code: 'VND-R', name: 'VND-R', nameKey: 'VND-R', type: 'ORGANIZATION', mobile: '9000000002', status: 'ACTIVE', kyc: { pan: true, gst: true, bank: true, address: true } });
  const ops = await User.create({ name: 'OPS', email: 'ops@r.com', role: 'OPERATIONS', passwordHash: await hashPassword('Passw0rd!x') });
  await User.create({ name: 'VA', email: 'va@r.com', role: 'VENDOR', vendorId: vendor._id, passwordHash: await hashPassword('Passw0rd!x') });
  token = (await api().post('/api/v1/auth/login').send({ email: 'va@r.com', password: 'Passw0rd!x' })).body.data.accessToken;
  const client = await Client.create({ name: 'Amul', code: 'AM' });
  const project = await Project.create({ code: 'P-REND', name: 'Renders', client: client._id, status: 'IN_PROGRESS', assignedTo: ops._id, createdBy: ops._id, requirementType: 'SHOP_DETAILS' });
  siteId = String((await Site.create({ project: project._id, seq: 1, siteCode: 'P-REND-S1', scenario: 'MEASUREMENT_REQUIRED', shopName: 'Shop R1', boardType: 'GSB Single Side', quantity: 2, district: 'Madurai', lat: 9.9, lng: 78.1, channel: 'VENDOR', vendor: vendor._id }))._id);
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('board 2D / 3D renders', () => {
  it('stores the 2D drawing and 3D preview inside the board, next to its photos', async () => {
    expect((await put('m1', '2d', png('two-d'))).status).toBe(200);
    expect((await put('m1', '3d', png('three-d'))).status).toBe(200);
    expect((await send(Buffer.concat([JPEG, Buffer.from('front')]), 'front.jpg', 'SHOP_FRONT')).status).toBe(201);
    const board = (await detail()).boards.find((b: { key: string }) => b.key === 'm1');
    expect(board.drawing2d.category).toBe('DRAWING_2D');
    expect(board.view3d.category).toBe('VIEW_3D');
    expect(board.drawing2d.url).toBeTruthy();
    expect(board.photos.map((p: { category: string }) => p.category)).toEqual(['SHOP_FRONT']);
    expect(board.photoCount).toBe(1);
  });

  it('a new picture replaces the draft one: one live picture of each kind per board', async () => {
    await put('m1', '2d', png('two-d-new'));
    const d = await detail();
    expect(d.photos.filter((p: { category: string }) => p.category === 'DRAWING_2D')).toHaveLength(1);
  });

  it('refuses an unknown board and a render sent through the photo endpoint', async () => {
    expect((await put('zz', '2d', png('x'))).status).toBe(400);
    expect((await send(png('y'), 'x.png', 'DRAWING_2D')).status).toBe(400);
  });
});
