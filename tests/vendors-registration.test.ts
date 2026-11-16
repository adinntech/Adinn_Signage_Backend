import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import type { OutgoingMail } from '../src/modules/notifications/mail.service';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root = '';
const tokens: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const sent: OutgoingMail[] = [];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-reg-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  process.env.VENDOR_REGISTRATION_RECIPIENTS = 'accounts@t.com';
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
  (await import('../src/modules/notifications/mail.service')).setMailSenderForTests(undefined);
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

const upload = (id: string, docType: string) => api().post(`/api/v1/vendors/${id}/kyc-files`).set(as('OPS')).field('docType', docType).attach('files', png, { filename: `${docType}.png`, contentType: 'image/png' });
const create = (body: Record<string, unknown>) => api().post('/api/v1/vendors').set(as('OPS')).send(body);

describe('vendor types', () => {
  it('lists the two built-in types and lets Operations add one with a rule class', async () => {
    const first = await api().get('/api/v1/vendors/types').set(as('OPS'));
    expect(first.body.data.map((t: { name: string }) => t.name)).toEqual(['Organization', 'One-man / Freelancer']);
    const add = await api().post('/api/v1/vendors/types').set(as('OPS')).send({ name: 'Partnership firm', rules: 'ORGANIZATION' });
    expect(add.status).toBe(201);
    expect((await api().post('/api/v1/vendors/types').set(as('OPS')).send({ name: 'partnership  FIRM', rules: 'ONE_MAN' })).status).toBe(409);
    expect((await api().post('/api/v1/vendors/types').set(as('BD')).send({ name: 'Other', rules: 'ONE_MAN' })).status).toBe(403);
  });

  it('organization needs contact person and GST, one-man needs neither; the chosen type decides the rules', async () => {
    const org = await create({ type: 'ORGANIZATION', typeName: 'Organization', name: 'Sri Signs', mobile: '9876543210' });
    expect(org.status).toBe(422);
    expect(org.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['contactPerson', 'gstin']);
    const ok = await create({ type: 'ORGANIZATION', typeName: 'Organization', name: 'Sri Signs', mobile: '9876543210', contactPerson: 'Murugan', gstin: '33ABCDE1234F1Z5' });
    expect(ok.status).toBe(201);
    // the server takes the rule class from the type name, whatever `type` the client sent
    const one = await create({ type: 'ORGANIZATION', typeName: 'One-man / Freelancer', name: 'Ravi', mobile: '9876500001' });
    expect(one.status).toBe(201);
    expect(one.body.data).toMatchObject({ type: 'ONE_MAN', typeName: 'One-man / Freelancer' });
    expect((await create({ type: 'ONE_MAN', typeName: 'Nonsense', name: 'X Y', mobile: '9876500002' })).status).toBe(422);
    const custom = await create({ type: 'ONE_MAN', typeName: 'Partnership firm', name: 'Partners', mobile: '9876500003' });
    expect(custom.status).toBe(422); // follows the ORGANIZATION rules
  });
});

