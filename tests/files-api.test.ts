import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root: string;
const tokens: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
let projectId = '';
let projectCode = '';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const XLSX = Buffer.concat([Buffer.from('PK'), Buffer.alloc(100, 2)]);
const listDir = (p: string) => (fs.existsSync(p) ? fs.readdirSync(p) : []);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-api-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  process.env.MAX_IMAGE_SIZE = '1000';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  for (const role of ['BD', 'FINANCE', 'RECCE_EXECUTIVE']) {
    await User.create({ name: role, email: `${role.toLowerCase()}@t.com`, role: role as 'BD', passwordHash: await hashPassword('Passw0rd!x') });
    tokens[role] = (await api().post('/api/v1/auth/login').send({ email: `${role.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const c = await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Coca Cola', code: 'COCA' });
  const p = await api().post('/api/v1/projects').set(as('BD')).send({ clientId: c.body.data._id, campaign: 'Files', requirement: { source: 'EMAIL', siteDataScenario: 'CLIENT_PROVIDED' } });
  projectId = p.body.data._id;
  projectCode = p.body.data.code;
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (role: string | null, category: string, file: { name: string; data: Buffer; type?: string }) => {
  const r = api().post(`/api/v1/projects/${projectId}/files`);
  if (role) r.set(as(role));
  return r.field('category', category).attach('files', file.data, { filename: file.name, contentType: file.type ?? 'application/octet-stream' });
};

describe('BD client documents', () => {
  let id = '';
  it('stores the Excel under BD/Client_Details/<client>/<project>', async () => {
    const res = await post('BD', 'BD_CLIENT_DETAILS', { name: 'Shop List.xlsx', data: XLSX });
    expect(res.status).toBe(201);
    id = res.body.data[0].id;
    const dir = path.join(root, 'BD', 'Client_Details', 'Coca_Cola', projectCode);
    const files = listDir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/_Shop_List\.xlsx$/);
    expect(fs.readFileSync(path.join(dir, files[0]!)).equals(XLSX)).toBe(true);
  });

  it('lists the file and opens it through a short-lived signed link', async () => {
    const list = await api().get(`/api/v1/projects/${projectId}/files?category=BD_CLIENT_DETAILS`).set(as('BD'));
    expect(list.body.data).toHaveLength(1);
    const u = await api().get(`/api/v1/files/${id}/url`).set(as('BD'));
    expect(u.status).toBe(200);
    const link = new URL(u.body.data.url);
    const ok = await api().get(link.pathname + link.search);
    expect(ok.status).toBe(200);
    const tampered = await api().get(link.pathname + link.search.replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(64)}`));
    expect(tampered.status).toBe(403);
  });

  it('erases the stored object when a normal document is deleted', async () => {
    const del = await api().delete(`/api/v1/files/${id}`).set(as('BD'));
    expect(del.body.data.removed).toBe('erased');
    expect(listDir(path.join(root, 'BD', 'Client_Details', 'Coca_Cola', projectCode))).toHaveLength(0);
    expect((await api().get(`/api/v1/files/${id}/url`).set(as('BD'))).status).toBe(404);
  });
});

describe('Recce images', () => {
  let id = '';
  it('stores originals under Recce/<client>/<project>/Images/Original', async () => {
    const res = await post('RECCE_EXECUTIVE', 'RECCE_IMAGE_ORIGINAL', { name: 'front.jpg', data: JPEG, type: 'image/jpeg' });
    expect(res.status).toBe(201);
    id = res.body.data[0].id;
    expect(listDir(path.join(root, 'Recce', 'Coca_Cola', projectCode, 'Images', 'Original'))).toHaveLength(1);
  });

  it('keeps the original object when evidence is deleted (soft delete only)', async () => {
    const del = await api().delete(`/api/v1/files/${id}`).set(as('RECCE_EXECUTIVE'));
    expect(del.body.data.removed).toBe('hidden');
    expect(listDir(path.join(root, 'Recce', 'Coca_Cola', projectCode, 'Images', 'Original'))).toHaveLength(1);
    const list = await api().get(`/api/v1/projects/${projectId}/files?category=RECCE_IMAGE_ORIGINAL`).set(as('BD'));
    expect(list.body.data).toHaveLength(0);
  });

  it('keeps edited photos separate from originals', async () => {
    const res = await post('RECCE_EXECUTIVE', 'RECCE_IMAGE_EDITED', { name: 'marked.png', data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(50)]), type: 'image/png' });
    expect(res.status).toBe(201);
    expect(listDir(path.join(root, 'Recce', 'Coca_Cola', projectCode, 'Images', 'Edited'))).toHaveLength(1);
  });
});

