import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let otherProjectId = '';
let siteId = '';

const contact = { name: 'Suresh Kumar', email: 'suresh@client.example', phone: '9876543210' };

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
  for (const [key, role] of [['BD', 'BD'], ['OPS', 'OPERATIONS'], ['OPS2', 'OPERATIONS'], ['ADMIN', 'SUPER_ADMIN']] as const) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const clientId = (await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Board Client', code: 'BRD' })).body.data._id;
  const mk = async (campaign: string) =>
    (await api().post('/api/v1/projects').set(as('BD')).send({ clientId, campaign, status: 'DRAFT', requirementType: 'ASO', startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Madurai', contacts: [contact] })).body.data as { _id: string };
  projectId = (await mk('ASO One'))._id;
  otherProjectId = (await mk('ASO Two'))._id;
  await api().post(`/api/v1/projects/${projectId}/assign`).set(as('BD')).send({ assigneeId: uid.OPS });
  siteId = (await api().post(`/api/v1/projects/${projectId}/sites`).set(as('OPS')).send({ shopName: 'Murugan Stores', dealerName: 'Murugan', location: 'Theppakulam', district: 'Madurai', mobile: '9843011122' })).body.data.site._id;
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

describe('board options per shop', () => {
  let boardId = '';

  it('records several boards for one shop and computes sq.ft', async () => {
    const r = await api().post(`/api/v1/projects/${projectId}/boards`).set(as('OPS')).send({ siteId, boardType: 'GSB Glow Sign', width: 10, height: 4, unit: 'ft', quantity: 2 });
    expect(r.status).toBe(201);
    expect(r.body.data.sqft).toBe(80);
    expect(r.body.data.decision).toBe('PENDING');
    boardId = r.body.data._id;
    expect((await api().post(`/api/v1/projects/${projectId}/boards`).set(as('OPS')).send({ siteId, boardType: 'ACP Board', width: 8, height: 3 })).status).toBe(201);
    const list = await api().get(`/api/v1/projects/${projectId}/boards?siteId=${siteId}`).set(as('OPS'));
    expect(list.body.data).toHaveLength(2);
  });

  it('rejects a shop that belongs to another project and bad input', async () => {
    expect((await api().post(`/api/v1/projects/${otherProjectId}/boards`).set(as('BD')).send({ siteId, boardType: 'ACP Board' })).status).toBe(404);
    expect((await api().post(`/api/v1/projects/${projectId}/boards`).set(as('OPS')).send({ siteId, boardType: 'x' })).status).toBe(422);
  });

  it('needs a reason to reject or change, not to approve', async () => {
    expect((await api().post(`/api/v1/boards/${boardId}/decision`).set(as('BD')).send({ decision: 'REJECTED' })).status).toBe(422);
    const ok = await api().post(`/api/v1/boards/${boardId}/decision`).set(as('BD')).send({ decision: 'REJECTED', remark: 'Client does not want glow sign here' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.decision).toBe('REJECTED');
    expect((await api().post(`/api/v1/boards/${boardId}/decision`).set(as('BD')).send({ decision: 'APPROVED' })).body.data.decision).toBe('APPROVED');
  });

  it('sends an edited board back to the client as pending', async () => {
    const r = await api().patch(`/api/v1/boards/${boardId}`).set(as('OPS')).send({ width: 12 });
    expect(r.body.data.decision).toBe('PENDING');
    expect(r.body.data.sqft).toBe(96);
  });

  it('summarises decisions and exports an Excel sheet', async () => {
    await api().post(`/api/v1/boards/${boardId}/decision`).set(as('BD')).send({ decision: 'CHANGED', remark: 'Wants ACP instead' });
    const s = await api().get(`/api/v1/projects/${projectId}/boards/summary`).set(as('BD'));
    expect(s.body.data.totals).toMatchObject({ CHANGED: 1, PENDING: 1 });
    const x = await api().get(`/api/v1/projects/${projectId}/boards/export`).set(as('BD')).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(x.status).toBe(200);
    expect((x.body as Buffer).subarray(0, 2).toString()).toBe('PK');
  });

  it('keeps an unassigned Operations user out', async () => {
    expect((await api().get(`/api/v1/projects/${projectId}/boards`).set(as('OPS2'))).status).toBe(404);
    expect((await api().post(`/api/v1/boards/${boardId}/decision`).set(as('OPS2')).send({ decision: 'APPROVED' })).status).toBe(404);
  });

  it('is deleted with the project', async () => {
    const { BoardOption } = await import('../src/modules/boards/boardOption.model');
    expect(await BoardOption.countDocuments({ project: projectId })).toBe(2);
    expect((await api().delete(`/api/v1/projects/${projectId}`).set(as('ADMIN'))).status).toBe(200);
    expect(await BoardOption.countDocuments({ project: projectId })).toBe(0);
  });
});