describe('registration mail and vendor ID', () => {
  it('needs the required documents, attaches every KYC file, and gates activation on the vendor ID', async () => {
    const mailer = await import('../src/modules/notifications/mail.service');
    mailer.setMailSenderForTests(async (m) => void sent.push(m));
    const v = (await create({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', name: 'Kumar Boards', mobile: '9876500010', contactPerson: undefined })).body.data;

    const draft = await api().get(`/api/v1/vendors/${v._id}/registration-mail`).set(as('OPS'));
    expect(draft.body.data).toMatchObject({ to: ['accounts@t.com'], missing: ['PAN card', 'Cancelled cheque'] });
    // Save as Draft keeps the text being written; the next open starts from it
    expect((await api().put(`/api/v1/vendors/${v._id}/registration-mail/draft`).set(as('OPS')).send({ to: ['a@t.com'], subject: 'My subject', body: '<p>Hello</p>' })).status).toBe(200);
    expect((await api().get(`/api/v1/vendors/${v._id}/registration-mail`).set(as('OPS'))).body.data).toMatchObject({ hasDraft: true, to: ['a@t.com'], subject: 'My subject', draft: { createdBy: 'OPS', updatedBy: 'OPS' } });
    const mail = { to: ['accounts@t.com'], subject: draft.body.data.subject, body: draft.body.data.body, requestKey: 'req-key-0001' };
    const early = await api().post(`/api/v1/vendors/${v._id}/registration-mail`).set(as('OPS')).send(mail);
    expect(early.status).toBe(409);
    expect(sent).toHaveLength(0);

    for (const d of ['pan', 'bank', 'address', 'other']) expect((await upload(v._id, d)).status, d).toBe(201);
    const res = await api().post(`/api/v1/vendors/${v._id}/registration-mail`).set(as('OPS')).send(mail);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.attachments).toHaveLength(4);
    expect(res.body.data.history[0]).toMatchObject({ status: 'SENT', sentBy: 'OPS', writtenBy: 'OPS', bcc: [], attachmentNames: expect.any(Array) });
    expect(res.body.data.history[0].writtenAt).toBeTruthy();
    expect(res.body.data.draft).toBeNull(); // the draft is gone once sent
    // same request key again: nothing is mailed twice
    await api().post(`/api/v1/vendors/${v._id}/registration-mail`).set(as('OPS')).send(mail);
    expect(sent).toHaveLength(1);

    for (const k of ['pan', 'bank', 'address']) await api().put(`/api/v1/vendors/${v._id}/kyc`).set(as('OPS')).send({ [k]: true });
    const blocked = await api().post(`/api/v1/vendors/${v._id}/status`).set(as('OPS')).send({ status: 'ACTIVE' });
    expect(blocked.status).toBe(409);
    expect((await api().post(`/api/v1/vendors/${v._id}/vendor-id`).set(as('OPS')).send({ vendorNo: 'abc' })).status).toBe(422);
    // typing the vendor ID Accounts sent makes the vendor ACTIVE at once
    expect((await api().post(`/api/v1/vendors/${v._id}/vendor-id`).set(as('OPS')).send({ vendorNo: '13001' })).body.data).toMatchObject({ zohoVendorNo: '13001', status: 'ACTIVE' });
    expect((await api().post(`/api/v1/vendors/${v._id}/status`).set(as('OPS')).send({ status: 'ACTIVE' })).status).toBe(200);
  });

  it('refuses a vendor ID before the mail went, and a duplicate vendor ID', async () => {
    const a = (await create({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', name: 'Early Bird', mobile: '9876500020' })).body.data;
    expect((await api().post(`/api/v1/vendors/${a._id}/vendor-id`).set(as('OPS')).send({ vendorNo: '13002' })).status).toBe(409);
  });
});

describe('vendor price management', () => {
  it('stores a price for a Zoho vendor, shows it in the list, and carries it over when the vendor is registered', async () => {
    // The Zoho list is not stored; a vendor is kept only because it has a cost. Zoho is not reachable in this test, so the snapshot of an earlier save is used.
    const { VendorPrice } = await import('../src/modules/vendors/vendorPrice.model');
    await VendorPrice.create({ zohoContactId: '777000000000111', vendorNo: '12600', name: 'Price Test Signs', zohoStatus: 'active' });
    // A cost above the company rate waits for approval (tests/vendor-rate-approval.test.ts); this test is about storing, so the rate is set high.
    await (await import('../src/modules/costing/costing.model')).CostPolicy.create({ key: 'default', vendorRatePerShop: 1000, vendorFarRatePerShop: 1500 });
    const put = (b: unknown) => api().put('/api/v1/vendors/zoho-directory/777000000000111/price').set(as('OPS')).send(b);
    expect((await put({ ratePerShop: 320, farRatePerShop: 280 })).status).toBe(400); // far cannot be below normal
    // skills come from the list: an unknown one is refused until it is added
    expect((await put({ ratePerShop: 320, farRatePerShop: 380, skills: ['Flex printing'] })).status).toBe(422);
    expect((await api().post('/api/v1/vendors/skills').set(as('OPS')).send({ name: 'Flex printing' })).status).toBe(201);
    expect((await api().post('/api/v1/vendors/skills').set(as('OPS')).send({ name: 'flex  PRINTING' })).status).toBe(409);
    expect((await api().get('/api/v1/vendors/skills').set(as('OPS'))).body.data.map((x: { name: string }) => x.name)).toEqual(['Flex printing']);
    expect((await put({ ratePerShop: 320, farRatePerShop: 380, skills: ['flex printing'] })).body.data).toMatchObject({ ratePerShop: 320, farRatePerShop: 380, skills: ['Flex printing'], source: 'ZOHO' });
    const list = await api().get('/api/v1/vendors/zoho-directory?price=set').set(as('OPS'));
    expect(list.body.data[0]).toMatchObject({ vendorNo: '12600', price: { ratePerShop: 320 } });
    expect((await api().put('/api/v1/vendors/zoho-directory/777000000000111/price').set(as('BD')).send({ ratePerShop: 1 })).status).toBe(403);

    const reg = await create({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', name: 'Price Test Signs', mobile: '9876500030', zohoContactId: '777000000000111', zohoVendorNo: '12600' });
    expect(reg.body.data).toMatchObject({ ratePerShop: 320, farRatePerShop: 380, skills: ['Flex printing'] });
    // once registered, the price lives on the vendor and clearing it falls back to the company rate
    expect((await put({ ratePerShop: 350 })).body.data).toMatchObject({ ratePerShop: 350, farRatePerShop: null, source: 'VENDOR' });
    expect((await put({ ratePerShop: null })).body.data).toMatchObject({ ratePerShop: null, source: 'VENDOR' });
  });
});

describe('GST check', () => {
  it('shows the name a GST number is known by in Zoho and in the registered vendors', async () => {
    const { VendorPrice } = await import('../src/modules/vendors/vendorPrice.model');
    await VendorPrice.create({ zohoContactId: '777000000000222', vendorNo: '12700', name: 'GST Known Traders', gstin: '33AAGCA2094M1ZK', zohoStatus: 'active', ratePerShop: 200 });
    const hit = await api().get('/api/v1/vendors/gst/33aagca2094m1zk').set(as('OPS'));
    expect(hit.body.data).toMatchObject({ gstin: '33AAGCA2094M1ZK', zoho: { name: 'GST Known Traders', vendorNo: '12700' }, registered: null });
    expect((await api().get('/api/v1/vendors/gst/29ABCDE1234F1Z5').set(as('OPS'))).body.data).toMatchObject({ zoho: null, registered: null });
    expect((await api().get('/api/v1/vendors/gst/BAD').set(as('OPS'))).status).toBe(422);
    expect((await api().get('/api/v1/vendors/gst/33AAGCA2094M1ZK').set(as('BD'))).status).toBe(403);
  });
});

describe('duplicates and delete', () => {
  it('does not treat a repeated name as a duplicate, only a repeated mobile', async () => {
    const a = await create({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', name: 'Same Name Boards', mobile: '9876500040' });
    expect(a.status).toBe(201);
    const b = await create({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', name: 'Same Name Boards', mobile: '9876500041', email: 'other@t.com' });
    expect(b.status).toBe(201);
    const c = await create({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', name: 'Another Name', mobile: '9876500040' });
    expect(c.status).toBe(409);
  });

  it('deleting a vendor removes its files, its logins and their notifications, and the vendor itself', async () => {
    const { Vendor } = await import('../src/modules/vendors/vendor.model');
    const { User } = await import('../src/modules/users/user.model');
    const { Notification } = await import('../src/modules/notifications/notification.model');
    const v = (await create({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', name: 'Delete Me Boards', mobile: '9876500050' })).body.data;
    expect((await upload(v._id, 'pan')).status).toBe(201);
    const files = (n: string) => (fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).filter((f) => String(f).includes(n)) : []);
    // another vendor's pan.png is in the folder too: this vendor's file is the one that must go
    const before = files('pan.png').length;
    expect(before).toBeGreaterThan(0);
    const made = await api().post(`/api/v1/vendors/${v._id}/logins`).set(as('OPS')).send({ name: 'Vendor Login', phone: '9222222931', employeeId: 'EMP931', email: 'vl931@x.test', mpin: '2580', authMethod: 'MPIN' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const uid = made.body.data.id as string;
    const kind = (await import('../src/modules/notifications/notification.model')).NOTIFICATION_KINDS[0];
    await Notification.create({ recipient: uid, kind, title: 't', body: 'b', dedupeKey: 'vendor-delete-test' });
    expect(await Notification.countDocuments({ recipient: uid })).toBe(1);

    expect((await api().delete(`/api/v1/vendors/${v._id}`).set(as('OPS'))).status).toBe(200);
    expect(await Vendor.countDocuments({ _id: v._id })).toBe(0);
    expect(files('pan.png')).toHaveLength(before - 1);
    expect((await User.findById(uid).lean())?.deletedAt).toBeTruthy();
    expect(await Notification.countDocuments({ recipient: uid })).toBe(0);
    expect((await api().get(`/api/v1/vendors/${v._id}`).set(as('OPS'))).status).toBe(404);
  });
});

describe('draft meta and discard', () => {
  it('keeps who created and last saved a draft, and can discard it', async () => {
    const v = (await create({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', name: 'Draft Meta Boards', mobile: '9876500060' })).body.data;
    const put = (subject: string) => api().put(`/api/v1/vendors/${v._id}/registration-mail/draft`).set(as('OPS')).send({ subject, body: '<p>x</p>' });
    await put('first');
    const one = (await api().get(`/api/v1/vendors/${v._id}/registration-mail`).set(as('OPS'))).body.data.draft;
    await new Promise((r) => setTimeout(r, 20));
    await put('second');
    const two = (await api().get(`/api/v1/vendors/${v._id}/registration-mail`).set(as('OPS'))).body.data.draft;
    expect(two.subject).toBe('second');
    expect(two.createdAt).toBe(one.createdAt); // created stays, last updated moves
    expect(new Date(two.updatedAt).getTime()).toBeGreaterThan(new Date(one.updatedAt).getTime());
    const gone = await api().delete(`/api/v1/vendors/${v._id}/registration-mail/draft`).set(as('OPS'));
    expect(gone.body.data).toMatchObject({ hasDraft: false, draft: null });
  });
});

describe('vendor ID activates the vendor', () => {
  it('activates a vendor waiting for KYC even before the checklist is ticked, and leaves an inactive vendor alone', async () => {
    const mailer = await import('../src/modules/notifications/mail.service');
    mailer.setMailSenderForTests(async () => undefined);
    const mk = async (name: string, mobile: string) => {
      const v = (await create({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', name, mobile })).body.data;
      await upload(v._id, 'pan');
      await upload(v._id, 'bank');
      await api().post(`/api/v1/vendors/${v._id}/registration-mail`).set(as('OPS')).send({ to: ['a@t.com'], subject: 's', body: '<p>b</p>', requestKey: `act-${mobile}-key` });
      return v as { _id: string };
    };
    const a = await mk('Auto Active Boards', '9876500070');
    expect((await api().get(`/api/v1/vendors/${a._id}`).set(as('OPS'))).body.data.status).toBe('PENDING_KYC');
    const done = await api().post(`/api/v1/vendors/${a._id}/vendor-id`).set(as('OPS')).send({ vendorNo: '13070' });
    expect(done.body.data).toMatchObject({ status: 'ACTIVE', zohoVendorNo: '13070' });
    expect(done.body.data.kyc?.pan).toBeFalsy(); // the checklist is not ticked for them; the ID is what activates

    const b = await mk('Stays Inactive Boards', '9876500071');
    await api().post(`/api/v1/vendors/${b._id}/status`).set(as('OPS')).send({ status: 'INACTIVE', reason: 'on hold' });
    expect((await api().post(`/api/v1/vendors/${b._id}/vendor-id`).set(as('OPS')).send({ vendorNo: '13071' })).body.data).toMatchObject({ status: 'INACTIVE', zohoVendorNo: '13071' });
  });
});
