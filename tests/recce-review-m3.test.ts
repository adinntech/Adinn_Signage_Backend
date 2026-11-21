import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Milestone 3 (2026-11-21): shop thread (paging, unread, refs, one image), system cards, field dashboard, staff performance,
 * verified cost, notifications. In-memory MongoDB only (same setup as recce-review-m1.test.ts): it never connects to the real database.
 */

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root: string;
const tokens: Record<string, string> = {};
const as = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` });
const api = () => request(app);
const ids = {} as Record<'vendorA' | 'vendorB' | 'VA' | 'VB' | 'EX1' | 'EX2' | 'OPS' | 'OPS2' | 'CS' | 'ADMIN' | 'MGMT' | 'P1' | 'P2' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8', string>;
let M: typeof import('../src/modules/recce-review/recceReview.model');
let Notification: typeof import('../src/modules/notifications/notification.model').Notification;
let ConnectMessage: typeof import('../src/modules/connect/connect.model').ConnectMessage;

let n = 0;
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`m3-photo-${++n}-${Math.random()}`)]);
const meta = (category: string, extra: Record<string, unknown> = {}) => ({ category, mediaKey: 'm1', capturedAt: new Date().toISOString(), lat: 9.9, lng: 78.1, gpsAccuracy: 12, width: 1600, height: 1200, source: 'LIVE_CAMERA', device: 'Pixel 7', clientId: `cid-${Math.random().toString(36).slice(2)}-${n}`, ...extra });
const upload = (who: string, siteId: string, metas: Record<string, unknown>[]) => {
  let r = api().post(`/api/v1/recce/shops/${siteId}/photos`).set(as(who));
  metas.forEach((_, i) => { r = r.attach('photos', png(), `p${i}.png`); });
  return r.field('meta', JSON.stringify(metas));
};
const base = (siteId: string) => `/api/v1/recce/shops/${siteId}`;
const answers = { ladderRequired: 'NO', scaffoldingRequired: 'NO', craneRequired: 'NO', hydraRequired: 'NO', manualInstallationPossible: 'YES' };
const submit = (who: string, siteId: string, key = `key-${Math.random().toString(36).slice(2)}-12345`) => api().post(`${base(siteId)}/submit`).set(as(who)).send({ idempotencyKey: key });
const detail = async (who: string, siteId: string) => (await api().get(base(siteId)).set(as(who))).body.data;
/** Photos + installation answers + submit, for a shop with the default required photos. */
async function submitShop(who: string, siteId: string, key?: string) {
  await upload(who, siteId, [meta('SHOP_FRONT'), meta('NAME_BOARD')]).expect(201);
  await api().put(`${base(siteId)}/draft`).set(as(who)).send({ installation: answers }).expect(200);
  const r = await submit(who, siteId, key);
  expect(r.status).toBe(200);
  return r;
}
const checklist = ['correct_shop', 'shop_front', 'board_area', 'angles', 'measurements', 'media_type', 'quantity', 'quality', 'gps', 'client_req'].map((key) => ({ key, passed: true }));
const decide = (who: string, sub: string, stage: string, decision: string, version: number, extra: Record<string, unknown> = {}) =>
  api().post(`/api/v1/recce-review/submissions/${sub}/decision`).set(as(who)).send({ stage, decision, versionNo: version, comment: decision === 'APPROVE' ? 'Looks fine' : 'Front view is blurry, please retake it', checklist, ...extra });
const thread = (who: string, siteId: string, qs = '') => api().get(`${base(siteId)}/messages${qs}`).set(as(who));
const say = (who: string, siteId: string, body: string, extra: Record<string, unknown> = {}) => api().post(`${base(siteId)}/messages`).set(as(who)).send({ body, ...extra });
const cardsOf = (msgs: { card: null | { title: string; lines: { label: string; value: string }[] } }[]) => msgs.filter((m) => m.card).map((m) => `${m.card!.title}:${m.card!.lines.find((l) => l.label === 'Decision')?.value ?? ''}`);
const perf = (who: string, qs = '') => api().get(`/api/v1/recce-review/performance${qs}`).set(as(who));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recce-review-m3-test-'));
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
  M = await import('../src/modules/recce-review/recceReview.model');
  ({ Notification } = await import('../src/modules/notifications/notification.model'));
  ({ ConnectMessage } = await import('../src/modules/connect/connect.model'));
  app = (await import('../src/app')).createApp();

  const kyc = { pan: true, gst: true, bank: true, address: true };
  const mk = (code: string) => Vendor.create({ code, name: code, nameKey: code, type: 'ORGANIZATION', mobile: '9000000000', status: 'ACTIVE', kyc });
  const a = await mk('VND-A');
  const b = await mk('VND-B');
  ids.vendorA = String(a._id);
  ids.vendorB = String(b._id);
  const passwordHash = await hashPassword('Passw0rd!x');
  const users: [string, string, unknown?][] = [['VA', 'VENDOR', a._id], ['VB', 'VENDOR', b._id], ['EX1', 'RECCE_EXECUTIVE'], ['EX2', 'RECCE_EXECUTIVE'], ['OPS', 'OPERATIONS'], ['OPS2', 'OPERATIONS'], ['CS', 'CLIENT_SERVICING'], ['ADMIN', 'SUPER_ADMIN'], ['MGMT', 'MANAGEMENT']];
  for (const [key, role, vendorId] of users) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash, ...(vendorId ? { vendorId } : {}) } as never) as unknown as { _id: unknown };
    (ids as Record<string, string>)[key] = String(u._id);
    const login = await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' });
    tokens[key] = login.body.data.accessToken;
  }
  const client = await Client.create({ name: 'Amul', code: 'AM' });
  const p1 = await Project.create({ code: 'P-M3', name: 'Recce M3', client: client._id, status: 'IN_PROGRESS', assignedTo: ids.OPS, createdBy: ids.CS, requirementType: 'SHOP_DETAILS' });
  const p2 = await Project.create({ code: 'P-M3B', name: 'Recce M3 B', client: client._id, status: 'IN_PROGRESS', assignedTo: ids.OPS2, createdBy: ids.ADMIN, requirementType: 'SHOP_DETAILS' });
  ids.P1 = String(p1._id);
  ids.P2 = String(p2._id);
  const mkSite = async (project: typeof p1, i: number, extra: Record<string, unknown>) => String((await Site.create({ project: project._id, seq: i, siteCode: `${project.code}-S${i}`, scenario: 'MEASUREMENT_REQUIRED', shopName: `Shop ${i}`, boardType: 'GSB Single Side', quantity: 1, width: 6, height: 4, district: 'Madurai', lat: 9.9, lng: 78.1, ...extra }))._id);
  ids.S1 = await mkSite(p1, 1, { channel: 'VENDOR', vendor: a._id });
  ids.S2 = await mkSite(p1, 2, { channel: 'VENDOR', vendor: b._id });
  ids.S3 = await mkSite(p1, 3, { channel: 'VENDOR', vendor: a._id });
  ids.S4 = await mkSite(p1, 4, { channel: 'IN_HOUSE', assignedTo: ids.EX1, status: 'IN_PROGRESS' });
  ids.S5 = await mkSite(p1, 5, { channel: 'IN_HOUSE', assignedTo: ids.EX1, status: 'IN_PROGRESS' });
  ids.S7 = await mkSite(p1, 7, { channel: 'VENDOR', vendor: a._id });
  ids.S6 = await mkSite(p2, 6, { channel: 'IN_HOUSE', assignedTo: ids.EX2, status: 'IN_PROGRESS' });
  ids.S8 = await mkSite(p2, 8, { channel: 'IN_HOUSE', assignedTo: ids.EX1, status: 'IN_PROGRESS' });
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------ system events: the whole life of one shop ------------------------------------------------ */

describe('system events in the shop thread and the notifications that go with them', () => {
  let sub = '';
  let frontId = '';
  it('V1 submitted, Client Servicing approved V1, Operations asked for the Front View again: each posts one card with refs', async () => {
    await M.RecceConfig.updateOne({ key: 'default' }, { $set: { sequential: false } }, { upsert: true }); // either stage may decide first
    const first = await submitShop('VA', ids.S1, 'k-s1-v1-12345');
    expect(first.body.data.version).toBe(1);
    const d = await detail('VA', ids.S1);
    sub = d.submissionId;
    frontId = d.photos.find((p: { category: string }) => p.category === 'SHOP_FRONT').id;
    expect((await decide('CS', sub, 'CS', 'APPROVE', 1)).status).toBe(200);
    const rw = await decide('OPS', sub, 'OPS', 'REWORK', 1, { items: [{ type: 'REPLACE_PHOTO', photo: frontId, note: 'Blurry' }] });
    expect(rw.status).toBe(200);
    expect(rw.body.data.status).toBe('REWORK_REQUIRED');
    const msgs = (await thread('VA', ids.S1)).body.data;
    expect(cardsOf(msgs)).toEqual(['Shop Recce Submitted:', 'Recce Review Update:Client Servicing approved', 'Recce Review Update:Rework required']);
    const card = msgs[2];
    expect(card.card.lines.find((l: { label: string }) => l.label === 'Rework items').value).toContain('Full Shop Front View');
    expect(card.refs).toEqual(expect.arrayContaining([{ type: 'PHOTO', id: frontId }, { type: 'VERSION', id: '1' }]));
    expect(msgs[0].refs).toEqual([{ type: 'VERSION', id: '1' }]);
  });
  it('V2 submitted, then approved by both stages: cards in order, and a retried submit adds nothing', async () => {
    await upload('VA', ids.S1, [meta('SHOP_FRONT', { replaces: frontId })]).expect(201);
    const v2 = await submit('VA', ids.S1, 'k-s1-v2-12345');
    expect(v2.body.data.version).toBe(2);
    const again = await submit('VA', ids.S1, 'k-s1-v2-12345');
    expect(again.body.data.duplicate).toBe(true);
    expect((await decide('CS', sub, 'CS', 'APPROVE', 2)).body.data.status).toBe('UNDER_REVIEW');
    expect((await decide('OPS', sub, 'OPS', 'APPROVE', 2)).body.data.status).toBe('APPROVED');
    await M.RecceConfig.updateOne({ key: 'default' }, { $set: { sequential: true } });
    const msgs = (await thread('VA', ids.S1)).body.data;
    expect(cardsOf(msgs)).toEqual([
      'Shop Recce Submitted:', 'Recce Review Update:Client Servicing approved', 'Recce Review Update:Rework required', 'Shop Recce Resubmitted:', 'Recce Review Update:Client Servicing approved', 'Recce Review Update:Final approval',
    ]);
  });
  it('the same event key never posts a second card', async () => {
    const { postShopMessage } = await import('../src/modules/connect/connect.service');
    const before = (await thread('VA', ids.S1)).body.data.length;
    const card = { title: 'Again', lines: [{ label: 'x', value: 'y' }] };
    expect(await postShopMessage(ids.P1, ids.S1, { id: ids.OPS, role: 'OPERATIONS' }, { card, eventKey: 'test:once' })).not.toBeNull();
    expect(await postShopMessage(ids.P1, ids.S1, { id: ids.OPS, role: 'OPERATIONS' }, { card, eventKey: 'test:once' })).toBeNull();
    expect((await thread('VA', ids.S1)).body.data.length).toBe(before + 1);
    await ConnectMessage.deleteOne({ eventKey: 'test:once' });
  });
  it('notifications: who is told, once each, never the person who acted', async () => {
    const titles = async (who: string) => (await Notification.find({ recipient: (ids as Record<string, string>)[who] }).lean()).map((x) => x.title);
    const count = async (who: string, title: string) => (await titles(who)).filter((t) => t === title).length;
    expect(await count('OPS', 'Shop recce submitted')).toBe(1); // v1: retried submit does not add a second one
    expect(await count('OPS', 'Shop recce resubmitted (v2)')).toBe(1);
    expect(await count('VA', 'Client Servicing approved')).toBe(2); // v1 and v2
    expect(await count('VA', 'Rework required')).toBe(1);
    expect(await count('VA', 'Final approval')).toBe(1);
    expect(await count('OPS', 'Rework required')).toBe(0); // the actor
    expect(await count('CS', 'Shop approved by all stages')).toBe(1); // new: the other stage hears that both approved
    expect(await count('OPS', 'Shop approved by all stages')).toBe(0); // OPS made the last decision
    expect(await count('VA', 'Shop approved by all stages')).toBe(0); // already told by "Final approval"
    const mine = (await api().get('/api/v1/notifications').set(as('VA'))).body.data;
    const item = mine.items.find((x: { title: string }) => x.title === 'Rework required');
    expect(item).toMatchObject({ type: 'RECCE_REVIEWED', siteId: ids.S1 });
  });
  it('a retried submit after the first one posts no second notification and no second card', async () => {
    const r = await submitShop('VA', ids.S3, 'k-s3-v1-12345');
    expect(r.body.data.duplicate).toBe(false);
    const s3 = (await detail('VA', ids.S3)).submissionId;
    const cardsBefore = (await thread('VA', ids.S3)).body.data.length;
    const retry = await submit('VA', ids.S3, 'k-s3-v1-12345');
    expect(retry.body.data.duplicate).toBe(true);
    expect((await thread('VA', ids.S3)).body.data.length).toBe(cardsBefore);
    expect(await Notification.countDocuments({ recipient: ids.OPS, kind: 'RECCE_SUBMITTED', path: `/recce-review/${s3}` })).toBe(1);
  });
});

/* ------------------------------------------------ thread: paging, unread, refs, image ------------------------------------------------ */

describe('thread paging (a shop with no recce record yet: only replies)', () => {
  const sent: string[] = [];
  it('newest first with nextBefore; before accepts a message id or an ISO time; no query keeps the original shape', async () => {
    for (const t of ['m1', 'm2', 'm3', 'm4', 'm5']) { sent.push((await say('VA', ids.S7, t)).body.data.id); }
    const p1 = await thread('VA', ids.S7, '?limit=2');
    expect(p1.status).toBe(200);
    expect(p1.body.data.map((m: { body: string }) => m.body)).toEqual(['m5', 'm4']);
    expect(p1.body.meta).toEqual({ limit: 2, hasMore: true, nextBefore: sent[3] });
    const p2 = await thread('VA', ids.S7, `?limit=2&before=${p1.body.meta.nextBefore}`);
    expect(p2.body.data.map((m: { body: string }) => m.body)).toEqual(['m3', 'm2']);
    expect(p2.body.meta.hasMore).toBe(true);
    const p3 = await thread('VA', ids.S7, `?limit=2&before=${p2.body.meta.nextBefore}`);
    expect(p3.body.data.map((m: { body: string }) => m.body)).toEqual(['m1']);
    expect(p3.body.meta).toEqual({ limit: 2, hasMore: false, nextBefore: null });
    const m3 = (await thread('VA', ids.S7, '?limit=5')).body.data.find((m: { body: string }) => m.body === 'm3');
    const byTime = await thread('VA', ids.S7, `?limit=10&before=${encodeURIComponent(m3.createdAt)}`);
    expect(byTime.body.data.map((m: { body: string }) => m.body)).toEqual(['m2', 'm1']);
    const legacy = await thread('VA', ids.S7);
    expect(legacy.body.data.map((m: { body: string }) => m.body)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(legacy.body.meta).toBeUndefined();
  });
  it('rejects a bad limit or before', async () => {
    expect((await thread('VA', ids.S7, '?limit=0')).status).toBe(422);
    expect((await thread('VA', ids.S7, '?limit=500')).status).toBe(422);
    expect((await thread('VA', ids.S7, '?before=yesterday')).status).toBe(422);
  });
});

describe('unread count and mark read (per person, per shop)', () => {
  let sub = '';
  const unread = async (who: string, siteId: string) => (await api().get(`${base(siteId)}/messages/unread`).set(as(who))).body.data.unread;
  it('counts other people\'s messages only, drops to 0 when marked read, and counts again for new ones', async () => {
    sub = (await detail('VA', ids.S1)).submissionId;
    const ru = (who: string) => api().get(`/api/v1/recce-review/submissions/${sub}/messages/unread`).set(as(who));
    const all = (await thread('VA', ids.S1)).body.data as { author: { id: string } }[];
    const fromOthers = all.filter((m) => m.author.id !== ids.OPS).length; // cards OPS wrote itself never count for OPS
    expect(fromOthers).toBeGreaterThan(0);
    expect((await ru('OPS')).body.data.unread).toBe(fromOthers);
    const read = await api().post(`/api/v1/recce-review/submissions/${sub}/messages/read`).set(as('OPS'));
    expect(read.body.data).toEqual({ ok: true, unread: 0 });
    expect((await ru('OPS')).body.data.unread).toBe(0);
    expect((await ru('CS')).body.data.unread).toBeGreaterThan(0); // another person's marker is separate
    await say('VA', ids.S1, 'Is the board lit at night?').expect(201);
    expect((await ru('OPS')).body.data.unread).toBe(1);
    expect(await unread('VA', ids.S1)).toBeGreaterThan(0); // reviewers wrote the cards: VA has not opened them
    await api().post(`${base(ids.S1)}/messages/read`).set(as('VA')).expect(200);
    expect(await unread('VA', ids.S1)).toBe(0);
    await api().post(`/api/v1/recce-review/submissions/${sub}/messages`).set(as('OPS')).send({ body: 'Yes, lit from inside' }).expect(201);
    expect(await unread('VA', ids.S1)).toBe(1);
    expect((await ru('OPS')).body.data.unread).toBe(1); // OPS's own message never counts for OPS
  });
  it('a new message notifies the other side only, once, and reading the thread clears that notification', async () => {
    const note = (who: string) => Notification.find({ recipient: (ids as Record<string, string>)[who], kind: 'RECCE_MESSAGE', site: ids.S1 }).lean();
    expect((await note('VA')).length).toBe(1); // OPS's reply
    expect((await note('OPS')).length).toBe(1); // VA's question (OPS decided last: the stage waiting is none, so every stage's people hear it)
    expect((await note('VA')).every((x) => String(x.actor) === ids.OPS)).toBe(true); // never self-notified
    expect((await Notification.find({ recipient: ids.VA, kind: 'RECCE_MESSAGE', readAt: null }).lean()).length).toBe(1);
    await api().post(`${base(ids.S1)}/messages/read`).set(as('VA')).expect(200);
    expect(await Notification.countDocuments({ recipient: ids.VA, kind: 'RECCE_MESSAGE', readAt: null })).toBe(0);
  });
});

describe('refs: a message can point at a photo, a board item or a version of THIS shop', () => {
  let photoId = '';
  it('accepts valid refs and returns them', async () => {
    const d = await detail('VA', ids.S1);
    photoId = d.photos[0].id;
    const r = await say('VA', ids.S1, 'About this one', { refs: [{ type: 'PHOTO', id: photoId }, { type: 'BOARD', id: 'm1' }, { type: 'VERSION', id: '2' }, { type: 'VERSION', id: '2' }] });
    expect(r.status).toBe(201);
    expect(r.body.data.refs).toEqual([{ type: 'PHOTO', id: photoId }, { type: 'BOARD', id: 'm1' }, { type: 'VERSION', id: '2' }]); // duplicate dropped
    const listed = (await thread('VA', ids.S1, '?limit=1')).body.data[0];
    expect(listed.refs).toHaveLength(3);
  });
  it('rejects a board key that is not in the shop, another shop\'s photo and a version that does not exist (400), and a bad shape (422)', async () => {
    const bad = await say('VA', ids.S1, 'x', { refs: [{ type: 'BOARD', id: 'zz9' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('board');
    const other = (await detail('VA', ids.S3)).photos[0].id;
    expect((await say('VA', ids.S1, 'x', { refs: [{ type: 'PHOTO', id: other }] })).status).toBe(400);
    expect((await say('VA', ids.S1, 'x', { refs: [{ type: 'PHOTO', id: 'a'.repeat(24) }] })).status).toBe(400);
    expect((await say('VA', ids.S1, 'x', { refs: [{ type: 'VERSION', id: '9' }] })).status).toBe(400);
    expect((await say('VA', ids.S1, 'x', { refs: [{ type: 'SHOP', id: '1' }] })).status).toBe(422);
    expect((await say('VA', ids.S7, 'x', { refs: [{ type: 'PHOTO', id: photoId }] })).status).toBe(400); // S7 has no recce record
    expect((await say('VA', ids.S7, 'seeded board', { refs: [{ type: 'BOARD', id: 'm1' }] })).status).toBe(201); // but its seeded board exists
  });
  it('a reviewer\'s refs are checked the same way (and a draft photo cannot be pointed at)', async () => {
    const sub = (await detail('VA', ids.S1)).submissionId;
    const post = (refs: unknown) => api().post(`/api/v1/recce-review/submissions/${sub}/messages`).set(as('OPS')).send({ body: 'Please check', refs });
    expect((await post([{ type: 'PHOTO', id: photoId }])).status).toBe(201);
    expect((await post([{ type: 'BOARD', id: 'nope' }])).status).toBe(400);
  });
});

describe('one image per message', () => {
  it('stores the image under the project, returns a link, and only images up to the limit are accepted', async () => {
    const r = await api().post(`${base(ids.S1)}/messages`).set(as('VA')).field('body', 'Photo of the lane').field('refs', JSON.stringify([{ type: 'BOARD', id: 'm1' }])).attach('file', png(), 'lane.png');
    expect(r.status).toBe(201);
    expect(r.body.data.attachments).toHaveLength(1);
    expect(r.body.data.attachments[0]).toMatchObject({ name: 'lane.png', kind: 'image', mimeType: expect.stringContaining('image') });
    expect(r.body.data.attachments[0].url).toBeTruthy();
    expect(r.body.data.refs).toEqual([{ type: 'BOARD', id: 'm1' }]);
    const stored = await ConnectMessage.findById(r.body.data.id).lean();
    const key = (stored!.attachments![0] as unknown as { key: string }).key;
    expect(key).toContain('P-M3'); // filed under the project, so deleting the project erases it
    expect(fs.existsSync(path.join(root, key))).toBe(true);
    const listed = (await thread('VA', ids.S1, '?limit=1')).body.data[0];
    expect(listed.attachments[0].fileId).toBe(r.body.data.attachments[0].fileId);
    const sub = (await detail('VA', ids.S1)).submissionId;
    const rv = (await api().get(`/api/v1/recce-review/submissions/${sub}/messages`).query({ limit: 1 }).set(as('OPS'))).body.data[0];
    expect(rv.attachments[0].url).toBeTruthy(); // the reviewer sees the same image
  });
  it('an image alone is a message; a document, an empty post or a bad refs string is refused', async () => {
    const only = await api().post(`${base(ids.S1)}/messages`).set(as('VA')).attach('file', png(), 'only.png');
    expect(only.status).toBe(201);
    expect(only.body.data.body).toBe('');
    const pdf = await api().post(`${base(ids.S1)}/messages`).set(as('VA')).field('body', 'doc').attach('file', Buffer.from('%PDF-1.4 test'), 'a.pdf');
    expect(pdf.status).toBe(400);
    expect((await say('VA', ids.S1, '')).status).toBe(422);
    const badRefs = await api().post(`${base(ids.S1)}/messages`).set(as('VA')).field('body', 'x').field('refs', '{not json');
    expect(badRefs.status).toBe(400);
    const badOne = await api().post(`${base(ids.S1)}/messages`).set(as('VA')).field('body', 'x').field('refs', JSON.stringify([{ type: 'BOARD', id: 'zz' }])).attach('file', png(), 'bad.png');
    expect(badOne.status).toBe(400);
    expect(await ConnectMessage.countDocuments({ 'attachments.name': 'bad.png' })).toBe(0); // nothing stored when a ref is wrong
  });
});

describe('who can read a thread', () => {
  it('another vendor, and another field login, get 404 on every thread route', async () => {
    for (const who of ['VB', 'EX1']) {
      expect((await thread(who, ids.S1)).status, who).toBe(404);
      expect((await api().get(`${base(ids.S1)}/messages/unread`).set(as(who))).status, who).toBe(404);
      expect((await api().post(`${base(ids.S1)}/messages/read`).set(as(who))).status, who).toBe(404);
      expect((await say(who, ids.S1, 'hello')).status, who).toBe(404);
    }
  });
  it('field logins cannot use the review thread; reviewers outside the project get 404', async () => {
    const sub = (await detail('VA', ids.S1)).submissionId;
    expect((await api().get(`/api/v1/recce-review/submissions/${sub}/messages`).set(as('VA'))).status).toBe(404);
    expect((await api().get(`/api/v1/recce-review/submissions/${sub}/messages/unread`).set(as('OPS2'))).status).toBe(404);
    expect((await api().get(`/api/v1/recce-review/submissions/${sub}/messages`).set(as('OPS')).query({ limit: 1 })).status).toBe(200);
  });
});

/* ------------------------------------------------ dashboards ------------------------------------------------ */

describe('field dashboard (own shops only)', () => {
  const dash = async (who: string) => (await api().get('/api/v1/recce/dashboard').set(as(who)));
  it('is limited to field logins', async () => {
    expect((await dash('OPS')).status).toBe(403);
    expect((await dash('ADMIN')).status).toBe(403);
    expect((await api().get('/api/v1/recce/dashboard')).status).toBe(401);
  });
  it('vendor A: S1 completed after rework, S3 waiting for review, S7 not started', async () => {
    const d = (await dash('VA')).body.data;
    expect(d).toMatchObject({ assignedProjects: 1, assignedShops: 3, started: 2, submitted: 2, underReview: 1, approved: 1, rework: 0, completed: 1, pending: 2, reworkCount: 1, reworkPercent: 50 });
    expect(typeof d.avgCompletionHours).toBe('number');
    expect(d.projects).toEqual([{ projectId: ids.P1, projectCode: 'P-M3', projectName: 'Recce M3', assigned: 3, started: 2, submitted: 2, approved: 1, rework: 0, pending: 2 }]);
  });
  it('vendor B sees only its own shop (no approved or completed shops, no average)', async () => {
    await api().post(`${base(ids.S2)}/start`).set(as('VB')).expect(200);
    const d = (await dash('VB')).body.data;
    expect(d).toMatchObject({ assignedProjects: 1, assignedShops: 1, started: 1, submitted: 0, underReview: 0, approved: 0, completed: 0, pending: 1, reworkCount: 0, reworkPercent: 0, avgCompletionHours: null });
  });
  it('in-house: completed counts only after BOTH stages approved the current version', async () => {
    await submitShop('EX1', ids.S4, 'k-s4-v1-12345');
    const sub = (await detail('EX1', ids.S4)).submissionId;
    expect((await dash('EX1')).body.data).toMatchObject({ assignedProjects: 2, assignedShops: 3, started: 1, submitted: 1, underReview: 1, approved: 0, completed: 0, pending: 3, avgCompletionHours: null });
    expect((await decide('OPS', sub, 'OPS', 'APPROVE', 1)).body.data.status).toBe('UNDER_REVIEW');
    expect((await dash('EX1')).body.data).toMatchObject({ approved: 0, completed: 0, underReview: 1 }); // one stage is not enough
    const thr = cardsOf((await thread('EX1', ids.S4)).body.data);
    expect(thr).toEqual(['Shop Recce Submitted:', 'Recce Review Update:Recce Operations approved', 'Client Servicing Review Due:']);
    expect((await decide('CS', sub, 'CS', 'APPROVE', 1)).body.data.status).toBe('APPROVED');
    const d = (await dash('EX1')).body.data;
    expect(d).toMatchObject({ started: 1, submitted: 1, underReview: 0, approved: 1, completed: 1, pending: 2, reworkCount: 0, reworkPercent: 0 });
    expect(typeof d.avgCompletionHours).toBe('number');
    expect(d.projects).toEqual([
      { projectId: ids.P1, projectCode: 'P-M3', projectName: 'Recce M3', assigned: 2, started: 1, submitted: 1, approved: 1, rework: 0, pending: 1 },
      { projectId: ids.P2, projectCode: 'P-M3B', projectName: 'Recce M3 B', assigned: 1, started: 0, submitted: 0, approved: 0, rework: 0, pending: 1 },
    ]);
  });
  it('a shop that is not completed by every stage is never counted completed, even if its status says approved', async () => {
    const sub = (await detail('VA', ids.S3)).submissionId;
    await M.RecceSubmission.updateOne({ _id: sub }, { $set: { status: 'APPROVED' } }); // status forced without any approval rows
    expect((await api().get('/api/v1/recce/dashboard').set(as('VA'))).body.data).toMatchObject({ approved: 2, completed: 1 });
    await M.RecceSubmission.updateOne({ _id: sub }, { $set: { status: 'SUBMITTED' } });
  });
});

describe('staff performance', () => {
  it('is for reviewers and monitors only: vendor and in-house logins get 403, a bad range 422', async () => {
    expect((await perf('VA')).status).toBe(403);
    expect((await perf('EX1')).status).toBe(403);
    expect((await api().get('/api/v1/recce-review/performance')).status).toBe(401);
    expect((await perf('ADMIN', '?from=2026-12-01&to=2026-11-01')).status).toBe(422);
  });
  it('Admin: in-house against vendor, project-wise and vendor-wise', async () => {
    await api().post(`${base(ids.S6)}/start`).set(as('EX2')).expect(200);
    const r = await perf('ADMIN');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totals).toMatchObject({ started: 5, submitted: 3, completed: 2, pending: 3, reworkCount: 1, reworkPercent: 33.3 });
    expect(d.inHouse).toMatchObject({ started: 2, submitted: 1, completed: 1, pending: 1, reworkCount: 0, reworkPercent: 0 });
    expect(d.vendor).toMatchObject({ started: 3, submitted: 2, completed: 1, pending: 2, reworkCount: 1, reworkPercent: 50 });
    expect(typeof d.totals.avgCompletionHours).toBe('number');
    expect(d.projects.map((p: { projectCode: string }) => p.projectCode)).toEqual(['P-M3', 'P-M3B']);
    expect(d.projects[0]).toMatchObject({ total: { started: 4, completed: 2 }, inHouse: { started: 1, completed: 1 }, vendor: { started: 3, completed: 1 } });
    expect(d.projects[1]).toMatchObject({ total: { started: 1, completed: 0 }, inHouse: { started: 1 }, vendor: { started: 0 } });
    expect(d.vendors.map((v: { name: string; started: number; completed: number }) => [v.name, v.started, v.completed])).toEqual([['VND-A', 2, 1], ['VND-B', 1, 0]]);
    expect(d.vendors[0].reworkCount).toBe(1);
  });
  it('Operations and Client Servicing see only their projects; another project is 404; Management sees all', async () => {
    expect((await perf('OPS')).body.data.totals.started).toBe(4);
    expect((await perf('OPS2')).body.data.totals.started).toBe(1);
    expect((await perf('CS')).body.data.totals.started).toBe(4); // created P-M3 only
    expect((await perf('MGMT')).body.data.totals.started).toBe(5);
    expect((await perf('OPS', `?projectId=${ids.P2}`)).status).toBe(404);
    expect((await perf('OPS2', `?projectId=${ids.P2}`)).body.data.totals.started).toBe(1);
    expect((await perf('ADMIN', `?projectId=${ids.P1}`)).body.data.totals.started).toBe(4);
  });
  it('from / to select shops started in that range', async () => {
    expect((await perf('ADMIN', '?from=2100-01-01')).body.data.totals.started).toBe(0);
    expect((await perf('ADMIN', '?to=2000-01-01')).body.data.totals.started).toBe(0);
    expect((await perf('ADMIN', '?from=2000-01-01&to=2100-01-01')).body.data.totals.started).toBe(5);
  });
});

describe('cost: only values the recce cost module has verified', () => {
  it('no cost key at all while there is no verified record (nothing is estimated)', async () => {
    const d = (await perf('ADMIN')).body.data;
    expect('cost' in d).toBe(false);
    expect(JSON.stringify(d)).not.toContain('"cost"');
  });
  it('an unapproved claim is not counted; approved claim and applied vendor cost are, per project', async () => {
    const { RecceTrip, VendorRecceCost } = await import('../src/modules/recce-cost/recceCost.model');
    const { Project } = await import('../src/modules/projects/project.model');
    const p = (await Project.findById(ids.P1).lean())!;
    const trip = (status: string, approved?: { total: number }) => ({ project: p._id, client: p.client, employee: ids.EX1, startAt: new Date(), transportType: 'PRIVATE', status, ...(approved ? { approved } : {}) });
    await RecceTrip.create(trip('SUBMITTED') as never);
    expect('cost' in (await perf('ADMIN')).body.data).toBe(false); // in flight: not verified
    await RecceTrip.create(trip('APPROVED', { total: 1200 }) as never);
    await RecceTrip.create(trip('SETTLED', { total: 300.5 }) as never);
    let cost = (await perf('ADMIN')).body.data.cost;
    expect(cost).toMatchObject({ inHouse: 1500.5, vendor: null, total: 1500.5, perShop: [] });
    expect(cost.perProject).toEqual([{ projectId: ids.P1, projectCode: 'P-M3', projectName: 'Recce M3', inHouse: 1500.5, vendor: null, total: 1500.5 }]);
    await VendorRecceCost.create({ project: p._id, client: p.client, vendor: ids.vendorA, total: 5000 } as never);
    cost = (await perf('ADMIN')).body.data.cost;
    expect(cost).toMatchObject({ inHouse: 1500.5, vendor: 5000, total: 6500.5, perShop: [] });
    expect(cost.perProject).toHaveLength(1);
  });
  it('is shown only to people who may review recce cost, and respects the project and date filters', async () => {
    expect((await perf('OPS')).body.data.cost.total).toBe(6500.5);
    expect('cost' in (await perf('CS')).body.data).toBe(false);
    expect('cost' in (await perf('MGMT')).body.data).toBe(false);
    expect('cost' in (await perf('OPS2')).body.data).toBe(false); // P-M3B has no verified record
    expect('cost' in (await perf('ADMIN', `?projectId=${ids.P2}`)).body.data).toBe(false);
    expect('cost' in (await perf('ADMIN', '?from=2100-01-01')).body.data).toBe(false);
  });
});

/* ------------------------------------------------ reassignment, then deleting the project ------------------------------------------------ */

describe('history survives reassignment', () => {
  it('a shop moved to another vendor keeps its thread for the new vendor and closes it for the old one', async () => {
    const { Site } = await import('../src/modules/sites/site.model');
    expect((await thread('VB', ids.S7)).status).toBe(404);
    await Site.updateOne({ _id: ids.S7 }, { $set: { vendor: ids.vendorB } });
    const now = await thread('VB', ids.S7);
    expect(now.status).toBe(200);
    expect(now.body.data.map((m: { body: string }) => m.body)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'seeded board']);
    expect((await thread('VA', ids.S7)).status).toBe(404);
    expect((await say('VB', ids.S7, 'I took over this shop')).status).toBe(201);
    expect((await thread('VB', ids.S7, '?limit=1')).body.data[0].body).toBe('I took over this shop');
  });
});

describe('deleting the project removes everything the thread added', () => {
  it('messages, read markers, notifications and the stored image are gone; another project is untouched', async () => {
    const files = (await ConnectMessage.find({ 'attachments.0': { $exists: true } }).lean()).map((m) => (m.attachments![0] as unknown as { key: string }).key);
    expect(files.length).toBeGreaterThan(0);
    for (const k of files) expect(fs.existsSync(path.join(root, k))).toBe(true);
    expect(await M.RecceThreadRead.countDocuments({ project: ids.P1 })).toBeGreaterThan(0);
    expect(await Notification.countDocuments({ project: ids.P1, kind: 'RECCE_MESSAGE' })).toBeGreaterThan(0);
    const { ConnectChannel } = await import('../src/modules/connect/connect.model');
    const channel = await ConnectChannel.findOne({ project: ids.P1 }).lean();
    expect(await ConnectMessage.countDocuments({ channel: channel!._id })).toBeGreaterThan(0);
    const del = await api().delete(`/api/v1/projects/${ids.P1}`).set(as('ADMIN'));
    expect(del.status).toBe(200);
    expect(await M.RecceThreadRead.countDocuments({ project: ids.P1 })).toBe(0);
    expect(await Notification.countDocuments({ project: ids.P1 })).toBe(0);
    expect(await ConnectMessage.countDocuments({ channel: channel!._id })).toBe(0);
    for (const k of files) expect(fs.existsSync(path.join(root, k))).toBe(false);
    expect(await M.RecceSubmission.countDocuments({ project: ids.P2 })).toBe(1); // S6 of the other project
  });
});
