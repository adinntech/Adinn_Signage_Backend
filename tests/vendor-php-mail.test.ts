import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

// The PHP mail service is "configured" here; what would be POSTed to it is captured instead of sent.
const posted = vi.hoisted(() => ({ calls: [] as Record<string, any>[], fail: null as string | null }));
vi.mock('../src/modules/codeRequests/signageCodeMail', async (orig) => ({
  ...(await orig<typeof import('../src/modules/codeRequests/signageCodeMail')>()),
  signageMailAvailable: () => true,
  postSignageMail: async (payload: Record<string, any>) => {
    if (posted.fail) throw new Error(posted.fail);
    posted.calls.push(payload);
    return { status: 'success' };
  },
}));

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root = '';
const tokens: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
let n = 0;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-php-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  process.env.MAIL_FROM = 'Operations <ops@adinn.co.in>';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  for (const [key, role] of [['BD', 'BD'], ['OPS', 'OPERATIONS']] as const) {
    await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => { posted.calls.length = 0; posted.fail = null; });

const upload = (id: string, docType: string, name = `${docType}.png`) => api().post(`/api/v1/vendors/${id}/kyc-files`).set(as('OPS')).field('docType', docType).attach('files', png, { filename: name, contentType: 'image/png' });
async function vendor(extra: Record<string, unknown> = {}) {
  n++;
  const r = await api().post('/api/v1/vendors').set(as('OPS')).send({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', name: `PHP Mail Vendor ${n}`, mobile: `98765${String(10000 + n)}`, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { _id: string; code: string; name: string };
}
const mailBody = (over: Record<string, unknown> = {}) => ({ to: ['accounts@t.com'], cc: ['ops@t.com'], bcc: ['boss@t.com'], subject: 'Vendor Registration Request', body: '<p>Hi Team,</p><p>Please register <strong>this vendor</strong>.</p><script>alert(1)</script>', requestKey: `key-php-${++n}-${Date.now()}`, ...over });
const send = (id: string, body: Record<string, unknown>) => api().post(`/api/v1/vendors/${id}/registration-mail`).set(as('OPS')).send(body);

describe('vendor registration mail through the PHP mail service', () => {
  it('posts the vendor mailtype with every uploaded document as a labelled base64 file', async () => {
    const v = await vendor();
    for (const d of ['pan', 'bank', 'address']) expect((await upload(v._id, d, `${d}-scan.png`)).status, d).toBe(201);
    expect((await upload(v._id, 'other', 'agreement.png')).status).toBe(201);

    const res = await send(v._id, mailBody({ from: undefined }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(posted.calls).toHaveLength(1);
    const p = posted.calls[0]!;
    expect(p).toMatchObject({
      mailtype: 'vendor',
      toEmail: ['accounts@t.com'],
      ccEmail: ['ops@t.com'],
      bccEmail: ['boss@t.com'],
      subject: expect.stringMatching(/^Vendor Registration Request - Adn-Signage-VenReg-\d{8,}$/),
      requestId: expect.stringMatching(/^Adn-Signage-VenReg-\d{8,}$/),
      source: 'Operations Team',
      replyTo: 'ops@adinn.co.in', // "Name <address>" becomes the bare address
      vendor: { vendorName: v.name, vendorType: 'One-man / Freelancer', vendorCode: v.code },
    });
    expect(p.bodyHtml).toContain('<strong>this vendor</strong>');
    expect(p.bodyHtml).not.toMatch(/<script|alert/); // cleaned before it leaves the server
    const files = p.attachments as { filename: string; base64: string; label?: string }[];
    expect(files.map((f) => [f.filename, f.label]).sort()).toEqual([['address-scan.png', 'Address proof'], ['agreement.png', 'Other document'], ['bank-scan.png', 'Cancelled cheque'], ['pan-scan.png', 'PAN card']]);
    expect(files.every((f) => Buffer.from(f.base64, 'base64').equals(png))).toBe(true); // the real bytes, not names

    expect(res.body.data.history[0]).toMatchObject({ status: 'SENT', to: ['accounts@t.com'], cc: ['ops@t.com'], bcc: ['boss@t.com'], sentBy: 'OPS' });
    expect(res.body.data.history[0].attachmentNames.sort()).toEqual(['address-scan.png', 'agreement.png', 'bank-scan.png', 'pan-scan.png']);
    expect(res.body.data.registration.mailSentAt).toBeTruthy();
  });

  it('does not post twice for the same request key, and keeps the mail history of every send', async () => {
    const v = await vendor();
    await upload(v._id, 'pan');
    await upload(v._id, 'bank');
    const body = mailBody();
    await send(v._id, body);
    await send(v._id, body);
    expect(posted.calls).toHaveLength(1);
    await send(v._id, mailBody({ subject: 'Second try' }));
    expect(posted.calls).toHaveLength(2);
    const list = (await api().get(`/api/v1/vendors/${v._id}/registration-mail`).set(as('OPS'))).body.data.history;
    const subjects = list.map((h: { subject: string }) => h.subject);
    expect(subjects[0]).toMatch(/^Second try - Adn-Signage-VenReg-/);
    expect(subjects[1]).toMatch(/^Vendor Registration Request - Adn-Signage-VenReg-/);
    // Each real send takes its own ID; the repeated click did not use one.
    expect(new Set(list.map((h: { requestId: string }) => h.requestId)).size).toBe(2);
  });

  it('refuses before posting when a required document is missing', async () => {
    const v = await vendor();
    await upload(v._id, 'pan'); // bank proof missing
    const res = await send(v._id, mailBody());
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Cancelled cheque/);
    expect(posted.calls).toHaveLength(0);
  });

  it('needs the GST certificate for an organization', async () => {
    const v = await vendor({ type: 'ORGANIZATION', typeName: 'Organization', contactPerson: 'Murugan', gstin: '33AAGCA2094M1ZK' });
    await upload(v._id, 'pan');
    await upload(v._id, 'bank');
    expect((await send(v._id, mailBody())).body.error.message).toMatch(/GST certificate/);
    await upload(v._id, 'gst');
    expect((await send(v._id, mailBody())).status).toBe(201);
    expect(posted.calls[0]!.vendor.vendorType).toBe('Organization');
  });

  it('records FAILED (not sent) when the PHP service rejects it, keeps the draft, and a retry can succeed', async () => {
    const v = await vendor();
    await upload(v._id, 'pan');
    await upload(v._id, 'bank');
    await api().put(`/api/v1/vendors/${v._id}/registration-mail/draft`).set(as('OPS')).send({ to: ['accounts@t.com'], subject: 'My draft', body: '<p>draft text</p>' });

    posted.fail = 'Signage mail API could not be reached: ECONNREFUSED';
    const bad = await send(v._id, mailBody());
    expect(bad.status).toBe(201);
    expect(bad.body.data.history[0]).toMatchObject({ status: 'FAILED', error: expect.stringContaining('ECONNREFUSED') });
    expect(bad.body.data.registration?.mailSentAt).toBeFalsy(); // a failed mail does not move the vendor on
    expect(bad.body.data.draft).toMatchObject({ subject: 'My draft' }); // and the draft is kept

    posted.fail = null;
    const good = await send(v._id, mailBody());
    expect(good.body.data.history[0].status).toBe('SENT');
    expect(good.body.data.registration.mailSentAt).toBeTruthy();
    expect(good.body.data.draft).toBeNull();
  });

  it('refuses more than 8 documents with a clear message and posts nothing', async () => {
    const v = await vendor();
    for (const d of ['pan', 'bank', 'address', 'gst']) for (let i = 0; i < 2; i++) await upload(v._id, d, `${d}${i}.png`);
    await upload(v._id, 'other', 'o1.png');
    const res = await send(v._id, mailBody());
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/At most 8 documents/);
    expect(posted.calls).toHaveLength(0);
  });

  it('is for Operations only', async () => {
    const v = await vendor();
    expect((await api().post(`/api/v1/vendors/${v._id}/registration-mail`).set(as('BD')).send(mailBody())).status).toBe(403);
  });
});