describe('guards', () => {
  it('requires login', async () => {
    expect((await post(null, 'BD_CLIENT_DETAILS', { name: 'a.xlsx', data: XLSX })).status).toBe(401);
  });

  it('enforces who may write to each category', async () => {
    expect((await post('RECCE_EXECUTIVE', 'BD_CLIENT_DETAILS', { name: 'a.xlsx', data: XLSX })).status).toBe(403);
    expect((await post('BD', 'RECCE_IMAGE_ORIGINAL', { name: 'a.jpg', data: JPEG })).status).toBe(403);
    expect((await post('FINANCE', 'BD_CLIENT_DETAILS', { name: 'a.xlsx', data: XLSX })).status).toBe(403);
  });

  it('limits who can read each category (Finance sees expenses, not recce photos or BD documents it did not need)', async () => {
    const photo = await post('RECCE_EXECUTIVE', 'RECCE_IMAGE_ORIGINAL', { name: 'guard.jpg', data: JPEG, type: 'image/jpeg' });
    const photoId = photo.body.data[0].id;
    expect((await api().get(`/api/v1/projects/${projectId}/files?category=RECCE_IMAGE_ORIGINAL`).set(as('FINANCE'))).status).toBe(403);
    expect((await api().get(`/api/v1/files/${photoId}/url`).set(as('FINANCE'))).status).toBe(403);
    const all = await api().get(`/api/v1/projects/${projectId}/files`).set(as('FINANCE'));
    expect(all.status).toBe(200);
    expect(all.body.data.every((f: { category: string }) => f.category !== 'RECCE_IMAGE_ORIGINAL')).toBe(true);
    // Recce staff cannot read BD client documents either.
    expect((await api().get(`/api/v1/projects/${projectId}/files?category=BD_CLIENT_DETAILS`).set(as('RECCE_EXECUTIVE'))).status).toBe(403);
    expect((await api().get(`/api/v1/files/${photoId}/url`).set(as('RECCE_EXECUTIVE'))).status).toBe(200);
  });

  it('rejects wrong types, spoofed content, unknown categories and oversize images', async () => {
    expect((await post('BD', 'BD_CLIENT_DETAILS', { name: 'run.exe', data: XLSX })).status).toBe(400);
    expect((await post('BD', 'BD_CLIENT_DETAILS', { name: 'fake.jpg', data: XLSX })).status).toBe(400);
    expect((await post('RECCE_EXECUTIVE', 'RECCE_IMAGE_ORIGINAL', { name: 'sheet.xlsx', data: XLSX })).status).toBe(400);
    expect((await post('BD', '../../hack', { name: 'a.xlsx', data: XLSX })).status).toBe(422);
    const big = await post('RECCE_EXECUTIVE', 'RECCE_IMAGE_ORIGINAL', { name: 'big.jpg', data: Buffer.concat([JPEG, Buffer.alloc(2000)]), type: 'image/jpeg' });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('returns 404 for an unknown project and never writes a file for it', async () => {
    const before = fs.readdirSync(root).length;
    const res = await api()
      .post('/api/v1/projects/64b000000000000000000000/files')
      .set(as('BD'))
      .field('category', 'BD_CLIENT_DETAILS')
      .attach('files', XLSX, { filename: 'a.xlsx' });
    expect(res.status).toBe(404);
    expect(fs.readdirSync(root).length).toBe(before);
  });
});

describe('opening and downloading a file', () => {
  const NAMES = ['Client Brief (final) v2.xlsx', 'அறிக்கை ஆவணம்.xlsx'];
  const ids: string[] = [];

  it('keeps the original name, including spaces, brackets and non-English characters', async () => {
    for (const [i, name] of NAMES.entries()) {
      const res = await post('BD', 'BD_CLIENT_DETAILS', { name, data: Buffer.concat([Buffer.from('PK'), Buffer.alloc(60, 100 + i)]) });
      expect(res.status).toBe(201);
      expect(res.body.data[0].originalName).toBe(name);
      ids.push(res.body.data[0].id);
    }
  });

  it('serves a download under the ORIGINAL name, not the stored time-stamped one', async () => {
    for (const [i, name] of NAMES.entries()) {
      const u = await api().get(`/api/v1/files/${ids[i]}/url?disposition=attachment`).set(as('BD'));
      expect(u.body.data.url).toContain('dl=1');
      const link = new URL(u.body.data.url);
      const r = await api().get(link.pathname + link.search);
      expect(r.status).toBe(200);
      const cd = r.headers['content-disposition'] as string;
      expect(cd.startsWith('attachment;')).toBe(true);
      expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(cd)![1]!)).toBe(name); // exact original name
      expect(cd).not.toMatch(/\d{8}-\d{6}_/); // not the stored, time-stamped name
    }
  });

  it('opens inline by default so it can be previewed', async () => {
    const u = await api().get(`/api/v1/files/${ids[0]}/url`).set(as('BD'));
    expect(u.body.data.url).not.toContain('dl=1');
    const link = new URL(u.body.data.url);
    const r = await api().get(link.pathname + link.search);
    expect((r.headers['content-disposition'] as string).startsWith('inline;')).toBe(true);
  });

  it('allows the web app to show it in an <img> or <iframe> from another origin, and nobody else', async () => {
    const u = await api().get(`/api/v1/files/${ids[0]}/url`).set(as('BD'));
    const link = new URL(u.body.data.url);
    const r = await api().get(link.pathname + link.search);
    expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(r.headers['x-frame-options']).toBeUndefined();
    expect(r.headers['content-security-policy']).toMatch(/^frame-ancestors 'self'/);
    expect(r.headers['content-security-policy']).not.toContain('*');
    expect(r.headers['cache-control']).toContain('no-store');
  });

  it('rejects an unknown disposition and a hidden file\'s old link', async () => {
    expect((await api().get(`/api/v1/files/${ids[0]}/url?disposition=executable`).set(as('BD'))).status).toBe(422);
    const u = await api().get(`/api/v1/files/${ids[1]}/url?disposition=attachment`).set(as('BD'));
    const link = new URL(u.body.data.url);
    await api().delete(`/api/v1/files/${ids[1]}`).set(as('BD'));
    expect((await api().get(link.pathname + link.search)).status).toBe(403);
  });

  it('Spaces reports the full bucket path and URL to store; local reports none', async () => {
    const { SpacesStorage } = await import('../src/modules/files/storage');
    const s = new SpacesStorage({ bucket: 'adinn-space', prefix: 'signage', client: { send: async () => undefined } as never, baseUrl: 'https://adinn-space.sgp1.digitaloceanspaces.com/' });
    expect(s.locate('BD/Client_Details/AMUL/22070300/20261021_Brief one.png')).toEqual({
      path: 'signage/BD/Client_Details/AMUL/22070300/20261021_Brief one.png',
      url: 'https://adinn-space.sgp1.digitaloceanspaces.com/signage/BD/Client_Details/AMUL/22070300/20261021_Brief%20one.png',
    });
    const { getStorage } = await import('../src/modules/files/storage');
    expect(getStorage().locate).toBeUndefined(); // tests run on local storage
  });

  it('asks Spaces for the same header, so live downloads keep the original name too', async () => {
    const { SpacesStorage, contentDisposition } = await import('../src/modules/files/storage');
    const seen: unknown[][] = [];
    const s = new SpacesStorage({ bucket: 'b', prefix: 'signage', client: { send: async () => undefined } as never, signer: async (...a) => (seen.push(a), 'https://signed.example/x') });
    await s.signedUrl('BD/Client_Details/A/P/f.xlsx', 'Client Brief (final).xlsx', 600, 'attachment');
    await s.signedUrl('BD/Client_Details/A/P/f.xlsx', 'Client Brief (final).xlsx', 600);
    expect(seen[0]).toEqual(['signage/BD/Client_Details/A/P/f.xlsx', 'Client Brief (final).xlsx', 600, 'attachment']);
    expect(seen[1]![3]).toBe('inline');
    const cd = contentDisposition('attachment', 'Report "final" தமிழ்.xlsx');
    expect(cd).toContain('filename="Report _final_ _____.xlsx"'); // plain fallback, no quotes or non-ASCII
    expect(cd).toContain("filename*=UTF-8''Report%20%22final%22%20%E0%AE%A4"); // exact name for modern browsers
  });
});

