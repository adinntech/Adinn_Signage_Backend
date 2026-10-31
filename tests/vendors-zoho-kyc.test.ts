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

describe('Zoho vendors directory (stored copy of the Zoho vendor list)', () => {
  const pages: Record<string, unknown[]> = {
    '1': [
      { contact_id: '800000000000001', cf_contact_code: 'Creditors - Signage', created_time: '2026-08-04T17:13:28+0530', contact_name: '12543 - SRI MURUGAN SIGNS', company_name: 'SRI MURUGAN SIGNS', gst_no: '33ABCDE1234F1Z5', mobile: '9876543210', status: 'active' },
      { contact_id: '800000000000002', cf_contact_code: 'Creditors - Signage', contact_name: '20001 - OLD PRINTERS', company_name: 'OLD PRINTERS', status: 'inactive' },
    ],
    // not a Signage creditor: Zoho should not return it, and if it does the sync drops it
    '2': [{ contact_id: '800000000000009', cf_contact_code: 'Creditors - Roadshow', contact_name: '30000 - ROADSHOW ONLY', status: 'active' }, { contact_id: '800000000000003', cf_contact_code: 'Creditors - Signage', contact_name: '*No Number Vendor', status: 'active', mobile: '12345' }],
  };
  const stub = () =>
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      if (String(url).includes('/oauth/v2/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
      const u = new URL(String(url));
      const detail = /\/contacts\/(\d+)$/.exec(u.pathname);
      if (detail) return new Response(JSON.stringify({ code: 0, contact: { contact_id: detail[1], contact_name: 'x', created_by_name: 'Accounts Manager', billing_address: { city: 'Madurai', state: 'Tamil Nadu', zip: '625001' } } }), { status: 200 });
      expect(u.searchParams.get('cf_contact_code')).toBe('Creditors - Signage');
      const page = u.searchParams.get('page') ?? '1';
      return new Response(JSON.stringify({ code: 0, contacts: pages[page] ?? [], page_context: { has_more_page: page === '1' } }), { status: 200 });
    }));
  const finished = async () => {
    for (let i = 0; i < 50; i++) {
      const s = (await api().get('/api/v1/vendors/zoho-directory/status').set(as('OPS'))).body.data;
      if (!s.sync.running) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('sync did not finish');
  };

  it('syncs every page, keeps them apart from registered vendors, and lists them', async () => {
    stub();
    expect((await api().post('/api/v1/vendors/zoho-directory/sync').set(as('BD'))).status).toBe(403);
    expect((await api().post('/api/v1/vendors/zoho-directory/sync').set(as('OPS'))).status).toBe(202);
    const s = await finished();
    expect(s).toMatchObject({ total: 3, active: 2, sync: { fetched: 3, detailsDone: 3, detailsTotal: 3, error: null } });
    const all = (await api().get('/api/v1/vendors/zoho-directory?limit=50').set(as('OPS'))).body;
    expect(all.data.map((v: { name: string }) => v.name).sort()).toEqual(['*No Number Vendor', 'OLD PRINTERS', 'SRI MURUGAN SIGNS'].sort());
    expect(all.data.find((v: { vendorNo?: string }) => v.vendorNo === '12543')).toMatchObject({ gstin: '33ABCDE1234F1Z5', pan: 'ABCDE1234F', mobile: '9876543210', vendor: null, city: 'Madurai', createdByName: 'Accounts Manager' });
    expect(all.data.some((v: { name: string }) => v.name === 'ROADSHOW ONLY')).toBe(false);
    expect(all.data.find((v: { name: string }) => v.name === '*No Number Vendor').mobile).toBeFalsy(); // invalid mobile dropped
    // they are NOT registered vendors
    const registered = (await api().get('/api/v1/vendors?q=SRI MURUGAN').set(as('OPS'))).body.data.filter((v: { zohoContactId?: string }) => v.zohoContactId === '800000000000001');
    expect(registered).toHaveLength(0);
  });

  it('filters by search, status and registration; registering links the row back', async () => {
    const q = (s: string) => api().get(`/api/v1/vendors/zoho-directory?${s}`).set(as('OPS')).then((r) => r.body.data as { vendorNo?: string; vendor: { code: string } | null }[]);
    expect(await q('q=20001')).toHaveLength(1);
    expect(await q('status=inactive')).toHaveLength(1);
    expect(await q('registered=no')).toHaveLength(3);
    const created = await api().post('/api/v1/vendors').set(as('OPS')).send({ name: 'Sri Murugan Signs Reg', type: 'ORGANIZATION', mobile: '9876500099', zohoContactId: '800000000000001', zohoVendorNo: '12543' });
    expect(created.status).toBe(201);
    expect(await q('registered=no')).toHaveLength(2);
    const yes = await q('registered=yes');
    expect(yes).toHaveLength(1);
    expect(yes[0]!.vendor).toMatchObject({ code: created.body.data.code });
  });

  it('a second sync removes vendors that are gone from Zoho and cannot run twice at once', async () => {
    pages['2'] = [];
    pages['1'] = (pages['1'] as { contact_id: string }[]).slice(0, 1);
    stub();
    const [a, b] = await Promise.all([api().post('/api/v1/vendors/zoho-directory/sync').set(as('OPS')), api().post('/api/v1/vendors/zoho-directory/sync').set(as('OPS'))]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const last = await finished();
    expect(last).toMatchObject({ total: 1, registered: 2 });
    expect(last.sync.detailsTotal).toBe(0); // nothing changed in Zoho since the details were read: no detail calls
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

  it('Zoho vendors: CSV with the fetched details and the active/inactive filter', async () => {
    const all = await csv('/api/v1/vendors/zoho-directory/export?format=csv');
    const lines = (all.body as string).replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Vendor ID,Vendor Name,Phone,Email,Created By,Created On,Status,City,Address,GSTIN,PAN,Zoho Contact ID,Last Synced');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[1]).toContain('Active');
    const inactive = await csv('/api/v1/vendors/zoho-directory/export?format=csv&status=inactive');
    expect((inactive.body as string).trim().split('\r\n')).toHaveLength(1);
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
