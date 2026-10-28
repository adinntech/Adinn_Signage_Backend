import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
let projectId = '';
const contact = { name: 'Suresh Kumar', email: 'suresh@client.example', phone: '9876543210' };
const calls: { url: string; init?: { headers?: Record<string, string>; body?: string } }[] = [];

beforeAll(async () => {
  vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://maps.googleapis.com/maps/api/geocode/json')) {
      return { ok: true, status: 200, json: async () => ({ status: 'OK', results: [{ geometry: { location: { lat: 8.2, lng: 77.3 }, location_type: 'ROOFTOP' }, types: ['street_address'] }] }) };
    }
    if (String(url) === 'https://routes.googleapis.com/directions/v2:computeRoutes') {
      const n = (JSON.parse(init?.body ?? '{}') as { intermediates?: unknown[] }).intermediates?.length ?? 0;
      return {
        ok: true, status: 200,
        // visits the stops in reverse; 122.4 km, 3 hr 43 min; the polyline is Google's documented example
        json: async () => ({ routes: [{ distanceMeters: 122400, duration: '13380s', polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }, optimizedIntermediateWaypointIndex: Array.from({ length: n }, (_, i) => n - 1 - i) }] }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  process.env.ROUTING_URL = '';
  process.env.GEOCODER_URL = '';
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
  const clientId = (await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Google Client', code: 'GGL' })).body.data._id;
  projectId = (await api().post('/api/v1/projects').set(as('BD')).send({ clientId, campaign: 'Kanyakumari', status: 'DRAFT', requirementType: 'SHOP_DETAILS', expectedShops: 3, startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Kanyakumari', contacts: [contact] })).body.data._id;
  await api().post(`/api/v1/projects/${projectId}/assign`).set(as('BD')).send({ assigneeId: uid.OPS });
  const shops: [string, string, string, string][] = [['FAYAZ HARDWARE', '30-1-D, MAIN ROAD', 'Colachel', '9443607543'], ['NU COLOURS', '8/105-3, ERACHAKULAM', 'Erachakulam', '8015763231'], ['NRS MATHA TRADERS', '20-5B', 'Kadayal', '7598030001']];
  for (const [shopName, address1, address3, mobile] of shops) await api().post(`/api/v1/projects/${projectId}/sites`).set(as('OPS')).send({ shopName, dealerName: shopName, district: 'Kanyakumari', address1, address3, pincode: '629251', mobile });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await disconnectDb();
  await mongod.stop();
});

const A = () => `/api/v1/projects/${projectId}/allocation`;
const C = () => `/api/v1/projects/${projectId}/cost`;

describe('with a Google Maps key', () => {
  it('finds shops the way Google Maps does and says how exact the match is', async () => {
    const r = await api().post(`${A()}/geocode`).set(as('OPS')).send({ limit: 10 });
    expect(r.body.data).toMatchObject({ tried: 3, found: 3, remaining: 0 });
    const geo = calls.find((c) => c.url.startsWith('https://maps.googleapis.com/maps/api/geocode/json'))!;
    expect(geo.url).toContain('key=test-key');
    expect(geo.url).toContain('components=country:IN');
    expect(decodeURIComponent(geo.url)).toContain('MAIN ROAD');
    const shops = (await api().get(`${A()}/shops`).set(as('OPS'))).body.data as { geoQuality?: string; lat: number }[];
    expect(shops.every((s) => s.geoQuality === 'ADDRESS' && s.lat === 8.2)).toBe(true);
  });

  it('gets a two-wheeler road round trip from Google, with the best stop order', async () => {
    await api().put(`${A()}/origin`).set(as('OPS')).send({ name: 'Erachakulam office', lat: 8.19, lng: 77.31 });
    await api().post(`${C()}/sync`).set(as('OPS'));
    const r = await api().post(`${C()}/legs/kanyakumari/route`).set(as('OPS'));
    expect(r.status).toBe(200);
    expect(r.body.data.route).toMatchObject({ located: 3, roadDistance: true, totalKm: 122.4 });
    expect(r.body.data.route.days[0]).toMatchObject({ km: 122.4, minutes: 223, source: 'ROAD' });
    const call = calls.find((c) => c.url === 'https://routes.googleapis.com/directions/v2:computeRoutes')!;
    expect(call.init?.headers?.['X-Goog-Api-Key']).toBe('test-key');
    const body = JSON.parse(call.init!.body!) as { travelMode: string; optimizeWaypointOrder: boolean; intermediates: unknown[] };
    expect(body).toMatchObject({ travelMode: 'TWO_WHEELER', optimizeWaypointOrder: true });
    expect(body.intermediates).toHaveLength(3);
  });

  it('builds Google Maps links from the written addresses, even before the shops are located', async () => {
    const r = await api().get(`${C()}/legs/kanyakumari/map-links`).set(as('OPS'));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ key: 'kanyakumari', shops: 3 });
    const url = r.body.data.days[0].googleUrl as string;
    expect(url.startsWith('https://www.google.com/maps/dir/8.190000,77.310000/')).toBe(true);
    expect(decodeURIComponent(url)).toContain('FAYAZ HARDWARE, 30-1-D, MAIN ROAD, Colachel, Kanyakumari, 629251');
    expect(url.split('/maps/dir/')[1]!.split('/')).toHaveLength(5); // start, 3 shops, back to start
    expect((await api().get(`${C()}/legs/nowhere/map-links`).set(as('OPS'))).status).toBe(404);
  });
});