describe('files grouped inside the project, and erased with it', () => {
  it('keeps each file in the project document under its CRM section, and removes it with the project', async () => {
    const { Project } = await import('../src/modules/projects/project.model');
    const c = await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Lisaa', code: 'LISAA' });
    const p = await api().post('/api/v1/projects').set(as('BD')).send({ clientId: c.body.data._id, campaign: 'To Delete', requirement: { source: 'EMAIL', siteDataScenario: 'CLIENT_PROVIDED' } });
    const id = p.body.data._id as string;
    const up = await api().post(`/api/v1/projects/${id}/files`).set(as('BD')).field('category', 'BD_CLIENT_DETAILS').attach('files', XLSX, { filename: 'Brief.xlsx' });
    expect(up.status).toBe(201);

    const doc = await Project.findById(id).select('files').lean();
    expect(doc?.files).toHaveLength(1);
    expect(doc!.files![0]).toMatchObject({ section: 'BD - Client Details', category: 'BD_CLIENT_DETAILS', originalName: 'Brief.xlsx' });
    const key = doc!.files![0]!.key as string;
    expect(fs.existsSync(path.join(root, key))).toBe(true);

    const del = await api().delete(`/api/v1/projects/${id}`).set(as('BD'));
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(root, key))).toBe(false); // gone from storage
    expect(fs.existsSync(path.join(root, path.dirname(key)))).toBe(false); // and its empty folder
    expect(await Project.countDocuments({ _id: id })).toBe(0); // the project itself is gone too
  });

  it('removes a single deleted file from the project array', async () => {
    const { Project } = await import('../src/modules/projects/project.model');
    const up = await post('BD', 'BD_CLIENT_DETAILS', { name: 'single.xlsx', data: Buffer.concat([Buffer.from('PK'), Buffer.alloc(100, 77)]) });
    const fid = up.body.data[0].id as string;
    expect((await Project.findById(projectId).select('files').lean())?.files?.some((f) => String(f._id) === fid)).toBe(true);
    expect((await api().delete(`/api/v1/files/${fid}`).set(as('BD'))).status).toBe(200);
    expect((await Project.findById(projectId).select('files').lean())?.files?.some((f) => String(f._id) === fid)).toBe(false);
  });
});

