import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import type { OutgoingMail } from '../src/modules/notifications/mail.service';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let setMailSender: (s: ((m: OutgoingMail) => Promise<void>) | undefined) => void;
let root: string;
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
const sent: OutgoingMail[] = [];
const PDF = Buffer.from('%PDF-1.4\n% test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
/** Legacy FileAsset rows: the model is gone, but no BD CRM file may leave one behind in the collection. */
const FileAsset = () => ({ countDocuments: async (q: object) => (await import('mongoose')).default.connection.db!.collection('fileassets').countDocuments(q) });

let seq = 0;
const company = (over: Record<string, unknown> = {}) => ({
  name: `Acme Retail ${++seq}`,
  email: `info${seq}@acme.example`,
  industry: 'Retail & FMCG',
  address: '123, Business Park, Andheri (E)',
  city: 'Mumbai',
  district: 'Mumbai Suburban',
  state: 'Maharashtra',
  pincode: '400069',
  contacts: [
    { name: 'Rohan Mehta', designation: 'Business Head', phone: `98765${String(43210 + seq).slice(-5)}`, email: `rohan${seq}@acme.example`, isPrimary: true },
    { name: 'Priya Shah', designation: 'Purchase Head', phone: `91234${String(56789 - seq).slice(-5)}`, email: `priya${seq}@acme.example` },
  ],
  ...over,
});
const register = (over: Record<string, unknown> = {}, role = 'BD') => api().post('/api/v1/sales/orders/new-client').set(as(role)).send(company(over));
const move = (id: string, stage: string) => api().post(`/api/v1/sales/orders/${id}/stage`).set(as('BD')).send({ stage });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-bdcrm-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  setMailSender = (await import('../src/modules/notifications/mail.service')).setMailSenderForTests;
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  for (const [key, role] of [['BD', 'BD'], ['BD2', 'BD'], ['FINANCE', 'FINANCE'], ['OPERATIONS', 'OPERATIONS']] as const) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, phone: `98${String(10000000 + Object.keys(uid).length)}`, role, passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
});
afterAll(async () => {
  setMailSender(undefined);
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('client registration and orders', () => {
  it('creates the company, its contacts and one New Order card owned by the BD', async () => {
    const r = await register();
    expect(r.status).toBe(201);
    const { client, order } = r.body.data;
    expect(client.clientNo).toMatch(/^CLI-\d{4}$/);
    expect(client.code).toMatch(/^[A-Z0-9]{2,8}$/);
    expect(client.clientType).toBe('NEW');
    expect(client.contacts).toHaveLength(2);
    expect(client.contacts.filter((c: { isPrimary: boolean }) => c.isPrimary)).toHaveLength(1);
    expect(order.orderNo).toMatch(/^ORD-\d{4}-\d{4}$/);
    expect(order.stage).toBe('NEW_ORDER');
    expect(order.clientType).toBe('NEW');
    expect(order.owner._id).toBe(uid.BD);
    const board = await api().get('/api/v1/sales/orders/board').set(as('BD'));
    expect(board.body.data.columns[0].items.map((o: { _id: string }) => o._id)).toContain(order._id);
  });

  it('a repeated submission with the same request key returns the same order', async () => {
    const body = { ...company(), requestKey: 'form-session-123456' };
    const a = await api().post('/api/v1/sales/orders/new-client').set(as('BD')).send(body);
    const b = await api().post('/api/v1/sales/orders/new-client').set(as('BD')).send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.data.order._id).toBe(a.body.data.order._id);
  });

  it('rejects duplicate companies, missing contacts and invalid mobiles', async () => {
    const first = company();
    expect((await api().post('/api/v1/sales/orders/new-client').set(as('BD')).send(first)).status).toBe(201);
    const dup = await api().post('/api/v1/sales/orders/new-client').set(as('BD')).send({ ...first, name: first.name.toUpperCase(), email: 'other@x.example' });
    expect(dup.status).toBe(409);
    expect((await register({ contacts: [] })).status).toBe(422);
    const badPhone = await register({ contacts: [{ name: 'A', phone: '12345' }] });
    expect(badPhone.status).toBe(422);
    expect(JSON.stringify(badPhone.body.error.details)).toContain('10 digits');
    expect((await register({ email: 'not-an-email' })).status).toBe(422);
  });

  it('creates further orders for an existing client without duplicating it', async () => {
    const { client } = (await register()).body.data;
    const r = await api().post('/api/v1/sales/orders').set(as('BD')).send({ clientId: client._id });
    expect(r.status).toBe(201);
    expect(r.body.data.order.clientType).toBe('EXISTING');
    const again = await api().post('/api/v1/sales/orders').set(as('BD')).send({ clientId: client._id });
    expect(again.body.data.order._id).not.toBe(r.body.data.order._id);
    const detail = await api().get(`/api/v1/clients/${client._id}`).set(as('BD'));
    expect(detail.body.data.orderCount).toBe(3);
    expect(detail.body.data.clientType).toBe('EXISTING');
    expect(detail.body.data.createdBy.name).toBe('BD');
    const list = await api().get(`/api/v1/clients?q=${encodeURIComponent(client.name)}`).set(as('BD'));
    expect(list.body.meta.total).toBe(1);
  });

  it('summary counts come from the database and search finds contacts', async () => {
    const s = await api().get('/api/v1/clients/summary').set(as('BD'));
    expect(s.status).toBe(200);
    expect(s.body.data.newClientOrders).toBeGreaterThan(0);
    expect(s.body.data.existingClientOrders).toBeGreaterThan(0);
    const byContact = await api().get('/api/v1/clients?q=Priya&clientType=NEW').set(as('BD'));
    expect(byContact.status).toBe(200);
    for (const c of byContact.body.data) expect(c.clientType).toBe('NEW');
  });

  it('keeps the sales pipeline closed to roles without sales permissions', async () => {
    expect((await api().get('/api/v1/sales/orders/board').set(as('FINANCE'))).status).toBe(403);
    expect((await register({}, 'OPERATIONS')).status).toBe(403);
    expect((await api().get('/api/v1/email-templates/company-profile').set(as('FINANCE'))).status).toBe(403);
    expect((await api().post('/api/v1/rate-items').set(as('FINANCE')).send({ particulars: 'X', unit: 'UNIT', rate: 1 })).status).toBe(403);
  });
});

describe('kanban stages, comments and history', () => {
  it('moves forward one stage at a time and records pipeline history', async () => {
    const { order } = (await register()).body.data;
    expect((await move(order._id, 'RATE_CARD')).status).toBe(409);
    expect((await move(order._id, 'COMPANY_PROFILE')).body.data.stage).toBe('COMPANY_PROFILE');
    expect((await move(order._id, 'RATE_CARD')).body.data.stage).toBe('RATE_CARD');
    const blocked = await move(order._id, 'CLIENT_APPROVAL');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('Save the rate card');
    const h = await api().get(`/api/v1/sales/orders/${order._id}/history`).set(as('BD'));
    expect(h.body.data.map((x: { toStage: string }) => x.toStage)).toEqual(['RATE_CARD', 'COMPANY_PROFILE', 'NEW_ORDER']);
  });

  it('reassigns to another BD and filters the board by owner', async () => {
    const { order } = (await register()).body.data;
    const r = await api().patch(`/api/v1/sales/orders/${order._id}/owner`).set(as('BD')).send({ ownerId: uid.BD2 });
    expect(r.body.data.owner._id).toBe(uid.BD2);
    expect((await api().patch(`/api/v1/sales/orders/${order._id}/owner`).set(as('BD')).send({ ownerId: uid.FINANCE })).status).toBe(400);
    const board = await api().get(`/api/v1/sales/orders/board?ownerId=${uid.BD2}`).set(as('BD'));
    const ids = board.body.data.columns.flatMap((c: { items: { _id: string }[] }) => c.items.map((i) => i._id));
    expect(ids).toEqual([order._id]);
  });

  it('adds comments with attachments, latest first', async () => {
    const { order } = (await register()).body.data;
    expect((await api().post(`/api/v1/sales/orders/${order._id}/comments`).set(as('BD')).field('body', '')).status).toBe(422);
    await api().post(`/api/v1/sales/orders/${order._id}/comments`).set(as('BD')).field('body', 'First call done');
    const c2 = await api().post(`/api/v1/sales/orders/${order._id}/comments`).set(as('BD')).field('body', 'Brief received').attach('files', PDF, 'brief.pdf');
    expect(c2.status).toBe(201);
    expect(c2.body.data.attachments[0].name).toBe('brief.pdf');
    expect(c2.body.data.role).toBe('BD');
    const list = await api().get(`/api/v1/sales/orders/${order._id}/comments`).set(as('BD'));
    expect(list.body.data.map((c: { body: string }) => c.body)).toEqual(['Brief received', 'First call done']);
    const url = await api().get(`/api/v1/sales/orders/${order._id}/files/${c2.body.data.attachments[0].fileId}/url`).set(as('BD'));
    expect(url.status).toBe(200);
    expect(url.body.data.name).toBe('brief.pdf');
    // the open link serves the file (local storage)
    const link = new URL(url.body.data.url);
    expect((await api().get(link.pathname + link.search)).status).toBe(200);
  });

  it('keeps comment file details in the order, not in fileassets', async () => {
    const { order } = (await register()).body.data;
    const c = await api().post(`/api/v1/sales/orders/${order._id}/comments`).set(as('BD')).field('body', 'Site photos').attach('files', PDF, 'photos.pdf');
    const a = c.body.data.attachments[0];
    expect(a).toMatchObject({ name: 'photos.pdf', storage: 'local', kind: 'document', mimeType: 'application/pdf' });
    expect(a.key).toMatch(new RegExp(`^BD/Sales/.+/${order.orderNo}/Comments/`));
    expect(a.sha256).toHaveLength(64);
    expect(fs.existsSync(path.join(root, a.key))).toBe(true);
    expect(await FileAsset().countDocuments({ order: order._id })).toBe(0);
  });

  it('deleting a comment or one of its files erases the file from storage', async () => {
    const { order } = (await register()).body.data;
    const base = `/api/v1/sales/orders/${order._id}/comments`;
    const c = await api().post(base).set(as('BD')).field('body', 'Two files').attach('files', PDF, 'a.pdf').attach('files', Buffer.concat([PDF, Buffer.from('b')]), 'b.pdf');
    const [a, b] = c.body.data.attachments;
    // only the author may delete
    expect((await api().delete(`${base}/${c.body.data._id}`).set(as('BD2'))).status).toBe(403);
    expect((await api().delete(`${base}/${c.body.data._id}/attachments/${a.fileId}`).set(as('BD2'))).status).toBe(403);

    const one = await api().delete(`${base}/${c.body.data._id}/attachments/${a.fileId}`).set(as('BD'));
    expect(one.status).toBe(200);
    expect(one.body.data.attachments.map((x: { name: string }) => x.name)).toEqual(['b.pdf']);
    expect(fs.existsSync(path.join(root, a.key))).toBe(false);
    expect(fs.existsSync(path.join(root, b.key))).toBe(true);
    expect((await api().get(`/api/v1/sales/orders/${order._id}/files/${a.fileId}/url`).set(as('BD'))).status).toBe(404);

    const del = await api().delete(`${base}/${c.body.data._id}`).set(as('BD'));
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(root, b.key))).toBe(false);
    expect((await api().get(base).set(as('BD'))).body.data).toHaveLength(0);
    expect((await api().delete(`${base}/${c.body.data._id}`).set(as('BD'))).status).toBe(404);

    // a file-only comment disappears with its last file
    const f = await api().post(base).set(as('BD')).attach('files', Buffer.concat([PDF, Buffer.from('c')]), 'c.pdf');
    const gone = await api().delete(`${base}/${f.body.data._id}/attachments/${f.body.data.attachments[0].fileId}`).set(as('BD'));
    expect(gone.body.data).toBeNull();
    expect((await api().get(base).set(as('BD'))).body.data).toHaveLength(0);
  });
});

