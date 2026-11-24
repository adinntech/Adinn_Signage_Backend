import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Media catalog (2026-11-24): the media types, installation methods and site questions are data the admin edits, read by everyone who is
 * signed in. Boards carry their media code, installation type and answers. In-memory database only.
 */
let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root: string;
let admin = '';
let vendor = '';
let siteId = '';
const api = () => request(app);
const as = (t: string) => ({ Authorization: `Bearer ${t}` });
const get = async () => (await api().get('/api/v1/catalog').set(as(vendor))).body.data;
const post = (url: string, body: unknown, t = admin) => api().post(`/api/v1/catalog${url}`).set(as(t)).send(body as object);
const put = (url: string, body: unknown, t = admin) => api().put(`/api/v1/catalog${url}`).set(as(t)).send(body as object);
const del = (url: string, t = admin) => api().delete(`/api/v1/catalog${url}`).set(as(t));
const saveBoards = (mediaItems: Record<string, unknown>[]) => api().put(`/api/v1/recce/shops/${siteId}/draft`).set(as(vendor)).send({ mediaItems });

const board = (extra: Record<string, unknown> = {}) => ({ key: 'b1', name: 'GSB Board (Glow Sign Board)', mediaType: 'GSB', seq: 1, quantity: 1, width: 6, height: 4, unit: 'FT', ...extra });
const NEW_MEDIA = { code: 'LED_WALL', shortName: 'LED Wall', name: 'LED Video Wall', description: 'Video wall panels', icon: 'light_mode_outlined', color: '#1A73E8', illuminated: true, sidedness: 'SINGLE', depthFt: 0.5, thicknessMm: 0, installations: ['wall_mount', 'rooftop'] };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
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

  const v = await Vendor.create({ code: 'VND-C', name: 'VND-C', nameKey: 'VND-C', type: 'ORGANIZATION', mobile: '9000000003', status: 'ACTIVE', kyc: { pan: true, gst: true, bank: true, address: true } });
  await User.create({ name: 'ADMIN', email: 'admin@t.com', role: 'SUPER_ADMIN', passwordHash: await hashPassword('Passw0rd!x') });
  const ops = await User.create({ name: 'OPS', email: 'ops@t.com', role: 'OPERATIONS', passwordHash: await hashPassword('Passw0rd!x') });
  await User.create({ name: 'VA', email: 'va@t.com', role: 'VENDOR', vendorId: v._id, passwordHash: await hashPassword('Passw0rd!x') });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: 'Passw0rd!x' })).body.data.accessToken as string;
  admin = await login('admin@t.com');
  vendor = await login('va@t.com');
  const client = await Client.create({ name: 'Amul', code: 'AM' });
  const project = await Project.create({ code: 'P-CAT', name: 'Catalog', client: client._id, status: 'IN_PROGRESS', assignedTo: ops._id, createdBy: ops._id, requirementType: 'SHOP_DETAILS' });
  siteId = String((await Site.create({ project: project._id, seq: 1, siteCode: 'P-CAT-S1', scenario: 'MEASUREMENT_REQUIRED', shopName: 'Shop C1', boardType: 'GSB Single Side', quantity: 1, district: 'Madurai', lat: 9.9, lng: 78.1, channel: 'VENDOR', vendor: v._id }))._id);
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('reading the catalog', () => {
  it('fills itself from the built-in list the first time it is read, for any signed-in role', async () => {
    const d = await get();
    expect(d.media).toHaveLength(18);
    expect(d.media.filter((m: { legacy: boolean }) => !m.legacy)).toHaveLength(13); // the 13 cards the phone offers
    expect(d.installations).toHaveLength(10);
    expect(d.questions).toHaveLength(93);
    const gsb = d.media.find((m: { code: string }) => m.code === 'GSB');
    expect(gsb).toMatchObject({ shortName: 'GSB', name: 'GSB Board (Glow Sign Board)', sidedness: 'SELECTABLE', illuminated: true, active: true, legacy: false });
    expect(gsb.installations).toEqual(['shop_fascia', 'wall_mount', 'double_pole', 'single_pole', 'rooftop', 'support_pipe']);
    expect(d.questions.filter((q: { scope: string }) => q.scope === 'COMMON')).toHaveLength(4);
    const dep = d.questions.find((q: { id: string }) => q.id === 'remove_existing');
    expect(dep).toMatchObject({ type: 'YES_NO', showIfId: 'existing_board', showIfValue: true });
  });

  it('answers "unchanged" to a phone that already has this version, and the new catalog when it does not', async () => {
    const d = await get();
    const same = (await api().get(`/api/v1/catalog?version=${d.version}`).set(as(vendor))).body.data;
    expect(same).toEqual({ version: d.version, unchanged: true });
    const stale = (await api().get(`/api/v1/catalog?version=${d.version - 1}`).set(as(vendor))).body.data;
    expect(stale.unchanged).toBe(false);
    expect(stale.media).toHaveLength(18);
  });

  it('needs a login', async () => {
    expect((await api().get('/api/v1/catalog')).status).toBe(401);
  });
});

