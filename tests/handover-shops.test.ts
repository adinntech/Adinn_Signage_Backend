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
const rows = async (id: string) => (await api().get(`/api/v1/sales/orders/${id}/handover/shops?page=1&limit=100`).set(as())).body.data;

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
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('handover shop Excel upload', () => {
  it('imports the first file into an empty table (both shop types)', async () => {
    for (const type of ['SHOP_DETAILS', 'SHOP_MEASUREMENT'] as const) {
      const id = await newOrder(type);
      const r = await upload(id, await xlsx([['Shop Name', 'District', 'Mobile', 'Size (W x H)'], ['ABC Traders', 'Vellore', '9876543210', '10x4']]));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const list = await rows(id);
      expect(list).toHaveLength(1);
      if (type === 'SHOP_DETAILS') expect(list[0].width ?? null).toBeNull();
      else expect(list[0]).toMatchObject({ width: 10, height: 4 });
    }
  });

  it('imports again after the table was cleared', async () => {
    const id = await newOrder('SHOP_DETAILS');
    expect((await upload(id, await xlsx([['Shop Name'], ['One']]))).status).toBe(201);
    expect((await api().delete(`/api/v1/sales/orders/${id}/handover/shops`).set(as())).status).toBe(200);
    const r = await upload(id, await xlsx([['Shop Name'], ['Two']]));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('maps other header names and column orders, keeps extra columns and leading zeros', async () => {
    const id = await newOrder('SHOP_DETAILS');
    const r = await upload(id, await xlsx([['Outlet Code', 'PIN', 'Phone No', 'Retailer', 'Beat'], ['007', '600001', '09876543210', 'Kumar Stores', 'North']]));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const [row] = await rows(id);
    expect(row.shopName ?? row.dealerName).toBe('Kumar Stores');
    expect(row.pincode).toBe('600001');
    expect(row.extra).toMatchObject({ Beat: 'North' });
  });

  it('asks for a mapping when no shop or dealer column is recognised, then imports with it', async () => {
    const id = await newOrder('SHOP_DETAILS');
    const buf = await xlsx([['Name of party', 'Town'], ['Sri Balaji', 'Salem']]);
    const r = await upload(id, buf);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('SHOP_MAPPING_REQUIRED');
    expect(r.body.error.details.preview.headers).toEqual(['Name of party', 'Town']);
    const ok = await upload(id, buf, 'shops.xlsx', { mapping: JSON.stringify({ 'Name of party': 'shopName', Town: 'district' }) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await rows(id))[0]).toMatchObject({ shopName: 'Sri Balaji', district: 'Salem' });
  });

  it('asks which sheet to use when several have data', async () => {
    const id = await newOrder('SHOP_DETAILS');
    const buf = await xlsx([['Shop Name'], ['A']], [{ name: 'Second', rows: [['Shop Name'], ['B']] }]);
    const r = await upload(id, buf);
    expect(r.status).toBe(422);
    expect(r.body.error.details.preview.sheets.map((s: { name: string }) => s.name)).toEqual(['Shops', 'Second']);
    const ok = await upload(id, buf, 'shops.xlsx', { sheet: 'Second' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await rows(id))[0].shopName).toBe('B');
  });

  it('rejects malformed and unsupported files with a clear 400', async () => {
    const id = await newOrder('SHOP_DETAILS');
    const bad = await upload(id, Buffer.from('not a workbook'), 'shops.xlsx');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).not.toBe('INTERNAL_ERROR');
  });

  it('records history for imports and row edits / deletes', async () => {
    const id = await newOrder('SHOP_MEASUREMENT');
    await upload(id, await xlsx([['Shop Name', 'Mobile'], ['Hist Shop', '9876543210']]));
    const [row] = await rows(id);
    expect((await api().put(`/api/v1/sales/orders/${id}/handover/shop-rows/${row.rowId}`).set(as()).send({ shopName: 'Hist Shop 2', mobile: '9876543210' })).status).toBe(200);
    expect((await api().delete(`/api/v1/sales/orders/${id}/handover/shop-rows/${row.rowId}`).set(as())).status).toBe(200);
    const h = (await api().get(`/api/v1/sales/orders/${id}/handover/shop-history`).set(as())).body.data;
    expect(h.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining(['IMPORT', 'ADD', 'EDIT', 'DELETE']));
    const edit = h.find((l: { action: string }) => l.action === 'EDIT');
    expect(edit.before.shopName).toBe('Hist Shop');
    expect(edit.after.shopName).toBe('Hist Shop 2');
    expect(h.find((l: { action: string }) => l.action === 'DELETE').before.shopName).toBe('Hist Shop 2');
  });
});
