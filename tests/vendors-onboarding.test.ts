import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root = '';
const tokens: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-onb-'));
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
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());

const create = (body: Record<string, unknown>) => api().post('/api/v1/vendors').set(as('OPS')).send(body);
const upload = (id: string, docType: string) => api().post(`/api/v1/vendors/${id}/kyc-files`).set(as('OPS')).field('docType', docType).attach('files', png, { filename: `${docType}.png`, contentType: 'image/png' });
const missingOf = async (id: string) => (await api().get(`/api/v1/vendors/${id}/registration-mail`).set(as('OPS'))).body.data.missing as string[];
const paths = (r: { body: { error: { details: { path: string }[] } } }) => r.body.error.details.map((d) => d.path).sort();

const FULL = {
  type: 'ONE_MAN', typeName: 'One-man / Freelancer', fullDetails: true, name: 'Sri Flex Works', contactPerson: 'Murugan', designation: 'Owner', mobile: '9876543210', email: 'murugan@flex.com',
  address: '12, Main Road', pincode: '600001', state: 'Tamil Nadu', district: 'Chennai', pan: 'ABCDE1234F',
};

describe('new registration: details and GST / Aadhaar rule', () => {
  it('the full form needs every detail, and the GST number or the Aadhaar number', async () => {
    const empty = await create({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', fullDetails: true, hasGst: true, name: 'Sri Flex', mobile: '9876543210' });
    expect(empty.status).toBe(422);
    expect(paths(empty)).toEqual(['address', 'contactPerson', 'designation', 'district', 'email', 'gstin', 'pan', 'pincode', 'state']);
    const noGst = await create({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', fullDetails: true, hasGst: false, name: 'Sri Flex', mobile: '9876543210' });
    expect(paths(noGst)).toContain('aadhaar');
    expect(paths(noGst)).not.toContain('gstin');
  });

  it('GST yes: GST and PAN numbers are required, Aadhaar is not', async () => {
    const r = await create({ ...FULL, hasGst: true, gstin: '33ABCDE1234F1Z5' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ hasGst: true, designation: 'Owner', state: 'Tamil Nadu', pincode: '600001', district: 'Chennai' });
    expect(r.body.data.fullDetails).toBeUndefined();
  });

  it('GST no: the Aadhaar number is required and is checked', async () => {
    expect(paths(await create({ ...FULL, mobile: '9876500001', hasGst: false, aadhaar: '1234' }))).toEqual(['aadhaar']);
    const r = await create({ ...FULL, mobile: '9876500001', hasGst: false, aadhaar: '2345 6789 0123' });
    expect(r.status).toBe(201);
    expect(r.body.data.aadhaar).toBe('234567890123');
    expect(r.body.data.gstin).toBeUndefined();
  });

  it('checks the pincode and PAN format', async () => {
    expect(paths(await create({ ...FULL, mobile: '9876500002', hasGst: false, aadhaar: '234567890123', pincode: '12' }))).toEqual(['pincode']);
    expect(paths(await create({ ...FULL, mobile: '9876500002', hasGst: false, aadhaar: '234567890123', pan: 'XX' }))).toEqual(['pan']);
  });

  it('quick registration (no fullDetails) needs only the name, mobile and the GST number when GST is yes', async () => {
    expect((await create({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', hasGst: false, name: 'Quick Man', mobile: '9876500003' })).status).toBe(201);
    const g = await create({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', hasGst: true, name: 'Quick Co', mobile: '9876500004' });
    expect(paths(g)).toEqual(['gstin']);
  });

  it('an older vendor (no hasGst) keeps the organization rule', async () => {
    const org = await create({ type: 'ORGANIZATION', typeName: 'Organization', name: 'Old Org', mobile: '9876500005' });
    expect(paths(org)).toEqual(['contactPerson', 'gstin']);
  });
});

describe('mandatory documents', () => {
  it('GST yes: PAN, GST certificate and cancelled cheque; the Aadhaar is not asked for', async () => {
    const v = (await create({ ...FULL, mobile: '9876500010', hasGst: true, gstin: '33ABCDE1234F1Z5' })).body.data;
    expect((await missingOf(v._id)).sort()).toEqual(['Cancelled cheque', 'GST certificate', 'PAN card']);
    for (const d of ['pan', 'gst', 'bank']) expect((await upload(v._id, d)).status).toBe(201);
    expect(await missingOf(v._id)).toEqual([]);
  });

  it('GST no: PAN, Aadhaar and cancelled cheque; the GST certificate is not asked for; other documents stay optional', async () => {
    const v = (await create({ ...FULL, mobile: '9876500011', hasGst: false, aadhaar: '234567890123' })).body.data;
    expect((await missingOf(v._id)).sort()).toEqual(['Aadhaar card', 'Cancelled cheque', 'PAN card']);
    for (const d of ['pan', 'aadhaar', 'bank']) expect((await upload(v._id, d)).status).toBe(201);
    expect(await missingOf(v._id)).toEqual([]);
    expect((await upload(v._id, 'other')).status).toBe(201); // the vendor agreement
  });

  it('the mail text carries the new details, with the Aadhaar number masked', async () => {
    const v = (await create({ ...FULL, mobile: '9876500012', hasGst: false, aadhaar: '234567890123' })).body.data;
    const d = (await api().get(`/api/v1/vendors/${v._id}/registration-mail`).set(as('OPS'))).body.data;
    expect(d.body).toContain('Murugan, Owner');
    expect(d.body).toContain('12, Main Road, Chennai, Tamil Nadu, 600001');
    expect(d.body).toContain('XXXX XXXX 0123');
    expect(d.body).not.toContain('234567890123');
    expect(d.body).toContain('Not registered for GST');
  });

  it('the checklist for a vendor without GST is PAN, Aadhaar and bank', async () => {
    const v = (await create({ ...FULL, mobile: '9876500013', hasGst: false, aadhaar: '234567890123' })).body.data;
    await api().put(`/api/v1/vendors/${v._id}/kyc`).set(as('OPS')).send({ pan: true, bank: true });
    expect((await api().post(`/api/v1/vendors/${v._id}/status`).set(as('OPS')).send({ status: 'ACTIVE' })).status).toBe(409);
    await api().put(`/api/v1/vendors/${v._id}/kyc`).set(as('OPS')).send({ aadhaar: true });
    expect((await api().post(`/api/v1/vendors/${v._id}/status`).set(as('OPS')).send({ status: 'ACTIVE' })).status).toBe(200);
  });
});

describe('pincode lookup', () => {
  const answer = (json: unknown, ok = true) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => json })));
  const get = (pin: string, role = 'OPS') => api().get(`/api/v1/vendors/pincode/${pin}`).set(as(role));

  it('returns the state and district of a pincode', async () => {
    answer([{ Status: 'Success', PostOffice: [{ Name: 'Chennai G.P.O.', District: 'Chennai', State: 'Tamil Nadu' }, { Name: 'Parrys', District: 'Chennai', State: 'Tamil Nadu' }] }]);
    const r = await get('600001');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ pincode: '600001', state: 'Tamil Nadu', district: 'Chennai', areas: ['Chennai G.P.O.', 'Parrys'] });
  });

  it('404 for an unknown pincode, 502 when the service is down, 422 for a bad pincode, 403 without permission', async () => {
    answer([{ Status: 'Error', PostOffice: null }]);
    expect((await get('999999')).status).toBe(404);
    answer({}, false);
    const down = await get('600001');
    expect(down.status).toBe(502);
    expect(down.body.error.message).toMatch(/choose the state/i);
    expect((await get('12')).status).toBe(422);
    expect((await get('600001', 'BD')).status).toBe(403);
  });
});