describe('only the admin edits it', () => {
  it('refuses a vendor on every write and on the usage list', async () => {
    expect((await post('/media', NEW_MEDIA, vendor)).status).toBe(403);
    expect((await put('/media/GSB', { name: 'Hacked' }, vendor)).status).toBe(403);
    expect((await del('/media/GSB', vendor)).status).toBe(403);
    expect((await post('/installations', { code: 'x_inst', name: 'X' }, vendor)).status).toBe(403);
    expect((await post('/questions', { scope: 'COMMON', id: 'x_q', label: 'Question', type: 'TEXT' }, vendor)).status).toBe(403);
    expect((await post('/reorder', { kind: 'media', ids: ['GSB'] }, vendor)).status).toBe(403);
    expect((await post('/defaults', {}, vendor)).status).toBe(403);
    expect((await api().get('/api/v1/catalog/usage').set(as(vendor))).status).toBe(403);
    expect((await get()).media.find((m: { code: string }) => m.code === 'GSB').name).toBe('GSB Board (Glow Sign Board)');
  });
});

describe('media types', () => {
  it('adds one, lists it, and raises the version', async () => {
    const before = (await get()).version;
    const res = await post('/media', NEW_MEDIA);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'LED_WALL', name: 'LED Video Wall', active: true, legacy: false, installations: ['wall_mount', 'rooftop'] });
    const d = await get();
    expect(d.version).toBeGreaterThan(before);
    expect(d.media.map((m: { code: string }) => m.code)).toContain('LED_WALL');
  });

  it('refuses a repeated code, a bad code or colour, an unknown installation, and typed markup', async () => {
    expect((await post('/media', NEW_MEDIA)).status).toBe(409);
    expect((await post('/media', { ...NEW_MEDIA, code: 'a b' })).status).toBe(422);
    expect((await post('/media', { ...NEW_MEDIA, code: 'X' })).status).toBe(422);
    expect((await post('/media', { ...NEW_MEDIA, code: 'OK_1', color: 'red' })).status).toBe(422);
    expect((await post('/media', { ...NEW_MEDIA, code: 'OK_2', name: '<script>x</script>' })).status).toBe(422);
    expect((await post('/media', { ...NEW_MEDIA, code: 'OK_3', icon: 'not_an_icon' })).status).toBe(422);
    const unknown = await post('/media', { ...NEW_MEDIA, code: 'OK_4', installations: ['nope'] });
    expect(unknown.status).toBe(400);
    expect((await post('/media', { ...NEW_MEDIA, code: 'OK_5', installations: ['rooftop', 'rooftop'] })).status).toBe(422);
    expect((await get()).media.map((m: { code: string }) => m.code).filter((c: string) => c.startsWith('OK_'))).toEqual([]);
  });

  it('edits the name, the installations offered and the active switch; its code and unknown fields cannot be sent', async () => {
    const res = await put('/media/LED_WALL', { name: 'LED Video Wall 2', installations: ['wall_mount'], active: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'LED Video Wall 2', installations: ['wall_mount'], active: false });
    // what was not sent stays exactly as it was (an edit never fills in defaults)
    expect(res.body.data).toMatchObject({ description: 'Video wall panels', icon: 'light_mode_outlined', color: '#1A73E8', illuminated: true, depthFt: 0.5, shortName: 'LED Wall', sidedness: 'SINGLE' });
    expect((await put('/media/LED_WALL', { code: 'OTHER' })).status).toBe(422);
    expect((await put('/media/LED_WALL', { legacy: true })).status).toBe(422);
    expect((await put('/media/LED_WALL', { installations: ['nope'] })).status).toBe(400);
    expect((await put('/media/NOPE_X', { name: 'x' })).status).toBe(404);
    // an edit that changes nothing does not raise the version
    const v = (await get()).version;
    expect((await put('/media/LED_WALL', { name: 'LED Video Wall 2' })).status).toBe(200);
    expect((await get()).version).toBe(v);
  });

  it('deleting a media type also deletes its own questions; a media type used by a board cannot be deleted', async () => {
    await post('/questions', { scope: 'MEDIA', scopeCode: 'LED_WALL', id: 'pixel_pitch', label: 'Pixel pitch', type: 'NUMBER', unit: 'mm' });
    expect((await get()).questions.some((q: { scopeCode: string }) => q.scopeCode === 'LED_WALL')).toBe(true);
    const gone = await del('/media/LED_WALL');
    expect(gone.status).toBe(200);
    expect(gone.body.data).toMatchObject({ deleted: 'LED_WALL', questionsDeleted: 1 });
    expect((await get()).questions.some((q: { scopeCode: string }) => q.scopeCode === 'LED_WALL')).toBe(false);

    expect((await saveBoards([board({ mediaCode: 'GSB' })])).status).toBe(200);
    const used = await del('/media/GSB');
    expect(used.status).toBe(409);
    expect(used.body.error.message).toMatch(/used by 1 board.*inactive/i);
    expect((await get()).media.some((m: { code: string }) => m.code === 'GSB')).toBe(true);
  });
});

