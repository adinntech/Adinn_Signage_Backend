import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';

/**
 * Mobile field recce flow (2026-11-21): six GPS-tagged photos, board items, installation feasibility, version history and compare.
 * Uses an in-memory MongoDB only (same setup as recce-review.test.ts). It never connects to the real database.
 */

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
const tokens: Record<string, string> = {};
const as = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` });
const api = () => request(app);
const ids: Record<string, string> = {};
let RecceConfig: typeof import('../src/modules/recce-review/recceReview.model').RecceConfig;

let n = 0;
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`m1-photo-${++n}-${Math.random()}`)]);
const meta = (category: string, extra: Record<string, unknown> = {}) => ({ category, mediaKey: 'm1', capturedAt: new Date().toISOString(), lat: 9.9, lng: 78.1, gpsAccuracy: 12, width: 1600, height: 1200, source: 'LIVE_CAMERA', device: 'Pixel 7', clientId: `cid-${Math.random().toString(36).slice(2)}-${n}`, ...extra });
const upload = (who: string, siteId: string, metas: Record<string, unknown>[]) => {
  let r = api().post(`/api/v1/recce/shops/${siteId}/photos`).set(as(who));
  metas.forEach((_, i) => { r = r.attach('photos', png(), `p${i}.png`); });
  return r.field('meta', JSON.stringify(metas));
};
const base = (siteId: string) => `/api/v1/recce/shops/${siteId}`;
const put = (who: string, siteId: string, body: Record<string, unknown>) => api().put(`${base(siteId)}/draft`).set(as(who)).send(body);
const submit = (who: string, siteId: string, key = `key-${Math.random().toString(36).slice(2)}-12345`) => api().post(`${base(siteId)}/submit`).set(as(who)).send({ idempotencyKey: key });
const detail = async (who: string, siteId: string) => (await api().get(base(siteId)).set(as(who))).body.data;
const answers = { ladderRequired: 'NO', scaffoldingRequired: 'NO', craneRequired: 'NO', hydraRequired: 'NO', manualInstallationPossible: 'YES' };
const photoOf = (d: { photos: { id: string; category: string }[] }, category: string) => d.photos.find((p) => p.category === category)!;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.LOCAL_UPLOAD_PATH = path.join(os.tmpdir(), `recce-review-m1-test-${Date.now()}`);
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  const { User } = await import('../src/modules/users/user.model');
  const { Vendor } = await import('../src/modules/vendors/vendor.model');
  const { Client } = await import('../src/modules/clients/client.model');
  const { Project } = await import('../src/modules/projects/project.model');
  const { Site } = await import('../src/modules/sites/site.model');
  ({ RecceConfig } = await import('../src/modules/recce-review/recceReview.model'));
  app = (await import('../src/app')).createApp();

  const kyc = { pan: true, gst: true, bank: true, address: true };
  const mk = (code: string) => Vendor.create({ code, name: code, nameKey: code, type: 'ORGANIZATION', mobile: '9000000000', status: 'ACTIVE', kyc });
  const a = await mk('VND-A');
  const b = await mk('VND-B');
  const passwordHash = await hashPassword('Passw0rd!x');
  const users: [string, string, unknown?][] = [['VA', 'VENDOR', a._id], ['VB', 'VENDOR', b._id], ['OPS', 'OPERATIONS'], ['CS', 'CLIENT_SERVICING'], ['ADMIN', 'SUPER_ADMIN']];
  for (const [key, role, vendorId] of users) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash, ...(vendorId ? { vendorId } : {}) });
    ids[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const client = await Client.create({ name: 'Amul', code: 'AM' });
  const p = await Project.create({ code: 'P-M1', name: 'Recce M1', client: client._id, status: 'IN_PROGRESS', assignedTo: ids.OPS, createdBy: ids.CS, requirementType: 'SHOP_DETAILS' });
  const mkSite = (i: number, extra: Record<string, unknown>) => Site.create({ project: p._id, seq: i, siteCode: `P-M1-S${i}`, scenario: 'MEASUREMENT_REQUIRED', shopName: `Shop ${i}`, boardType: 'GSB Single Side', quantity: 1, width: 6, height: 4, district: 'Madurai', lat: 9.9, lng: 78.1, ...extra });
  ids.S1 = String((await mkSite(1, { channel: 'VENDOR', vendor: a._id }))._id);
  ids.S2 = String((await mkSite(2, { channel: 'VENDOR', vendor: b._id }))._id);
  ids.S3 = String((await mkSite(3, { channel: 'VENDOR', vendor: a._id }))._id);
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

describe('six photo categories and photo metadata', () => {
  it('accepts the six field categories with source and device, and reports GPS verification and who captured it', async () => {
    const r = await upload('VA', ids.S1, [meta('SHOP_FRONT'), meta('SIDE_VIEW'), meta('LONG_SHOT'), meta('ANNOTATED_VIEW'), meta('LOCATION_VIEW'), meta('ACCESS_PATH'), meta('NAME_BOARD'), meta('ADDITIONAL', { lat: 0, lng: 0, source: 'GALLERY' })]);
    expect(r.status).toBe(201);
    const d = r.body.data;
    expect(d.photos).toHaveLength(8);
    for (const c of ['SIDE_VIEW', 'LONG_SHOT', 'ANNOTATED_VIEW', 'LOCATION_VIEW', 'ACCESS_PATH']) expect(d.categories.map((x: { key: string }) => x.key)).toContain(c);
    const front = photoOf(d, 'SHOP_FRONT') as Record<string, unknown>;
    expect(front.source).toBe('LIVE_CAMERA');
    expect(front.device).toBe('Pixel 7');
    expect(front.capturedByRole).toBe('VENDOR');
    expect(front.gpsVerified).toBe(true);
    const zero = photoOf(d, 'ADDITIONAL') as Record<string, unknown>;
    expect(zero.gpsVerified).toBe(false);
    expect(zero.source).toBe('GALLERY');
    expect((front.review as { status: string }).status).toBe('PENDING');
    expect(d.status).toBe('READY_TO_SUBMIT');
  });
  it('rejects an unknown category or source', async () => {
    expect((await upload('VA', ids.S1, [meta('FRONT_VIEW')])).status).toBe(422);
    expect((await upload('VA', ids.S1, [meta('SIDE_VIEW', { source: 'WEBCAM' })])).status).toBe(422);
  });
});

describe('installation feasibility is required at submit', () => {
  it('blocks submit without installation and names the five fields', async () => {
    const r = await submit('VA', ids.S1);
    expect(r.status).toBe(400);
    for (const f of Object.keys(answers)) expect(r.body.error.message).toContain(f);
    expect((await detail('VA', ids.S1)).installationPending).toHaveLength(5);
    expect((await detail('VA', ids.S1)).installation.ladderRequired).toBe('NOT_ASSESSED'); // never read as NO
  });
  it('saves installation alone, validates it, and an answer left NOT_ASSESSED still blocks submit', async () => {
    expect((await put('VA', ids.S1, { installation: { ladderRequired: 'MAYBE' } })).status).toBe(422);
    expect((await put('VA', ids.S1, { installation: { installationHeightFt: 600 } })).status).toBe(422);
    expect((await put('VA', ids.S1, { installation: { accessRestrictions: Array(11).fill('x') } })).status).toBe(422);
    const ok = await put('VA', ids.S1, { installation: { ...answers, craneRequired: 'NOT_ASSESSED', electricalAccess: 'AVAILABLE', installationHeightFt: 18, accessRestrictions: ['Narrow lane'] } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.installation.electricalAccess).toBe('AVAILABLE');
    expect(ok.body.data.installationPending).toEqual(['craneRequired']);
    const r = await submit('VA', ids.S1);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('craneRequired');
    expect(r.body.error.message).not.toContain('ladderRequired');
  });
  it('a later save keeps earlier answers (only sent fields change) and is logged', async () => {
    const r = await put('VA', ids.S1, { installation: { craneRequired: 'NO', notes: 'Shutter opens outward' } });
    expect(r.body.data.installation).toMatchObject({ ...answers, installationHeightFt: 18, accessRestrictions: ['Narrow lane'], notes: 'Shutter opens outward' });
    expect(r.body.data.installationPending).toEqual([]);
    const t = await api().get(`${base(ids.S1)}/activity`).set(as('VA'));
    expect(t.body.data.map((e: { type: string }) => e.type)).toContain('INSTALLATION_UPDATED');
  });
  it('with GPS required, submit fails when a required photo has no usable GPS (and the shop stays editable)', async () => {
    await upload('VA', ids.S3, [meta('SHOP_FRONT', { lat: undefined, lng: undefined, gpsAccuracy: undefined }), meta('NAME_BOARD')]).expect(201);
    await put('VA', ids.S3, { installation: answers }).expect(200);
    await RecceConfig.updateOne({ key: 'default' }, { requireGps: true });
    const r = await submit('VA', ids.S3);
    await RecceConfig.updateOne({ key: 'default' }, { requireGps: false });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('GPS_REQUIRED');
    expect(JSON.stringify(r.body.error.details)).toContain('SHOP_FRONT');
    expect((await detail('VA', ids.S3)).editable).toBe(true);
  });
});

describe('version 1, rework flag, version 2 and compare', () => {
  let sub = '';
  let oldFront = '';
  it('submits version 1 with board details and an installation snapshot', async () => {
    await put('VA', ids.S1, { mediaItems: [{ key: 'm1', name: 'GSB Single Side', quantity: 1, width: 6, height: 4, unit: 'FT', sided: 'DOUBLE', condition: 'PROPOSED', position: 'Above the entrance', installationNotes: 'Needs two people' }] }).expect(200);
    const s = await submit('VA', ids.S1);
    expect(s.status).toBe(200);
    expect(s.body.data.version).toBe(1);
    sub = s.body.data.detail.submissionId;
    const item = s.body.data.detail.mediaItems[0];
    expect(item).toMatchObject({ sided: 'DOUBLE', condition: 'PROPOSED', position: 'Above the entrance', installationNotes: 'Needs two people' });
    oldFront = photoOf(s.body.data.detail, 'SHOP_FRONT').id;
  });
  it('shows an open rework as a flag on the marked photo only, with its history', async () => {
    const r = await api().post(`/api/v1/recce-review/submissions/${sub}/decision`).set(as('OPS')).send({ stage: 'OPS', decision: 'REWORK', versionNo: 1, comment: 'Front view is blurred, retake it.', checklist: [], items: [{ type: 'REPLACE_PHOTO', photo: oldFront, note: 'Blurred' }, { type: 'FIX_MEASUREMENT', mediaKey: 'm1', note: 'Re-measure the width' }] });
    expect(r.status).toBe(200);
    const d = await detail('VA', ids.S1);
    const front = photoOf(d, 'SHOP_FRONT') as { review: { status: string; openRework: { note: string; stage: string; stageLabel: string; requestedBy: string } | null } };
    expect(front.review.status).toBe('REWORK_REQUIRED');
    expect(front.review.openRework).toMatchObject({ note: 'Blurred', stage: 'OPS', requestedBy: 'OPS' });
    expect((photoOf(d, 'SIDE_VIEW') as typeof front).review).toEqual({ status: 'PENDING', openRework: null });
    const h = await api().get(`${base(ids.S1)}/photos/${oldFront}/history`).set(as('VA'));
    expect(h.status).toBe(200);
    expect(h.body.data.revisions).toHaveLength(1);
    expect(h.body.data.reworks[0]).toMatchObject({ photoId: oldFront, note: 'Blurred', resolved: false });
    expect((await api().get(`${base(ids.S2)}/photos/${oldFront}/history`).set(as('VA'))).status).toBe(404);
  });
  it('version 2: width 6 to 8, crane YES, front photo replaced; version 1 snapshot stays as it was', async () => {
    await put('VA', ids.S1, { mediaItems: [{ key: 'm1', name: 'GSB Single Side', quantity: 1, width: 8, height: 4, unit: 'FT', sided: 'DOUBLE', condition: 'PROPOSED', position: 'Above the entrance', installationNotes: 'Needs two people' }], installation: { craneRequired: 'YES' } }).expect(200);
    await upload('VA', ids.S1, [meta('SHOP_FRONT', { replaces: oldFront })]).expect(201);
    const s = await submit('VA', ids.S1);
    expect(s.status).toBe(200);
    expect(s.body.data.version).toBe(2);
    const v = await api().get(`${base(ids.S1)}/versions`).set(as('VA'));
    expect(v.status).toBe(200);
    expect(v.body.data.map((x: { version: number }) => x.version)).toEqual([1, 2]);
    const [v1, v2] = v.body.data;
    expect(v1.installation.craneRequired).toBe('NO'); // immutable
    expect(v1.mediaItems[0].width).toBe(6);
    expect(v2.installation.craneRequired).toBe('YES');
    expect(v2.mediaItems[0].width).toBe(8);
    expect(v1.photos).toHaveLength(8);
    expect(v1.photos.some((p: { id: string; state: string }) => p.id === oldFront && p.state === 'SUPERSEDED')).toBe(true);
    expect(v1.decisions.find((x: { stage: string }) => x.stage === 'OPS')).toMatchObject({ decision: 'REWORK', comment: 'Front view is blurred, retake it.' });
    expect(v1.reworks).toHaveLength(1);
    expect(v2.reworks).toHaveLength(0);
    expect(v2.submittedBy).toBe('VA');
    const hist = await api().get(`${base(ids.S1)}/photos/${photoOf(s.body.data.detail, 'SHOP_FRONT').id}/history`).set(as('VA'));
    expect(hist.body.data.revisions.map((x: { revision: number; id: string }) => x.id)).toEqual([oldFront, photoOf(s.body.data.detail, 'SHOP_FRONT').id]);
  });
  it('compares v1 to v2: width 6 to 8, one replaced front photo, the rest unchanged, crane changed', async () => {
    const r = await api().get(`${base(ids.S1)}/versions/compare`).query({ from: 1, to: 2 }).set(as('VA'));
    expect(r.status).toBe(200);
    const c = r.body.data;
    expect(c.photos.replaced).toHaveLength(1);
    expect(c.photos.replaced[0].from.id).toBe(oldFront);
    expect(c.photos.replaced[0].from.category).toBe('SHOP_FRONT');
    expect(c.photos.replaced[0].to.category).toBe('SHOP_FRONT');
    expect(c.photos.unchanged).toHaveLength(7);
    expect(c.photos.added).toHaveLength(0);
    expect(c.photos.removed).toHaveLength(0);
    expect(c.mediaItems.changed).toEqual([{ key: 'm1', name: 'GSB Single Side', fields: [{ field: 'width', from: 6, to: 8 }] }]);
    expect(c.installation).toEqual([{ field: 'craneRequired', from: 'NO', to: 'YES' }]);
    expect(c.notes).toBeNull();
    expect(c.from.version).toBe(1);
    expect(c.to.version).toBe(2);
    expect(c.from.submittedAt).toBeTruthy();
    expect(c.from.reviewerComments[0].comment).toContain('blurred');
    expect(c.to.reviewerComments).toEqual([]);
    expect(c.changed).toBe(true);
    expect((await api().get(`${base(ids.S1)}/versions/compare`).query({ from: 1, to: 9 }).set(as('VA'))).status).toBe(404);
    expect((await api().get(`${base(ids.S1)}/versions/compare`).query({ from: 'x', to: 2 }).set(as('VA'))).status).toBe(422);
  });
  it('another vendor gets 404 on versions and compare; reviewers use the review routes', async () => {
    expect((await api().get(`${base(ids.S1)}/versions`).set(as('VB'))).status).toBe(404);
    expect((await api().get(`${base(ids.S1)}/versions/compare`).query({ from: 1, to: 2 }).set(as('VB'))).status).toBe(404);
    const rv = await api().get(`/api/v1/recce-review/submissions/${sub}/versions`).set(as('OPS'));
    expect(rv.status).toBe(200);
    expect(rv.body.data).toHaveLength(2);
    const rc = await api().get(`/api/v1/recce-review/submissions/${sub}/versions/compare`).query({ from: 1, to: 2 }).set(as('CS'));
    expect(rc.status).toBe(200);
    expect(rc.body.data.mediaItems.changed[0].fields[0]).toEqual({ field: 'width', from: 6, to: 8 });
    const ws = await api().get(`/api/v1/recce-review/submissions/${sub}`).set(as('OPS'));
    expect(ws.body.data.installation.craneRequired).toBe('YES');
    expect(ws.body.data.versions[0].installation.craneRequired).toBe('NO');
    expect((await api().get(`/api/v1/recce-review/submissions/${sub}/versions`).set(as('VB'))).status).toBe(404);
  });
});
