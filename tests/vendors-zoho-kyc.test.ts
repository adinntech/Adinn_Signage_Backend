import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import { toVendorFields } from '../src/modules/zoho/zoho.mapper';

describe('Zoho vendor -> registration form fields', () => {
  const base = { contact_id: '131627200002319999', contact_name: '12543 - SRI MURUGAN SIGNS', company_name: 'SRI MURUGAN SIGNS' };

  it('takes a GST vendor as an organization and derives the PAN from the GSTIN', () => {
    const f = toVendorFields({ ...base, gst_no: '33abcde1234f1z5', email: 'Accounts@Sri.com', billing_address: { address: '12 Main Rd', city: 'Madurai' }, contact_persons: [{ first_name: 'Murugan', mobile: '+91 98765 43210', is_primary_contact: true }] });
    expect(f).toMatchObject({ name: 'SRI MURUGAN SIGNS', type: 'ORGANIZATION', gstin: '33ABCDE1234F1Z5', pan: 'ABCDE1234F', email: 'accounts@sri.com', district: 'Madurai', contactPerson: 'Murugan', mobile: '9876543210' });
  });

  it('leaves unusable values empty and strips the number prefix from the name', () => {
    const f = toVendorFields({ contact_id: '1', contact_name: '12543 - ONE MAN', mobile: '12345', gst_no: 'BAD', email: 'nope' });
    expect(f).toMatchObject({ name: 'ONE MAN', type: 'ONE_MAN', mobile: undefined, gstin: undefined, pan: undefined, email: undefined });
  });
});

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
/** The parsed config, imported inside beforeAll (after the test environment is set), never at the top of the file. */
let env: { ZOHO_VENDOR_CONTACT_CODE: string; ZOHO_SIGNAGE_CREDITORS_ONLY: 'true' | 'false' };
let root = '';
const tokens: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const walk = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-kyc-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  process.env.ZOHO_ORGANIZATION_ID = '1';
  process.env.ZOHO_ACCESS_TOKEN = 'test-token';
  env = (await import('../src/config/env')).env;
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
  vi.unstubAllGlobals();
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Zoho vendor lookup by number', () => {
  const zoho = (contacts: unknown[]) =>
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      // A developer's .env may hold a refresh token: answer the token call too so the test never reaches the real Zoho.
      if (String(url).includes('/oauth/v2/token')) return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 });
      const body = String(url).includes('/contacts/') ? { code: 0, contact: { contact_id: '777000000000001', contact_name: '12543 - SRI MURUGAN SIGNS', company_name: 'SRI MURUGAN SIGNS', gst_no: '33ABCDE1234F1Z5', contact_persons: [{ first_name: 'Murugan', mobile: '9876543210', is_primary_contact: true }] } } : { code: 0, contacts };
      return new Response(JSON.stringify(body), { status: 200 });
    }));

  it('returns the details for the exact number and flags an already registered vendor', async () => {
    zoho([{ contact_id: '777000000000002', contact_name: '125430 - OTHER' }, { contact_id: '777000000000001', contact_name: '12543 - SRI MURUGAN SIGNS' }]);
    const r = await api().get('/api/v1/vendors/zoho/12543').set(as('OPS'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ contactId: '777000000000001', vendorNo: '12543', existing: null, vendor: { name: 'SRI MURUGAN SIGNS', type: 'ORGANIZATION', mobile: '9876543210' } });
    const created = await api().post('/api/v1/vendors').set(as('OPS')).send({ ...r.body.data.vendor, zohoContactId: r.body.data.contactId, zohoVendorNo: '12543', status: undefined });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ source: 'ZOHO', zohoVendorNo: '12543' });
    const again = await api().get('/api/v1/vendors/zoho/12543').set(as('OPS'));
    expect(again.body.data.existing).toMatchObject({ code: created.body.data.code });
    expect((await api().post('/api/v1/vendors').set(as('OPS')).send({ ...r.body.data.vendor, mobile: '9876500000', name: 'Different', zohoContactId: r.body.data.contactId })).status).toBe(409);
  });

  it('404 when no vendor has that exact number, 422 for a bad number, 403 for BD', async () => {
    zoho([{ contact_id: '9', contact_name: '99999 - SOMEONE' }]);
    expect((await api().get('/api/v1/vendors/zoho/12999').set(as('OPS'))).status).toBe(404);
    expect((await api().get('/api/v1/vendors/zoho/abc').set(as('OPS'))).status).toBe(422);
    expect((await api().get('/api/v1/vendors/zoho/12543').set(as('BD'))).status).toBe(403);
  });
});