describe('installation types', () => {
  it('adds one and offers it on a media type', async () => {
    const res = await post('/installations', { code: 'parapet', name: 'Parapet Wall', description: 'On the terrace parapet', icon: 'roofing_outlined' });
    expect(res.status).toBe(201);
    expect((await post('/installations', { code: 'parapet', name: 'Again' })).status).toBe(409);
    expect((await post('/installations', { code: 'Bad Code', name: 'x' })).status).toBe(422);
    const renamed = await put('/installations/parapet', { name: 'Parapet' });
    expect(renamed.body.data).toMatchObject({ name: 'Parapet', description: 'On the terrace parapet', icon: 'roofing_outlined', active: true }); // description and icon untouched
    await put('/installations/parapet', { name: 'Parapet Wall' });
    expect((await put('/media/NLB', { installations: ['shop_fascia', 'parapet'] })).body.data.installations).toEqual(['shop_fascia', 'parapet']);
  });

  it('deleting one takes it off every media type and deletes its questions; an installation used by a board stays', async () => {
    await post('/questions', { scope: 'INSTALLATION', scopeCode: 'parapet', id: 'parapet_height', label: 'Parapet height', type: 'NUMBER', unit: 'ft' });
    const gone = await del('/installations/parapet');
    expect(gone.status).toBe(200);
    expect(gone.body.data).toMatchObject({ removedFromMedia: 1, questionsDeleted: 1 });
    const d = await get();
    expect(d.media.find((m: { code: string }) => m.code === 'NLB').installations).toEqual(['shop_fascia']);
    expect(d.installations.some((i: { code: string }) => i.code === 'parapet')).toBe(false);

    expect((await saveBoards([board({ mediaCode: 'GSB', installationType: 'rooftop' })])).status).toBe(200);
    const used = await del('/installations/rooftop');
    expect(used.status).toBe(409);
    expect(used.body.error.message).toMatch(/used by 1 board/i);
  });
});

