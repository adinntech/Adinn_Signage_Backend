import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';

let repl: MongoMemoryReplSet;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let stopWatching: () => void;
let root: string;
let token = '';
const api = () => request(app);

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-watch-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = repl.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  process.env.STORAGE_ORPHAN_GRACE_MINUTES = '1';
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
  stopWatching?.();
  await disconnectDb();
  await repl.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a project deleted straight in the database is cleaned up on its own', () => {
  it('removes its shops, notifications and stored files within seconds', async () => {
    const { watchProjectDeletes } = await import('../src/modules/files/orphans');
    const { Site } = await import('../src/modules/sites/site.model');
    const { Notification } = await import('../src/modules/notifications/notification.model');
    const auth = { Authorization: `Bearer ${token}` };
    const client = (await api().post('/api/v1/clients').set(auth).send({ name: 'Watch Client', code: 'WATCH' })).body.data._id;
    const p = (await api().post('/api/v1/projects').set(auth).send({ clientId: client, campaign: 'Watched', status: 'DRAFT', requirementType: 'SHOP_DETAILS', expectedShops: 3, startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Salem', contacts: [{ name: 'Suresh Kumar', email: 's@c.example', phone: '9876543210' }] })).body.data as { _id: string };
    await api().post(`/api/v1/projects/${p._id}/sites`).set(auth).send({ shopName: 'Anand Stores', dealerName: 'Anand', district: 'Salem', mobile: '9843011122' });
    const up = await api().post(`/api/v1/projects/${p._id}/files`).set(auth).field('category', 'BD_CLIENT_DETAILS').attach('files', Buffer.concat([Buffer.from('PK'), Buffer.alloc(80, 9)]), { filename: 'Brief.xlsx' });
    expect(up.status).toBe(201);
    await Notification.create({ recipient: new mongoose.Types.ObjectId(), kind: 'ACTIVITY', title: 't', body: 'b', project: p._id, dedupeKey: 'watch-1' });
    const stored = fs.readdirSync(path.join(root, 'BD/Client_Details/Watch_Client'), { recursive: true }).map(String).filter((f) => f.endsWith('.xlsx'));
    expect(stored).toHaveLength(1);
    const file = path.join(root, 'BD/Client_Details/Watch_Client', stored[0]!);
    const old = new Date(Date.now() - 600_000);
    fs.utimesSync(file, old, old); // older than the grace period, as a real leftover would be

    const cleared = new Promise((resolve) => {
      stopWatching = watchProjectDeletes(resolve);
    });
    await new Promise((r) => setTimeout(r, 1000)); // let the change stream attach
    await mongoose.connection.collection('projects').deleteOne({ _id: new mongoose.Types.ObjectId(p._id) }); // like deleting it in Atlas
    await cleared;

    expect(await Site.countDocuments({ project: p._id })).toBe(0);
    expect(await Notification.countDocuments({ project: p._id })).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  }, 60_000);
});

describe('Spaces files of a directly deleted project', () => {
  it('are erased from Spaces too, using the deleted project\'s own record, and nothing else', async () => {
    const { watchProjectDeletes } = await import('../src/modules/files/orphans');
    const { setStorageForTests } = await import('../src/modules/files/storage');
    stopWatching?.(); // the previous test's watcher would erase the same files a second time
    const removed: string[] = [];
    setStorageForTests({ type: 'space', put: async () => undefined, remove: async (k: string) => void removed.push(k), signedUrl: async () => 'x', stream: async () => { throw new Error('unused'); } });
    try {
      const projects = mongoose.connection.collection('projects');
      const id = new mongoose.Types.ObjectId();
      const cleared = new Promise((resolve) => {
        stopWatching = watchProjectDeletes(resolve);
      });
      await new Promise((r) => setTimeout(r, 2000)); // let the change stream attach
      await projects.insertOne({ _id: id, code: 'GONE', files: [{ key: 'BD/Client_Details/Test/GONE/a.png', storage: 'space' }, { key: 'BD/Client_Details/Test/GONE/b.xlsx', storage: 'space' }] });
      await projects.deleteOne({ _id: id });
      await cleared;
      expect(removed.sort()).toEqual(['BD/Client_Details/Test/GONE/a.png', 'BD/Client_Details/Test/GONE/b.xlsx']);
    } finally {
      setStorageForTests(undefined);
    }
  }, 60_000);
});