describe('file content for in-app previews', () => {
  it('streams the stored bytes to a signed-in user with access, and refuses everyone else', async () => {
    const up = await post('BD', 'BD_CLIENT_DETAILS', { name: 'preview.xlsx', data: Buffer.concat([Buffer.from('PK'), Buffer.alloc(100, 55)]) });
    const id = up.body.data[0].id as string;
    const r = await api().get(`/api/v1/files/${id}/content`).set(as('BD')).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect((r.body as Buffer).length).toBe(102);
    expect(r.headers['content-disposition']).toContain('preview.xlsx');
    expect((await api().get(`/api/v1/files/${id}/content`)).status).toBe(401);
  });
});

describe('files nobody records are swept away', () => {
  it('erases stored files with no project record, keeps recorded ones, and skips brand-new files', async () => {
    const { sweepOrphans } = await import('../src/modules/files/orphans');
    const up = await post('BD', 'BD_CLIENT_DETAILS', { name: 'recorded.xlsx', data: Buffer.concat([Buffer.from('PK'), Buffer.alloc(100, 91)]) });
    expect(up.status).toBe(201);
    const stray = path.join(root, 'BD/Client_Details/Gone/9999');
    fs.mkdirSync(stray, { recursive: true });
    const strayFile = path.join(stray, 'left-behind.xlsx');
    fs.writeFileSync(strayFile, 'x');

    expect(await sweepOrphans({ apply: true, graceMs: 60_000 })).toEqual([]); // too new, so left alone
    expect(fs.existsSync(strayFile)).toBe(true);

    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(strayFile, old, old);
    const found = await sweepOrphans({ apply: true, graceMs: 60_000 });
    expect(found).toEqual(['BD/Client_Details/Gone/9999/left-behind.xlsx']);
    expect(fs.existsSync(strayFile)).toBe(false);
    expect(fs.existsSync(stray)).toBe(false); // and its empty folder
    expect((await api().get(`/api/v1/projects/${projectId}/files`).set(as('BD'))).body.data.some((f: { originalName: string }) => f.originalName === 'recorded.xlsx')).toBe(true);
  });
});

describe('each file is read from the place it was saved', () => {
  it('opens a local file whatever STORAGE_TYPE says, and a Spaces file from Spaces', async () => {
    const { Project } = await import('../src/modules/projects/project.model');
    const up = await post('BD', 'BD_CLIENT_DETAILS', { name: 'where.xlsx', data: Buffer.concat([Buffer.from('PK'), Buffer.alloc(100, 33)]) });
    const id = up.body.data[0].id as string;
    expect((await api().get(`/api/v1/files/${id}/url`).set(as('BD'))).body.data.url).toContain('/api/v1/files/raw');

    // Pretend it was saved to Spaces while this server has no Spaces settings.
    await Project.updateOne({ 'files._id': id }, { $set: { 'files.$.storage': 'space' } });
    const r = await api().get(`/api/v1/files/${id}/url`).set(as('BD'));
    // With Spaces settings it is a Spaces link; without them, a clear message. Either way it is never the local link.
    if (r.status === 200) expect(r.body.data.url).not.toContain('/api/v1/files/raw');
    else expect(r.body.error.message).toContain('Spaces is not configured');
    await Project.updateOne({ 'files._id': id }, { $set: { 'files.$.storage': 'local' } });
  });
});

describe('upload limits for the browser', () => {
  it('tells a signed-in user the size limits and allowed types', async () => {
    const r = await api().get('/api/v1/files/limits').set(as('BD'));
    expect(r.status).toBe(200);
    expect(r.body.data.maxImageBytes).toBe(1000); // this test file sets MAX_IMAGE_SIZE=1000
    expect(r.body.data.extensions).toContain('.xlsx');
    expect((await api().get('/api/v1/files/limits')).status).toBe(401);
  });
});