describe('Vendor KYC documents', () => {
  let id = '';
  it('uploads, lists, views and removes a scan; limits files per document type', async () => {
    id = (await api().post('/api/v1/vendors').set(as('OPS')).send({ name: 'KYC Vendor', type: 'ONE_MAN', mobile: '9811111111' })).body.data._id;
    const up = (name = 'pan.png') => api().post(`/api/v1/vendors/${id}/kyc-files`).set(as('OPS')).field('docType', 'pan').attach('files', png, name);
    const first = await up();
    expect(first.status).toBe(201);
    expect(first.body.data.kycFiles).toHaveLength(1);
    expect(first.body.data.kycFiles[0]).toMatchObject({ docType: 'pan', name: 'pan.png' });
    expect(first.body.data.kyc.pan).toBe(false); // uploading never ticks the checklist
    expect(walk(root).filter((f) => f.includes('KYC'))).toHaveLength(1);
    const fileId = first.body.data.kycFiles[0].fileId;
    expect((await api().get(`/api/v1/vendors/${id}/kyc-files/${fileId}/url`).set(as('OPS'))).body.data.url).toContain('/files/raw');
    await up('pan2.png');
    await up('pan3.png');
    expect((await up('pan4.png')).status).toBe(400);
    const gone = await api().delete(`/api/v1/vendors/${id}/kyc-files/${fileId}`).set(as('OPS'));
    expect(gone.body.data.kycFiles).toHaveLength(2);
    expect(walk(root).filter((f) => f.includes('KYC'))).toHaveLength(2);
  });

  it('rejects other document types and users without vendor access', async () => {
    expect((await api().post(`/api/v1/vendors/${id}/kyc-files`).set(as('OPS')).field('docType', 'selfie').attach('files', png, 'a.png')).status).toBe(422);
    expect((await api().post(`/api/v1/vendors/${id}/kyc-files`).set(as('BD')).field('docType', 'pan').attach('files', png, 'a.png')).status).toBe(403);
  });

  it('erases the stored scans when the vendor is deleted', async () => {
    expect((await api().delete(`/api/v1/vendors/${id}`).set(as('OPS'))).status).toBe(200);
    expect(walk(root).filter((f) => f.includes('KYC'))).toHaveLength(0);
  });
});

