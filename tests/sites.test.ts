import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import ExcelJS from 'exceljs';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);

async function xlsx(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const H2 = ['S.No', 'Customer / Dealer Name', 'District', 'Size (W * H)', 'Address Line 1', 'Address Line 2', 'Mobile Number(PH)', 'GST Number', 'Region'];
const districts = ['Vellore', 'Chennai', 'Madurai', 'Trichy', 'Coimbatore'];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
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
  const c = await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Amul', code: 'AMUL' });
  const mk = async (scenario: string, key: string) => {
    const p = await api().post('/api/v1/projects').set(as('BD')).send({ clientId: c.body.data._id, campaign: key, requirement: { source: 'EMAIL', siteDataScenario: scenario } });
    ids[key] = p.body.data._id;
    ids[`${key}Code`] = p.body.data.code;
  };
  await mk('CLIENT_PROVIDED', 's2');
  await mk('MEASUREMENT_REQUIRED', 's1');
  await mk('CLIENT_PROVIDED', 'big');
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

const base = (k: string) => `/api/v1/projects/${ids[k]}/sites`;

describe('Scenario 2: 260-row client sheet', () => {
  let batch: string;
  let mapping: Record<string, string>;

  it('uploads, extracts and auto-maps', async () => {
    const rows: unknown[][] = [H2];
    for (let i = 1; i <= 250; i++) {
      rows.push([i, `Dealer ${i}`, districts[i % 5], i % 7 === 0 ? '12 x 5' : '10 x 4', `${i} Main Road`, 'Near bus stand', 9000000000 + i, '33AAACA2094M1ZK', i % 3 ? 'North' : '']);
    }
    rows.push([251, 'Bad Phone Dealer', 'Vellore', '10 x 4', 'addr', '', '12345', '', '']); // sheet row 252
    rows.push([252, 'Bad Gst Dealer', 'Vellore', '10 x 4', 'addr', '', '9876500001', 'XYZ', '']); // 253
    rows.push([253, '', 'Vellore', '10 x 4', 'addr', '', '9876500002', '', '']); // 254: no name
    rows.push([254, 'No Size Dealer', 'Vellore', '', 'addr', '', '9876500003', '', '']); // 255: size required
    rows.push([255, 'Weird Size', 'Vellore', 'big', 'addr', '', '9876500004', '', '']); // 256
    rows.push([256, 'Dealer 5', districts[0], '10 x 4', '5 Main Road', '', 9000000005, '', '']); // 257: duplicate of row 6 (Dealer 5, Vellore)
    rows.push([]); // blank row ignored
    rows.push([258, 'No District Dealer', '', '9 x 3', '', '', '', '', '']); // 259: warnings only
    const buf = await xlsx(rows);

    const r = await api().post(`${base('s2')}/imports`).set(as('BD')).attach('file', buf, 'Amul_Shop_List.xlsx');
    expect(r.status).toBe(201);
    expect(r.body.data.batch.totalRows).toBe(257);
    expect(r.body.data.batch.scenario).toBe('CLIENT_PROVIDED');
    mapping = r.body.data.suggestedMapping;
    expect(mapping).toMatchObject({ 'Customer / Dealer Name': 'dealerName', District: 'district', 'Size (W * H)': 'size', 'Mobile Number(PH)': 'mobile', 'GST Number': 'gstin', 'S.No': 'extra' });
    expect(r.body.data.problems).toEqual([]);
    batch = r.body.data.batch._id;
  });

  it('validates with sheet row numbers and reasons', async () => {
    const p = await api().post(`${base('s2')}/imports/${batch}/preview`).set(as('BD')).send({ mapping, defaultUnit: 'ft', duplicatePolicy: 'skip' });
    expect(p.status).toBe(200);
    expect(p.body.data.summary).toMatchObject({ error: 5, duplicates: 1 });
    expect(p.body.data.summary.valid + p.body.data.summary.warning + p.body.data.summary.error).toBe(257);
    const e = await api().get(`${base('s2')}/imports/${batch}/rows?state=ERROR`).set(as('BD'));
    const byRow = Object.fromEntries(e.body.data.map((r: any) => [r.rowNumber, r.errors.map((x: any) => x.code)]));
    expect(byRow).toEqual({ 252: ['BAD_MOBILE'], 253: ['BAD_GST'], 254: ['NAME_REQUIRED'], 255: ['MISSING_SIZE'], 256: ['BAD_SIZE'] });
    const d = await api().get(`${base('s2')}/imports/${batch}/rows?state=DUPLICATE`).set(as('BD'));
    expect(d.body.data.map((r: any) => r.rowNumber)).toEqual([257]);
    expect(d.body.data[0].warnings.map((w: any) => w.message).join(' ')).toContain('row 6');
    const w = await api().get(`${base('s2')}/imports/${batch}/rows?state=WARNING&limit=200`).set(as('BD'));
    expect(w.body.data.some((r: any) => r.rowNumber === 259 && r.warnings.some((x: any) => x.code === 'MISSING_DISTRICT'))).toBe(true);
  });

  it('rejects incomplete mapping and unknown columns', async () => {
    const m = { ...mapping, 'Customer / Dealer Name': 'ignore' };
    expect((await api().post(`${base('s2')}/imports/${batch}/preview`).set(as('BD')).send({ mapping: m })).status).toBe(400);
    expect((await api().post(`${base('s2')}/imports/${batch}/preview`).set(as('BD')).send({ mapping: { ...mapping, Nope: 'extra' } })).status).toBe(400);
  });

  it('inline-fixes a staged row and skips another', async () => {
    const e = await api().get(`${base('s2')}/imports/${batch}/rows?state=ERROR`).set(as('BD'));
    const bad = e.body.data.find((r: any) => r.rowNumber === 252);
    const fixed = await api().patch(`${base('s2')}/imports/${batch}/rows/${bad._id}`).set(as('BD')).send({ mapped: { mobile: '9876500009' } });
    expect(fixed.body.data.row.state).not.toBe('ERROR');
    expect(fixed.body.data.summary.error).toBe(4);
    const still = await api().patch(`${base('s2')}/imports/${batch}/rows/${bad._id}`).set(as('BD')).send({ mapped: { mobile: '1' } });
    expect(still.body.data.row.state).toBe('ERROR');
    await api().patch(`${base('s2')}/imports/${batch}/rows/${bad._id}`).set(as('BD')).send({ mapped: { mobile: '9876500009' } });
    const skip = e.body.data.find((r: any) => r.rowNumber === 253);
    expect((await api().patch(`${base('s2')}/imports/${batch}/rows/${skip._id}`).set(as('BD')).send({ skipped: true })).body.data.summary.skipped).toBe(1);
  });

  it('commits valid rows only, once, with sequential site codes and sq.ft', async () => {
    expect((await api().post(`${base('s2')}/imports/${batch}/commit`).set(as('FINANCE')).send({})).status).toBe(403);
    const rs = await Promise.all([1, 2].map(() => api().post(`${base("s2")}/imports/${batch}/commit`).set(as("BD")).send({})));
    const a = rs[0]!, b = rs[1]!;
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const done = a.status === 200 ? a : b;
    // 257 rows - 3 error (254,255,256) - 1 skipped (253) - 1 duplicate (257) = 252
    expect(done.body.data.result).toMatchObject({ created: 252, updated: 0, skippedRows: 2, errorRows: 3 });
    const list = await api().get(`${base('s2')}?limit=200&sort=seq`).set(as('BD'));
    expect(list.body.meta.total).toBe(252);
    expect(list.body.data[0].siteCode).toBe(`${ids.s2Code}-S001`);
    expect(list.body.data[0]).toMatchObject({ dealerName: 'Dealer 1', width: 10, height: 4, sqft: 40, mobile: '9000000001', unit: 'ft', scenario: 'CLIENT_PROVIDED' });
    expect(list.body.data[0].extra).toMatchObject({ 'S.No': '1', Region: 'North' });
    const proj = await api().get(`/api/v1/projects/${ids.s2}`).set(as('BD'));
    expect(proj.body.data.siteCount).toBe(252);
    expect((await api().post(`${base('s2')}/imports/${batch}/commit`).set(as('BD')).send({})).status).toBe(409);
    const hist = await api().get(`${base('s2')}/imports`).set(as('BD'));
    expect(hist.body.data[0]).toMatchObject({ status: 'COMMITTED', fileName: 'Amul_Shop_List.xlsx' });
  });

  it('filters, searches, sorts and reports stats', async () => {
    const q = await api().get(`${base('s2')}?q=dealer 17&limit=50`).set(as('BD'));
    expect(q.body.data.length).toBeGreaterThan(0);
    expect(q.body.data.every((s: any) => /dealer 17/i.test(s.dealerName))).toBe(true);
    const d = await api().get(`${base('s2')}?district=chennai&limit=200`).set(as('BD'));
    expect(d.body.data.length).toBeGreaterThan(40);
    expect((await api().get(`${base('s2')}?missing=gst&limit=1`).set(as('BD'))).body.meta.total).toBeGreaterThanOrEqual(1);
    const s = await api().get(`${base('s2')}/stats`).set(as('BD'));
    expect(s.body.data.total).toBe(252);
    expect(s.body.data.districts.length).toBeGreaterThanOrEqual(5);
    expect((await api().get(`${base('s2')}?limit=1000`).set(as('BD'))).status).toBe(422);
    expect((await api().get(`${base('s2')}`).set(as('RECCE_EXECUTIVE'))).status).toBe(403);
  });

  it('revised sheet with policy=update changes existing sites without duplicating', async () => {
    const buf = await xlsx([H2, [1, 'Dealer 1', districts[1], '20 x 6', '1 Main Road', 'Near bus stand', 9000000001, '33AAACA2094M1ZK', 'North']]);
    const up = await api().post(`${base('s2')}/imports`).set(as('BD')).attach('file', buf, 'revised.xlsx');
    const b = up.body.data.batch._id;
    const pv = await api().post(`${base('s2')}/imports/${b}/preview`).set(as('BD')).send({ mapping: up.body.data.suggestedMapping, duplicatePolicy: 'update' });
    expect(pv.body.data.summary.duplicates).toBe(1);
    const c = await api().post(`${base('s2')}/imports/${b}/commit`).set(as('BD')).send({});
    expect(c.body.data.result).toMatchObject({ created: 0, updated: 1 });
    const s = await api().get(`${base('s2')}?q=Dealer 1&sort=seq&limit=1`).set(as('BD'));
    expect(s.body.data[0]).toMatchObject({ dealerName: 'Dealer 1', width: 20, height: 6, sqft: 120 });
    expect((await api().get(`${base('s2')}/stats`).set(as('BD'))).body.data.total).toBe(252);
  });

  it('edits inline with validation, duplicates, deletes, bulk edits', async () => {
    const list = await api().get(`${base('s2')}?limit=5&sort=seq`).set(as('BD'));
    const [s1, s2, s3] = list.body.data;
    const ok = await api().patch(`/api/v1/sites/${s1._id}`).set(as('BD')).send({ width: 12 });
    expect(ok.body.data.site).toMatchObject({ width: 12, sqft: 12 * s1.height });
    const bad = await api().patch(`/api/v1/sites/${s1._id}`).set(as('BD')).send({ mobile: '12' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].path).toBe('mobile');
    const sc = await api().patch(`/api/v1/sites/${s1._id}`).set(as('BD')).send({ scenario: 'MEASUREMENT_REQUIRED' });
    expect(sc.body.data.site.scenario).toBe('MEASUREMENT_REQUIRED');
    const clr = await api().patch(`/api/v1/sites/${s1._id}`).set(as('BD')).send({ address2: '' });
    expect(clr.body.data.site.address2).toBeUndefined();
    const dup = await api().post(`/api/v1/sites/${s2._id}/duplicate`).set(as('BD'));
    expect(dup.status).toBe(201);
    expect(dup.body.data.siteCode).not.toBe(s2.siteCode);
    const bulk = await api().post(`${base('s2')}/bulk`).set(as('BD')).send({ action: 'update', ids: [s2._id, s3._id], patch: { district: 'Salem', width: 5, height: 5 } });
    expect(bulk.body.data.affected).toBe(2);
    const salem = await api().get(`${base('s2')}?district=Salem`).set(as('BD'));
    expect(salem.body.meta.total).toBe(2);
    expect(salem.body.data[0].sqft).toBe(25);
    expect((await api().post(`${base('s2')}/bulk`).set(as('BD')).send({ action: 'update', ids: [s2._id], patch: { shopName: 'x' } })).status).toBe(422);
    expect((await api().post(`${base('s2')}/bulk`).set(as('BD')).send({ action: 'update', patch: { district: 'X' } })).status).toBe(422);
    const del = await api().post(`${base('s2')}/bulk`).set(as('BD')).send({ action: 'delete', filter: { district: 'Salem' } });
    expect(del.body.data.affected).toBe(2);
    expect((await api().delete(`/api/v1/sites/${dup.body.data._id}`).set(as('BD'))).status).toBe(200);
    expect((await api().get(`/api/v1/projects/${ids.s2}`).set(as('BD'))).body.data.siteCount).toBe(252 - 2);
    const hist = await api().get(`/api/v1/projects/${ids.s2}/history`).set(as('BD'));
    expect(hist.body.data.map((h: any) => h.action)).toContain('BULK_UPDATE');
  });

  it('exports the current view as xlsx and csv, neutralising formulas', async () => {
    await api().post(base('s1')).set(as('BD')).send({ shopName: '=HYPERLINK("http://x")', dealerName: 'Evil', district: 'Vellore', address1: 'a', mobile: '9876543210' });
    const csv = await api().get(`${base('s1')}/export?format=csv&columns=siteCode,shopName,district`).set(as('BD'));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toContain('Site ID');
    expect(csv.text).toContain("'=HYPERLINK");
    const x = await api().get(`${base('s2')}/export?district=Chennai&columns=siteCode,dealerName,width,height,sqft`).set(as('BD')).buffer().parse(binary);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body as never);
    const ws = wb.worksheets[0]!;
    const chennai = await api().get(`${base('s2')}?district=Chennai&limit=1`).set(as('BD'));
    expect(ws.rowCount - 1).toBe(chennai.body.meta.total);
    expect(ws.getRow(1).getCell(1).value).toBe('Site ID');
    expect((await api().get(`${base('s2')}/export`).set(as('FINANCE'))).status).toBe(403);
    const t = await api().get(`${base('s2')}/template?scenario=CLIENT_PROVIDED`).set(as('BD')).buffer().parse(binary);
    expect(t.status).toBe(200);
  });
});

