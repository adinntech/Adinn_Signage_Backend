import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
const tokens: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);

async function sheet(rows: (string | undefined)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Contacts');
  ws.addRows([['Name', 'Email', 'Group'], ...rows]);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-contacts-'));
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  for (const [key, role] of [['ADMIN', 'SUPER_ADMIN'], ['CS', 'CLIENT_SERVICING']] as const) {
    await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

describe('mail address book', () => {
  it('only the admin manages it, but any signed-in user gets suggestions', async () => {
    expect((await api().get('/api/v1/mail-contacts').set(as('CS'))).status).toBe(403);
    expect((await api().post('/api/v1/mail-contacts').set(as('CS')).send({ email: 'a@b.com' })).status).toBe(403);
    expect((await api().get('/api/v1/mail-contacts/suggest?q=re').set(as('CS'))).status).toBe(200);
    expect((await api().get('/api/v1/mail-contacts/suggest?q=re')).status).toBe(401);
  });

  it('imports an Excel sheet: adds, updates, skips bad and repeated rows, keeps names on blank cells', async () => {
    const first = await sheet([
      ['React developer', 'reactder@adinn.co.in', 'IT'],
      ['SM', 'SM@adinn.co.in', 'Signage'],
      ['Full stack', 'fullstack@adinn.co.in', 'IT'],
      ['Broken', 'not-an-email', ''],
      ['Again', 'sm@adinn.co.in', ''],
    ]);
    const res = await api().post('/api/v1/mail-contacts/import').set(as('ADMIN')).attach('file', first, 'contacts.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ added: 3, updated: 0 });
    expect(res.body.data.skipped.map((s: { reason: string }) => s.reason).sort()).toEqual(['Not a valid email address', 'Repeated in the file']);

    const again = await sheet([[undefined, 'reactder@adinn.co.in', undefined], ['New', 'new@adinn.co.in', 'Ops']]);
    const r2 = await api().post('/api/v1/mail-contacts/import').set(as('ADMIN')).attach('file', again, 'contacts.xlsx');
    expect(r2.body.data).toMatchObject({ added: 1, updated: 1 });
    const kept = (await api().get('/api/v1/mail-contacts?q=reactder').set(as('ADMIN'))).body.data[0];
    expect(kept).toMatchObject({ name: 'React developer', group: 'IT' });
  });

  it('imports the staff sheet (S.No, NAME, Email Address, Status) and importing it again edits instead of duplicating', async () => {
    const make = async (rows: (string | number)[][]) => {
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet('Staff').addRows([['S.No', 'NAME', 'Email Address', 'Status'], ...rows]);
      return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    };
    const post = async (buf: Buffer) => api().post('/api/v1/mail-contacts/import').set(as('ADMIN')).attach('file', buf, 'staff.xlsx');
    const one = await post(await make([[1, 'Abhishek Shukla', 'agmdelhi@adinn.co.in', 'Active'], [2, 'Anand R', 'salesmdu1@adinn.co.in', 'Active']]));
    expect(one.body, JSON.stringify(one.body)).toHaveProperty('data');
    expect(one.body.data).toMatchObject({ added: 2, updated: 0 });
    const two = await post(await make([[1, 'Abhishek S', 'AGMDELHI@adinn.co.in', 'Inactive'], [2, 'Anand R', 'salesmdu1@adinn.co.in', 'Active']]));
    expect(two.body.data).toMatchObject({ added: 0, updated: 2 });
    const all = (await api().get('/api/v1/mail-contacts?q=adinn.co.in&limit=100').set(as('ADMIN'))).body.data as { email: string; name: string; active: boolean }[];
    expect(all.filter((c) => c.email === 'agmdelhi@adinn.co.in')).toHaveLength(1);
    expect(all.find((c) => c.email === 'agmdelhi@adinn.co.in')).toMatchObject({ name: 'Abhishek S', active: false });
    expect(all.find((c) => c.email === 'salesmdu1@adinn.co.in')).toMatchObject({ active: true });
  });

  it('filters by status and group, sorts ascending or descending, and changes or deletes many at once', async () => {
    const buf = await sheet([['Zed', 'bulk-z@x.in', 'Ops'], ['Amy', 'bulk-a@x.in', 'Ops'], ['Mia', 'bulk-m@x.in', 'Sales'], ['Nobody', 'bulk-n@x.in', '']]);
    await api().post('/api/v1/mail-contacts/import').set(as('ADMIN')).attach('file', buf, 'b.xlsx');
    const get = async (qs: string) => (await api().get(`/api/v1/mail-contacts?q=bulk-&${qs}`).set(as('ADMIN'))).body.data as { id: string; name: string; email: string; active: boolean }[];
    expect((await get('sort=name&dir=asc')).map((c) => c.name)).toEqual(['Amy', 'Mia', 'Nobody', 'Zed']);
    expect((await get('sort=name&dir=desc')).map((c) => c.name)).toEqual(['Zed', 'Nobody', 'Mia', 'Amy']);
    expect((await get('group=ops&sort=email')).map((c) => c.email)).toEqual(['bulk-a@x.in', 'bulk-z@x.in']);
    expect((await get('group=none')).map((c) => c.email)).toEqual(['bulk-n@x.in']);
    expect((await api().get('/api/v1/mail-contacts/groups').set(as('ADMIN'))).body.data).toEqual(expect.arrayContaining(['Ops', 'Sales']));

    const ops = await get('group=Ops');
    const off = await api().post('/api/v1/mail-contacts/bulk').set(as('ADMIN')).send({ action: 'deactivate', ids: ops.map((c) => c.id) });
    expect(off.body, JSON.stringify(off.body)).toHaveProperty('data');
    expect(off.body.data).toMatchObject({ matched: 2 });
    expect((await get('status=inactive')).map((c) => c.email).sort()).toEqual(['bulk-a@x.in', 'bulk-z@x.in']);
    expect((await get('status=active')).map((c) => c.email).sort()).toEqual(['bulk-m@x.in', 'bulk-n@x.in']);
    await api().post('/api/v1/mail-contacts/bulk').set(as('ADMIN')).send({ action: 'activate', filter: { q: 'bulk-', status: 'inactive' } });
    expect((await get('status=inactive'))).toHaveLength(0);
    await api().post('/api/v1/mail-contacts/bulk').set(as('ADMIN')).send({ action: 'group', filter: { q: 'bulk-', group: 'none' }, group: 'Misc' });
    expect((await get('group=Misc')).map((c) => c.email)).toEqual(['bulk-n@x.in']);
    expect((await api().post('/api/v1/mail-contacts/bulk').set(as('ADMIN')).send({ action: 'delete' })).status).toBe(422);
    const del = await api().post('/api/v1/mail-contacts/bulk').set(as('ADMIN')).send({ action: 'delete', filter: { q: 'bulk-' } });
    expect(del.body.data).toMatchObject({ matched: 4 });
    expect(await get('')).toHaveLength(0);
    expect((await api().post('/api/v1/mail-contacts/bulk').set(as('CS')).send({ action: 'delete', filter: { q: 'a' } })).status).toBe(403);
  });

  it('rejects a wrong file type and a sheet without an Email column', async () => {
    expect((await api().post('/api/v1/mail-contacts/import').set(as('ADMIN')).attach('file', Buffer.from('x'), 'a.pdf')).status).toBe(400);
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('S').addRows([['Name'], ['x']]);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect((await api().post('/api/v1/mail-contacts/import').set(as('ADMIN')).attach('file', buf, 'a.xlsx')).status).toBe(400);
  });

  it('suggests as the person types, like the Gmail box', async () => {
    const names = async (q: string) => (await api().get(`/api/v1/mail-contacts/suggest?q=${q}`).set(as('CS'))).body.data.map((c: { email: string }) => c.email);
    expect(await names('re')).toEqual(['reactder@adinn.co.in']);
    expect(await names('sm')).toEqual(['sm@adinn.co.in']);
    expect(await names('full')).toEqual(['fullstack@adinn.co.in']);
    expect(await names('React')).toEqual(['reactder@adinn.co.in']); // by name, any case
    expect((await names('')).length).toBeGreaterThanOrEqual(4);
    expect(await names('zzz')).toEqual([]);
    expect(await names('adinn')).toEqual([]); // matches the start of a word, not the middle of the domain
  });

  it('adds, edits, hides and deletes a contact; refuses a duplicate', async () => {
    const add = await api().post('/api/v1/mail-contacts').set(as('ADMIN')).send({ email: 'Project@Adinn.co.in', name: 'Project desk' });
    expect(add.status).toBe(201);
    expect(add.body.data).toMatchObject({ email: 'project@adinn.co.in', active: true });
    expect((await api().post('/api/v1/mail-contacts').set(as('ADMIN')).send({ email: 'project@adinn.co.in' })).status).toBe(409);
    expect((await api().post('/api/v1/mail-contacts').set(as('ADMIN')).send({ email: 'bad' })).status).toBe(422);
    const id = add.body.data.id;
    await api().put(`/api/v1/mail-contacts/${id}`).set(as('ADMIN')).send({ active: false });
    expect((await api().get('/api/v1/mail-contacts/suggest?q=proj').set(as('CS'))).body.data).toEqual([]); // inactive: not suggested
    expect((await api().delete(`/api/v1/mail-contacts/${id}`).set(as('ADMIN'))).status).toBe(200);
    expect((await api().delete(`/api/v1/mail-contacts/${id}`).set(as('ADMIN'))).status).toBe(404);
  });

  it('addresses saved in Mail settings join the book', async () => {
    await api().put('/api/v1/mail-settings/routing/VENDOR_REGISTRATION').set(as('ADMIN')).send({ to: ['srbe@adinn.co.in'], cc: [] });
    expect((await api().get('/api/v1/mail-contacts/suggest?q=srbe').set(as('CS'))).body.data[0].email).toBe('srbe@adinn.co.in');
  });

  it('serves a sample sheet', async () => {
    const res = await api().get('/api/v1/mail-contacts/sample').set(as('ADMIN'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });
});
