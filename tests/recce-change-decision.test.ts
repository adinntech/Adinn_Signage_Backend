import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

/**
 * A review stage that already APPROVED may change its decision (Reject / Rework / More photos), from either reviewer login
 * (Recce Operations = stage OPS, Client Servicing = stage CS), while the shop is with the review teams or already finally approved.
 * Over HTTP, in-memory MongoDB: it never connects to the real database.
 */

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root: string;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const as = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` });
const api = () => request(app);
const BASE = '/api/v1';

let n = 0;
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`change-photo-${++n}-${Math.random()}`)]);
const SIX = [['SHOP_FRONT', 13.0412, 80.2345], ['SIDE_VIEW', 13.04122, 80.23455], ['LONG_SHOT', 13.04105, 80.2343], ['ANNOTATED_VIEW', 13.04121, 80.23448], ['LOCATION_VIEW', 13.04118, 80.23451], ['ACCESS_PATH', 13.0409, 80.2342]] as const;
const metas = () => SIX.map(([category, lat, lng]) => ({ clientId: `c-${Date.now()}-${++n}-${category}`, category, mediaKey: '', caption: category, capturedAt: new Date().toISOString(), lat, lng, gpsAccuracy: 8, width: 3000, height: 4000, source: 'LIVE_CAMERA', device: 'Test phone' }));
const shop = (siteId: string) => `${BASE}/recce/shops/${siteId}`;
const detail = async (who: string, siteId: string) => (await api().get(shop(siteId)).set(as(who))).body.data;
const boards = [{ key: 'b1', name: 'GSB', quantity: 1, width: 6, height: 4, unit: 'FT', sided: 'SINGLE', condition: 'PROPOSED', position: 'Shop fascia' }];
const installation = { ladderRequired: 'YES', scaffoldingRequired: 'NO', craneRequired: 'NO', hydraRequired: 'NO', manualInstallationPossible: 'YES', electricalAccess: 'AVAILABLE', installationHeightFt: 12, notes: 'ok' };
const checklist = ['correct_shop', 'shop_front', 'board_area', 'angles', 'measurements', 'media_type', 'quantity', 'quality', 'gps', 'client_req'].map((key) => ({ key, passed: true }));
const approve = (who: string, sub: string, stage: string, version = 1) =>
  api().post(`${BASE}/recce-review/submissions/${sub}/decision`).set(as(who)).send({ stage, decision: 'APPROVE', versionNo: version, comment: 'Looks fine', checklist });
const change = (who: string, sub: string, stage: string, decision: string, body: Record<string, unknown> = {}) =>
  api().post(`${BASE}/recce-review/submissions/${sub}/change-decision`).set(as(who)).send({ stage, decision, versionNo: 1, comment: 'Measurement does not match the photo', ...body });
const workspace = async (who: string, sub: string) => (await api().get(`${BASE}/recce-review/submissions/${sub}`).set(as(who))).body.data;

/** Submits Version 1 of one shop of the vendor and returns the submission id. */
async function submitted(siteId: string) {
  await api().put(`${shop(siteId)}/draft`).set(as('VA')).send({ mediaItems: boards, installation }).expect(200);
  const m = metas();
  let r = api().post(`${shop(siteId)}/photos`).set(as('VA'));
  m.forEach((_, i) => { r = r.attach('photos', png(), `p${i}.png`); });
  await r.field('meta', JSON.stringify(m)).expect(201);
  const s = await api().post(`${shop(siteId)}/submit`).set(as('VA')).send({ idempotencyKey: `submit-${siteId}-1`, notes: 'done' });
  expect(s.status).toBe(200);
  return (await detail('VA', siteId)).submissionId as string;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recce-change-decision-test-'));
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

  const vendor = await Vendor.create({ code: 'VND-0048', name: 'S R Glass', nameKey: 'S R Glass', type: 'ORGANIZATION', mobile: '9344124985', status: 'ACTIVE', kyc: { pan: true, gst: true, bank: true, address: true }, zohoVendorNo: '11121' } as never);
  const passwordHash = await hashPassword('Passw0rd!x');
  for (const [key, name, role] of [['VA', 'S R Glass', 'VENDOR'], ['OPS', 'Operations Arvind', 'OPERATIONS'], ['CS', 'Client Servicing Priya', 'CLIENT_SERVICING'], ['ADMIN', 'Admin', 'SUPER_ADMIN']] as const) {
    ids[key] = String(((await User.create({ name, email: `${key.toLowerCase()}@t.com`, role, passwordHash, ...(key === 'VA' ? { vendorId: vendor._id } : {}) } as never)) as unknown as { _id: unknown })._id);
  }
  const client = await Client.create({ name: 'DEMO', code: 'DM' });
  const p = await Project.create({ code: '20262026', name: 'DEMO - 2026-FIRST', client: client._id, status: 'IN_PROGRESS', assignedTo: ids.OPS, createdBy: ids.CS, requirementType: 'SHOP_DETAILS' });
  for (let i = 1; i <= 7; i++) {
    ids[`S${i}`] = String((await Site.create({ project: p._id, seq: i, siteCode: `20262026-S00${i}`, scenario: 'MEASUREMENT_REQUIRED', dealerName: `Dealer ${i}`, boardType: 'Board', quantity: 1, district: 'CHENNAI', location: 'T. Nagar', lat: 13.041, lng: 80.234, channel: 'VENDOR', vendor: vendor._id }))._id);
  }
  for (const k of ['OPS', 'CS', 'ADMIN']) tokens[k] = (await api().post(`${BASE}/auth/login`).send({ email: `${k.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  tokens.VA = (await api().post(`${BASE}/auth/vendor-login`).send({ vendorId: '1121' })).body.data.accessToken;
  await api().put(`${BASE}/recce-review/config`).set(as('ADMIN')).send({ sequential: false, requiredPhotos: { default: SIX.map((s) => s[0]) } }).expect(200);
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a stage that approved changes its decision', () => {
  let sub1 = '';
  let sub2 = '';
  let sub3 = '';
  let sub5 = '';

  it('Operations approves, then changes to Rework: the shop goes back to the recce person and the approval stays in the history', async () => {
    sub1 = await submitted(ids.S1!);
    expect((await approve('OPS', sub1, 'OPS')).status).toBe(200);
    // Only the stage that approved sees the option; the other login has not approved anything.
    expect((await workspace('OPS', sub1)).me.canChange).toBe(true);
    expect((await workspace('CS', sub1)).me.canChange).toBe(false);
    // the normal decision route still refuses a second answer
    expect((await approve('OPS', sub1, 'OPS')).status).toBe(409);

    const r = await change('OPS', sub1, 'OPS', 'REWORK', { items: [{ type: 'FIX_MEASUREMENT', mediaKey: 'b1', note: 'Width is 8 ft' }] });
    expect(r.status).toBe(200);
    const ws = r.body.data as { status: string; me: { canChange: boolean }; versions: { reviews: { stage: string; decision: string; comment: string; history: { decision: string; reviewer: string | null }[] }[] }[]; reworks: { stage: string; status: string; kind: string }[] };
    expect(ws.status).toBe('REWORK_REQUIRED');
    expect(ws.me.canChange).toBe(false);
    const reviews = ws.versions[0]!.reviews;
    const ops = reviews.find((x) => x.stage === 'OPS')!;
    expect(ops.decision).toBe('REWORK');
    expect(ops.comment).toBe('Measurement does not match the photo');
    expect(ops.history).toHaveLength(1);
    expect(ops.history[0]!.decision).toBe('APPROVED');
    expect(ops.history[0]!.reviewer).toBe('Operations Arvind');
    expect(reviews.find((x) => x.stage === 'CS')!.decision).toBe('VOID'); // the waiting review of the other stage is void
    expect(ws.reworks).toHaveLength(1);
    expect(ws.reworks[0]).toMatchObject({ stage: 'OPS', status: 'OPEN', kind: 'REWORK' });

    const d = await detail('VA', ids.S1!);
    expect(d.status).toBe('REWORK_REQUIRED');
    expect(d.editable).toBe(true);
    // nothing more to change: the stage no longer holds an approval
    expect((await change('OPS', sub1, 'OPS', 'REJECT')).status).toBe(409);
    const timeline = await api().get(`${BASE}/recce-review/submissions/${sub1}/activity`).set(as('OPS'));
    expect(JSON.stringify(timeline.body.data)).toContain('Decision changed');
  });

  it('after the FINAL approval, Client Servicing can still reject (Operations approval stays as it was)', async () => {
    sub2 = await submitted(ids.S2!);
    expect((await approve('OPS', sub2, 'OPS')).status).toBe(200);
    const done = await approve('CS', sub2, 'CS');
    expect(done.body.data.status).toBe('APPROVED');
    expect((await workspace('CS', sub2)).me.canChange).toBe(true);
    expect((await workspace('OPS', sub2)).me.canChange).toBe(true); // both logins get the option

    const r = await change('CS', sub2, 'CS', 'REJECT', { reason: 'Wrong shop was photographed' });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('REJECTED');
    const reviews = (r.body.data.versions[0].reviews as { stage: string; decision: string; comment: string }[]);
    expect(reviews.find((x) => x.stage === 'CS')).toMatchObject({ decision: 'REJECTED', comment: 'Wrong shop was photographed' });
    expect(reviews.find((x) => x.stage === 'OPS')!.decision).toBe('APPROVED');
    const { RecceSubmission } = await import('../src/modules/recce-review/recceReview.model');
    const row = await RecceSubmission.findById(sub2).lean();
    expect(row?.status).toBe('REJECTED');
    expect(row?.finalApprovedAt).toBeUndefined(); // no longer finally approved
  });

  it('More photos after the final approval opens an ADDITIONAL request for the recce person', async () => {
    sub3 = await submitted(ids.S3!);
    await approve('OPS', sub3, 'OPS');
    expect((await approve('CS', sub3, 'CS')).body.data.status).toBe('APPROVED');
    const r = await change('OPS', sub3, 'OPS', 'ADDITIONAL', { items: [{ type: 'ADDITIONAL_PHOTO', category: 'SIDE_VIEW', mediaKey: 'b1', note: 'Right side please' }] });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('REWORK_REQUIRED');
    expect(r.body.data.reworks[0]).toMatchObject({ stage: 'OPS', kind: 'ADDITIONAL', status: 'OPEN' });
  });

  /** What the recce person sees for each photo of a shop: category -> { review status, the reviewer's note }. */
  const flags = async (siteId: string) => Object.fromEntries(((await detail('VA', siteId)).photos as { category: string; review: { status: string; openRework: { note: string; rejected: boolean } | null } }[]).map((p) => [p.category, { status: p.review.status, note: p.review.openRework?.note ?? null, rejected: p.review.openRework?.rejected ?? false }]));
  const photoId = async (who: string, sub: string, category: string) => ((await workspace(who, sub)).photos as { id: string; category: string }[]).find((p) => p.category === category)!.id;

  it('each photo can be rejected with its own reason: two rejected photos go back as ONE rework and only those two are flagged', async () => {
    const sub = sub5 = await submitted(ids.S5!);
    const front = await photoId('CS', sub, 'SHOP_FRONT');
    const side = await photoId('CS', sub, 'SIDE_VIEW');
    // the same request the review screen sends for "Send 2 rejected photos back"
    const r = await api().post(`${BASE}/recce-review/submissions/${sub}/decision`).set(as('CS')).send({
      stage: 'CS', decision: 'REWORK', versionNo: 1, comment: 'Photos rejected: Full Shop Front View, Side View', checklist: [],
      items: [{ type: 'REPLACE_PHOTO', photo: front, note: 'Board is cut off', rejected: true }, { type: 'REPLACE_PHOTO', photo: side, note: 'Too dark', rejected: true }],
    });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('REWORK_REQUIRED');
    expect(r.body.data.reworks).toHaveLength(1);
    expect(r.body.data.reworks[0].items).toHaveLength(2);
    expect(r.body.data.reworks[0].items.every((i: { rejected: boolean }) => i.rejected)).toBe(true);
    const f = await flags(ids.S5!);
    expect(f.SHOP_FRONT).toEqual({ status: 'REWORK_REQUIRED', note: 'Board is cut off', rejected: true });
    expect(f.SIDE_VIEW).toEqual({ status: 'REWORK_REQUIRED', note: 'Too dark', rejected: true });
    expect(f.LONG_SHOT!.status).toBe('PENDING'); // the other photos are not asked again
    expect(f.ACCESS_PATH!.status).toBe('PENDING');
  });

  it('a stage that approved can still reject a photo (change decision with a photo item); the other photos stay as they are', async () => {
    const sub = await submitted(ids.S6!);
    expect((await approve('OPS', sub, 'OPS')).status).toBe(200);
    const roof = await photoId('OPS', sub, 'LOCATION_VIEW');
    const r = await change('OPS', sub, 'OPS', 'REWORK', { comment: 'Photos rejected: Location View', items: [{ type: 'REPLACE_PHOTO', photo: roof, note: 'Wrong street', rejected: true }] });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('REWORK_REQUIRED');
    const f = await flags(ids.S6!);
    expect(f.LOCATION_VIEW).toEqual({ status: 'REWORK_REQUIRED', note: 'Wrong street', rejected: true });
    expect(f.SHOP_FRONT!.status).toBe('PENDING');
  });

  it('a plain rework item (not rejected) is flagged "rework required" and carries no rejected mark; a rejected photo needs its reason', async () => {
    const sub = await submitted(ids.S7!);
    const front = await photoId('CS', sub, 'SHOP_FRONT');
    const side = await photoId('CS', sub, 'SIDE_VIEW');
    const decide = (items: unknown[]) => api().post(`${BASE}/recce-review/submissions/${sub}/decision`).set(as('CS')).send({ stage: 'CS', decision: 'REWORK', versionNo: 1, comment: 'Fix the photos', checklist: [], items });
    // refused, nothing written: a rejected photo without a reason, and a rejected item that names no photo
    expect((await decide([{ type: 'REPLACE_PHOTO', photo: front, rejected: true }])).status).toBe(400);
    expect((await decide([{ type: 'REPLACE_PHOTO', photo: front, note: 'ab', rejected: true }])).status).toBe(400);
    expect((await decide([{ type: 'REPLACE_PHOTO', category: 'SIDE_VIEW', note: 'Retake this one', rejected: true }])).status).toBe(400);
    expect((await detail('VA', ids.S7!)).status).toBe('SUBMITTED'); // untouched: still waiting for the review
    // accepted: one rejected, one plain rework
    expect((await decide([{ type: 'REPLACE_PHOTO', photo: front, note: 'Out of focus', rejected: true }, { type: 'REPLACE_PHOTO', photo: side, note: 'Please retake' }])).status).toBe(200);
    const f = await flags(ids.S7!);
    expect(f.SHOP_FRONT).toEqual({ status: 'REWORK_REQUIRED', note: 'Out of focus', rejected: true });
    expect(f.SIDE_VIEW).toEqual({ status: 'REWORK_REQUIRED', note: 'Please retake', rejected: false });
  });

  it('refuses: no approval yet, wrong team, wrong version, vendor, short reason, approve as the new answer', async () => {
    const sub = await submitted(ids.S4!);
    expect((await change('OPS', sub, 'OPS', 'REWORK')).status).toBe(409); // OPS has not approved
    await approve('OPS', sub, 'OPS');
    expect((await change('CS', sub, 'OPS', 'REJECT')).status).toBe(403); // CS cannot change the OPS stage
    expect((await change('VA', sub, 'OPS', 'REJECT')).status).toBe(403); // a vendor has no review rights
    expect((await change('OPS', sub, 'OPS', 'REJECT', { versionNo: 2 })).status).toBe(409); // not the current version
    expect((await change('OPS', sub, 'OPS', 'REWORK', { comment: 'bad' })).status).toBe(400); // a real reason is needed
    expect((await change('OPS', sub, 'OPS', 'APPROVE')).status).toBe(422); // approving again is not a change (schema refuses it)
    // a photo of another shop cannot be rejected through this shop
    const foreign = await photoId('OPS', sub5, 'SHOP_FRONT');
    expect((await change('OPS', sub, 'OPS', 'REWORK', { items: [{ type: 'REPLACE_PHOTO', photo: foreign }] })).status).toBe(400);
    // none of the refused calls changed anything
    const ws = await workspace('OPS', sub);
    expect(ws.status).toBe('UNDER_REVIEW');
    expect(ws.versions[0].reviews.find((x: { stage: string }) => x.stage === 'OPS').decision).toBe('APPROVED');
  });
});
