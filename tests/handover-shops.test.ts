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
let root: string;
let token = '';
const as = () => ({ Authorization: `Bearer ${token}` });
const api = () => request(app);

let seq = 0;
const newOrder = async (type: 'SHOP_DETAILS' | 'SHOP_MEASUREMENT' | 'ASO') => {
  seq++;
  const r = await api()
    .post('/api/v1/sales/orders/new-client')
    .set(as())
    .send({ name: `Shop Client ${seq}`, email: `shop${seq}@x.example`, contacts: [{ name: 'Ravi', phone: `98765${String(43210 + seq).slice(-5)}`, isPrimary: true }] });
  expect(r.status).toBe(201);
  const id = r.body.data.order._id as string;
  expect((await api().patch(`/api/v1/sales/orders/${id}/handover/type`).set(as()).send({ type })).status).toBe(200);
  return id;
};

const xlsx = async (rows: unknown[][], sheets: { name: string; rows: unknown[][] }[] = []) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Shops');
  for (const r of rows) ws.addRow(r);
  for (const s of sheets) {
    const w = wb.addWorksheet(s.name);
    for (const r of s.rows) w.addRow(r);
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
};
const upload = (id: string, buf: Buffer, name = 'shops.xlsx', fields: Record<string, string> = {}) => {
  const req = api().post(`/api/v1/sales/orders/${id}/handover/shops`).set(as());
  for (const [k, v] of Object.entries(fields)) req.field(k, v);
  return req.attach('files', buf, name);
};
const list = async (id: string) => (await api().get(`/api/v1/sales/orders/${id}/handover/shops?page=1&limit=100`).set(as())).body as { data: Record<string, any>[]; meta: { columns: { id: string; header: string }[] | null } };
const history = async (id: string) => (await api().get(`/api/v1/sales/orders/${id}/handover/shop-history`).set(as())).body.data as Record<string, any>[];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-shops-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  await User.create({ name: 'BD', email: 'bd@t.com', role: 'BD', passwordHash: await hashPassword('Passw0rd!x') });
  token = (await api().post('/api/v1/auth/login').send({ email: 'bd@t.com', password: 'Passw0rd!x' })).body.data.accessToken;
});
afterAll(async () => {
  await disconnectDb?.();
  await mongod?.stop();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('handover shop Excel upload', () => {
  it('imports the first file into an empty table and again after Clear All (both shop types)', async () => {
    for (const type of ['SHOP_DETAILS', 'SHOP_MEASUREMENT'] as const) {
      const id = await newOrder(type);
      const r = await upload(id, await xlsx([['Shop Name', 'District', 'Mobile', 'Size (W x H)'], ['ABC Traders', 'Vellore', '9876543210', '10x4']]));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const { data } = await list(id);
      expect(data).toHaveLength(1);
      if (type === 'SHOP_DETAILS') expect(data[0]!.width ?? null).toBeNull();
      else expect(data[0]).toMatchObject({ width: 10, height: 4 });
      expect((await api().delete(`/api/v1/sales/orders/${id}/handover/shops`).set(as())).status).toBe(200);
      expect((await upload(id, await xlsx([['Shop Name'], ['Two']]))).status).toBe(201);
    }
  });

  it('keeps the sheet columns as uploaded, with cell edits, added rows and history after a reload', async () => {
    const id = await newOrder('SHOP_DETAILS');
    const r = await upload(id, await xlsx([['Outlet Code', 'PIN', 'Phone No', 'Retailer', 'Beat', ''], ['007', '600001', '+91 98765 43210', 'Kumar Stores', 'North', 'x']]));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const { data, meta } = await list(id);
    const columns = meta.columns!;
    expect(columns.map((c) => c.header)).toEqual(['Outlet Code', 'PIN', 'Phone No', 'Retailer', 'Beat', '']);
    const row = data[0]!;
    expect(columns.map((c) => row.cells[c.id] ?? '')).toEqual(['007', '600001', '+91 98765 43210', 'Kumar Stores', 'North', 'x']);
    const beat = columns.find((c) => c.header === 'Beat')!.id;
    expect((await api().put(`/api/v1/sales/orders/${id}/handover/shop-rows/${row.rowId}`).set(as()).send({ cells: { ...row.cells, [beat]: 'South' } })).status).toBe(200);
    expect((await api().post(`/api/v1/sales/orders/${id}/handover/shop-rows`).set(as()).send({ cells: { [beat]: 'East' } })).status).toBe(201);
    expect((await list(id)).data.map((x) => x.cells[beat])).toEqual(['South', 'East']);
    const edit = (await history(id)).find((l) => l.action === 'EDIT')!;
    expect(edit.cells).toEqual([{ column: 'Beat', before: 'North', after: 'South' }]);
  });

  it('asks which sheet when several have a list', async () => {
    const id = await newOrder('SHOP_DETAILS');
    const buf = await xlsx([['Shop Name'], ['A']], [{ name: 'Second', rows: [['Shop Name'], ['B']] }]);
    const r = await upload(id, buf);
    expect(r.status).toBe(422);
    expect(r.body.error.details.preview.sheets.map((s: { name: string }) => s.name)).toEqual(['Shops', 'Second']);
    const ok = await upload(id, buf, 'shops.xlsx', { sheet: 'Second' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const { data, meta } = await list(id);
    expect(data[0]!.cells[meta.columns![0]!.id]).toBe('B');
  });

  it('rejects malformed files with a clear 400', async () => {
    const id = await newOrder('SHOP_DETAILS');
    const bad = await upload(id, Buffer.from('not a workbook'), 'shops.xlsx');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).not.toBe('INTERNAL_ERROR');
  });

  it('records history for imports and row edits / deletes', async () => {
    const id = await newOrder('SHOP_MEASUREMENT');
    await upload(id, await xlsx([['Shop Name', 'Mobile'], ['Hist Shop', '9876543210']]));
    const { data, meta } = await list(id);
    const row = data[0]!;
    const name = meta.columns![0]!.id;
    expect((await api().put(`/api/v1/sales/orders/${id}/handover/shop-rows/${row.rowId}`).set(as()).send({ cells: { ...row.cells, [name]: 'Hist Shop 2' }, width: '8', height: '3' })).status).toBe(200);
    expect((await api().delete(`/api/v1/sales/orders/${id}/handover/shop-rows/${row.rowId}`).set(as())).status).toBe(200);
    const h = await history(id);
    expect(h.map((l) => l.action)).toEqual(expect.arrayContaining(['IMPORT', 'ADD', 'EDIT', 'DELETE']));
    const edit = h.find((l) => l.action === 'EDIT')!;
    expect(edit.cells).toEqual([{ column: 'Shop Name', before: 'Hist Shop', after: 'Hist Shop 2' }]);
    expect(edit.after).toMatchObject({ width: 8, height: 3 });
    expect(h.find((l) => l.action === 'DELETE')!.cells[0]).toMatchObject({ column: 'Shop Name', before: 'Hist Shop 2' });
  });
});