describe('Zoho vendors (read live from Zoho; only vendors with a cost are stored)', () => {
  const calls: URL[] = [];
  const listed = (code: string | undefined, id: string, name: string, extra: object = {}) => ({ contact_id: id, contact_name: name, ...(code ? { cf_contact_code: code } : {}), status: 'active', ...extra });
  const stub = () =>
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      if (String(url).includes('/oauth/v2/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
      const u = new URL(String(url));
      calls.push(u);
      const detail = /\/contacts\/(\d+)$/.exec(u.pathname);
      if (detail) return new Response(JSON.stringify({ code: 0, contact: { contact_id: detail[1], contact_name: '12543 - SRI MURUGAN SIGNS', company_name: 'SRI MURUGAN SIGNS', cf_contact_code: 'Creditors - Signage', gst_no: '33ABCDE1234F1Z5', mobile: '9876543210', created_by_name: 'Accounts Manager', billing_address: { city: 'Madurai', state: 'Tamil Nadu', zip: '625001' } } }), { status: 200 });
      const all = [listed('Creditors - Signage', '800000000000001', '12543 - SRI MURUGAN SIGNS', { gst_no: '33ABCDE1234F1Z5', mobile: '9876543210' }), listed('Creditors - Roadshow', '800000000000009', '30000 - ROADSHOW ONLY'), listed(undefined, '800000000000010', '40000 - NO CODE VENDOR')];
      const only = u.searchParams.get('cf_contact_code');
      return new Response(JSON.stringify({ code: 0, contacts: only ? all.filter((c) => c.cf_contact_code === only) : all, page_context: { has_more_page: u.searchParams.get('page') === '1' && !only } }), { status: 200 });
    }));
  const list = (qs = '') => api().get(`/api/v1/vendors/zoho-directory?${qs}`).set(as('OPS'));
  const last = () => calls[calls.length - 1]!;

  it('reads the list from Zoho when asked and stores nothing', async () => {
    stub();
    env.ZOHO_SIGNAGE_CREDITORS_ONLY = 'true';
    const r = await list('limit=2');
    expect(r.status).toBe(200);
    expect(last().searchParams.get('cf_contact_code')).toBe('Creditors - Signage');
    expect(last().searchParams.get('per_page')).toBe('200'); // the whole Signage group is read once (200 per call) and paged here
    expect(r.body.data.map((v: { name: string }) => v.name)).toEqual(['SRI MURUGAN SIGNS']);
    expect(r.body.data[0]).toMatchObject({ vendorNo: '12543', vendor: null, price: { ratePerShop: null } });
    const { VendorPrice } = await import('../src/modules/vendors/vendorPrice.model');
    expect(await VendorPrice.countDocuments()).toBe(0);
    expect((await api().get('/api/v1/vendors/zoho-directory').set(as('BD'))).status).toBe(403);
  });

  it('signageOnly=false (or ZOHO_SIGNAGE_CREDITORS_ONLY=false) asks Zoho for every vendor and keeps each Contact Code', async () => {
    stub();
    const r = await list('signageOnly=false&limit=50');
    expect(last().searchParams.get('cf_contact_code')).toBeNull();
    expect(r.body.data.map((v: { name: string }) => v.name).sort()).toEqual(['NO CODE VENDOR', 'ROADSHOW ONLY', 'SRI MURUGAN SIGNS']);
    expect(r.body.data.find((v: { name: string }) => v.name === 'ROADSHOW ONLY')).toMatchObject({ contactCode: 'Creditors - Roadshow' });
    expect(r.body.meta.totalPages).toBe(2); // Zoho said another page exists
    env.ZOHO_SIGNAGE_CREDITORS_ONLY = 'false';
    await list('limit=5');
    expect(last().searchParams.get('cf_contact_code')).toBeNull();
    env.ZOHO_SIGNAGE_CREDITORS_ONLY = 'true';
  });

  it('sends the search to the Zoho field that fits it, and the status as a Zoho filter', async () => {
    stub();
    await list('q=SRI&status=inactive&signageOnly=false');
    expect(last().searchParams.get('contact_name_contains')).toBe('SRI');
    expect(last().searchParams.get('filter_by')).toBe('Status.Inactive');
    await list('q=a%40b.com&signageOnly=false');
    expect(last().searchParams.get('email_contains')).toBe('a@b.com');
    await list('q=98765%2043210&signageOnly=false');
    expect(last().searchParams.get('phone_contains')).toBe('9876543210');
  });

  it('adding a cost stores only that vendor (name, city, GST... read from Zoho); the cost list and registration read it back', async () => {
    stub();
    const { VendorPrice } = await import('../src/modules/vendors/vendorPrice.model');
    const put = (b: unknown) => api().put('/api/v1/vendors/zoho-directory/800000000000001/price').set(as('OPS')).send(b);
    expect((await put({ ratePerShop: 300 })).body.data).toMatchObject({ ratePerShop: 300, source: 'ZOHO' });
    expect(await VendorPrice.countDocuments()).toBe(1);
    expect(await VendorPrice.findOne().lean()).toMatchObject({ zohoContactId: '800000000000001', name: 'SRI MURUGAN SIGNS', vendorNo: '12543', city: 'Madurai', gstin: '33ABCDE1234F1Z5', createdByName: 'Accounts Manager' });
    const withCost = await list('price=set');
    expect(withCost.body.data).toHaveLength(1);
    expect(withCost.body.data[0]).toMatchObject({ name: 'SRI MURUGAN SIGNS', city: 'Madurai', price: { ratePerShop: 300 }, vendor: null });
    expect((await list('price=set&q=nobody')).body.data).toHaveLength(0);
    // the live list shows the cost next to the vendor, and "missing" hides it
    expect((await list()).body.data[0]).toMatchObject({ price: { ratePerShop: 300 } });
    expect((await list('price=missing')).body.data).toHaveLength(0);
    const created = await api().post('/api/v1/vendors').set(as('OPS')).send({ name: 'Sri Murugan Signs Reg', type: 'ORGANIZATION', contactPerson: 'Murugan', gstin: '33ABCDE1234F1Z5', mobile: '9876500099', zohoContactId: '800000000000001', zohoVendorNo: '12543' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ ratePerShop: 300 });
    expect((await list()).body.data[0].vendor).toMatchObject({ code: created.body.data.code });
    expect((await list('registered=yes')).body.data.map((v: { zohoContactId: string }) => v.zohoContactId)).toContain('800000000000001');
    const st = (await api().get('/api/v1/vendors/zoho-directory/status').set(as('OPS'))).body.data;
    expect(st).toMatchObject({ live: true });
    expect(st.costed).toBeGreaterThanOrEqual(1);
    expect(st.registered).toBeGreaterThanOrEqual(1);
  });

  it('removing the cost removes what was stored for that vendor', async () => {
    stub();
    const { VendorPrice } = await import('../src/modules/vendors/vendorPrice.model');
    // a vendor that is not registered: price, then no price
    await VendorPrice.deleteMany({});
    const put = (b: unknown) => api().put('/api/v1/vendors/800000000000010/price'.replace('/vendors/', '/vendors/zoho-directory/')).set(as('OPS')).send(b);
    expect((await put({ ratePerShop: 250 })).status).toBe(200);
    expect(await VendorPrice.countDocuments()).toBe(1);
    expect((await put({ ratePerShop: null })).body.data).toMatchObject({ ratePerShop: null, source: null });
    expect(await VendorPrice.countDocuments()).toBe(0);
  });
});


