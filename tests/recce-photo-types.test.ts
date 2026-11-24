import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Recce photo types: a picture is accepted whatever picture format it is and whatever picture extension it carries
 * (a PNG screenshot saved as photo.jpg), a non-picture is still refused, and one picture can be stored for every photo type
 * of a shop (the person may use one good view for several angles).
 */
let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root: string;
let token = '';
let siteId = '';
const api = () => request(app);

const tail = (s: string) => Buffer.from(`${s}-${Math.random()}`);
const BYTES = {
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), tail('jpeg')]),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), tail('png')]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), tail('webp')]),
  gif: Buffer.concat([Buffer.from('GIF89a'), tail('gif')]),
  bmp: Buffer.concat([Buffer.from('BM'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), tail('bmp-body')]),
  heic: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), tail('heic')]),
};
const NOT_A_PICTURE = Buffer.concat([Buffer.from('PK'), tail('zip')]);
const SCRIPT = Buffer.from('MZ-not-a-picture-' + 'x'.repeat(40));

const meta = (category: string) => JSON.stringify([{ category, mediaKey: 'm1', capturedAt: new Date().toISOString(), lat: 9.9, lng: 78.1, width: 1600, height: 1200, clientId: `cid-${Math.random().toString(36).slice(2)}` }]);
const send = (data: Buffer, name: string, category: string) =>
  api().post(`/api/v1/recce/shops/${siteId}/photos`).set({ Authorization: `Bearer ${token}` }).attach('photos', data, name).field('meta', meta(category));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recce-photo-types-'));
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

  const vendor = await Vendor.create({ code: 'VND-T', name: 'VND-T', nameKey: 'VND-T', type: 'ORGANIZATION', mobile: '9000000001', status: 'ACTIVE', kyc: { pan: true, gst: true, bank: true, address: true } });
  const ops = await User.create({ name: 'OPS', email: 'ops@t.com', role: 'OPERATIONS', passwordHash: await hashPassword('Passw0rd!x') });
  await User.create({ name: 'VA', email: 'va@t.com', role: 'VENDOR', vendorId: vendor._id, passwordHash: await hashPassword('Passw0rd!x') });
  token = (await api().post('/api/v1/auth/login').send({ email: 'va@t.com', password: 'Passw0rd!x' })).body.data.accessToken;
  const client = await Client.create({ name: 'Amul', code: 'AM' });
  const project = await Project.create({ code: 'P-TYPES', name: 'Types', client: client._id, status: 'IN_PROGRESS', assignedTo: ops._id, createdBy: ops._id, requirementType: 'SHOP_DETAILS' });
  siteId = String((await Site.create({ project: project._id, seq: 1, siteCode: 'P-TYPES-S1', scenario: 'MEASUREMENT_REQUIRED', shopName: 'Shop T1', boardType: 'GSB Single Side', quantity: 2, district: 'Madurai', lat: 9.9, lng: 78.1, channel: 'VENDOR', vendor: vendor._id }))._id);
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('recce photo types', () => {
  it('accepts a picture under any picture extension, e.g. a PNG screenshot saved as .jpg', async () => {
    expect((await send(BYTES.png, 'photo_1.jpg', 'SHOP_FRONT')).status).toBe(201);
    expect((await send(BYTES.jpeg, 'photo_2.png', 'NAME_BOARD')).status).toBe(201);
  });

  it('accepts JPEG, PNG, WebP, GIF, BMP and HEIC pictures', async () => {
    const cases: [string, Buffer][] = [['a.jpg', BYTES.jpeg], ['b.png', BYTES.png], ['c.webp', BYTES.webp], ['d.gif', BYTES.gif], ['e.bmp', BYTES.bmp], ['f.heic', BYTES.heic]];
    for (const [name, data] of cases) {
      const res = await send(data, name, 'ADDITIONAL');
      expect(res.status, name).toBe(201);
    }
  });

  it('still refuses a file that is not a picture, whatever its name says', async () => {
    for (const [name, data] of [['fake.jpg', NOT_A_PICTURE], ['fake.png', SCRIPT], ['fake.heic', SCRIPT]] as [string, Buffer][]) {
      const res = await send(data, name, 'ADDITIONAL');
      expect(res.status, name).toBe(400);
      expect(res.body.error.message).toMatch(/does not match its type/);
    }
    expect((await send(SCRIPT, 'run.exe', 'ADDITIONAL')).status).toBe(400);
  });

  it('stores one picture for every photo type, with no switch or setting needed', async () => {
    const same = Buffer.concat([BYTES.png, Buffer.from('one-picture-for-all')]);
    for (const category of ['SIDE_VIEW', 'LONG_SHOT', 'ANNOTATED_VIEW', 'LOCATION_VIEW']) {
      const res = await send(same, 'photo_same.jpg', category);
      expect(res.status, category).toBe(201);
    }
    const detail = (await api().get(`/api/v1/recce/shops/${siteId}`).set({ Authorization: `Bearer ${token}` })).body.data;
    const stored = detail.photos.filter((p: { category: string }) => ['SIDE_VIEW', 'LONG_SHOT', 'ANNOTATED_VIEW', 'LOCATION_VIEW'].includes(p.category));
    expect(stored).toHaveLength(4);
  });
});