describe('site questions', () => {
  const q = (extra: Record<string, unknown> = {}) => ({ scope: 'COMMON', id: 'site_note', label: 'Anything else on site?', type: 'TEXT', ...extra });

  it('adds a choice, number, yes/no and text question to a group, in order', async () => {
    expect((await post('/questions', { scope: 'MEDIA', scopeCode: 'GSB', id: 'led_colour', label: 'LED colour', type: 'CHOICE', options: ['White', 'Warm white', 'RGB'], required: false })).status).toBe(201);
    expect((await post('/questions', { scope: 'MEDIA', scopeCode: 'GSB', id: 'led_count', label: 'LED modules', type: 'NUMBER', unit: 'nos' })).status).toBe(201);
    const res = await post('/questions', { scope: 'MEDIA', scopeCode: 'GSB', id: 'led_dimmer', label: 'Dimmer needed?', type: 'YES_NO', showIfId: 'led_count', showIfValue: 12 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ showIfId: 'led_count', showIfValue: 12, required: true, active: true });
    const mine = (await get()).questions.filter((x: { scope: string; scopeCode: string; id: string }) => x.scope === 'MEDIA' && x.scopeCode === 'GSB' && x.id.startsWith('led_'));
    expect(mine.map((x: { id: string }) => x.id)).toEqual(['led_colour', 'led_count', 'led_dimmer']);
    expect(mine[0].options).toEqual(['White', 'Warm white', 'RGB']);
  });

  it('keeps the rules of each type', async () => {
    expect((await post('/questions', q({ type: 'CHOICE', options: ['Only one'] }))).status).toBe(422);
    expect((await post('/questions', q({ type: 'CHOICE', options: ['A', 'A'] }))).status).toBe(422);
    expect((await post('/questions', q({ type: 'NUMBER', options: ['A', 'B'] }))).status).toBe(422);
    expect((await post('/questions', q({ type: 'TEXT', unit: 'ft' }))).status).toBe(422);
    expect((await post('/questions', q({ showIfId: 'site_note', showIfValue: true }))).status).toBe(422); // depends on itself
    expect((await post('/questions', q({ showIfId: 'other_q' }))).status).toBe(422); // which answer?
    expect((await post('/questions', q({ scopeCode: 'GSB' }))).status).toBe(422); // for every board: no media
    expect((await post('/questions', q({ scope: 'MEDIA' }))).status).toBe(422); // which media?
    expect((await post('/questions', q({ id: 'Bad Key' }))).status).toBe(422);
    expect((await post('/questions', q({ label: '<b>x</b>' }))).status).toBe(422);
    expect((await post('/questions', q({ scope: 'MEDIA', scopeCode: 'NO_SUCH' }))).status).toBe(400);
    expect((await post('/questions', q({ scope: 'INSTALLATION', scopeCode: 'nope' }))).status).toBe(400);
    expect((await post('/questions', q({ scope: 'MEDIA', scopeCode: 'GSB', id: 'led_colour', type: 'TEXT' }))).status).toBe(409); // key already used in this group
  });

  it('edits a question; its scope, key and type cannot change; null clears a value', async () => {
    const created = (await post('/questions', q({ id: 'edit_me', label: 'Old label', hint: 'A hint', options: [], type: 'TEXT' }))).body.data;
    const res = await put(`/questions/${created.uid}`, { label: 'New label', hint: null, required: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ label: 'New label', hint: null, required: false, type: 'TEXT', id: 'edit_me' });
    expect((await put(`/questions/${created.uid}`, { type: 'NUMBER' })).status).toBe(422);
    expect((await put(`/questions/${created.uid}`, { id: 'renamed' })).status).toBe(422);
    expect((await put(`/questions/${created.uid}`, { scope: 'MEDIA' })).status).toBe(422);
    expect((await put(`/questions/${created.uid}`, { options: ['A', 'B'] })).status).toBe(422); // a text question has no options
    expect((await put('/questions/000000000000000000000001', { label: 'Nope' })).status).toBe(404);
    expect((await put('/questions/not-an-id', { label: 'Nope' })).status).toBe(422);
  });

  it('deletes a question', async () => {
    const created = (await post('/questions', q({ id: 'delete_me' }))).body.data;
    expect((await del(`/questions/${created.uid}`)).status).toBe(200);
    expect((await get()).questions.some((x: { id: string }) => x.id === 'delete_me')).toBe(false);
    expect((await del(`/questions/${created.uid}`)).status).toBe(404);
  });
});

