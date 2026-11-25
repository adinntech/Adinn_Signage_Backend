import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Review marks (2026-11-24): a reviewer ticks photos / board details (media type, quantity, size) and marks them Approved, Rejected or Rework.
 * A remark is mandatory for Rejected and Rework. Marks are kept version by version with their history, are visible to the other stage, and become the
 * rework items when the stage sends Rework. Over HTTP, in-memory MongoDB: it never connects to the real database.
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recce-marks-test-'));
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

const marksUrl = (sub: string) => `${BASE}/recce-review/submissions/${sub}/marks`;
const mark = (who: string, sub: string, stage: string, decision: string, targets: unknown[], reason = '', version = 1) =>
  api().post(marksUrl(sub)).set(as(who)).send({ stage, versionNo: version, decision, reason, targets });
const rework = (who: string, sub: string, stage: string, comment: string, version = 1) =>
  api().post(`${BASE}/recce-review/submissions/${sub}/decision`).set(as(who)).send({ stage, decision: 'REWORK', versionNo: version, comment, checklist: [], items: [] });
type WsMark = { stage: string; kind: string; photo: string | null; mediaKey: string; field: string | null; decision: string; reason: string; sent: boolean; versionNo: number; history: { decision: string; reason: string }[] };
const marksOf = (ws: { marks: WsMark[] }, stage: string, version = 1) => ws.marks.filter((m) => m.stage === stage && m.versionNo === version);
const photoOf = (ws: { photos: { id: string; category: string }[] }, category: string) => ws.photos.find((p) => p.category === category)!.id;