describe('Scenario 1 manual entry', () => {
  it('adds, validates, detects duplicates and multi-numbers', async () => {
    const ok = await api().post(base('s1')).set(as('BD')).send({ shopName: 'Lakshmi Electricals', dealerName: 'Lakshmi', district: 'Madurai', address1: '1 Bazaar St', mobile: '98765 43210 / 9123456780' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.site).toMatchObject({ scenario: 'MEASUREMENT_REQUIRED', mobile: '9876543210', mobileAlt: '9123456780' });
    expect(ok.body.data.site.siteCode).toMatch(/-S\d{3}$/);
    expect(ok.body.data.warnings.map((w: any) => w.code)).toEqual([]);
    const body = { shopName: 'LAKSHMI electricals', dealerName: 'lakshmi', district: 'madurai' };
    expect((await api().post(base('s1')).set(as('BD')).send(body)).status).toBe(409);
    expect((await api().post(base('s1')).set(as('BD')).send({ ...body, allowDuplicate: true })).status).toBe(201);
    const bad = await api().post(base('s1')).set(as('BD')).send({ district: 'X', mobile: 'abc' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.map((d: any) => d.path).sort()).toEqual(['mobile', 'shopName']);
  });
});

describe('upload hardening and edge cases', () => {
  const up = (buf: Buffer, name: string) => api().post(`${base('s1')}/imports`).set(as('BD')).attach('file', buf, name);
  it('rejects empty, header-only, wrong type, fake xlsx and oversize files', async () => {
    expect((await up(await xlsx([]), 'empty.xlsx')).status).toBe(400);
    expect((await up(await xlsx([['Shop Name', 'District']]), 'headers.xlsx')).status).toBe(400);
    expect((await up(Buffer.from('hello'), 'x.pdf')).status).toBe(400);
    expect((await up(Buffer.from('not a zip'), 'fake.xlsx')).status).toBe(400);
    expect((await up(Buffer.alloc(11 * 1024 * 1024, 'a'), 'big.csv')).status).toBe(413);
    expect((await api().post(`${base('s1')}/imports`).set(as('BD'))).status).toBe(400);
  });
  it('imports csv, de-duplicating repeated headers', async () => {
    const r = await up(Buffer.from('Shop Name,Shop Name,Mobile\nA Store,dup,9876543210\n'), 'a.csv');
    expect(r.status).toBe(201);
    expect(r.body.data.batch.headers).toEqual(['Shop Name', 'Shop Name (2)', 'Mobile']);
  });
});

describe('10,000 sites', () => {
  it('imports 10k rows and stays queryable/pageable', async () => {
    const rows: unknown[][] = [['Dealer', 'District', 'Size', 'Address', 'Mobile']];
    for (let i = 1; i <= 10000; i++) rows.push([`Big Dealer ${i}`, districts[i % 5], '10 x 4', `${i} Road`, 9000000000 + i]);
    const t0 = Date.now();
    const u = await api().post(`${base('big')}/imports`).set(as('BD')).attach('file', await xlsx(rows), 'big.xlsx');
    expect(u.status).toBe(201);
    const b = u.body.data.batch._id;
    const pv = await api().post(`${base('big')}/imports/${b}/preview`).set(as('BD')).send({ mapping: u.body.data.suggestedMapping });
    expect(pv.body.data.summary).toMatchObject({ error: 0, valid: 10000 });
    const c = await api().post(`${base('big')}/imports/${b}/commit`).set(as('BD')).send({});
    expect(c.body.data.result.created).toBe(10000);
    const secs = (Date.now() - t0) / 1000;
    console.log(`10k import end-to-end: ${secs}s`);
    expect(secs).toBeLessThan(90);
    const p = await api().get(`${base('big')}?page=50&limit=200&sort=-seq`).set(as('BD'));
    expect(p.body.meta).toMatchObject({ total: 10000, page: 50, totalPages: 50 });
    expect(p.body.data.length).toBe(200);
    expect((await api().get(`/api/v1/projects/${ids.big}`).set(as('BD'))).body.data.siteCount).toBe(10000);
    const codes = (await api().get(`${base('big')}?limit=200&sort=siteCode`).set(as('BD'))).body.data.map((s: any) => s.siteCode);
    expect(new Set(codes).size).toBe(200);
  }, 180000);
});
