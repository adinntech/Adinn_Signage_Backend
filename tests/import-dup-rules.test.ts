import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import ExcelJS from 'exceljs';
import type { Express } from 'express';
import { dupKeysOf } from '../src/modules/sites/site.fields';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let token = '';
let pid = '';
const auth = () => ({ Authorization: `Bearer ${token}` });
const api = () => request(app);

async function xlsx(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Shops');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
const HEAD = ['S.no', 'Shop Name', 'Owner Name', 'Address', 'Mobile no', 'GST', 'Area', 'District'];

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
  await User.create({ name: 'BD', email: 'bd@t.com', role: 'BD', passwordHash: await hashPassword('Passw0rd!x') });
  token = (await api().post('/api/v1/auth/login').send({ email: 'bd@t.com', password: 'Passw0rd!x' })).body.data.accessToken;
  const c = await api().post('/api/v1/clients').set(auth()).send({ name: 'Dup Client', code: 'DUP' });
  const p = await api().post('/api/v1/projects').set(auth()).send({ clientId: c.body.data._id, campaign: 'dups', requirement: { source: 'EMAIL', siteDataScenario: 'MEASUREMENT_REQUIRED' } });
  pid = p.body.data._id;
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

describe('what counts as a duplicate shop', () => {
  it('uses the mobile number, or the same shop + dealer + location; never GST, address or the dealer alone', () => {
    expect(dupKeysOf({ shopName: 'A', mobile: '98765 43210' })).toContain('mob:9876543210');
    const same = (a: object, b: object) => dupKeysOf(a).some((k) => dupKeysOf(b).includes(k));
    // same shop, dealer and location, written differently
    expect(same({ shopName: 'Ram Electricals', dealerName: 'Ram', location: 'Palani' }, { shopName: 'RAM electricals ', dealerName: 'ram', location: 'palani' })).toBe(true);
    // same owner, different shops
    expect(same({ shopName: 'Ram Electricals', dealerName: 'Ram', location: 'Palani', mobile: '9000000001' }, { shopName: 'Sri Ram Electricals', dealerName: 'Ram', location: 'Palani', mobile: '9000000002' })).toBe(false);
    // same shop name, different dealer or different area
    expect(same({ shopName: 'Ganesh Traders', dealerName: 'Ganesh', location: 'Dindigul' }, { shopName: 'Ganesh Traders', dealerName: 'Mani', location: 'Dindigul' })).toBe(false);
    expect(same({ shopName: 'Ganesh Traders', dealerName: 'Ganesh', location: 'Dindigul' }, { shopName: 'Ganesh Traders', dealerName: 'Ganesh', location: 'Palani' })).toBe(false);
    // a GST number is never an identity
    expect(dupKeysOf({ shopName: 'A', gstin: '33AAACA1111M1ZK' } as never).some((k) => k.startsWith('gst'))).toBe(false);
  });
});

describe('review step: duplicates and bulk skip', () => {
  let batch = '';
  it('flags only real duplicates (same mobile, or same shop + dealer + location)', async () => {
    const first = await api().post(`/api/v1/projects/${pid}/sites/imports`).set(auth()).attach('file', await xlsx([HEAD, [1, 'Existing Shop', 'Owner One', '10 Main Road Palani', 9000000001, '33AAACA0001M1ZK', 'Palani', 'Dindigul']]), 'a.xlsx');
    const b1 = first.body.data.batch._id;
    await api().post(`/api/v1/projects/${pid}/sites/imports/${b1}/preview`).set(auth()).send({ mapping: first.body.data.suggestedMapping, duplicatePolicy: 'skip' });
    expect((await api().post(`/api/v1/projects/${pid}/sites/imports/${b1}/commit`).set(auth()).send({})).status).toBe(200);

    const rows = [
      HEAD,
      [1, 'Renamed Shop', 'Owner Z', '99 Other Street', 9000000001, '33AAACA0009M1ZK', 'Ammapatti', 'Dindigul'], // same mobile as the existing shop
      [2, 'Existing Shop', 'Owner One', '10 Main Road Palani', 9000000003, '', 'Palani', 'Dindigul'], // same shop + dealer + location
      [8, 'Existing Shop', 'Owner Two', '10 Main Road Palani', 9000000008, '33AAACA0001M1ZK', 'Palani', 'Dindigul'], // same shop name, other dealer, same GST: not a duplicate
      [3, 'Ram Electricals', 'Ram', '10 Cinema Road', 9000000004, '33AAACA0003M1ZK', 'Oddanchatram', 'Dindigul'],
      [4, 'Sri Ram Electricals', 'Ram', '22 Bus Stand Road', 9000000005, '33AAACA0004M1ZK', 'Oddanchatram', 'Dindigul'], // same owner, different shop
      [5, 'Ganesh Traders', 'Ganesh', '1 Market Street', 9000000006, '', 'Dindigul', 'Dindigul'],
      [6, 'Ganesh Traders', 'Mani', '9 Temple Road', 9000000007, '', 'Dindigul', 'Dindigul'], // same shop name, different dealer
      [7, 'No Mobile Shop', '', '', '', '', 'Dindigul', 'Dindigul'],
    ];
    const up = await api().post(`/api/v1/projects/${pid}/sites/imports`).set(auth()).attach('file', await xlsx(rows), 'b.xlsx');
    batch = up.body.data.batch._id;
    const pv = await api().post(`/api/v1/projects/${pid}/sites/imports/${batch}/preview`).set(auth()).send({ mapping: up.body.data.suggestedMapping, duplicatePolicy: 'skip' });
    expect(pv.status).toBe(200);
    expect(pv.body.data.summary.duplicates).toBe(2);
    const list = await api().get(`/api/v1/projects/${pid}/sites/imports/${batch}/rows?limit=50`).set(auth());
    const dupRows = list.body.data.filter((r: { dup?: { type: string } }) => r.dup?.type).map((r: { rowNumber: number }) => r.rowNumber);
    expect(dupRows).toEqual([2, 3]);
    expect(list.body.data.some((r: { dup?: { type: string } }) => r.dup?.type === 'DEALER')).toBe(false);
  });

  it('skips all duplicates in one go, and restores them', async () => {
    const s = await api().post(`/api/v1/projects/${pid}/sites/imports/${batch}/rows/skip`).set(auth()).send({ scope: 'DUPLICATE', skipped: true });
    expect(s.status).toBe(200);
    expect(s.body.data.changed).toBe(2);
    expect(s.body.data.summary.skipped).toBe(2);
    const all = await api().post(`/api/v1/projects/${pid}/sites/imports/${batch}/rows/skip`).set(auth()).send({ scope: 'ALL', skipped: false });
    expect(all.body.data.summary.skipped).toBe(0);
    expect((await api().post(`/api/v1/projects/${pid}/sites/imports/${batch}/rows/skip`).set(auth()).send({ scope: 'NOPE', skipped: true })).status).toBe(422);
    const commit = await api().post(`/api/v1/projects/${pid}/sites/imports/${batch}/commit`).set(auth()).send({});
    expect(commit.status).toBe(200);
    expect(commit.body.data.result.created).toBe(6);
    expect(commit.body.data.result.skippedRows).toBe(2);
  });
});

describe('importing the same Excel again adds only the new shops', () => {
  const rows = (n: number) => [
    HEAD,
    ...Array.from({ length: n }, (_, i) => [i + 1, `Again Shop ${i + 1}`, `Owner ${i + 1}`, `${i + 1} Again Street`, 9100000000 + i, `33BBBCB${String(i).padStart(4, '0')}M1ZK`, 'Natham', 'Dindigul']),
  ];
  const run = async (data: unknown[][]) => {
    const up = await api().post(`/api/v1/projects/${pid}/sites/imports`).set(auth()).attach('file', await xlsx(data), 'again.xlsx');
    const b = up.body.data.batch._id as string;
    const pv = await api().post(`/api/v1/projects/${pid}/sites/imports/${b}/preview`).set(auth()).send({ mapping: up.body.data.suggestedMapping, duplicatePolicy: 'skip' });
    const to = await api().get(`/api/v1/projects/${pid}/sites/imports/${b}/rows?state=IMPORT&limit=100`).set(auth());
    const commit = await api().post(`/api/v1/projects/${pid}/sites/imports/${b}/commit`).set(auth()).send({});
    return { summary: pv.body.data.summary, willImport: to.body.data.length as number, created: commit.body.data.result.created as number };
  };

  it('first time all rows come in; the second time only the new row; the third time nothing', async () => {
    const { Site } = await import('../src/modules/sites/site.model');
    const before = await Site.countDocuments({ project: pid, deletedAt: null });
    const a = await run(rows(3));
    expect(a.summary.importable).toBe(3);
    expect(a.willImport).toBe(3);
    expect(a.created).toBe(3);
    const b = await run(rows(4)); // the same 3 plus one new
    expect(b.summary.duplicates).toBe(3);
    expect(b.summary.importable).toBe(1);
    expect(b.willImport).toBe(1);
    expect(b.created).toBe(1);
    const c = await run(rows(4));
    expect(c.summary.importable).toBe(0);
    expect(c.created).toBe(0);
    expect(await Site.countDocuments({ project: pid, deletedAt: null })).toBe(before + 4);
  });
});

describe('area (cluster) filter and deleting one import', () => {
  it('lists the areas of each district with counts, filters by area, and deletes only one import', async () => {
    const { ImportBatch } = await import('../src/modules/sites/site.model');
    const stats = await api().get(`/api/v1/projects/${pid}/sites/stats`).set(auth());
    const natham = stats.body.data.locations.find((l: { location: string }) => l.location.toLowerCase() === 'natham');
    expect(natham).toMatchObject({ district: 'Dindigul', count: 4 });
    const area = await api().get(`/api/v1/projects/${pid}/sites?location=natham&limit=50`).set(auth());
    expect(area.body.data).toHaveLength(4);
    expect((await api().get(`/api/v1/projects/${pid}/sites?location=nowhere`).set(auth())).body.data).toHaveLength(0);

    // delete everything the first "again.xlsx" import created (3 shops); the 4th shop came from the second import
    const batches = await ImportBatch.find({ project: pid, fileName: 'again.xlsx', 'result.created': { $gt: 0 } }).sort({ createdAt: 1 }).lean();
    expect(batches).toHaveLength(2);
    const del = await api().post(`/api/v1/projects/${pid}/sites/bulk`).set(auth()).send({ action: 'delete', filter: { importBatchId: String(batches[0]!._id) } });
    expect(del.status).toBe(200);
    expect(del.body.data.affected).toBe(3);
    expect((await api().get(`/api/v1/projects/${pid}/sites?location=natham&limit=50`).set(auth())).body.data).toHaveLength(1);
  });
});