describe('Export of entered and fetched vendor details', () => {
  const csv = (path: string, as_ = 'OPS') => api().get(path).set(as(as_)).buffer(true).parse((res, cb) => { let t = ''; res.setEncoding('utf8'); res.on('data', (c: string) => (t += c)); res.on('end', () => cb(null, t)); });

  it('registered vendors: CSV with every entered detail, honouring the filters', async () => {
    const r = await csv('/api/v1/vendors/export?format=csv');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toMatch(/registered-vendors-\d{4}-\d{2}-\d{2}\.csv/);
    const lines = (r.body as string).replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toContain('Vendor Code,Vendor Name,Type,Status');
    expect(lines[0]).toContain('Bank Account No');
    expect(lines.length).toBeGreaterThan(2);
    const filtered = await csv('/api/v1/vendors/export?format=csv&q=KYC%20Vendor');
    expect((filtered.body as string).trim().split('\r\n')).toHaveLength(1); // that vendor was deleted in the KYC test: header only
    const none = await csv('/api/v1/vendors/export?format=csv&status=BLACKLISTED');
    expect((none.body as string).trim().split('\r\n')).toHaveLength(1);
  });

  it('registered vendors: Excel by default, bad format rejected, BD refused', async () => {
    const x = await api().get('/api/v1/vendors/export').set(as('OPS')).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(x.headers['content-type']).toContain('spreadsheetml');
    expect((x.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    expect((await api().get('/api/v1/vendors/export?format=pdf').set(as('OPS'))).status).toBe(422);
    expect((await api().get('/api/v1/vendors/export?format=csv').set(as('BD'))).status).toBe(403);
  });

  it('Zoho vendors: the CSV holds the vendors that have a cost, with the status filter', async () => {
    const { VendorPrice } = await import('../src/modules/vendors/vendorPrice.model');
    await VendorPrice.create({ zohoContactId: '800000000000555', name: 'Export Signs', vendorNo: '55555', ratePerShop: 210, city: 'Theni', zohoStatus: 'active' });
    const all = await csv('/api/v1/vendors/zoho-directory/export?format=csv');
    const lines = (all.body as string).replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Vendor ID,Vendor Name,Phone,Email,Created By,Created On,Status,City,Address,GSTIN,PAN,Price per Shop,Far Price per Shop,Contact Code,Zoho Contact ID');
    const mine = lines.find((l) => l.includes('Export Signs'));
    expect(mine).toContain('Active');
    expect(mine).toContain('Theni');
    const inactive = await csv('/api/v1/vendors/zoho-directory/export?format=csv&status=inactive');
    expect(inactive.body as string).not.toContain('Export Signs');
    await VendorPrice.deleteMany({});
  });
});

describe('Dashboard counts', () => {
  it('counts vendors registered here separately from those linked to Zoho', async () => {
    const r = await api().get('/api/v1/vendors').set(as('OPS'));
    const s = r.body.meta.summary;
    const all = r.body.meta.total;
    const linked = (await api().get('/api/v1/vendors?limit=200').set(as('OPS'))).body.data.filter((v: { zohoContactId?: string }) => v.zohoContactId).length;
    expect(s.NEW).toBe(all - linked);
    expect(s.NEW_PENDING_KYC).toBeLessThanOrEqual(s.NEW);
    expect(s.NEW + linked).toBe(s.ALL);
  });
});
