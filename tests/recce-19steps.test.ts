import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

/**
 * The whole field flow of ONE shop for the vendor "S R Glass" (vendor ID 1121), step by step, over HTTP only (no direct model access), plus the
 * parallel approval scenarios (both stages at the same time). In-memory MongoDB: it never connects to the real database.
 *
 * Set FLOW_OUT=<file.md> to write a readable transcript (request, status, key response facts) of every step.
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

/* ------------------------------------------------ transcript ------------------------------------------------ */

const transcript: string[] = [];
const short = (v: unknown, max = 900) => { const s = JSON.stringify(v, null, 2) ?? ''; return s.length > max ? `${s.slice(0, max)}\n... (cut)` : s; };
type Res = { status: number; body: { data?: unknown; error?: unknown; meta?: unknown } };
/** Records one call: heading, request line, request body, status and the chosen facts of the answer. */
function note(step: string, method: string, url: string, body: unknown, res: Res, facts?: unknown) {
  transcript.push(`### ${step}\n\n\`${method} http://localhost:4000${url}\`\n\n${body === undefined ? '' : `Request body:\n\`\`\`json\n${short(body)}\n\`\`\`\n\n`}Status: **${res.status}**\n\n${facts === undefined ? '' : `Response (key facts):\n\`\`\`json\n${short(facts)}\n\`\`\`\n`}`);
}
const remark = (text: string) => transcript.push(`> ${text}\n`);

/* ------------------------------------------------ helpers ------------------------------------------------ */

let n = 0;
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`demo-photo-${++n}-${Math.random()}`)]);
// Shop-level angle photos carry no mediaKey, so they count for every board of the shop.
const meta = (category: string, lat: number, lng: number, extra: Record<string, unknown> = {}) => ({
  clientId: `c-${Date.now()}-${++n}-${category}`, category, mediaKey: '', caption: category, capturedAt: new Date().toISOString(), lat, lng, gpsAccuracy: 8, width: 3000, height: 4000, source: 'LIVE_CAMERA', device: 'Test phone', ...extra,
});
const upload = (who: string, siteId: string, metas: Record<string, unknown>[]) => {
  let r = api().post(`${BASE}/recce/shops/${siteId}/photos`).set(as(who));
  metas.forEach((_, i) => { r = r.attach('photos', png(), `p${i}.png`); });
  return r.field('meta', JSON.stringify(metas));
};
const SIX = [
  ['SHOP_FRONT', 13.0412, 80.2345], ['SIDE_VIEW', 13.04122, 80.23455], ['LONG_SHOT', 13.04105, 80.2343], ['ANNOTATED_VIEW', 13.04121, 80.23448], ['LOCATION_VIEW', 13.04118, 80.23451], ['ACCESS_PATH', 13.0409, 80.2342],
] as const;
const sixMetas = () => SIX.map(([c, la, ln]) => meta(c, la, ln));
const shop = (siteId: string) => `${BASE}/recce/shops/${siteId}`;
const detail = async (who: string, siteId: string) => (await api().get(shop(siteId)).set(as(who))).body.data;
const boardsV1 = [
  { key: 'b1', name: 'GSB', quantity: 2, width: 6, height: 4, unit: 'FT', sided: 'SINGLE', condition: 'PROPOSED', position: 'Shop fascia' },
  { key: 'b2', name: 'Acrylic', quantity: 1, width: 4, height: 2, unit: 'FT', sided: 'SINGLE', condition: 'PROPOSED', position: 'Entrance glass' },
];
const installation = { ladderRequired: 'YES', scaffoldingRequired: 'NO', craneRequired: 'NO', hydraRequired: 'NO', manualInstallationPossible: 'YES', electricalAccess: 'AVAILABLE', installationHeightFt: 12, additionalEquipment: ['Ladder 12 ft', 'Drill machine'], notes: 'Ladder access available' };
const checklist = ['correct_shop', 'shop_front', 'board_area', 'angles', 'measurements', 'media_type', 'quantity', 'quality', 'gps', 'client_req'].map((key) => ({ key, passed: true }));
const decide = (who: string, sub: string, stage: string, decision: string, version: number, extra: Record<string, unknown> = {}) =>
  api().post(`${BASE}/recce-review/submissions/${sub}/decision`).set(as(who)).send({ stage, decision, versionNo: version, comment: decision === 'APPROVE' ? 'Looks fine' : decision === 'REJECT' ? 'Not acceptable' : 'Fix the front photo and the width', checklist, ...(decision === 'REJECT' ? { reason: 'Wrong shop photographed' } : {}), ...extra });
const submit = (who: string, siteId: string, key: string) => api().post(`${shop(siteId)}/submit`).set(as(who)).send({ idempotencyKey: key, notes: 'All angles done' });
/** Photos + boards + installation + submit V1 for one more shop of S R Glass, for the approval scenarios. */
async function readyAndSubmit(siteId: string) {
  await api().put(`${shop(siteId)}/draft`).set(as('VA')).send({ mediaItems: boardsV1, installation }).expect(200);
  await upload('VA', siteId, sixMetas()).expect(201);
  const r = await submit('VA', siteId, `submit-${siteId}-1`);
  expect(r.status).toBe(200);
  return (await detail('VA', siteId)).submissionId as string;
}
const stateOf = async (siteId: string) => { const d = await detail('VA', siteId); return { status: d.status as string, version: d.version as number, reviews: (d.reviews as { versionNo: number; stage: string; decision: string }[]).filter((r) => r.versionNo === d.version).map((r) => `${r.stage}:${r.decision}`).sort() }; };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recce-19steps-test-'));
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

  const kyc = { pan: true, gst: true, bank: true, address: true };
  const srGlass = await Vendor.create({ code: 'VND-0048', name: 'S R Glass', nameKey: 'S R Glass', type: 'ORGANIZATION', mobile: '9344124985', status: 'ACTIVE', kyc, zohoVendorNo: '11121' } as never);
  const other = await Vendor.create({ code: 'VND-0049', name: 'Other Vendor', nameKey: 'Other Vendor', type: 'ORGANIZATION', mobile: '9000000001', status: 'ACTIVE', kyc, zohoVendorNo: '22222' } as never);
  const passwordHash = await hashPassword('Passw0rd!x');
  const people: [string, string, string, unknown?][] = [['VA', 'S R Glass', 'VENDOR', srGlass._id], ['VB', 'Other Vendor', 'VENDOR', other._id], ['OPS', 'Operations Arvind', 'OPERATIONS'], ['CS', 'Client Servicing Priya', 'CLIENT_SERVICING'], ['ADMIN', 'Admin', 'SUPER_ADMIN']];
  for (const [key, name, role, vendorId] of people) {
    const u = await User.create({ name, email: `${key.toLowerCase()}@t.com`, role, passwordHash, ...(vendorId ? { vendorId } : {}) } as never) as unknown as { _id: unknown };
    ids[key] = String(u._id);
  }
  const client = await Client.create({ name: 'DEMO', code: 'DM' });
  const p = await Project.create({ code: '20262026', name: 'DEMO - 2026-FIRST', client: client._id, status: 'IN_PROGRESS', assignedTo: ids.OPS, createdBy: ids.CS, requirementType: 'SHOP_DETAILS' });
  ids.P = String(p._id);
  for (let i = 1; i <= 9; i++) {
    ids[`S${i}`] = String((await Site.create({ project: p._id, seq: i, siteCode: `20262026-S00${i}`, scenario: 'MEASUREMENT_REQUIRED', dealerName: i === 1 ? 'All India Hardware' : `Dealer ${i}`, boardType: 'Board', quantity: 1, district: 'CHENNAI', location: 'T. Nagar', lat: 13.041, lng: 80.234, channel: 'VENDOR', vendor: i === 9 ? other._id : srGlass._id }))._id);
  }
  // Reviewers sign in with email and password (web); the vendor signs in with the vendor ID in step 1.
  for (const k of ['OPS', 'CS', 'ADMIN']) tokens[k] = (await api().post(`${BASE}/auth/login`).send({ email: `${k.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
});
afterAll(async () => {
  if (process.env.FLOW_OUT) fs.writeFileSync(process.env.FLOW_OUT, `# Recce flow test output\n\nGenerated by tests/recce-19steps.test.ts (in-memory database, ${new Date().toISOString()}).\n\n${transcript.join('\n')}\n`);
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------ the 19 steps (one shop, S R Glass) ------------------------------------------------ */

describe('one shop from login to final approval', () => {
  let frontId = '';
  let sub = '';
  const siteId = () => ids.S1;

  it('step 0 (Admin, one time): both stages review at the same time, and the six angle photos are the required ones', async () => {
    const body = { sequential: false, requiredPhotos: { default: SIX.map((s) => s[0]) } };
    const r = await api().put(`${BASE}/recce-review/config`).set(as('ADMIN')).send(body);
    note('Step 0 - Admin config (one time)', 'PUT', '/api/v1/recce-review/config', body, r, { sequential: r.body.data && (r.body.data as { sequential: boolean }).sequential, requiredPhotos: r.body.data && (r.body.data as { requiredPhotos: unknown }).requiredPhotos });
    expect(r.status).toBe(200);
    expect((r.body.data as { sequential: boolean }).sequential).toBe(false);
  });

  it('step 1: vendor login with the last 4 digits of the vendor ID (1121 matches vendor no 11121)', async () => {
    const body = { vendorId: '1121' };
    const r = await api().post(`${BASE}/auth/vendor-login`).send(body);
    const d = r.body.data as { accessToken: string; user: { name: string; role: string; vendorId: string } };
    note('Step 1 - Vendor login', 'POST', '/api/v1/auth/vendor-login', body, r, { accessToken: `${d?.accessToken?.slice(0, 20)}...`, user: d?.user && { name: d.user.name, role: d.user.role, vendorId: d.user.vendorId } });
    expect(r.status).toBe(200);
    expect(d.user.name).toBe('S R Glass');
    tokens.VA = d.accessToken;
    tokens.VB = (await api().post(`${BASE}/auth/login`).send({ email: 'vb@t.com', password: 'Passw0rd!x' })).body.data.accessToken;
  });

  it('step 2: project list (dashboard) shows only this vendor\'s project', async () => {
    const r = await api().get(`${BASE}/recce/dashboard`).set(as('VA'));
    note('Step 2 - Project list (dashboard)', 'GET', '/api/v1/recce/dashboard', undefined, r, r.body.data);
    expect(r.status).toBe(200);
    const d = r.body.data as { assignedProjects: number; assignedShops: number; projects: { projectCode: string }[] };
    expect(d.assignedProjects).toBe(1);
    expect(d.assignedShops).toBe(8); // S1..S8, not the other vendor's S9
    expect(d.projects[0]?.projectCode).toBe('20262026');
  });

  it('step 3: shops of the project; another vendor\'s shop is not listed', async () => {
    const r = await api().get(`${BASE}/recce/shops`).query({ projectId: ids.P, page: 1, limit: 50 }).set(as('VA'));
    const rows = r.body.data as { siteId: string; siteCode: string; status: string }[];
    note('Step 3 - Project shops', 'GET', `/api/v1/recce/shops?projectId=${ids.P}&page=1&limit=50`, undefined, r, { count: rows?.length, first: rows?.[0], meta: r.body.meta });
    expect(r.status).toBe(200);
    expect(rows).toHaveLength(8);
    expect(rows.some((s) => s.siteId === ids.S9)).toBe(false);
    expect((await api().get(shop(ids.S9)).set(as('VA'))).status).toBe(404);
  });

  it('step 4: open the shop', async () => {
    const r = await api().get(shop(siteId())).set(as('VA'));
    const d = r.body.data;
    note('Step 4 - Shop detail', 'GET', `/api/v1/recce/shops/${siteId()}`, undefined, r, { siteCode: d.siteCode, status: d.status, editable: d.editable, mediaItems: d.mediaItems, installationPending: d.installationPending, categories: d.categories.map((c: { key: string }) => c.key), progress: d.progress });
    expect(r.status).toBe(200);
    expect(d.status).toBe('NOT_STARTED');
    expect(d.progress.missing.length).toBeGreaterThan(0);
  });

  it('step 5: start the visit', async () => {
    const r = await api().post(`${shop(siteId())}/start`).set(as('VA')).send({});
    note('Step 5 - Start visit', 'POST', `/api/v1/recce/shops/${siteId()}/start`, {}, r, { status: r.body.data?.status, rawStatus: r.body.data?.rawStatus });
    expect(r.status).toBe(200);
    const again = await api().post(`${shop(siteId())}/start`).set(as('VA')).send({});
    expect(again.status).toBe(200); // starting a started shop is harmless
  });

  it('step 6: boards - GSB x2 6x4 and Acrylic 4x2', async () => {
    const body = { mediaItems: boardsV1, notes: 'Shop opens at 9 am' };
    const r = await api().put(`${shop(siteId())}/draft`).set(as('VA')).send(body);
    note('Step 6 - Boards (V1)', 'PUT', `/api/v1/recce/shops/${siteId()}/draft`, body, r, r.body.data?.mediaItems);
    expect(r.status).toBe(200);
    expect(r.body.data.mediaItems.map((m: { key: string }) => m.key)).toEqual(['b1', 'b2']);
  });

  it('step 7: installation requirement (ladder, crane, equipment)', async () => {
    const r = await api().put(`${shop(siteId())}/draft`).set(as('VA')).send({ installation });
    note('Step 7 - Installation', 'PUT', `/api/v1/recce/shops/${siteId()}/draft`, { installation }, r, { installation: r.body.data?.installation, installationPending: r.body.data?.installationPending });
    expect(r.status).toBe(200);
    expect(r.body.data.installation.ladderRequired).toBe('YES');
    expect(r.body.data.installationPending).toEqual([]);
  });

  it('step 8: six photos, each with its own GPS', async () => {
    const outs: unknown[] = [];
    for (const m of sixMetas()) {
      const r = await upload('VA', siteId(), [m]);
      expect(r.status).toBe(201);
      outs.push({ category: m.category, lat: m.lat, lng: m.lng, status: r.status });
    }
    const d = await detail('VA', siteId());
    const photos = d.photos as { id: string; category: string; lat: number; lng: number; gpsVerified: boolean; state: string; review: { status: string } }[];
    frontId = photos.find((p) => p.category === 'SHOP_FRONT')!.id;
    note('Step 8 - Six photos (one request per photo, own GPS)', 'POST', `/api/v1/recce/shops/${siteId()}/photos`, { 'form-data photos': 'image file', meta: [sixMetas()[0]] }, { status: 201, body: {} }, { uploads: outs, shopStatus: d.status, progress: d.progress, photos: photos.map((p) => ({ id: p.id, category: p.category, lat: p.lat, lng: p.lng, gpsVerified: p.gpsVerified, state: p.state, review: p.review.status })) });
    expect(photos).toHaveLength(6);
    expect(photos.every((p) => p.lat && p.lng && p.gpsVerified)).toBe(true);
    expect(new Set(photos.map((p) => `${p.lat},${p.lng}`)).size).toBe(6); // every photo kept its own location
    expect(d.progress.missing).toEqual([]);
    expect(d.status).toBe('READY_TO_SUBMIT');
  });

  it('step 9: submit Version 1; a double tap is the same version; BOTH review stages are told at once', async () => {
    const key = `submit-${siteId()}-1`;
    const r = await submit('VA', siteId(), key);
    note('Step 9 - Submit V1', 'POST', `/api/v1/recce/shops/${siteId()}/submit`, { idempotencyKey: key, notes: 'All angles done' }, r, { duplicate: r.body.data?.duplicate, version: r.body.data?.version, status: r.body.data?.detail?.status });
    expect(r.status).toBe(200);
    expect(r.body.data.version).toBe(1);
    const again = await submit('VA', siteId(), key);
    expect(again.body.data.duplicate).toBe(true);
    expect(again.body.data.version).toBe(1);
    sub = (await detail('VA', siteId())).submissionId;
    for (const who of ['OPS', 'CS']) {
      const inbox = await api().get(`${BASE}/recce-review/inbox`).query({ view: 'mine' }).set(as(who));
      expect((inbox.body.data as { id: string }[]).some((x) => x.id === sub)).toBe(true);
      const bell = await api().get(`${BASE}/notifications`).set(as(who));
      expect((bell.body.data.items as { type: string; siteId: string | null }[]).some((x) => x.type === 'RECCE_SUBMITTED' && x.siteId === siteId())).toBe(true);
    }
    remark('Operations and Client Servicing both have this shop in their inbox ("mine") and both got a RECCE_SUBMITTED notification right after the submit.');
  });

  it('step 10: reviewers sign in (Operations = stage OPS, Client Servicing = stage CS)', async () => {
    const r = await api().get(`${BASE}/recce-review/submissions/${sub}`).set(as('OPS'));
    note('Step 10 - Reviewer workspace (Operations)', 'GET', `/api/v1/recce-review/submissions/${sub}`, undefined, r, { status: r.body.data?.status, version: r.body.data?.version, photos: r.body.data?.photos?.length });
    expect(r.status).toBe(200);
    expect([403, 404]).toContain((await api().get(`${BASE}/recce-review/submissions/${sub}`).set(as('VA'))).status); // a vendor cannot open the review side
  });

  it('step 11: Client Servicing approves V1 FIRST, without waiting for Operations', async () => {
    const r = await decide('CS', sub, 'CS', 'APPROVE', 1);
    note('Step 11 - Client Servicing approves V1', 'POST', `/api/v1/recce-review/submissions/${sub}/decision`, { stage: 'CS', decision: 'APPROVE', versionNo: 1, comment: 'Looks fine', checklist: '[10 items ticked]' }, r, { status: r.body.data?.status });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('UNDER_REVIEW');
  });

  it('step 12: Operations asks for rework of the front photo and the width', async () => {
    const body = { stage: 'OPS', decision: 'REWORK', versionNo: 1, comment: 'Fix the front photo and the width', items: [{ type: 'REPLACE_PHOTO', category: 'SHOP_FRONT', photo: frontId, note: 'Board not clear, retake straight on' }, { type: 'FIX_MEASUREMENT', mediaKey: 'b1', note: 'Width is 8 ft, not 6 ft' }] };
    const r = await decide('OPS', sub, 'OPS', 'REWORK', 1, { items: body.items });
    note('Step 12 - Operations rework', 'POST', `/api/v1/recce-review/submissions/${sub}/decision`, body, r, { status: r.body.data?.status });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('REWORK_REQUIRED');
  });

  it('step 13: the vendor sees the rework flag on the front photo only, with its history', async () => {
    const d = await detail('VA', siteId());
    const photos = d.photos as { id: string; category: string; review: { status: string; openRework: { note: string; stageLabel: string; requestedBy: string } | null } }[];
    const hist = await api().get(`${shop(siteId())}/photos/${frontId}/history`).set(as('VA'));
    note('Step 13 - Vendor sees the rework', 'GET', `/api/v1/recce/shops/${siteId()}`, undefined, { status: 200, body: {} }, { status: d.status, editable: d.editable, flags: photos.map((p) => ({ category: p.category, review: p.review.status, openRework: p.review.openRework && { note: p.review.openRework.note, stage: p.review.openRework.stageLabel, by: p.review.openRework.requestedBy } })), reworks: d.reworks });
    note('Step 13b - Photo history', 'GET', `/api/v1/recce/shops/${siteId()}/photos/${frontId}/history`, undefined, hist, hist.body.data);
    expect(d.status).toBe('REWORK_REQUIRED');
    expect(d.editable).toBe(true);
    expect(photos.find((p) => p.id === frontId)!.review.status).toBe('REWORK_REQUIRED');
    expect(photos.filter((p) => p.id !== frontId).every((p) => p.review.status === 'PENDING')).toBe(true);
    expect(hist.status).toBe(200);
  });

  it('step 14: replace only the front photo', async () => {
    const m = meta('SHOP_FRONT', 13.0413, 80.2346, { replaces: frontId, gpsAccuracy: 6.1 });
    const r = await upload('VA', siteId(), [m]);
    note('Step 14 - Replace the front photo', 'POST', `/api/v1/recce/shops/${siteId()}/photos`, { 'form-data photos': 'new image', meta: [m] }, r, { photos: (r.body.data?.photos as { id: string; category: string; state: string; replaces: string | null }[])?.filter((p) => p.category === 'SHOP_FRONT').map((p) => ({ id: p.id, state: p.state, replaces: p.replaces })) });
    expect(r.status).toBe(201);
  });

  it('step 15: width 6 ft to 8 ft', async () => {
    const body = { mediaItems: [{ ...boardsV1[0], width: 8 }, boardsV1[1]] };
    const r = await api().put(`${shop(siteId())}/draft`).set(as('VA')).send(body);
    note('Step 15 - Boards V2 (GSB width 8)', 'PUT', `/api/v1/recce/shops/${siteId()}/draft`, body, r, r.body.data?.mediaItems);
    expect(r.status).toBe(200);
  });

  it('step 16: submit Version 2', async () => {
    const key = `submit-${siteId()}-2`;
    const r = await submit('VA', siteId(), key);
    note('Step 16 - Submit V2', 'POST', `/api/v1/recce/shops/${siteId()}/submit`, { idempotencyKey: key, notes: 'All angles done' }, r, { duplicate: r.body.data?.duplicate, version: r.body.data?.version, status: r.body.data?.detail?.status });
    expect(r.status).toBe(200);
    expect(r.body.data.version).toBe(2);
  });

  it('step 17: versions array, compare V1 and V2, approval history', async () => {
    const v = await api().get(`${shop(siteId())}/versions`).set(as('VA'));
    const c = await api().get(`${shop(siteId())}/versions/compare`).query({ from: 1, to: 2 }).set(as('VA'));
    const a = await api().get(`${shop(siteId())}/activity`).set(as('VA'));
    const versions = v.body.data as { version: number; mediaItems: { key: string; width: number }[]; decisions: { stage: string; decision: string; reviewer: string }[] }[];
    note('Step 17a - Versions (V1, V2 array)', 'GET', `/api/v1/recce/shops/${siteId()}/versions`, undefined, v, versions.map((x) => ({ version: x.version, mediaItems: x.mediaItems, decisions: x.decisions })));
    note('Step 17b - Compare V1 and V2', 'GET', `/api/v1/recce/shops/${siteId()}/versions/compare?from=1&to=2`, undefined, c, c.body.data);
    note('Step 17c - Approval history (time based)', 'GET', `/api/v1/recce/shops/${siteId()}/activity`, undefined, a, (a.body.data as { type: string; actor?: unknown; at?: string; createdAt?: string }[]).map((e) => ({ type: e.type, at: e.at ?? e.createdAt })));
    expect(versions.map((x) => x.version)).toEqual([1, 2]);
    expect(versions[0]!.mediaItems.find((m) => m.key === 'b1')!.width).toBe(6);
    expect(versions[1]!.mediaItems.find((m) => m.key === 'b1')!.width).toBe(8);
    const cmp = c.body.data as { photos: { replaced: unknown[]; unchanged: unknown[] }; mediaItems: { changed: { key: string; fields: { field: string; from: number; to: number }[] }[] } };
    expect(cmp.photos.replaced).toHaveLength(1);
    expect(cmp.photos.unchanged).toHaveLength(5);
    expect(cmp.mediaItems.changed[0]!.fields).toEqual([{ field: 'width', from: 6, to: 8 }]);
    const types = (a.body.data as { type: string }[]).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['SUBMISSION_CREATED', 'REVIEW_APPROVED', 'REWORK_REQUESTED', 'REWORK_SUBMITTED']));
  });

  it('step 18: shop channel (messages, unread) and notifications', async () => {
    const post = await api().post(`${shop(siteId())}/messages`).set(as('VA')).send({ body: 'Front photo retaken as asked', refs: [{ type: 'BOARD', id: 'b1' }, { type: 'VERSION', id: '2' }] });
    const list = await api().get(`${shop(siteId())}/messages`).set(as('VA'));
    const unreadOps = await api().get(`${BASE}/recce-review/submissions/${sub}/messages/unread`).set(as('OPS'));
    const bell = await api().get(`${BASE}/notifications`).set(as('VA'));
    note('Step 18a - Post a channel message', 'POST', `/api/v1/recce/shops/${siteId()}/messages`, { body: 'Front photo retaken as asked', refs: [{ type: 'BOARD', id: 'b1' }, { type: 'VERSION', id: '2' }] }, post, { id: post.body.data && (post.body.data as { id: string }).id });
    note('Step 18b - Channel messages (system cards + people)', 'GET', `/api/v1/recce/shops/${siteId()}/messages`, undefined, list, (list.body.data as { author: { name: string; role: string }; body: string; card: { title: string; lines: { label: string; value: string }[] } | null }[]).map((m) => ({ by: `${m.author.name} (${m.author.role})`, text: m.card ? `${m.card.title}: ${m.card.lines.find((l) => l.label === 'Decision')?.value ?? ''}` : m.body })));
    note('Step 18c - Unread for Operations', 'GET', `/api/v1/recce-review/submissions/${sub}/messages/unread`, undefined, unreadOps, unreadOps.body.data);
    note('Step 18d - Vendor notifications', 'GET', '/api/v1/notifications', undefined, bell, (bell.body.data.items as { type: string; title: string; siteId: string | null }[]).map((x) => ({ type: x.type, title: x.title, siteId: x.siteId })));
    expect(post.status).toBe(201);
    expect(unreadOps.body.data.unread).toBeGreaterThan(0);
    expect((list.body.data as { author: { role: string } }[]).some((m) => m.author.role === 'OPERATIONS' || m.author.role === 'CLIENT_SERVICING')).toBe(true);
  });

  it('step 19: BOTH stages approve V2 at the same moment; both decisions stand and the shop is APPROVED', async () => {
    const [a, b] = await Promise.all([decide('CS', sub, 'CS', 'APPROVE', 2), decide('OPS', sub, 'OPS', 'APPROVE', 2)]);
    note('Step 19 - Both approve V2 at the same time', 'POST', `/api/v1/recce-review/submissions/${sub}/decision (two calls at once)`, { stage: 'CS and OPS', decision: 'APPROVE', versionNo: 2 }, { status: 200, body: {} }, { clientServicing: a.status, operations: b.status });
    expect([a.status, b.status]).toEqual([200, 200]);
    const s = await stateOf(siteId());
    note('Step 19b - Result', 'GET', `/api/v1/recce/shops/${siteId()}`, undefined, { status: 200, body: {} }, s);
    expect(s).toEqual({ status: 'APPROVED', version: 2, reviews: ['CS:APPROVED', 'OPS:APPROVED'] });
    const ws = await api().get(`${BASE}/recce-review/submissions/${sub}`).set(as('ADMIN'));
    expect(ws.body.data.status).toBe('APPROVED');
  });
});

