import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
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
let clientId = '';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-cascade-'));
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
  for (const [key, role] of [['BD', 'BD'], ['OPS', 'OPERATIONS'], ['ADMIN', 'SUPER_ADMIN']] as const) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  clientId = (await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Cascade Client', code: 'CASC' })).body.data._id;
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

const contact = { name: 'Suresh Kumar', email: 'suresh@client.example', phone: '9876543210' };
const waitFor = async (cond: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting');
};

describe('deleting a project removes everything linked to it', () => {
  it('erases files, shops, notifications, chat and history, and leaves other projects alone', async () => {
    const { Project } = await import('../src/modules/projects/project.model');
    const { Site } = await import('../src/modules/sites/site.model');
    const { Notification } = await import('../src/modules/notifications/notification.model');
    const { AuditLog } = await import('../src/modules/audit/auditLog.model');
    const { CommunicationMessage } = await import('../src/modules/communications/communication.model');
    const mk = async (campaign: string) =>
      (await api().post('/api/v1/projects').set(as('BD')).send({ clientId, campaign, status: 'DRAFT', requirementType: 'SHOP_DETAILS', expectedShops: 5, startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Salem', contacts: [contact] })).body.data as { _id: string };
    const doomed = await mk('Doomed');
    const keep = await mk('Keeper');

    await api().post(`/api/v1/projects/${doomed._id}/assign`).set(as('BD')).send({ assigneeId: uid.OPS });
    await api().post(`/api/v1/projects/${doomed._id}/sites`).set(as('OPS')).send({ shopName: 'Anand Stores', dealerName: 'Anand', district: 'Salem', mobile: '9843011122' });
    await api().post(`/api/v1/projects/${keep._id}/sites`).set(as('BD')).send({ shopName: 'Safe Stores', dealerName: 'Safe', district: 'Salem', mobile: '9843011133' });
    const up = await api().post(`/api/v1/projects/${doomed._id}/files`).set(as('BD')).field('category', 'BD_CLIENT_DETAILS').attach('files', Buffer.concat([Buffer.from('PK'), Buffer.alloc(80, 5)]), { filename: 'Brief.xlsx' });
    expect(up.status).toBe(201);
    await CommunicationMessage.create({ threadId: 't1', project: doomed._id, type: 'NOTE', direction: 'INTERNAL', body: 'hello', createdBy: uid.BD } as never).catch(() => undefined);
    await waitFor(async () => (await Notification.countDocuments({ project: doomed._id })) > 0);
    const key = ((await Project.findById(doomed._id).select('files').lean())!.files![0] as { key: string }).key;
    expect(fs.existsSync(path.join(root, key))).toBe(true);

    // BD may not delete it any more (Operations has it), Super Admin may.
    expect((await api().delete(`/api/v1/projects/${doomed._id}`).set(as('BD'))).status).toBe(409);
    const del = await api().delete(`/api/v1/projects/${doomed._id}`).set(as('ADMIN'));
    expect(del.status).toBe(200);

    expect(await Project.countDocuments({ _id: doomed._id })).toBe(0);
    expect(await Site.countDocuments({ project: doomed._id })).toBe(0);
    expect(await Notification.countDocuments({ project: doomed._id })).toBe(0);
    expect(await AuditLog.countDocuments({ project: doomed._id })).toBe(0);
    expect(await CommunicationMessage.countDocuments({ project: doomed._id })).toBe(0);
    expect(fs.existsSync(path.join(root, key))).toBe(false);

    // The other project is untouched.
    expect(await Project.countDocuments({ _id: keep._id })).toBe(1);
    expect(await Site.countDocuments({ project: keep._id })).toBe(1);
  });

  it('lets BD delete an unassigned draft, files included', async () => {
    const { Project } = await import('../src/modules/projects/project.model');
    const p = (await api().post('/api/v1/projects').set(as('BD')).send({ clientId, campaign: 'Plain Draft', status: 'DRAFT', requirementType: 'SHOP_DETAILS', expectedShops: 5, startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Salem', contacts: [contact] })).body.data as { _id: string };
    expect((await api().delete(`/api/v1/projects/${p._id}`).set(as('BD'))).status).toBe(200);
    expect(await Project.countDocuments({ _id: p._id })).toBe(0);
  });
});

describe('the cascade list cannot fall behind', () => {
  it('covers every model that refers to a project, so a new module cannot leave test data behind', async () => {
    const { PROJECT_OWNED, HANDLED_VIA_PARENT } = await import('../src/modules/projects/project.cascade');
    const covered = new Set([...PROJECT_OWNED.map((s) => s.model.modelName), ...HANDLED_VIA_PARENT, 'ImportBatch', 'Project']);
    const missing: string[] = [];
    for (const name of mongoose.modelNames()) {
      const schema = mongoose.model(name).schema;
      const refsProject = Object.values(schema.paths).some((p) => (p.options as { ref?: string }).ref === 'Project');
      if (refsProject && !covered.has(name)) missing.push(name);
    }
    expect(missing, `Add ${missing.join(', ')} to PROJECT_OWNED in src/modules/projects/project.cascade.ts`).toEqual([]);
  });
});