describe('company profile template and email', () => {
  it('loads, edits (sanitized), restores and tracks history of the template', async () => {
    const t = await api().get('/api/v1/email-templates/company-profile').set(as('BD'));
    expect(t.status).toBe(200);
    expect(t.body.data.name).toBe('Company Profile');
    const u = await api().put('/api/v1/email-templates/company-profile').set(as('BD')).send({ subject: 'Our profile for {{companyName}}', body: '<p onclick="x()">Hello <script>alert(1)</script><b>{{contactName}}</b></p>' });
    expect(u.status).toBe(200);
    expect(u.body.data.body).toBe('<p>Hello <b>{{contactName}}</b></p>');
    expect(u.body.data.version).toBe(2);
    expect((await api().put('/api/v1/email-templates/company-profile').set(as('BD')).send({ subject: '', body: '' })).status).toBe(422);
    const h = await api().get('/api/v1/email-templates/company-profile/history').set(as('BD'));
    expect(h.body.data.map((x: { field: string }) => x.field)).toEqual(expect.arrayContaining(['Email Subject', 'Email Content']));
    const r = await api().post('/api/v1/email-templates/company-profile/restore-default').set(as('BD'));
    expect(r.body.data.subject).toBe(r.body.data.defaultSubject);
    // keep the edited version for the send test below
    await api().put('/api/v1/email-templates/company-profile').set(as('BD')).send({ subject: 'Our profile for {{companyName}}', body: '<p>Hello {{contactName}}</p>' });
  });

  it('refuses to send without the PDF, then sends with the template PDF attached and keeps history', async () => {
    const { order, client } = (await register()).body.data;
    await move(order._id, 'COMPANY_PROFILE');
    const draft = await api().get(`/api/v1/sales/orders/${order._id}/company-profile/draft`).set(as('BD'));
    expect(draft.body.data.subject).toBe(`Our profile for ${client.name}`);
    expect(draft.body.data.body).toBe('<p>Hello Rohan Mehta</p>');
    expect(draft.body.data.to).toEqual([client.contacts[0].email]);
    const email = { to: draft.body.data.to, cc: ['boss@acme.example'], subject: draft.body.data.subject, body: '<p>Edited before sending</p>' };
    expect((await api().post(`/api/v1/sales/orders/${order._id}/company-profile/send`).set(as('BD')).send(email)).status).toBe(409);

    expect((await api().post('/api/v1/email-templates/company-profile/pdf').set(as('BD')).attach('files', Buffer.from('not a pdf'), 'profile.pdf')).status).toBe(400);
    const up = await api().post('/api/v1/email-templates/company-profile/pdf').set(as('BD')).attach('files', PDF, 'Company_Profile.pdf');
    expect(up.body.data.pdf.name).toBe('Company_Profile.pdf');

    // SMTP not configured: recorded honestly as SKIPPED
    const skipped = await api().post(`/api/v1/sales/orders/${order._id}/company-profile/send`).set(as('BD')).send(email);
    expect(skipped.status).toBe(201);
    expect(skipped.body.data.status).toBe('SKIPPED');

    setMailSender(async (m) => {
      sent.push(m);
    });
    const ok = await api().post(`/api/v1/sales/orders/${order._id}/company-profile/send`).set(as('BD')).send({ ...email, requestKey: 'send-key-0001' });
    const dupe = await api().post(`/api/v1/sales/orders/${order._id}/company-profile/send`).set(as('BD')).send({ ...email, requestKey: 'send-key-0001' });
    expect(ok.body.data.status).toBe('SENT');
    expect(dupe.body.data._id).toBe(ok.body.data._id);
    const mail = sent.at(-1)!;
    expect(mail.cc).toEqual(['boss@acme.example']);
    expect(mail.attachments?.[0]?.filename).toBe('Company_Profile.pdf');
    expect(mail.html).toContain('Edited before sending');

    // the master template is unchanged by the edited send, and history keeps the original attachment after replacing the PDF
    const t = await api().get('/api/v1/email-templates/company-profile').set(as('BD'));
    expect(t.body.data.body).toBe('<p>Hello {{contactName}}</p>');
    await api().post('/api/v1/email-templates/company-profile/pdf').set(as('BD')).attach('files', Buffer.concat([PDF, Buffer.from('v2')]), 'Profile_v2.pdf');
    const hist = await api().get(`/api/v1/sales/orders/${order._id}/emails?kind=COMPANY_PROFILE`).set(as('BD'));
    expect(hist.body.data).toHaveLength(2);
    expect(hist.body.data[0].attachments[0].name).toBe('Company_Profile.pdf');
    expect(hist.body.data[0].sentBy.name).toBe('BD');
    // the emailed PDF was replaced but stays in storage, so history and Resend still work
    expect(fs.existsSync(path.join(root, hist.body.data[0].attachments[0].key))).toBe(true);
    const resent = await api().post(`/api/v1/sales/emails/${hist.body.data[0]._id}/resend`).set(as('BD'));
    expect(resent.body.data.status).toBe('SENT');
    expect(sent.at(-1)!.attachments?.[0]?.filename).toBe('Company_Profile.pdf');
  });

  it('erases a template PDF that was never emailed when it is replaced or removed', async () => {
    const before = (await api().get('/api/v1/email-templates/company-profile').set(as('BD'))).body.data.pdf;
    const a = (await api().post('/api/v1/email-templates/company-profile/pdf').set(as('BD')).attach('files', Buffer.concat([PDF, Buffer.from('a')]), 'A.pdf')).body.data.pdf;
    expect(a).toMatchObject({ name: 'A.pdf', storage: 'local', kind: 'document' });
    expect(fs.existsSync(path.join(root, a.key))).toBe(true);
    expect(fs.existsSync(path.join(root, before.key))).toBe(false); // Profile_v2.pdf was never sent
    expect(await FileAsset().countDocuments({ category: 'TEMPLATE_COMPANY_PROFILE' })).toBe(0);
    const u = await api().get('/api/v1/email-templates/company-profile/pdf/url').set(as('BD'));
    expect(u.body.data.name).toBe('A.pdf');

    const b = (await api().post('/api/v1/email-templates/company-profile/pdf').set(as('BD')).attach('files', Buffer.concat([PDF, Buffer.from('b')]), 'B.pdf')).body.data.pdf;
    expect(fs.existsSync(path.join(root, a.key))).toBe(false);
    const removed = await api().delete('/api/v1/email-templates/company-profile/pdf').set(as('BD'));
    expect(removed.body.data.pdf).toBeNull();
    expect(fs.existsSync(path.join(root, b.key))).toBe(false);
    expect((await api().get('/api/v1/email-templates/company-profile/pdf/url').set(as('BD'))).status).toBe(404);
  });
});