describe('order and built-in defaults', () => {
  it('orders the questions of one group, and refuses a mix of groups', async () => {
    const d = await get();
    const gsb = d.questions.filter((x: { scope: string; scopeCode: string }) => x.scope === 'MEDIA' && x.scopeCode === 'GSB');
    const reversed = [...gsb].reverse().map((x: { uid: string }) => x.uid);
    const res = await post('/reorder', { kind: 'questions', ids: reversed });
    expect(res.status).toBe(200);
    const after = (await get()).questions.filter((x: { scope: string; scopeCode: string }) => x.scope === 'MEDIA' && x.scopeCode === 'GSB');
    expect(after.map((x: { uid: string }) => x.uid)).toEqual(reversed);
    const common = d.questions.find((x: { scope: string }) => x.scope === 'COMMON');
    expect((await post('/reorder', { kind: 'questions', ids: [gsb[0].uid, common.uid] })).status).toBe(400);
    expect((await post('/reorder', { kind: 'questions', ids: [gsb[0].uid, gsb[0].uid] })).status).toBe(400);
  });

  it('orders the media types and installation types', async () => {
    const codes = (await get()).media.filter((m: { legacy: boolean }) => !m.legacy).map((m: { code: string }) => m.code);
    const swapped = [codes[1], codes[0], ...codes.slice(2)];
    expect((await post('/reorder', { kind: 'media', ids: swapped })).status).toBe(200);
    expect((await get()).media.filter((m: { legacy: boolean }) => !m.legacy).map((m: { code: string }) => m.code).slice(0, 2)).toEqual([codes[1], codes[0]]);
    expect((await post('/reorder', { kind: 'media', ids: ['GSB', 'NOT_THERE'] })).status).toBe(404);
    const inst = (await get()).installations.map((i: { code: string }) => i.code);
    expect((await post('/reorder', { kind: 'installations', ids: [...inst].reverse() })).status).toBe(200);
    expect((await get()).installations.map((i: { code: string }) => i.code)).toEqual([...inst].reverse());
  });

  it('"load built-in defaults" brings back what was deleted and never overwrites an edit', async () => {
    const d = await get();
    const target = d.questions.find((x: { scope: string; id: string }) => x.scope === 'COMMON' && x.id === 'owner_permission');
    await put(`/questions/${d.questions.find((x: { scope: string; id: string }) => x.scope === 'COMMON' && x.id === 'access_method').uid}`, { label: 'My own wording' });
    await del(`/questions/${target.uid}`);
    expect((await get()).questions.some((x: { id: string }) => x.id === 'owner_permission')).toBe(false);
    const res = await post('/defaults', {});
    expect(res.status).toBe(200);
    expect(res.body.data.questions).toBe(1);
    const after = await get();
    expect(after.questions.some((x: { id: string }) => x.id === 'owner_permission')).toBe(true);
    expect(after.questions.find((x: { id: string }) => x.id === 'access_method').label).toBe('My own wording');
  });
});