describe('reviewers mark photos and board details; remarks are mandatory; history is kept version by version', () => {
  let sub1 = '';
  let sub2 = '';
  let sub3 = '';

  it('a remark is mandatory for Rejected and Rework; Approved needs none; each stage writes only its own marks', async () => {
    sub1 = await submitted(ids.S1!);
    const ws0 = await workspace('OPS', sub1);
    expect(ws0.me.canMark).toBe(true);
    const front = photoOf(ws0, 'SHOP_FRONT');
    const left = photoOf(ws0, 'SIDE_VIEW');
    // no remark, or a remark that is too short: nothing is saved
    expect((await mark('OPS', sub1, 'OPS', 'REJECTED', [{ kind: 'PHOTO', photo: front }])).status).toBe(422);
    expect((await mark('OPS', sub1, 'OPS', 'REWORK', [{ kind: 'PHOTO', photo: front }], '  ')).status).toBe(422);
    expect((await mark('OPS', sub1, 'OPS', 'REWORK', [{ kind: 'BOARD', mediaKey: 'b1', field: 'QUANTITY' }], 'ab')).status).toBe(422);
    expect(marksOf(await workspace('OPS', sub1), 'OPS')).toHaveLength(0);

    const ok = await mark('OPS', sub1, 'OPS', 'REJECTED', [{ kind: 'PHOTO', photo: front }, { kind: 'PHOTO', photo: left }], 'Front and left photos are not clear');
    expect(ok.status).toBe(200);
    const good = await mark('OPS', sub1, 'OPS', 'APPROVED', [{ kind: 'BOARD', mediaKey: 'b1', field: 'MEDIA_TYPE' }]); // no remark needed to approve
    expect(good.status).toBe(200);
    const ws = good.body.data as { marks: WsMark[] };
    const ops = marksOf(ws, 'OPS');
    expect(ops).toHaveLength(3);
    expect(ops.filter((m) => m.decision === 'REJECTED').every((m) => m.reason === 'Front and left photos are not clear' && !m.sent)).toBe(true);

    // the other login (Client Servicing) cannot write Operations marks, but sees them
    expect((await mark('CS', sub1, 'OPS', 'APPROVED', [{ kind: 'PHOTO', photo: front }])).status).toBe(403);
    expect(marksOf(await workspace('CS', sub1), 'OPS')).toHaveLength(3);
    // a photo or board that is not in this version is refused
    expect((await mark('OPS', sub1, 'OPS', 'APPROVED', [{ kind: 'BOARD', mediaKey: 'nope', field: 'SIZE' }])).status).toBe(400);
    expect((await mark('OPS', sub1, 'OPS', 'APPROVED', [{ kind: 'PHOTO', photo: '0123456789abcdef01234567' }])).status).toBe(400);
  });

  it('Approved -> Rejected -> Approved keeps every earlier answer with its reason (history)', async () => {
    const ws = await workspace('OPS', sub1);
    const front = photoOf(ws, 'SHOP_FRONT');
    // reject again with another reason: the first reason moves into history
    await mark('OPS', sub1, 'OPS', 'REJECTED', [{ kind: 'PHOTO', photo: front }], 'Board is cut off, retake straight on').expect(200);
    await mark('OPS', sub1, 'OPS', 'APPROVED', [{ kind: 'PHOTO', photo: front }]).expect(200); // changed his mind
    const m = marksOf(await workspace('OPS', sub1), 'OPS').find((x) => x.photo === front)!;
    expect(m.decision).toBe('APPROVED');
    expect(m.history.map((h) => `${h.decision}:${h.reason}`)).toEqual(['REJECTED:Front and left photos are not clear', 'REJECTED:Board is cut off, retake straight on']);
    // the timeline names every marking
    expect(JSON.stringify((await api().get(`${BASE}/recce-review/submissions/${sub1}/activity`).set(as('OPS'))).body.data)).toContain('marked');
  });

  it('approving is blocked while items are marked for rejection; sending Rework carries the marks to the recce person with their reasons', async () => {
    const ws = await workspace('OPS', sub1);
    const left = photoOf(ws, 'SIDE_VIEW'); // still REJECTED from the first test
    await mark('OPS', sub1, 'OPS', 'REWORK', [{ kind: 'BOARD', mediaKey: 'b1', field: 'QUANTITY' }, { kind: 'BOARD', mediaKey: 'b1', field: 'SIZE' }], 'Shop has 2 boards, size is 8 x 4 ft').expect(200);
    expect((await approve('OPS', sub1, 'OPS')).status).toBe(400);

    const sent = await rework('OPS', sub1, 'OPS', 'Left photo, quantity and size need to be redone');
    expect(sent.status).toBe(200);
    const w = sent.body.data as { status: string; marks: WsMark[]; reworks: { items: { type: string; photo: string | null; mediaKey: string; note: string; rejected: boolean }[] }[] };
    expect(w.status).toBe('REWORK_REQUIRED');
    const items = w.reworks[0]!.items;
    expect(items).toHaveLength(3); // left photo, quantity, size (the approved front photo and media type are not asked again)
    expect(items.find((i) => i.photo === left)).toMatchObject({ type: 'REPLACE_PHOTO', rejected: true, note: 'Front and left photos are not clear' });
    expect(items.find((i) => i.type === 'FIX_QUANTITY')).toMatchObject({ mediaKey: 'b1', note: 'Shop has 2 boards, size is 8 x 4 ft', rejected: false });
    expect(items.find((i) => i.type === 'FIX_MEASUREMENT')).toMatchObject({ mediaKey: 'b1' });
    expect(marksOf(w, 'OPS').filter((m) => m.decision !== 'APPROVED').every((m) => m.sent)).toBe(true);

    // what the recce person sees on the phone: the photo is Rejected with the reason; the board fields carry their remark
    const d = await detail('VA', ids.S1!);
    const ph = d.photos.find((p: { id: string }) => p.id === left);
    expect(ph.review.status).toBe('REWORK_REQUIRED');
    expect(ph.review.openRework).toMatchObject({ rejected: true, note: 'Front and left photos are not clear' });
    expect(d.reworks[0].items.map((i: { type: string }) => i.type).sort()).toEqual(['FIX_MEASUREMENT', 'FIX_QUANTITY', 'REPLACE_PHOTO']);
    // the version is closed: no more marks on it
    expect((await mark('OPS', sub1, 'OPS', 'APPROVED', [{ kind: 'PHOTO', photo: left }])).status).toBe(409);
  });

  it('the recce person answers with a new photo; version 2 starts with clean marks and version 1 history stays', async () => {
    const before = await workspace('OPS', sub1);
    const left = photoOf(before, 'SIDE_VIEW');
    const m = [{ ...metas()[1]!, replaces: left }];
    await api().post(`${shop(ids.S1!)}/photos`).set(as('VA')).attach('photos', png(), 'again.png').field('meta', JSON.stringify(m)).expect(201);
    const s2 = await api().post(`${shop(ids.S1!)}/submit`).set(as('VA')).send({ idempotencyKey: `submit-${ids.S1}-2`, notes: 'fixed' });
    expect(s2.status).toBe(200);
    const ws = await workspace('OPS', sub1);
    expect(ws.currentVersion).toBe(2);
    expect(marksOf(ws, 'OPS', 2)).toHaveLength(0);
    expect(marksOf(ws, 'OPS', 1).length).toBeGreaterThan(0); // version 1 history is untouched
    expect(ws.me.canMark).toBe(true);
    // the new photo is marked in version 2 only
    const fresh = ws.photos.find((p: { replaces: string | null }) => p.replaces === left).id as string;
    await mark('OPS', sub1, 'OPS', 'APPROVED', [{ kind: 'PHOTO', photo: fresh }], '', 2).expect(200);
    expect(marksOf(await workspace('OPS', sub1), 'OPS', 2)).toHaveLength(1);
    // an older version cannot be marked any more
    expect((await mark('OPS', sub1, 'OPS', 'APPROVED', [{ kind: 'PHOTO', photo: fresh }], '', 1)).status).toBe(409);
  });

  it('Client Servicing can decide first in parallel review, and an approved stage can still mark and send Rework (Approved -> Rework)', async () => {
    sub2 = await submitted(ids.S2!);
    const csFirst = await workspace('CS', sub2);
    expect(csFirst.me.canDecide).toBe(true); // Operations has not decided: Client Servicing does not wait for it
    expect((await approve('CS', sub2, 'CS')).status).toBe(200);
    const after = await workspace('CS', sub2);
    expect(after.me.canDecide).toBe(false);
    expect(after.me.canChange).toBe(true);
    expect(after.me.canMark).toBe(true); // an approved stage may still mark
    const right = photoOf(after, 'LONG_SHOT');
    await mark('CS', sub2, 'CS', 'REWORK', [{ kind: 'PHOTO', photo: right }], 'Long shot is blurred').expect(200);
    // Operations sees what Client Servicing marked and decided
    const opsView = await workspace('OPS', sub2);
    expect(marksOf(opsView, 'CS')).toHaveLength(1);
    expect(opsView.versions[0].reviews.find((x: { stage: string }) => x.stage === 'CS').decision).toBe('APPROVED');
    const changed = await change('CS', sub2, 'CS', 'REWORK', { comment: 'Changed my mind: long shot is blurred' });
    expect(changed.status).toBe(200);
    const w = changed.body.data as { status: string; reworks: { items: { photo: string | null; note: string; rejected: boolean }[] }[]; versions: { reviews: { stage: string; history: { decision: string }[] }[] }[] };
    expect(w.status).toBe('REWORK_REQUIRED');
    expect(w.reworks[0]!.items).toEqual([expect.objectContaining({ photo: right, note: 'Long shot is blurred', rejected: false })]);
    expect(w.versions[0]!.reviews.find((x) => x.stage === 'CS')!.history.map((h) => h.decision)).toEqual(['APPROVED']);
  });

  it('a stage that already sent its decision cannot mark; the other stage that is still pending can; Management cannot', async () => {
    sub3 = await submitted(ids.S3!);
    const ws = await workspace('OPS', sub3);
    const front = photoOf(ws, 'SHOP_FRONT');
    expect((await mark('ADMIN', sub3, 'OPS', 'APPROVED', [{ kind: 'PHOTO', photo: front }])).status).toBe(403); // Admin decides only through override
    await mark('OPS', sub3, 'OPS', 'REJECTED', [{ kind: 'PHOTO', photo: front }], 'Retake please').expect(200);
    expect((await rework('OPS', sub3, 'OPS', 'Retake the front photo')).status).toBe(200);
    // Client Servicing's own review is void now (the version went back to the recce person): it cannot mark either
    expect((await mark('CS', sub3, 'CS', 'APPROVED', [{ kind: 'PHOTO', photo: front }])).status).toBe(409);
  });
});

