import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
const tokens: Record<string, string> = {};
const as = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` });
const api = () => request(app);
const ids: Record<string, string> = {};
let projectId = '';
let Project: typeof import('../src/modules/projects/project.model').Project;
let Notification: typeof import('../src/modules/notifications/notification.model').Notification;

let n = 0;
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`photo-${++n}-${Math.random()}`)]);
const meta = (category: string, extra: Record<string, unknown> = {}) => ({ category, mediaKey: 'm1', capturedAt: new Date().toISOString(), lat: 9.9, lng: 78.1, width: 1600, height: 1200, clientId: `cid-${Math.random().toString(36).slice(2)}-${n}`, ...extra });
const upload = (who: string, siteId: string, metas: Record<string, unknown>[], buffers?: Buffer[]) => {
  let r = api().post(`/api/v1/recce/shops/${siteId}/photos`).set(as(who));
  metas.forEach((_, i) => { r = r.attach('photos', buffers?.[i] ?? png(), `p${i}.png`); });
  return r.field('meta', JSON.stringify(metas));
};
const fillRequired = async (who: string, siteId: string) => {
  await upload(who, siteId, [meta('SHOP_FRONT'), meta('NAME_BOARD')]).expect(201);
};
// Installation feasibility is required at submit (2026-11-21): answer it first so these older flows still submit. Ignored when the shop is not this login's or is locked.
const answered = { ladderRequired: 'NO', scaffoldingRequired: 'NO', craneRequired: 'NO', hydraRequired: 'NO', manualInstallationPossible: 'YES' };
const submit = async (who: string, siteId: string, key = `key-${Math.random().toString(36).slice(2)}-12345`) => {
  await api().put(`/api/v1/recce/shops/${siteId}/draft`).set(as(who)).send({ installation: answered });
  return api().post(`/api/v1/recce/shops/${siteId}/submit`).set(as(who)).send({ idempotencyKey: key });
};
const detail = async (who: string, siteId: string) => (await api().get(`/api/v1/recce/shops/${siteId}`).set(as(who))).body.data;
const ws = async (who: string, subId: string) => (await api().get(`/api/v1/recce-review/submissions/${subId}`).set(as(who))).body.data;
const allChecked = async (who: string, subId: string) => (await ws(who, subId)).checklist.map((c: { key: string }) => ({ key: c.key, passed: true }));
const decide = async (who: string, subId: string, stage: string, decision: string, extra: Record<string, unknown> = {}) => {
  const w = await ws(who, subId);
  return api().post(`/api/v1/recce-review/submissions/${subId}/decision`).set(as(who)).send({ stage, decision, versionNo: w.currentVersion, comment: '', checklist: decision === 'APPROVE' ? await allChecked(who, subId) : [], ...extra });
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.LOCAL_UPLOAD_PATH = path.join(os.tmpdir(), `recce-review-test-${Date.now()}`);
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  const { User } = await import('../src/modules/users/user.model');
  const { Vendor } = await import('../src/modules/vendors/vendor.model');
  const { Client } = await import('../src/modules/clients/client.model');
  ({ Project } = await import('../src/modules/projects/project.model'));
  ({ Notification } = await import('../src/modules/notifications/notification.model'));
  const { Site } = await import('../src/modules/sites/site.model');
  app = (await import('../src/app')).createApp();
  // These tests cover the ordered review (Operations first, then Client Servicing). The default is parallel review since 2026-11-23, see tests/recce-19steps.test.ts.
  const { RecceConfig } = await import('../src/modules/recce-review/recceReview.model');
  await RecceConfig.updateOne({ key: 'default' }, { $set: { sequential: true } }, { upsert: true });

  const kyc = { pan: true, gst: true, bank: true, address: true };
  const mk = (code: string) => Vendor.create({ code, name: code, nameKey: code, type: 'ORGANIZATION', mobile: '9000000000', status: 'ACTIVE', kyc });
  const a = await mk('VND-A');
  const b = await mk('VND-B');
  const passwordHash = await hashPassword('Passw0rd!x');
  const users: [string, string, unknown?][] = [['VA', 'VENDOR', a._id], ['VB', 'VENDOR', b._id], ['RECCE', 'RECCE_EXECUTIVE'], ['OPS', 'OPERATIONS'], ['OPS2', 'OPERATIONS'], ['CS', 'CLIENT_SERVICING'], ['CS2', 'CLIENT_SERVICING'], ['ADMIN', 'SUPER_ADMIN'], ['MGMT', 'MANAGEMENT']];
  for (const [key, role, vendorId] of users) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash, ...(vendorId ? { vendorId } : {}) });
    ids[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const client = await Client.create({ name: 'Amul', code: 'AM' });
  const p = await Project.create({ code: 'P-RR', name: 'Recce Review', client: client._id, status: 'IN_PROGRESS', assignedTo: ids.OPS, createdBy: ids.CS, requirementType: 'SHOP_DETAILS' });
  projectId = String(p._id);
  const mkSite = (i: number, extra: Record<string, unknown>) => Site.create({ project: p._id, seq: i, siteCode: `P-RR-S${i}`, scenario: 'MEASUREMENT_REQUIRED', shopName: `Shop ${i}`, boardType: 'GSB Single Side', quantity: 2, district: 'Madurai', lat: 9.9, lng: 78.1, ...extra });
  ids.S1 = String((await mkSite(1, { channel: 'VENDOR', vendor: a._id })) ._id);
  ids.S2 = String((await mkSite(2, { channel: 'VENDOR', vendor: b._id }))._id);
  ids.S3 = String((await mkSite(3, { channel: 'IN_HOUSE', assignedTo: ids.RECCE }))._id);
  ids.S4 = String((await mkSite(4, { channel: 'VENDOR', vendor: a._id }))._id);
  ids.S5 = String((await mkSite(5, { channel: 'VENDOR', vendor: a._id }))._id);
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

describe('assignment and access', () => {
  it('a vendor sees only its own shops and cannot open or upload to another vendor shop', async () => {
    const mine = await api().get('/api/v1/recce/shops').set(as('VA'));
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((s: { siteCode: string }) => s.siteCode).sort()).toEqual(['P-RR-S1', 'P-RR-S4', 'P-RR-S5']);
    expect(mine.body.data[0].status).toBe('NOT_STARTED');
    expect((await api().get(`/api/v1/recce/shops/${ids.S2}`).set(as('VA'))).status).toBe(404);
    expect((await upload('VA', ids.S2, [meta('SHOP_FRONT')])).status).toBe(404);
    expect((await submit('VA', ids.S2)).status).toBe(404);
  });
  it('an in-house executive sees only the shops given to them; review roles cannot use the field API', async () => {
    const r = await api().get('/api/v1/recce/shops').set(as('RECCE'));
    expect(r.body.data.map((s: { siteCode: string }) => s.siteCode)).toEqual(['P-RR-S3']);
    expect((await api().get('/api/v1/recce/shops').set(as('OPS'))).status).toBe(403);
    expect((await api().get(`/api/v1/recce/shops/${ids.S3}`).set(as('VA'))).status).toBe(404);
  });
  it('field roles cannot open the review API', async () => {
    expect((await api().get('/api/v1/recce-review/inbox').set(as('VA'))).status).toBe(403);
  });
});

describe('photo capture and upload', () => {
  it('uploads draft photos with metadata, seeds the media type, and flags suspicious data', async () => {
    const r = await upload('VA', ids.S1, [meta('SHOP_FRONT'), meta('NAME_BOARD', { capturedAt: new Date(Date.now() + 3600_000).toISOString(), lat: 10.9, lng: 79.1 })]);
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('READY_TO_SUBMIT');
    expect(r.body.data.mediaItems[0].name).toBe('GSB Single Side');
    expect(r.body.data.photos).toHaveLength(2);
    expect(r.body.data.progress.missing.length).toBe(0);
  });
  it('rejects the same photo twice, but a retried upload with the same clientId is stored once', async () => {
    const buf = png();
    const m = meta('LEFT_SIDE');
    expect((await upload('VA', ids.S1, [m], [buf])).status).toBe(201);
    const dup = await upload('VA', ids.S1, [meta('RIGHT_SIDE')], [buf]);
    expect(dup.status).toBe(409);
    const before = (await detail('VA', ids.S1)).photos.length;
    const retry = await upload('VA', ids.S1, [m]);
    expect(retry.status).toBe(201);
    expect((await detail('VA', ids.S1)).photos.length).toBe(before);
  });
  it('accepts a photo without GPS (permission denied) and rejects non-images', async () => {
    const r = await upload('VA', ids.S4, [{ category: 'SHOP_FRONT', mediaKey: 'm1', clientId: 'no-gps-12345' }]);
    expect(r.status).toBe(201);
    const bad = await api().post(`/api/v1/recce/shops/${ids.S4}/photos`).set(as('VA')).attach('photos', Buffer.from('not an image'), 'x.png').field('meta', JSON.stringify([meta('SHOP_FRONT')]));
    expect(bad.status).toBe(400);
  });
  it('blocks submit while required photos are missing and names them', async () => {
    const r = await submit('VA', ids.S4);
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body.error.details)).toContain('Shop Name Board');
  });
  it('deletes a draft photo for real and records it', async () => {
    const d = await detail('VA', ids.S4);
    const id = d.photos[0].id;
    const r = await api().delete(`/api/v1/recce/shops/${ids.S4}/photos/${id}`).set(as('VA'));
    expect(r.status).toBe(200);
    expect(r.body.data.photos).toHaveLength(0);
    const t = await api().get(`/api/v1/recce/shops/${ids.S4}/activity`).set(as('VA'));
    expect(t.body.data.map((e: { type: string }) => e.type)).toContain('PHOTO_DELETED');
  });
});

describe('submission and two-stage review', () => {
  let sub = '';
  it('submits once as version 1; a double tap with the same key does not create a second version', async () => {
    const key = 'double-tap-key-1';
    const [x, y] = await Promise.all([submit('VA', ids.S1, key), submit('VA', ids.S1, key)]);
    expect([x.status, y.status].every((s) => s === 200 || s === 409)).toBe(true);
    const again = await submit('VA', ids.S1, key);
    expect(again.status).toBe(200);
    expect(again.body.data.duplicate).toBe(true);
    const d = await detail('VA', ids.S1);
    sub = d.submissionId;
    expect(d.status).toBe('SUBMITTED');
    expect(d.version).toBe(1);
    expect(d.versions).toHaveLength(1);
  });
  it('locks the shop after submit: no new photos, no deleting submitted photos, no second submit', async () => {
    expect((await upload('VA', ids.S1, [meta('MOUNTING_AREA')])).status).toBe(409);
    const d = await detail('VA', ids.S1);
    expect((await api().delete(`/api/v1/recce/shops/${ids.S1}/photos/${d.photos[0].id}`).set(as('VA')).query({ reason: 'oops' })).status).toBe(409);
    expect((await submit('VA', ids.S1)).status).toBe(409);
  });
  it('shows the submission to Operations and its Client Servicing, but not to other reviewers', async () => {
    for (const who of ['OPS', 'CS', 'ADMIN', 'MGMT']) {
      const r = await api().get('/api/v1/recce-review/inbox').set(as(who));
      expect(r.status).toBe(200);
      expect(r.body.data.map((x: { id: string }) => x.id)).toContain(sub);
    }
    for (const who of ['OPS2', 'CS2']) expect((await api().get('/api/v1/recce-review/inbox').set(as(who))).body.data).toHaveLength(0);
    expect((await api().get(`/api/v1/recce-review/submissions/${sub}`).set(as('OPS2'))).status).toBe(404);
    const f = await api().get('/api/v1/recce-review/inbox').query({ district: 'Madurai', client: 'amul', mediaType: 'gsb' }).set(as('OPS'));
    expect(f.body.data.length).toBeGreaterThan(0);
    const none = await api().get('/api/v1/recce-review/inbox').query({ district: 'Chennai' }).set(as('OPS'));
    expect(none.body.data).toHaveLength(0);
  });
  it('notifies the Operations reviewer and posts the structured card into the shop thread', async () => {
    expect(await Notification.countDocuments({ recipient: ids.OPS, kind: 'RECCE_SUBMITTED' })).toBeGreaterThan(0);
    const thread = await api().get(`/api/v1/recce/shops/${ids.S1}/messages`).set(as('VA'));
    expect(thread.body.data[0].card.title).toBe('Shop Recce Submitted');
    expect(thread.body.data[0].card.lines.map((l: { label: string }) => l.label)).toEqual(expect.arrayContaining(['Project', 'Shop', 'Submitted By', 'Media Types', 'Photos', 'Submission Version']));
    const other = await api().get(`/api/v1/recce/shops/${ids.S4}/messages`).set(as('VA'));
    expect(other.body.data).toHaveLength(0);
    const reply = await api().post(`/api/v1/recce/shops/${ids.S1}/messages`).set(as('VA')).send({ body: 'Visited, board is faded' });
    expect(reply.status).toBe(201);
  });
  it('Client Servicing cannot decide before Operations; Operations cannot decide the CS stage', async () => {
    expect((await decide('CS', sub, 'CS', 'APPROVE')).status).toBe(409);
    expect((await decide('OPS', sub, 'CS', 'APPROVE')).status).toBe(403);
    expect((await decide('ADMIN', sub, 'OPS', 'APPROVE')).status).toBe(403);
  });
  it('approval needs the full checklist and a rejection needs a reason', async () => {
    const w = await ws('OPS', sub);
    const partial = await api().post(`/api/v1/recce-review/submissions/${sub}/decision`).set(as('OPS')).send({ stage: 'OPS', decision: 'APPROVE', versionNo: w.currentVersion, checklist: [{ key: 'correct_shop', passed: true }] });
    expect(partial.status).toBe(400);
    expect((await decide('OPS', sub, 'OPS', 'REJECT')).status).toBe(400);
  });
  it('Operations approval alone is not final; Client Servicing approval makes it final and locks it', async () => {
    const a = await decide('OPS', sub, 'OPS', 'APPROVE');
    expect(a.status).toBe(200);
    expect(a.body.data.status).toBe('UNDER_REVIEW');
    expect(a.body.data.me.openStage).toBe('CS');
    expect((await decide('OPS', sub, 'OPS', 'APPROVE')).status).toBe(409); // cannot decide twice
    expect(await Notification.countDocuments({ recipient: ids.CS, kind: 'RECCE_SUBMITTED' })).toBeGreaterThan(0);
    const c = await decide('CS', sub, 'CS', 'APPROVE');
    expect(c.body.data.status).toBe('APPROVED');
    expect((await detail('VA', ids.S1)).status).toBe('APPROVED');
    expect((await upload('VA', ids.S1, [meta('MOUNTING_AREA')])).status).toBe(409);
    expect(await Notification.countDocuments({ recipient: ids.VA, kind: 'RECCE_REVIEWED' })).toBeGreaterThan(0);
  });
  it('the timeline keeps every step and hides reviewer-only events from the field person', async () => {
    const types = (await api().get(`/api/v1/recce-review/submissions/${sub}/activity`).set(as('OPS'))).body.data.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['SHOP_VISIT_STARTED', 'PHOTO_CAPTURED', 'SUBMISSION_CREATED', 'REVIEW_STARTED'.replace('REVIEW_STARTED', 'REVIEW_APPROVED'), 'FINAL_APPROVAL', 'COMMENT_ADDED']));
    const filtered = await api().get(`/api/v1/recce-review/submissions/${sub}/activity`).query({ type: 'FINAL_APPROVAL' }).set(as('OPS'));
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].actor).toBe('CS');
  });
});

describe('rework, additional photos and versions', () => {
  let sub = '';
  it('rework keeps v1, asks for a right-side photo, and renews both reviews on v2', async () => {
    await fillRequired('RECCE', ids.S3);
    const first = await submit('RECCE', ids.S3);
    expect(first.status).toBe(200);
    sub = first.body.data.detail.submissionId;
    expect((await decide('OPS', sub, 'OPS', 'APPROVE')).body.data.status).toBe('UNDER_REVIEW');
    const bad = await decide('CS', sub, 'CS', 'ADDITIONAL', { comment: 'Need a clearer right-side view of the board mounting area.', items: [] });
    expect(bad.status).toBe(400);
    const rw = await decide('CS', sub, 'CS', 'ADDITIONAL', { comment: 'Need a clearer right-side view of the board mounting area.', items: [{ type: 'ADDITIONAL_PHOTO', category: 'RIGHT_SIDE', mediaKey: 'm1', note: 'closer' }] });
    expect(rw.status).toBe(200);
    expect(rw.body.data.status).toBe('REWORK_REQUIRED');
    expect(rw.body.data.reworks[0].status).toBe('OPEN');
    const d = await detail('RECCE', ids.S3);
    expect(d.status).toBe('REWORK_REQUIRED');
    expect(d.editable).toBe(true);
    expect(d.reworks[0].instructions).toContain('right-side');
    expect(await Notification.countDocuments({ recipient: ids.RECCE, kind: 'RECCE_REVIEWED' })).toBeGreaterThan(0);
  });
  it('resubmission is blocked until the requested photo is added, then makes version 2 with the change visible', async () => {
    const blocked = await submit('RECCE', ids.S3);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('REWORK_UNRESOLVED');
    await upload('RECCE', ids.S3, [meta('RIGHT_SIDE')]).expect(201);
    const second = await submit('RECCE', ids.S3);
    expect(second.status).toBe(200);
    expect(second.body.data.version).toBe(2);
    const w = await ws('CS', sub);
    expect(w.versions).toHaveLength(2);
    expect(w.versions[0].photoIds).toHaveLength(2);
    expect(w.versions[1].photoIds).toHaveLength(3);
    expect(w.versions[1].addedIds).toHaveLength(1);
    expect(w.versions[0].reviews.map((r: { decision: string }) => r.decision).sort()).toEqual(['APPROVED', 'REWORK']); // history stays on v1
    expect(w.versions[1].reviews.map((r: { decision: string }) => r.decision)).toEqual(['PENDING', 'PENDING']); // renewed
    expect(w.reworks[0].status).toBe('RESOLVED');
    expect(w.reworks[0].items[0].resolved).toBe(true);
    expect(w.status).toBe('SUBMITTED');
    expect(w.attempts).toBe(2);
  });
  it('a stale decision on the old version is refused', async () => {
    const r = await api().post(`/api/v1/recce-review/submissions/${sub}/decision`).set(as('OPS')).send({ stage: 'OPS', decision: 'APPROVE', versionNo: 1, checklist: await allChecked('OPS', sub) });
    expect(r.status).toBe(409);
  });
  it('replaces a submitted photo during rework: the old one is superseded, never erased; removal needs a reason', async () => {
    await decide('OPS', sub, 'OPS', 'REWORK', { comment: 'Name board is blurred, retake it.', items: [{ type: 'REPLACE_PHOTO', photo: (await detail('RECCE', ids.S3)).photos.find((p: { category: string }) => p.category === 'NAME_BOARD').id }] }).then((r) => expect(r.status).toBe(200));
    const d = await detail('RECCE', ids.S3);
    const old = d.photos.find((p: { category: string }) => p.category === 'NAME_BOARD');
    const noReason = await api().delete(`/api/v1/recce/shops/${ids.S3}/photos/${d.photos[0].id}`).set(as('RECCE'));
    expect(noReason.status).toBe(400);
    await upload('RECCE', ids.S3, [meta('NAME_BOARD', { replaces: old.id })]).expect(201);
    const done = await submit('RECCE', ids.S3);
    expect(done.status).toBe(200);
    expect(done.body.data.version).toBe(3);
    const w = await ws('OPS', sub);
    const oldRow = w.photos.find((p: { id: string }) => p.id === old.id);
    expect(oldRow.state).toBe('SUPERSEDED');
    expect(oldRow.url).toBeTruthy();
    expect(w.versions[2].removedIds).toContain(old.id);
    expect(w.versions[1].photoIds).toContain(old.id);
    expect(w.versions[2].photoIds).not.toContain(old.id);
    const field = await detail('RECCE', ids.S3);
    expect(field.photos.some((p: { id: string }) => p.id === old.id)).toBe(false);
  });
  it('removing a submitted photo while rework is open is a soft delete visible to reviewers only; admin can restore it', async () => {
    await decide('OPS', sub, 'OPS', 'REWORK', { comment: 'One photo is of the wrong shop.', items: [{ type: 'OTHER', note: 'remove wrong photo' }] }).then((r) => expect(r.status).toBe(200));
    const d = await detail('RECCE', ids.S3);
    const target = d.photos.find((p: { category: string }) => p.category === 'LEFT_SIDE' || p.category === 'RIGHT_SIDE');
    const rm = await api().delete(`/api/v1/recce/shops/${ids.S3}/photos/${target.id}`).query({ reason: 'Wrong shop in the picture' }).set(as('RECCE'));
    expect(rm.status).toBe(200);
    expect(rm.body.data.photos.some((p: { id: string }) => p.id === target.id)).toBe(false);
    const w = await ws('CS', sub);
    const row = w.photos.find((p: { id: string }) => p.id === target.id);
    expect(row.state).toBe('REMOVED');
    expect(row.removeReason).toBe('Wrong shop in the picture');
    expect(row.url).toBeTruthy();
    expect((await api().post(`/api/v1/recce-review/submissions/${sub}/photos/${target.id}/restore`).set(as('OPS'))).status).toBe(403);
    const back = await api().post(`/api/v1/recce-review/submissions/${sub}/photos/${target.id}/restore`).set(as('ADMIN'));
    expect(back.status).toBe(200);
    expect(back.body.data.photos.find((p: { id: string }) => p.id === target.id).state).toBe('SUBMITTED');
    const hist = await api().get('/api/v1/recce-review/monitor').set(as('ADMIN'));
    expect(hist.body.data.deletedPhotoActivity.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['PHOTO_REMOVED', 'PHOTO_RESTORED']));
  });
});

describe('rejection, reopen and admin override', () => {
  let sub = '';
  it('reject keeps the evidence, blocks edits and needs an Admin for a new attempt', async () => {
    await fillRequired('VA', ids.S4);
    const s = await submit('VA', ids.S4);
    expect(s.status).toBe(200);
    sub = s.body.data.detail.submissionId;
    const rej = await decide('OPS', sub, 'OPS', 'REJECT', { reason: 'Photos are of a different shop.' });
    expect(rej.status).toBe(200);
    expect(rej.body.data.status).toBe('REJECTED');
    expect(rej.body.data.photos).toHaveLength(2);
    expect((await detail('VA', ids.S4)).editable).toBe(false);
    expect((await upload('VA', ids.S4, [meta('MOUNTING_AREA')])).status).toBe(409);
    expect((await api().post(`/api/v1/recce-review/submissions/${sub}/reopen`).set(as('OPS')).send({ reason: 'let them retry' })).status).toBe(403);
    const re = await api().post(`/api/v1/recce-review/submissions/${sub}/reopen`).set(as('ADMIN')).send({ reason: 'Client agreed to a new visit' });
    expect(re.status).toBe(200);
    expect(re.body.data.status).toBe('IN_PROGRESS');
    expect((await detail('VA', ids.S4)).editable).toBe(true);
  });
  it('an Admin override needs a reason, is recorded, and is hidden from the field person', async () => {
    await fillRequired('VA', ids.S5);
    const s = await submit('VA', ids.S5);
    const id = s.body.data.detail.submissionId;
    expect((await api().post(`/api/v1/recce-review/submissions/${id}/override`).set(as('OPS')).send({ action: 'APPROVE', reason: 'urgent request' })).status).toBe(403);
    expect((await api().post(`/api/v1/recce-review/submissions/${id}/override`).set(as('ADMIN')).send({ action: 'APPROVE', reason: 'x' })).status).toBe(422);
    const o = await api().post(`/api/v1/recce-review/submissions/${id}/override`).set(as('ADMIN')).send({ action: 'APPROVE', reason: 'Client approved by phone call' });
    expect(o.body.data.status).toBe('APPROVED');
    expect(o.body.data.versions[0].reviews.every((r: { override: unknown }) => !!r.override)).toBe(true);
    const admin = (await api().get(`/api/v1/recce-review/submissions/${id}/activity`).set(as('ADMIN'))).body.data.map((e: { type: string }) => e.type);
    expect(admin).toContain('ADMIN_OVERRIDE');
    const field = (await api().get(`/api/v1/recce/shops/${ids.S5}/activity`).set(as('VA'))).body.data.map((e: { type: string }) => e.type);
    expect(field).not.toContain('ADMIN_OVERRIDE');
  });
});

describe('concurrency, progress, monitoring, closed projects', () => {
  it('two reviewers deciding the same stage at once: exactly one wins', async () => {
    const { Site } = await import('../src/modules/sites/site.model');
    const extra = await Site.create({ project: projectId, seq: 9, siteCode: 'P-RR-S9', scenario: 'MEASUREMENT_REQUIRED', shopName: 'Shop 9', boardType: 'Lit Board', channel: 'IN_HOUSE', assignedTo: ids.RECCE });
    await fillRequired('RECCE', String(extra._id));
    const s = await submit('RECCE', String(extra._id));
    const sub = s.body.data.detail.submissionId;
    const checklist = await allChecked('OPS', sub);
    const post = () => api().post(`/api/v1/recce-review/submissions/${sub}/decision`).set(as('OPS')).send({ stage: 'OPS', decision: 'APPROVE', versionNo: 1, checklist });
    const [a, b] = await Promise.all([post(), post()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await ws('OPS', sub)).versions[0].reviews.filter((r: { decision: string }) => r.decision === 'APPROVED')).toHaveLength(1);
  });
  it('progress counts each shop once by its current status and does not count rejected or pending as completed', async () => {
    const r = await api().get('/api/v1/recce-review/progress').query({ projectId }).set(as('OPS'));
    expect(r.status).toBe(200);
    const t = r.body.data.totals;
    expect(t.assigned).toBe(6);
    expect(t.approved).toBe(2); // S1 and S5
    expect(t.completed).toBe(2);
    expect(t.approved + t.inProgress + t.submitted + t.underReview + t.reworkRequired + t.rejected + t.notStarted).toBe(t.assigned);
    expect(r.body.data.completionPercent).toBe(Math.round((2 / 6) * 100));
    expect((await api().get('/api/v1/recce-review/progress').query({ projectId }).set(as('OPS2'))).status).toBe(404);
  });
  it('admin monitoring is for Admin and Management only', async () => {
    expect((await api().get('/api/v1/recce-review/monitor').set(as('ADMIN'))).status).toBe(200);
    expect((await api().get('/api/v1/recce-review/monitor').set(as('MGMT'))).status).toBe(200);
    expect((await api().get('/api/v1/recce-review/monitor').set(as('OPS'))).status).toBe(403);
  });
  it('only Admin changes the review configuration, and it is validated', async () => {
    expect((await api().put('/api/v1/recce-review/config').set(as('OPS')).send({ slaHours: 12 })).status).toBe(403);
    expect((await api().put('/api/v1/recce-review/config').set(as('ADMIN')).send({ slaHours: 0 })).status).toBe(422);
    expect((await api().put('/api/v1/recce-review/config').set(as('ADMIN')).send({ slaHours: 12 })).body.data.slaHours).toBe(12);
  });
  it('a completed project takes no more uploads, submissions or decisions', async () => {
    await Project.updateOne({ _id: projectId }, { status: 'COMPLETED' });
    expect((await upload('VA', ids.S4, [meta('MOUNTING_AREA')])).status).toBe(409);
    expect((await submit('VA', ids.S4)).status).toBe(409);
    await Project.updateOne({ _id: projectId }, { status: 'IN_PROGRESS' });
  });
});