describe('what a board keeps', () => {
  it('stores the media code, the installation and the answers on the board, and shows them back', async () => {
    const res = await saveBoards([board({ mediaCode: 'GSB', installationType: 'shop_fascia', answers: { fascia_material: 'Concrete', shutter_height: 9.5, existing_board: true, note: ' text ' } })]);
    expect(res.status).toBe(200);
    expect(res.body.data.mediaItems[0]).toMatchObject({ mediaCode: 'GSB', installationType: 'shop_fascia', answers: { fascia_material: 'Concrete', shutter_height: 9.5, existing_board: true, note: 'text' } });
    const again = (await api().get(`/api/v1/recce/shops/${siteId}`).set(as(vendor))).body.data.mediaItems[0];
    expect(again.answers.shutter_height).toBe(9.5); // a number stays a number, a yes stays a yes
    expect(again.answers.existing_board).toBe(true);
  });

  it('an older board (none of these fields) shows them empty, and a save that leaves them out clears them', async () => {
    const res = await saveBoards([board()]);
    expect(res.status).toBe(200);
    expect(res.body.data.mediaItems[0]).toMatchObject({ mediaCode: null, installationType: null, answers: {} });
  });

  it('refuses an installation the catalog does not offer, one not offered for that media, and badly shaped answers', async () => {
    expect((await saveBoards([board({ mediaCode: 'GSB', installationType: 'nope' })])).status).toBe(400);
    expect((await saveBoards([board({ mediaCode: 'NO_SUCH', installationType: 'rooftop' })])).status).toBe(400);
    const notOffered = await saveBoards([board({ mediaCode: 'SSTANDEE', installationType: 'rooftop' })]);
    expect(notOffered.status).toBe(400);
    expect(notOffered.body.error.message).toMatch(/not offered for/i);
    expect((await saveBoards([board({ answers: { Bad_Key: 'x' } })])).status).toBe(422);
    expect((await saveBoards([board({ answers: { nested: { a: 1 } } })])).status).toBe(422);
    expect((await saveBoards([board({ answers: { long: 'x'.repeat(301) } })])).status).toBe(422);
    expect((await saveBoards([board({ answers: Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`q${i}`, 'x'])) })])).status).toBe(422);
  });

  it('an older draft that carries an installation since made inactive can still be saved as it is, but cannot be given a new one', async () => {
    expect((await saveBoards([board({ mediaCode: 'GSB', installationType: 'wall_mount' })])).status).toBe(200);
    expect((await put('/installations/wall_mount', { active: false })).status).toBe(200);
    expect((await saveBoards([board({ mediaCode: 'GSB', installationType: 'wall_mount', width: 7 })])).status).toBe(200); // unchanged code
    expect((await saveBoards([board({ mediaCode: 'GSB', installationType: 'single_pole' })])).status).toBe(200); // another active one
    expect((await saveBoards([board({ mediaCode: 'GSB', installationType: 'wall_mount' })])).status).toBe(400); // choosing the inactive one again
    await put('/installations/wall_mount', { active: true });
  });

  it('counts the boards that use each media type and installation', async () => {
    expect((await saveBoards([board({ mediaCode: 'GSB', installationType: 'shop_fascia' }), board({ key: 'b2', seq: 2, mediaCode: 'GSB', installationType: 'shop_fascia' }), { key: 'b3', name: 'Non-Lit Board', mediaType: 'NLB', seq: 1, quantity: 1, width: 3, height: 2, unit: 'FT' }])).status).toBe(200);
    const usage = (await api().get('/api/v1/catalog/usage').set(as(admin))).body.data;
    expect(usage.media.GSB).toBe(2); // by its code
    expect(usage.media.NLB).toBe(1); // an older board is found by its name
    expect(usage.installations.shop_fascia).toBe(2);
  });
});
