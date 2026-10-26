import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root: string;
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
let projectId = '';
const contact = { name: 'Suresh Kumar', email: 'suresh@client.example', phone: '9876543210' };
const fetchCalls: string[] = [];

/** The sheet as the client sends it: S.No, Customer Name, District, Size, Remarks, Address 1-3, Dis, Pin, PH, GST. */
async function clientSheet() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['S.No', 'Customer Name', 'District', 'Size', 'Remarks', 'Address 1', 'Address 2', 'Address 3', 'Dis', 'Pin', 'PH', 'GST']);
  ws.addRow([1, 'FAYAZ HARDWREAS (COLACHAL)', 'KANYAKUMARI', '10*4', 'Signage Board', '30-1-D, MAIN ROAD', '', '', 'KANYAKUMARI', 629251, '+91 94436 07543', '33GXOPM0159M1ZY']);
  ws.addRow([2, 'NU COLOURS AND HARDWARES (ERACHAKULAM)', 'KANYAKUMARI', '10*4', 'Signage Board', '8/105-3, ERACHAKULAM', 'BALAMORE ROAD, BOOTHAPANDI', 'ERACHAKULAM', 'KANYAKUMARI', 629901, '+91 80157 63231', '33GXOPM0159M1ZX']);
  ws.addRow([3, 'N.R.S. MATHA LEKSHMI TRADERS (KADAYAL)', 'KANYAKUMARI', '8*4', 'Signage Board', '20-5B', 'CHENKUZHI KARAI', 'KALIYAL', 'KANYAKUMARI', 629101, '+91 75980 30001', '']);
  ws.addRow([4, 'ZION R.B.S TRADERS', 'KANYAKUMARI', '8*4', 'Signage Board', 'NOWHERE ROAD', '', '', 'KANYAKUMARI', '', '+91 94431 02395', '']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

beforeAll(async () => {
  vi.stubGlobal('fetch', async (url: string) => {
    fetchCalls.push(String(url));
    const u = String(url);
    if (u.includes('/search')) {
      const q = decodeURIComponent(u.split('q=')[1] ?? '');
      return { ok: true, status: 200, json: async () => (q.includes('NOWHERE') ? [] : [{ lat: '8.2', lon: '77.3' }]) };
    }
    if (u.includes('/trip/')) {
      const n = (u.split('/trip/v1/driving/')[1] ?? '').split('?')[0]!.split(';').length;
      return {
        ok: true, status: 200,
        json: async () => ({
          code: 'Ok',
          trips: [{ distance: 122400, duration: 13380, geometry: { coordinates: [[77.3, 8.2], [77.31, 8.21]] } }],
          waypoints: Array.from({ length: n }, (_, i) => ({ waypoint_index: i === 0 ? 0 : n - i })), // visits the points in reverse
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-maps-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  process.env.ROUTING_URL = 'http://routing.test';
  process.env.GEOCODER_URL = 'http://geo.test';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  for (const [key, role] of [['BD', 'BD'], ['OPS', 'OPERATIONS']] as const) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const clientId = (await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Map Client', code: 'MAP' })).body.data._id;
  projectId = (await api().post('/api/v1/projects').set(as('BD')).send({ clientId, campaign: 'Kanyakumari', status: 'DRAFT', requirementType: 'SHOP_MEASUREMENT', expectedShops: 4, startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Kanyakumari', contacts: [contact] })).body.data._id;
  await api().post(`/api/v1/projects/${projectId}/assign`).set(as('BD')).send({ assigneeId: uid.OPS });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("extracting the shops from the file BD attached", () => {
  let fileId = '';
  it('reads the stored attachment, no re-upload needed, and maps the client columns', async () => {
    const up = await api().post(`/api/v1/projects/${projectId}/files`).set(as('BD')).field('category', 'BD_CLIENT_DETAILS').attach('files', await clientSheet(), { filename: 'Shop_List.xlsx' });
    expect(up.status).toBe(201);
    const list = (up.body.data.files ?? up.body.data) as { _id?: string; id?: string }[];
    fileId = String(list[0]!._id ?? list[0]!.id);
    const ex = await api().post(`/api/v1/projects/${projectId}/sites/imports/from-file`).set(as('OPS')).send({ fileId });
    expect(ex.status).toBe(201);
    expect(ex.body.data.batch.totalRows).toBe(4);
    expect(ex.body.data.suggestedMapping).toMatchObject({ 'Customer Name': 'dealerName', Size: 'size', 'Address 3': 'address3', PH: 'mobile', GST: 'gstin', Pin: 'pincode' });
    expect(ex.body.data.problems).toEqual([]);
    const batchId = ex.body.data.batch._id;
    const pv = await api().post(`/api/v1/projects/${projectId}/sites/imports/${batchId}/preview`).set(as('OPS')).send({ mapping: ex.body.data.suggestedMapping, scenario: 'CLIENT_PROVIDED', defaultUnit: 'ft', duplicatePolicy: 'skip' });
    expect(pv.status).toBe(200);
    const done = await api().post(`/api/v1/projects/${projectId}/sites/imports/${batchId}/commit`).set(as('OPS')).send({});
    expect(done.status).toBe(200);
    const sites = (await api().get(`/api/v1/projects/${projectId}/sites?sort=seq`).set(as('OPS'))).body.data as { dealerName: string; width: number; location: string; mobile: string }[];
    expect(sites).toHaveLength(4);
    expect(sites[0]).toMatchObject({ width: 10, location: 'Colachal', mobile: '9443607543' });
    expect(sites[2]).toMatchObject({ width: 8, location: 'Kadayal' });
  });

  it('refuses files that are not attachments of this project, and non-sheets', async () => {
    expect((await api().post(`/api/v1/projects/${projectId}/sites/imports/from-file`).set(as('OPS')).send({ fileId: '64b7f0f0f0f0f0f0f0f0f0f0' })).status).toBe(404);
    expect((await api().post(`/api/v1/projects/${projectId}/sites/imports/from-file`).set(as('OPS')).send({})).status).toBe(422);
  });
});

describe('finding shops on the map and planning the road trips', () => {
  const A = () => `/api/v1/projects/${projectId}/allocation`;

  it('looks shops up from their address, area and pincode, and reports the ones it cannot find', async () => {
    const r = await api().post(`${A()}/geocode`).set(as('OPS')).send({ limit: 10 });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ tried: 4, found: 3, remaining: 0 });
    expect(r.body.data.notFound).toHaveLength(1);
    expect(fetchCalls.some((u) => u.startsWith('http://geo.test/search'))).toBe(true);
    const shops = (await api().get(`${A()}/shops`).set(as('OPS'))).body.data as { lat: number | null; geoQuality?: string }[];
    expect(shops.filter((s) => s.lat != null)).toHaveLength(3);
    expect(shops.find((s) => s.lat != null)!.geoQuality).toBeTruthy();
  });

  it('plans each day as a road round trip with the real distance and a Google Maps link', async () => {
    await api().put(`${A()}/origin`).set(as('OPS')).send({ name: 'Erachakulam office', lat: 8.19, lng: 77.31 });
    const sites = (await api().get(`${A()}/shops`).set(as('OPS'))).body.data as { _id: string }[];
    expect((await api().post(`${A()}/assign`).set(as('OPS')).send({ siteIds: sites.map((s) => s._id), channel: 'IN_HOUSE' })).status).toBe(200);
    const it = await api().get(`${A()}/itinerary?shopsPerDay=8`).set(as('OPS'));
    expect(it.status).toBe(200);
    expect(it.body.data.totalShops).toBe(3);
    expect(it.body.data.withoutCoords).toBe(1);
    expect(it.body.data.roadDistance).toBe(true);
    const day = it.body.data.days[0];
    expect(day).toMatchObject({ day: 1, km: 122.4, minutes: 223, source: 'ROAD' });
    expect(day.stops).toHaveLength(3);
    expect(day.googleUrl).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/8\.190000,77\.310000\//);
    expect(day.googleUrl.split('/maps/dir/')[1]!.split('/')).toHaveLength(5); // start, 3 shops, back to start
    expect(day.path.length).toBeGreaterThan(1);
    expect(it.body.data.estimate).toMatchObject({ days: 1, nights: 0 });
  });

  it('falls back to a straight-line estimate when the road service is down', async () => {
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    const it = await api().get(`${A()}/itinerary?shopsPerDay=8`).set(as('OPS'));
    vi.stubGlobal('fetch', original);
    expect(it.status).toBe(200);
    expect(it.body.data.roadDistance).toBe(false);
    expect(it.body.data.days[0].source).toBe('ESTIMATE');
    expect(it.body.data.days[0].km).toBeGreaterThan(0);
  });
});