describe('master rate card and quotation', () => {
  let items: { _id: string; particulars: string; unit: string; rate: number; specifications?: string }[] = [];

  it('seeds reference rates and supports CRUD with validation', async () => {
    const l = await api().get('/api/v1/rate-items?limit=100').set(as('BD'));
    expect(l.body.meta.total).toBeGreaterThanOrEqual(4);
    expect((await api().post('/api/v1/rate-items').set(as('BD')).send({ particulars: 'Pylon Sign', unit: 'UNIT', rate: 0 })).status).toBe(422);
    expect((await api().post('/api/v1/rate-items').set(as('BD')).send({ particulars: 'Pylon Sign', unit: 'MILES', rate: 10 })).status).toBe(422);
    const c = await api().post('/api/v1/rate-items').set(as('BD')).send({ particulars: 'Pylon Sign', specifications: 'MS frame with ACP', unit: 'UNIT', rate: 25000 });
    expect(c.status).toBe(201);
    expect((await api().post('/api/v1/rate-items').set(as('BD')).send({ particulars: 'pylon sign', specifications: 'MS frame with ACP', unit: 'UNIT', rate: 1 })).status).toBe(409);
    const u = await api().patch(`/api/v1/rate-items/${c.body.data._id}`).set(as('BD')).send({ rate: 26000, unit: 'RFT' });
    expect(u.body.data.rate).toBe(26000);
    items = (await api().get('/api/v1/rate-items?limit=100').set(as('BD'))).body.data;
  });

  it('saves revisions with PDFs, requires override reasons and never touches master rates', async () => {
    const { order } = (await register()).body.data;
    await move(order._id, 'COMPANY_PROFILE');
    const early = await api().get(`/api/v1/sales/orders/${order._id}/rate-card`).set(as('BD'));
    expect(early.body.data.editable).toBe(false);
    await move(order._id, 'RATE_CARD');
    const start = (await api().get(`/api/v1/sales/orders/${order._id}/rate-card`).set(as('BD'))).body.data;
    expect(start.editable).toBe(true);
    expect(start.latest).toBeNull();
    expect(start.draft.clientName).toBeTruthy();

    const [a, b] = items;
    const body = {
      clientAddress: start.draft.clientAddress,
      contact: start.draft.contact,
      quotationDate: '2026-10-10',
      subject: 'Signage Solutions for Retail Outlets',
      terms: start.draft.terms,
      regards: { name: 'Rahul Sharma', designation: 'Business Development Manager', mobile: '9820012345', email: 'rahul@adinn.example' },
      items: [
        { masterItemId: a!._id, particulars: a!.particulars, specifications: a!.specifications, unit: a!.unit, masterRate: a!.rate, quotedRate: a!.rate - 50 },
        { masterItemId: b!._id, particulars: b!.particulars, specifications: b!.specifications, unit: b!.unit, masterRate: b!.rate, quotedRate: b!.rate },
        { particulars: 'Custom Totem', unit: 'UNIT', quotedRate: 9000 },
      ],
    };
    const noReason = await api().put(`/api/v1/sales/orders/${order._id}/rate-card`).set(as('BD')).send(body);
    expect(noReason.status).toBe(422);
    expect(JSON.stringify(noReason.body.error.details)).toContain('items.0.overrideReason');

    body.items[0] = { ...body.items[0]!, overrideReason: 'Bulk order discount' } as never;
    const v1 = await api().put(`/api/v1/sales/orders/${order._id}/rate-card`).set(as('BD')).send(body);
    expect(v1.status).toBe(200);
    expect(v1.body.data.saved).toBe(true);
    expect(v1.body.data.revision.label).toBe('v1.0');
    expect(v1.body.data.revision.pdf.name).toMatch(/v1\.0\.pdf$/);

    const same = await api().put(`/api/v1/sales/orders/${order._id}/rate-card`).set(as('BD')).send(body);
    expect(same.body.data.saved).toBe(false);

    // master rate change does not alter the saved quotation
    await api().patch(`/api/v1/rate-items/${a!._id}`).set(as('BD')).send({ rate: a!.rate + 1000 });
    const after = (await api().get(`/api/v1/sales/orders/${order._id}/rate-card`).set(as('BD'))).body.data;
    expect(after.latest.items[0].masterRate).toBe(a!.rate);
    expect(after.latest.items[0].quotedRate).toBe(a!.rate - 50);

    body.items[1] = { ...body.items[1]!, quotedRate: b!.rate - 10, overrideReason: 'Long term client' } as never;
    body.items.pop();
    const v2 = await api().put(`/api/v1/sales/orders/${order._id}/rate-card`).set(as('BD')).send(body);
    expect(v2.body.data.revision.label).toBe('v1.1');
    const types = v2.body.data.revision.changes.map((c: { changeType: string }) => c.changeType);
    expect(types).toEqual(expect.arrayContaining(['UPDATED', 'REMOVED']));
    const all = (await api().get(`/api/v1/sales/orders/${order._id}/rate-card`).set(as('BD'))).body.data;
    expect(all.revisions.map((r: { label: string }) => r.label)).toEqual(['v1.1', 'v1.0']);
    expect(all.revisions[1].pdf.fileId).not.toBe(all.revisions[0].pdf.fileId);
    expect(all.revisions[0].pdf).toMatchObject({ storage: 'local', mimeType: 'application/pdf' });
    expect(fs.existsSync(path.join(root, all.revisions[1].pdf.key))).toBe(true);
    expect((await api().get(`/api/v1/sales/orders/${order._id}/files/${all.revisions[1].pdf.fileId}/url`).set(as('BD'))).status).toBe(200);

    // archive a master item that a quotation used: the quotation still loads
    expect((await api().delete(`/api/v1/rate-items/${b!._id}`).set(as('BD'))).body.data.archived).toBe(true);
    expect((await api().get(`/api/v1/sales/orders/${order._id}/rate-card`).set(as('BD'))).body.data.latest.items[1].particulars).toBe(b!.particulars);

    // send the current revision PDF
    setMailSender(async (m) => {
      sent.push(m);
    });
    const s = await api().post(`/api/v1/sales/orders/${order._id}/rate-card/send`).set(as('BD')).send({ to: ['client@acme.example'], subject: 'Rate card', body: all.emailDraft.body });
    expect(s.body.data.status).toBe('SENT');
    expect(s.body.data.rateCardRevision).toBe(2);
    expect(sent.at(-1)!.attachments?.[0]?.content.subarray(0, 4).toString()).toBe('%PDF');
    const re = await api().post(`/api/v1/sales/emails/${s.body.data._id}/resend`).set(as('BD'));
    expect(re.body.data.resentFrom).toBe(s.body.data._id);

    // and move on to approval
    expect((await move(order._id, 'CLIENT_APPROVAL')).body.data.stage).toBe('CLIENT_APPROVAL');
  });
});

