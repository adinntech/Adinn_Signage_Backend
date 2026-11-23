import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Recce data of a shop lives in ONE collection, ONE document per shop (RecceSubmission): its photos, versions, reviews and rework
 * requests are embedded. These tests prove that (no separate collections), that every workflow step is one atomic change of that
 * document, that the same photo sent twice at once is stored once, and that deleting a project removes it all with its files.
 */
let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root: string;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const as = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` });
const api = () => request(app);
let Models: typeof import('../src/modules/recce-review/recceReview.model');

let n = 0;
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`one-doc-${++n}-${Math.random()}`)]);
const meta = (category: string, extra: Record<string, unknown> = {}) => ({ category, mediaKey: 'm1', capturedAt: new Date().toISOString(), lat: 9.9, lng: 78.1, width: 1600, height: 1200, clientId: `cid-${Math.random().toString(36).slice(2)}-${n}`, ...extra });
const upload = (who: string, siteId: string, metas: Record<string, unknown>[]) => {
  let r = api().post(`/api/v1/recce/shops/${siteId}/photos`).set(as(who));
  metas.forEach((_, i) => { r = r.attach('photos', png(), `p${i}.png`); });
  return r.field('meta', JSON.stringify(metas));
};
const answered = { ladderRequired: 'NO', scaffoldingRequired: 'NO', craneRequired: 'NO', hydraRequired: 'NO', manualInstallationPossible: 'YES' };
const submit = async (who: string, siteId: string, key: string) => {
  await api().put(`/api/v1/recce/shops/${siteId}/draft`).set(as(who)).send({ installation: answered });
  return api().post(`/api/v1/recce/shops/${siteId}/submit`).set(as(who)).send({ idempotencyKey: key });
};
const detail = async (who: string, siteId: string) => (await api().get(`/api/v1/recce/shops/${siteId}`).set(as(who))).body.data;
const filesUnder = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recce-one-doc-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  Models = await import('../src/modules/recce-review/recceReview.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  const { User } = await import('../src/modules/users/user.model');
  const { Vendor } = await import('../src/modules/vendors/vendor.model');
  const { Client } = await import('../src/modules/clients/client.model');
  const { Project } = await import('../src/modules/projects/project.model');
  const { Site } = await import('../src/modules/sites/site.model');
  app = (await import('../src/app')).createApp();

  const vendor = await Vendor.create({ code: 'VND-1', name: 'VND-1', nameKey: 'VND-1', type: 'ORGANIZATION', mobile: '9000000000', status: 'ACTIVE', kyc: { pan: true, gst: true, bank: true, address: true } });
  const passwordHash = await hashPassword('Passw0rd!x');
  for (const [key, role, vendorId] of [['VA', 'VENDOR', vendor._id], ['OPS', 'OPERATIONS'], ['CS', 'CLIENT_SERVICING'], ['ADMIN', 'SUPER_ADMIN']] as [string, string, unknown?][]) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash, ...(vendorId ? { vendorId } : {}) });
    ids[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const client = await Client.create({ name: 'Amul', code: 'AM' });
  for (const [tag, code] of [['A', 'P-ONE'], ['B', 'P-TWO']] as const) {
    const p = await Project.create({ code, name: `Project ${tag}`, client: client._id, status: 'IN_PROGRESS', assignedTo: ids.OPS, createdBy: ids.CS, requirementType: 'SHOP_DETAILS' });
    ids[`P${tag}`] = String(p._id);
    for (const i of [1, 2]) {
      ids[`S${tag}${i}`] = String((await Site.create({ project: p._id, seq: i, siteCode: `${code}-S${i}`, scenario: 'MEASUREMENT_REQUIRED', shopName: `Shop ${tag}${i}`, boardType: 'GSB Single Side', quantity: 2, district: 'Madurai', lat: 9.9, lng: 78.1, channel: 'VENDOR', vendor: vendor._id }))._id);
    }
  }
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('recce data of a shop is one document', () => {
  it('keeps photos, versions, reviews and rework inside the shop document through a full rework cycle', async () => {
    const siteId = ids.SA1;
    expect((await upload('VA', siteId, [meta('SHOP_FRONT'), meta('NAME_BOARD')])).status).toBe(201);
    const first = await submit('VA', siteId, 'one-doc-key-1');
    expect(first.status).toBe(200);
    expect(first.body.data.version).toBe(1);

    const d1 = await detail('VA', siteId);
    const front = d1.photos.find((p: { category: string }) => p.category === 'SHOP_FRONT').id as string;
    const reworkAsk = await api().post(`/api/v1/recce-review/submissions/${d1.submissionId}/decision`).set(as('OPS')).send({
      stage: 'OPS', decision: 'REWORK', versionNo: 1, comment: 'Retake the front photo', checklist: [], items: [{ type: 'REPLACE_PHOTO', category: 'SHOP_FRONT', photo: front, note: 'blurry' }],
    });
    expect(reworkAsk.status).toBe(200);
    expect((await detail('VA', siteId)).status).toBe('REWORK_REQUIRED');

    const replace = await upload('VA', siteId, [meta('SHOP_FRONT', { replaces: front })]);
    expect(replace.status).toBe(201);
    const second = await submit('VA', siteId, 'one-doc-key-2');
    expect(second.status).toBe(200);
    expect(second.body.data.version).toBe(2);
    const again = await submit('VA', siteId, 'one-doc-key-2'); // a retried tap returns the same version, no third one
    expect(again.body.data.duplicate).toBe(true);

    // Exactly one document for the shop, and it holds everything.
    const docs = await Models.RecceSubmission.find({ site: siteId }).lean();
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(doc.photos).toHaveLength(3);
    expect(doc.photos.map((p) => p.state).sort()).toEqual(['SUBMITTED', 'SUBMITTED', 'SUPERSEDED']);
    const old = doc.photos.find((p) => String(p._id) === front)!;
    const fresh = doc.photos.find((p) => String(p.replaces) === front)!;
    expect(String(old.supersededBy)).toBe(String(fresh._id));
    expect(fresh.version).toBe(2);
    expect(doc.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(doc.versions[1]!.photos.map(String)).toContain(String(fresh._id));
    expect(doc.versions[1]!.photos.map(String)).not.toContain(front);
    expect(doc.versions[1]!.removed.map(String)).toContain(front);
    expect(doc.reviews).toHaveLength(4); // 2 stages x 2 versions
    expect(doc.reviews.filter((r) => r.versionNo === 1 && r.stage === 'OPS')[0]!.decision).toBe('REWORK');
    expect(doc.reviews.filter((r) => r.versionNo === 2).map((r) => r.decision)).toEqual(['PENDING', 'PENDING']);
    expect(doc.reworks).toHaveLength(1);
    expect(doc.reworks[0]!.status).toBe('RESOLVED');
    expect(doc.reworks[0]!.items.every((i) => i.resolved && i.resolvedInVersion === 2)).toBe(true);
    expect(doc.status).toBe('SUBMITTED');
    expect(doc.currentVersion).toBe(2);
    expect(doc.attempts).toBe(2);
  });

  it('creates no separate collections for photos, versions, reviews or rework', async () => {
    const names = (await mongoose.connection.db!.listCollections().toArray()).map((c) => c.name);
    expect(names).toContain(Models.RecceSubmission.collection.name);
    expect(names.filter((x) => /recce/i.test(x) && /photo|version|review|rework/i.test(x))).toEqual([]);
  });

  it('stores the same photo once when it arrives twice at the same moment', async () => {
    const cid = 'race-client-id-0001';
    const [a, b] = await Promise.all([upload('VA', ids.SA2, [meta('SHOP_FRONT', { clientId: cid })]), upload('VA', ids.SA2, [meta('SHOP_FRONT', { clientId: cid })])]);
    expect([a.status, b.status].every((s) => s === 201 || s === 409)).toBe(true);
    const doc = (await Models.RecceSubmission.findOne({ site: ids.SA2 }).lean())!;
    expect(doc.photos.filter((p) => p.clientId === cid)).toHaveLength(1);
    expect(filesUnder(root).filter((f) => f.includes('P-ONE_P-ONE-S2'))).toHaveLength(1); // the loser's file was removed again
  });

  it('keeps a draft upload from landing in a shop that was just submitted', async () => {
    expect((await upload('VA', ids.SA1, [meta('ADDITIONAL')])).status).toBe(409);
    expect((await Models.RecceSubmission.findOne({ site: ids.SA1 }).lean())!.photos).toHaveLength(3);
  });
});

describe('deleting a project removes the embedded recce data and its files', () => {
  it('erases every shop document and photo file of that project, and leaves the other project alone', async () => {
    expect((await upload('VA', ids.SB1, [meta('SHOP_FRONT'), meta('NAME_BOARD')])).status).toBe(201);
    const before = filesUnder(root);
    const ofA = before.filter((f) => f.includes('P-ONE'));
    const ofB = before.filter((f) => f.includes('P-TWO'));
    expect(ofA.length).toBeGreaterThan(0);
    expect(ofB).toHaveLength(2);

    expect((await api().delete(`/api/v1/projects/${ids.PA}`).set(as('ADMIN'))).status).toBe(200);

    expect(await Models.RecceSubmission.countDocuments({ project: ids.PA })).toBe(0);
    expect(filesUnder(root).filter((f) => f.includes('P-ONE'))).toEqual([]);
    const keep = (await Models.RecceSubmission.findOne({ project: ids.PB }).lean())!;
    expect(keep.photos).toHaveLength(2);
    expect(filesUnder(root).filter((f) => f.includes('P-TWO'))).toHaveLength(2);
  });
});