/* ------------------------------------------------ approval order scenarios (one shop each) ------------------------------------------------ */

describe('two reviewers, no dependency: every order and every mix', () => {
  it('A. Client Servicing then Operations approve: APPROVED', async () => {
    const sub = await readyAndSubmit(ids.S2);
    const x = await decide('CS', sub, 'CS', 'APPROVE', 1);
    const mid = await stateOf(ids.S2);
    const y = await decide('OPS', sub, 'OPS', 'APPROVE', 1);
    const end = await stateOf(ids.S2);
    remark(`Scenario A (CS first, then OPS): CS ${x.status}, after CS = ${mid.status}, OPS ${y.status}, final = ${end.status} ${JSON.stringify(end.reviews)}`);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(mid.status).toBe('UNDER_REVIEW');
    expect(end.status).toBe('APPROVED');
  });
  it('B. Operations then Client Servicing approve (the other order): APPROVED', async () => {
    const sub = await readyAndSubmit(ids.S3);
    const x = await decide('OPS', sub, 'OPS', 'APPROVE', 1);
    const y = await decide('CS', sub, 'CS', 'APPROVE', 1);
    const end = await stateOf(ids.S3);
    remark(`Scenario B (OPS first, then CS): OPS ${x.status}, CS ${y.status}, final = ${end.status} ${JSON.stringify(end.reviews)}`);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(end.status).toBe('APPROVED');
  });
  it('C. both approve at the very same moment: both 200, APPROVED, both decisions kept', async () => {
    const sub = await readyAndSubmit(ids.S4);
    const [x, y] = await Promise.all([decide('CS', sub, 'CS', 'APPROVE', 1), decide('OPS', sub, 'OPS', 'APPROVE', 1)]);
    const end = await stateOf(ids.S4);
    remark(`Scenario C (both approve together): CS ${x.status}, OPS ${y.status}, final = ${end.status} ${JSON.stringify(end.reviews)}`);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(end).toEqual({ status: 'APPROVED', version: 1, reviews: ['CS:APPROVED', 'OPS:APPROVED'] });
  });
  it('D. both reject at the same moment: REJECTED (the second call may answer 200 or 409, never 500)', async () => {
    const sub = await readyAndSubmit(ids.S5);
    const [x, y] = await Promise.all([decide('CS', sub, 'CS', 'REJECT', 1), decide('OPS', sub, 'OPS', 'REJECT', 1)]);
    const end = await stateOf(ids.S5);
    remark(`Scenario D (both reject together): CS ${x.status}, OPS ${y.status}, final = ${end.status} ${JSON.stringify(end.reviews)}`);
    expect([x.status, y.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect([x.status, y.status]).toContain(200);
    expect(end.status).toBe('REJECTED');
  });
  it('E. one approves, one rejects at the same moment: REJECTED', async () => {
    const sub = await readyAndSubmit(ids.S6);
    const [x, y] = await Promise.all([decide('CS', sub, 'CS', 'APPROVE', 1), decide('OPS', sub, 'OPS', 'REJECT', 1)]);
    const end = await stateOf(ids.S6);
    remark(`Scenario E (CS approves, OPS rejects, together): CS ${x.status}, OPS ${y.status}, final = ${end.status} ${JSON.stringify(end.reviews)}`);
    expect([x.status, y.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect(y.status).toBe(200);
    expect(end.status).toBe('REJECTED');
  });
  it('F. one approves, one asks for rework at the same moment: REWORK_REQUIRED', async () => {
    const sub = await readyAndSubmit(ids.S7);
    const [x, y] = await Promise.all([decide('CS', sub, 'CS', 'APPROVE', 1), decide('OPS', sub, 'OPS', 'REWORK', 1, { items: [{ type: 'FIX_MEASUREMENT', mediaKey: 'b1', note: 'Width is 8 ft' }] })]);
    const end = await stateOf(ids.S7);
    remark(`Scenario F (CS approves, OPS rework, together): CS ${x.status}, OPS ${y.status}, final = ${end.status} ${JSON.stringify(end.reviews)}`);
    expect([x.status, y.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect(y.status).toBe(200);
    expect(end.status).toBe('REWORK_REQUIRED');
  });
  it('G. a stage cannot decide twice, and a vendor cannot approve', async () => {
    const sub = await readyAndSubmit(ids.S8);
    expect((await decide('CS', sub, 'CS', 'APPROVE', 1)).status).toBe(200);
    const twice = await decide('CS', sub, 'CS', 'APPROVE', 1);
    const vendor = await decide('VA', sub, 'CS', 'APPROVE', 1);
    const wrongStage = await decide('OPS', sub, 'CS', 'APPROVE', 1);
    remark(`Scenario G: CS second decision ${twice.status}, vendor ${vendor.status}, OPS deciding the CS stage ${wrongStage.status}`);
    expect(twice.status).toBe(409);
    expect(vendor.status).toBe(403);
    expect(wrongStage.status).toBe(403);
  });
  it('H. old data and an old config still saying "sequential": Client Servicing never waits for Operations', async () => {
    // Atlas still holds sequential: true in the config and on versions made before 2026-11-25. Both are ignored now.
    await api().put(`${BASE}/recce-review/config`).set(as('ADMIN')).send({ sequential: true }).expect(200);
    // S9 belongs to the other vendor, so make a fresh shop for the test by re-using S2 after reopening is not needed: add one through a new site.
    const { Site } = await import('../src/modules/sites/site.model');
    const { Vendor } = await import('../src/modules/vendors/vendor.model');
    const v = await Vendor.findOne({ code: 'VND-0048' }).select('_id').lean();
    const site = await Site.create({ project: ids.P, seq: 20, siteCode: '20262026-S020', scenario: 'MEASUREMENT_REQUIRED', dealerName: 'Dealer 20', boardType: 'Board', quantity: 1, district: 'CHENNAI', lat: 13.041, lng: 80.234, channel: 'VENDOR', vendor: v!._id });
    const sub = await readyAndSubmit(String(site._id));
    const { RecceSubmission } = await import('../src/modules/recce-review/recceReview.model');
    await RecceSubmission.updateOne({ _id: sub }, { $set: { 'versions.$[].sequential': true } }); // a version made while the old rule was on
    const csView = await api().get(`${BASE}/recce-review/submissions/${sub}`).set(as('CS'));
    const first = await decide('CS', sub, 'CS', 'APPROVE', 1);
    const second = await decide('OPS', sub, 'OPS', 'APPROVE', 1);
    remark(`Scenario H (old sequential flags): CS can decide ${(csView.body.data as { me: { canDecide: boolean } }).me.canDecide}; CS first ${first.status} (${(first.body.data as { status?: string } | undefined)?.status}); OPS after ${second.status} (${(second.body.data as { status?: string } | undefined)?.status})`);
    expect((csView.body.data as { me: { canDecide: boolean } }).me.canDecide).toBe(true);
    expect(first.status).toBe(200);
    expect((first.body.data as { status: string }).status).toBe('UNDER_REVIEW');
    expect(second.status).toBe(200);
    expect((second.body.data as { status: string }).status).toBe('APPROVED');
    await api().put(`${BASE}/recce-review/config`).set(as('ADMIN')).send({ sequential: false }).expect(200);
  });
});