describe('client approval proof', () => {
  const toApproval = async (existing: boolean) => {
    const reg = (await register()).body.data;
    const order = existing ? (await api().post('/api/v1/sales/orders').set(as('BD')).send({ clientId: reg.client._id })).body.data.order : reg.order;
    await move(order._id, 'COMPANY_PROFILE');
    await move(order._id, 'RATE_CARD');
    await api()
      .put(`/api/v1/sales/orders/${order._id}/rate-card`)
      .set(as('BD'))
      .send({
        contact: { name: 'Rohan Mehta' },
        quotationDate: '2026-10-10',
        subject: 'Signage',
        regards: { name: 'R', designation: 'BDM', mobile: '9820012345', email: 'r@adinn.example' },
        items: [{ particulars: 'Custom', unit: 'UNIT', quotedRate: 100 }],
      });
    await move(order._id, 'CLIENT_APPROVAL');
    return order._id as string;
  };
  const upload = (id: string, docType: string, extra: Record<string, string> = {}) => {
    let r = api().post(`/api/v1/sales/orders/${id}/approval/documents`).set(as('BD')).field('docType', docType).field('approvalDate', '2026-10-12');
    for (const [k, v] of Object.entries(extra)) r = r.field(k, v);
    return r.attach('files', Buffer.concat([PDF, Buffer.from(`${docType}${Math.random()}`)]), `${docType}.pdf`);
  };

  it('new client: needs a Purchase Order before completion', async () => {
    const id = await toApproval(false);
    const o = await api().get(`/api/v1/sales/orders/${id}/approval`).set(as('BD'));
    expect(o.body.data.latestRevision.label).toBe('v1.0');
    expect(o.body.data.missing[0]).toContain('Purchase Order');
    await upload(id, 'EMAIL_APPROVAL');
    const blocked = await api().post(`/api/v1/sales/orders/${id}/approval/complete`).set(as('BD'));
    expect(blocked.status).toBe(422);
    const po = await upload(id, 'PURCHASE_ORDER', { remarks: 'PO 4512' });
    expect(po.status).toBe(201);
    const replaced = await upload(id, 'PURCHASE_ORDER', { replacesId: po.body.data._id });
    expect(replaced.body.data.replaces).toBe(po.body.data._id);
    const ov = (await api().get(`/api/v1/sales/orders/${id}/approval`).set(as('BD'))).body.data;
    expect(ov.documents).toHaveLength(2);
    expect(ov.history).toHaveLength(3);
    const done = await api().post(`/api/v1/sales/orders/${id}/approval/complete`).set(as('BD'));
    expect(done.status).toBe(200);
    expect(done.body.data.order.approvalStatus).toBe('COMPLETED');
    expect((await upload(id, 'OTHER_WRITTEN')).status).toBe(409);
    const h = await api().get(`/api/v1/sales/orders/${id}/history`).set(as('BD'));
    expect(h.body.data[0].action).toBe('APPROVAL_COMPLETE');
  });

  it('existing client: any one written approval is enough', async () => {
    const id = await toApproval(true);
    expect((await api().post(`/api/v1/sales/orders/${id}/approval/complete`).set(as('BD'))).status).toBe(422);
    expect((await upload(id, 'WHATSAPP_APPROVAL')).status).toBe(201);
    expect((await api().post(`/api/v1/sales/orders/${id}/approval/complete`).set(as('BD'))).status).toBe(200);
  });

  it('deletes approval documents (erasing the file) only until approval is complete', async () => {
    const id = await toApproval(true);
    const first = (await upload(id, 'EMAIL_APPROVAL')).body.data;
    const second = (await upload(id, 'EMAIL_APPROVAL', { replacesId: first._id })).body.data;
    expect(first.file.key).toBeTruthy();
    expect(await FileAsset().countDocuments({ category: 'SALES_APPROVAL_PROOF' })).toBe(0);

    // deleting the replacement erases its file and brings the replaced document back
    const del = await api().delete(`/api/v1/sales/approval/documents/${second._id}`).set(as('BD'));
    expect(del.status).toBe(200);
    expect(del.body.data.documents.map((d: { _id: string }) => d._id)).toEqual([first._id]);
    expect(del.body.data.history).toHaveLength(1);
    expect(fs.existsSync(path.join(root, second.file.key))).toBe(false);
    expect(fs.existsSync(path.join(root, first.file.key))).toBe(true);
    expect((await api().delete(`/api/v1/sales/approval/documents/${second._id}`).set(as('BD'))).status).toBe(404);

    // once complete, the proof is locked
    expect((await api().post(`/api/v1/sales/orders/${id}/approval/complete`).set(as('BD'))).status).toBe(200);
    expect((await api().delete(`/api/v1/sales/approval/documents/${first._id}`).set(as('BD'))).status).toBe(409);
    expect(fs.existsSync(path.join(root, first.file.key))).toBe(true);
    expect((await api().get(`/api/v1/sales/orders/${id}/files/${first.file.fileId}/url`).set(as('BD'))).status).toBe(200);
  });

  it('deleting a client with no projects erases its orders and their files; with projects it is only hidden', async () => {
    const { order, client } = (await register()).body.data;
    const c = await api().post(`/api/v1/sales/orders/${order._id}/comments`).set(as('BD')).field('body', 'Brief').attach('files', PDF, 'brief.pdf');
    const key = c.body.data.attachments[0].key;
    expect(fs.existsSync(path.join(root, key))).toBe(true);
    expect((await api().delete(`/api/v1/clients/${client._id}`).set(as('BD'))).status).toBe(200);
    expect(fs.existsSync(path.join(root, key))).toBe(false);
    const { SalesOrder } = await import('../src/modules/sales/sales.model');
    const { Client } = await import('../src/modules/clients/client.model');
    expect(await SalesOrder.countDocuments({ client: client._id })).toBe(0);
    expect(await Client.countDocuments({ _id: client._id })).toBe(0);

    // a client that still has a project is hidden, and its orders stay
    const kept = (await register()).body.data;
    const { Project } = await import('../src/modules/projects/project.model');
    vi.spyOn(Project, 'exists').mockResolvedValueOnce({ _id: kept.client._id } as never);
    expect((await api().delete(`/api/v1/clients/${kept.client._id}`).set(as('BD'))).status).toBe(200);
    expect(await Client.countDocuments({ _id: kept.client._id, deletedAt: { $ne: null } })).toBe(1);
    expect(await SalesOrder.countDocuments({ client: kept.client._id })).toBe(1);
    vi.restoreAllMocks();
  });
});