describe('the other team hears every answer at once, with what was marked and why; a checklist that is not met names the items', () => {
  const told = async (who: string, siteId: string) => {
    const { Notification } = await import('../src/modules/notifications/notification.model');
    return (await Notification.find({ recipient: ids[who], kind: 'RECCE_REVIEWED', site: siteId }).lean()).map((n) => ({ title: n.title, body: n.body, path: n.path }));
  };
  const decideWith = (who: string, sub: string, stage: string, decision: string, body: Record<string, unknown>) =>
    api().post(`${BASE}/recce-review/submissions/${sub}/decision`).set(as(who)).send({ stage, decision, versionNo: 1, items: [], ...body });

  it('a mark is told to the other team at once (what and why); not to the actor, not to the recce person', async () => {
    const sub = await submitted(ids.S4!);
    const ws = await workspace('OPS', sub);
    await mark('OPS', sub, 'OPS', 'REJECTED', [{ kind: 'PHOTO', photo: photoOf(ws, 'SHOP_FRONT') }, { kind: 'BOARD', mediaKey: 'b1', field: 'QUANTITY' }], 'Front photo is cut off and the quantity is wrong').expect(200);
    const cs = (await told('CS', ids.S4!)).filter((n) => n.title === 'Recce Operations: rejected');
    expect(cs).toHaveLength(1);
    expect(cs[0]!.body).toContain('rejected');
    expect(cs[0]!.body).toContain('quantity'); // what was marked
    expect(cs[0]!.body).toContain('Front photo is cut off and the quantity is wrong'); // and why
    expect(cs[0]!.path).toBe(`/recce-review/${sub}`);
    expect((await told('OPS', ids.S4!)).filter((n) => n.title === 'Recce Operations: rejected')).toHaveLength(0);
    expect((await told('VA', ids.S4!)).filter((n) => n.title === 'Recce Operations: rejected')).toHaveLength(0);
    // an approval mark is told too
    await mark('OPS', sub, 'OPS', 'APPROVED', [{ kind: 'BOARD', mediaKey: 'b1', field: 'SIZE' }]).expect(200);
    expect((await told('CS', ids.S4!)).filter((n) => n.title === 'Recce Operations: approved')).toHaveLength(1);
  });

  it('an approval reaches the other team at once; when the second approval completes the shop it is told once, not twice', async () => {
    const sub = await submitted(ids.S5!);
    expect((await approve('OPS', sub, 'OPS')).status).toBe(200);
    const first = await told('CS', ids.S5!);
    expect(first.filter((n) => n.title === 'Recce Operations approved')).toHaveLength(1); // CS sees OPS approved without waiting
    expect((await approve('CS', sub, 'CS')).status).toBe(200);
    const ops = await told('OPS', ids.S5!);
    expect(ops.filter((n) => n.title === 'Shop approved by all stages')).toHaveLength(1);
    expect(ops.filter((n) => n.title === 'Final approval' || n.title === 'Client Servicing approved')).toHaveLength(0); // covered by the one message above
    expect((await told('VA', ids.S5!)).filter((n) => n.title === 'Final approval')).toHaveLength(1);
  });

  it('every selected checklist item has its OWN remark; the remarks reach the other team; sent as rework items against their sections', async () => {
    const sub = await submitted(ids.S6!);
    const ws = await workspace('OPS', sub);
    const label = (key: string) => ws.checklist.find((c: { key: string }) => c.key === key).label as string;
    const items = (decision: string, list: [string, string][]) => ({ stage: 'OPS', versionNo: 1, decision, reason: '', targets: list.map(([key, reason]) => ({ kind: 'CHECK', key, reason })) });
    // an item without its own remark (and no shared one) is refused: nothing is saved; so is a key that is not in this stage's checklist
    expect((await api().post(marksUrl(sub)).set(as('OPS')).send(items('REWORK', [['shop_front', 'Front is blurred'], ['measurements', '']]))).status).toBe(422);
    expect((await api().post(marksUrl(sub)).set(as('OPS')).send(items('REWORK', [['client_req', 'not my stage']]))).status).toBe(400);
    expect(marksOf(await workspace('OPS', sub), 'OPS')).toHaveLength(0);

    const a = await api().post(marksUrl(sub)).set(as('OPS')).send(items('REWORK', [['shop_front', 'Front is blurred, retake'], ['measurements', 'Width is missing']])).expect(200);
    await api().post(marksUrl(sub)).set(as('OPS')).send(items('REJECTED', [['correct_shop', 'This is not the shop in the order']])).expect(200);
    const mine = marksOf(a.body.data, 'OPS');
    expect(mine.map((m: WsMark & { check?: string; label?: string }) => [m.check, m.reason])).toEqual([['shop_front', 'Front is blurred, retake'], ['measurements', 'Width is missing']]); // each its own remark
    expect(mine.every((m: WsMark & { label?: string }) => m.kind === 'CHECK' && m.label)).toBe(true);

    // Client Servicing sees them at once, with the label and the remark of each item, and was told with both remarks in the text
    const csView = marksOf(await workspace('CS', sub), 'OPS') as (WsMark & { check?: string; label?: string })[];
    expect(csView.map((m) => [m.label, m.decision])).toEqual([[label('shop_front'), 'REWORK'], [label('measurements'), 'REWORK'], [label('correct_shop'), 'REJECTED']]);
    const note = (await told('CS', ids.S6!)).find((n) => n.title === 'Recce Operations: rework asked');
    expect(note?.body).toContain(`${label('shop_front')} (Front is blurred, retake); ${label('measurements')} (Width is missing)`);

    // approving is blocked while they are unsent; sending Rework carries each as an item with its section, label and own remark
    expect((await approve('OPS', sub, 'OPS')).status).toBe(400);
    const sent = await decideWith('OPS', sub, 'OPS', 'REWORK', { comment: '3 items to fix', checklist: [] });
    expect(sent.status).toBe(200);
    type Item = { type: string; section: string | null; label: string; note: string; rejected: boolean };
    const got = (sent.body.data.reworks[0].items as Item[]).map((i) => [i.type, i.section, i.label, i.note, i.rejected]);
    expect(got).toEqual([
      ['OTHER', 'PHOTOS', label('shop_front'), 'Front is blurred, retake', false],
      ['FIX_MEASUREMENT', 'BOARDS', label('measurements'), 'Width is missing', false],
      ['OTHER', 'SHOP', label('correct_shop'), 'This is not the shop in the order', true],
    ]);
    // the phone reads the same items (section + label), and the marks turned sent
    const phone = (await detail('VA', ids.S6!)).reworks[0].items as Item[];
    expect(phone.map((i) => [i.section, i.label, i.note])).toEqual([['PHOTOS', label('shop_front'), 'Front is blurred, retake'], ['BOARDS', label('measurements'), 'Width is missing'], ['SHOP', label('correct_shop'), 'This is not the shop in the order']]);
    expect(marksOf(sent.body.data, 'OPS').every((m: WsMark) => m.sent)).toBe(true);
  });

  it('several photos can be marked in ONE call, each with its own remark (and a shared remark still works)', async () => {
    const sub = await submitted(ids.S7!);
    const ws = await workspace('CS', sub);
    const [front, left, long] = [photoOf(ws, 'SHOP_FRONT'), photoOf(ws, 'SIDE_VIEW'), photoOf(ws, 'LONG_SHOT')];
    await api().post(marksUrl(sub)).set(as('CS')).send({ stage: 'CS', versionNo: 1, decision: 'REWORK', reason: '', targets: [{ kind: 'PHOTO', photo: front, reason: 'Too dark' }, { kind: 'PHOTO', photo: left, reason: 'Cut off on the left' }] }).expect(200);
    await mark('CS', sub, 'CS', 'REJECTED', [{ kind: 'PHOTO', photo: long }], 'Wrong street').expect(200);
    const by = Object.fromEntries(marksOf(await workspace('CS', sub), 'CS').map((m) => [m.photo, m.reason]));
    expect(by).toEqual({ [front]: 'Too dark', [left]: 'Cut off on the left', [long]: 'Wrong street' });
    // a shared remark fills the items that have none of their own
    await api().post(marksUrl(sub)).set(as('CS')).send({ stage: 'CS', versionNo: 1, decision: 'REWORK', reason: 'Please retake', targets: [{ kind: 'PHOTO', photo: front }, { kind: 'PHOTO', photo: left, reason: 'Still cut off' }] }).expect(200);
    const again = Object.fromEntries(marksOf(await workspace('CS', sub), 'CS').map((m) => [m.photo, m.reason]));
    expect(again[front]).toBe('Please retake');
    expect(again[left]).toBe('Still cut off');
    // a whole-shop Reject needs no item at all (the overall reason is the remark)
    const rj = await decideWith('CS', sub, 'CS', 'REJECT', { comment: 'Wrong shop', reason: 'Wrong shop in the photos', checklist: [] });
    expect(rj.status).toBe(200);
    expect(rj.body.data.versions[0].reviews.find((x: { stage: string }) => x.stage === 'CS').comment).toBe('Wrong shop in the photos');
  });
});
