import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root: string;
let mail: typeof import('../src/modules/notifications/mail.service');
let notif: typeof import('../src/modules/notifications/notification.service');
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
let clientId = '';
let seq = 0;
const sent: { to: string; subject: string; text: string }[] = [];

const contact = { name: 'Suresh Kumar', email: 'suresh@client.example', phone: '9876543210' };
const make = async (over: Record<string, unknown> = {}) =>
  (await api().post('/api/v1/projects').set(as('BD')).send({
    clientId, campaign: `Scope ${++seq}`, status: 'DRAFT', requirementType: 'SHOP_DETAILS', expectedShops: 10,
    startDate: '2026-11-01', targetDate: '2026-12-01', district: 'Salem', contacts: [contact], ...over,
  })).body.data as { _id: string; code: string };
const assign = (id: string, to: string, role = 'BD') => api().post(`/api/v1/projects/${id}/assign`).set(as(role)).send({ assigneeId: uid[to] });
const inbox = async (who: string) => (await api().get('/api/v1/notifications').set(as(who))).body.data as { items: { id: string; kind: string; title: string; text: string; projectId: string; read: boolean }[]; unread: number };
const forProject = async (who: string, pid: string) => (await inbox(who)).items.filter((i) => i.projectId === pid);
const waitFor = async (cond: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting');
};
const log = async (pid: string) => (await api().get(`/api/v1/projects/${pid}/notification-log`).set(as('BD'))).body.data as { kind: string; recipient: { name: string } | null; readAt: string | null; deliveries: { status: string; attempts: number; lastError: string | null; to: string }[] }[];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-notif-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  process.env.WEB_BASE_URL = 'https://crm.example.test';
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  mail = await import('../src/modules/notifications/mail.service');
  notif = await import('../src/modules/notifications/notification.service');
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  const users: [string, string][] = [['BD', 'BD'], ['OPS_A', 'OPERATIONS'], ['OPS_B', 'OPERATIONS'], ['COORD', 'RECCE_COORDINATOR'], ['FINANCE', 'FINANCE']];
  for (const [key, role] of users) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role: role as 'BD', passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  clientId = (await api().post('/api/v1/clients').set(as('BD')).send({ name: 'Scope Client', code: 'SCOPE' })).body.data._id;
});
afterAll(async () => {
  mail.setMailSenderForTests(undefined);
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  sent.length = 0;
  mail.setMailSenderForTests(undefined);
});

describe('assignment notifications are stored per person in the database', () => {
  it('notifies only the assignee, with the project details, unread until opened', async () => {
    const p = await make({ campaign: 'Notify Campaign' });
    await assign(p._id, 'OPS_A');
    const mine = await forProject('OPS_A', p._id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'assigned', title: 'New Project Assigned', read: false });
    expect(mine[0]!.text).toContain(p.code);
    expect(mine[0]!.text).toContain('Scope Client');
    expect(mine[0]!.text).toContain('10 shops');
    expect(mine[0]!.text).toContain('Due 2026-12-01');
    expect(await forProject('OPS_B', p._id)).toHaveLength(0); // other Operations user is not told
    expect(await forProject('BD', p._id)).toHaveLength(0); // the person who assigned does not notify themself
    expect((await inbox('OPS_A')).unread).toBeGreaterThan(0);
  });

  it('does not notify twice when the same assignment is repeated', async () => {
    const p = await make();
    await assign(p._id, 'OPS_A');
    await assign(p._id, 'OPS_A');
    expect(await forProject('OPS_A', p._id)).toHaveLength(1);
  });

  it('tells the new owner, and the previous owner that it moved', async () => {
    const p = await make();
    await assign(p._id, 'OPS_A');
    await assign(p._id, 'OPS_B');
    expect((await forProject('OPS_B', p._id)).map((n) => n.title)).toEqual(['New Project Assigned']);
    const a = (await forProject('OPS_A', p._id)).map((n) => n.title);
    expect(a).toContain(`Project ${p.code} was reassigned`);
  });

  it('keeps read state per person and lets each person mark one or all as read', async () => {
    const p = await make();
    await assign(p._id, 'OPS_A');
    const [n] = await forProject('OPS_A', p._id);
    const before = (await inbox('OPS_A')).unread;
    expect((await api().post(`/api/v1/notifications/${n!.id}/read`).set(as('OPS_B'))).status).toBe(404); // not theirs
    expect((await api().post(`/api/v1/notifications/${n!.id}/read`).set(as('OPS_A'))).status).toBe(200);
    expect((await inbox('OPS_A')).unread).toBe(before - 1);
    expect((await api().post(`/api/v1/notifications/${n!.id}/read`).set(as('OPS_A'))).status).toBe(200); // idempotent
    await api().post('/api/v1/notifications/read').set(as('OPS_A'));
    expect((await inbox('OPS_A')).unread).toBe(0);
    const log1 = await log(p._id);
    expect(log1[0]!.readAt).toBeTruthy();
  });

  it('requires login', async () => {
    expect((await api().get('/api/v1/notifications')).status).toBe(401);
  });
});

describe('email delivery is tracked, retried and never faked', () => {
  it('records SKIPPED with the reason when email is not configured', async () => {
    const p = await make();
    await assign(p._id, 'OPS_A');
    const row = (await log(p._id)).find((l) => l.kind === 'assigned')!;
    expect(row.recipient?.name).toBe('OPS_A');
    expect(row.deliveries[0]).toMatchObject({ status: 'SKIPPED', attempts: 0, lastError: 'Email is not configured on the server' });
  });

  it('sends the email with a link to the project and records SENT', async () => {
    mail.setMailSenderForTests(async (m) => void sent.push(m));
    const p = await make();
    await assign(p._id, 'OPS_A');
    await waitFor(async () => (await log(p._id)).find((l) => l.kind === 'assigned')?.deliveries[0]?.status === 'SENT');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'ops_a@t.com', subject: 'New Project Assigned' });
    expect(sent[0]!.text).toContain(`https://crm.example.test/operations/projects/${p._id}`);
    const d = (await log(p._id)).find((l) => l.kind === 'assigned')!.deliveries[0]!;
    expect(d).toMatchObject({ status: 'SENT', attempts: 1, to: 'ops_a@t.com' });
  });

  it('records a failure, retries later, and gives up after three attempts', async () => {
    let up = false;
    mail.setMailSenderForTests(async (m) => {
      if (!up) throw new Error('SMTP connection refused');
      sent.push(m);
    });
    const p = await make();
    await assign(p._id, 'OPS_A');
    const status = async () => (await log(p._id)).find((l) => l.kind === 'assigned')!.deliveries[0]!;
    await waitFor(async () => (await status()).status === 'FAILED');
    expect(await status()).toMatchObject({ status: 'FAILED', attempts: 1, lastError: 'SMTP connection refused' });
    await notif.retryPendingEmails();
    expect((await status()).attempts).toBe(2);
    up = true;
    await notif.retryPendingEmails();
    expect(await status()).toMatchObject({ status: 'SENT', attempts: 3 });
    expect(sent).toHaveLength(1);
    await notif.retryPendingEmails(); // nothing left to retry, no duplicate email
    expect(sent).toHaveLength(1);

    mail.setMailSenderForTests(async () => {
      throw new Error('still down');
    });
    const q = await make();
    await assign(q._id, 'OPS_A');
    const qs = async () => (await log(q._id)).find((l) => l.kind === 'assigned')!.deliveries[0]!;
    await waitFor(async () => (await qs()).status === 'FAILED');
    await notif.retryPendingEmails();
    await notif.retryPendingEmails();
    expect((await qs()).attempts).toBe(3);
    expect(await notif.retryPendingEmails()).toBe(0); // not retried a fourth time
  });

  it('only BD and admins can read who was notified', async () => {
    const p = await make();
    await assign(p._id, 'OPS_A');
    expect((await api().get(`/api/v1/projects/${p._id}/notification-log`).set(as('OPS_A'))).status).toBe(403);
    expect((await api().get(`/api/v1/projects/${p._id}/notification-log`).set(as('BD'))).status).toBe(200);
  });
});

describe('other events notify the right side', () => {
  it('tells the assignee about new client documents once per hour, in-app only', async () => {
    const p = await make();
    await assign(p._id, 'OPS_A');
    const up = (n: number) => api().post(`/api/v1/projects/${p._id}/files`).set(as('BD')).field('category', 'BD_CLIENT_DETAILS').attach('files', Buffer.concat([Buffer.from('PK'), Buffer.alloc(60, n)]), { filename: `f${n}.xlsx` });
    expect((await up(1)).status).toBe(201);
    expect((await up(2)).status).toBe(201);
    const docs = (await forProject('OPS_A', p._id)).filter((n) => n.kind === 'documents');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe('Client documents added');
    const row = (await log(p._id)).find((l) => l.kind === 'documents')!;
    expect(row.deliveries).toHaveLength(0); // not an action item, so no email
  });

  it('does not notify anyone about documents on a draft nobody owns yet', async () => {
    const p = await make();
    const r = await api().post(`/api/v1/projects/${p._id}/files`).set(as('BD')).field('category', 'BD_CLIENT_DETAILS').attach('files', Buffer.concat([Buffer.from('PK'), Buffer.alloc(60, 77)]), { filename: 'draft.xlsx' });
    expect(r.status).toBe(201);
    expect(await log(p._id)).toHaveLength(0);
  });

  it('tells the BD owner when Operations changes the stage, and not Operations itself', async () => {
    const p = await make();
    await assign(p._id, 'OPS_A');
    const r = await api().post(`/api/v1/projects/${p._id}/stage`).set(as('OPS_A')).send({ stage: 'PLANNING' });
    expect(r.status).toBe(200);
    const bd = await forProject('BD', p._id);
    expect(bd).toHaveLength(1);
    expect(bd[0]).toMatchObject({ kind: 'stage', title: `${p.code} is now in planning` });
    expect((await forProject('OPS_A', p._id)).filter((n) => n.kind === 'stage')).toHaveLength(0);
  });

  it('tells the BD owner about imported shops', async () => {
    const p = await make();
    await assign(p._id, 'OPS_A');
    const csv = 'Shop Name,Dealer Name,District,Mobile\nA Shop,Raj,Salem,9843011122\nB Shop,Raj,Salem,9843011133';
    const up = await api().post(`/api/v1/projects/${p._id}/sites/imports`).set(as('OPS_A')).attach('file', Buffer.from(csv), { filename: 's.csv' });
    const batch = up.body.data.batch._id;
    await api().post(`/api/v1/projects/${p._id}/sites/imports/${batch}/preview`).set(as('OPS_A')).send({ mapping: up.body.data.suggestedMapping, scenario: 'MEASUREMENT_REQUIRED', defaultUnit: 'ft', duplicatePolicy: 'skip' });
    expect((await api().post(`/api/v1/projects/${p._id}/sites/imports/${batch}/commit`).set(as('OPS_A')).send({})).status).toBe(200);
    const n = (await forProject('BD', p._id)).find((x) => x.kind === 'imported');
    expect(n?.text).toContain('2 shops imported');
  });

  it('sends corrections to the other side, by email too', async () => {
    mail.setMailSenderForTests(async (m) => void sent.push(m));
    const p = await make({ requirementType: 'SHOP_MEASUREMENT' });
    await assign(p._id, 'OPS_A');
    const s = (await api().post(`/api/v1/projects/${p._id}/sites`).set(as('OPS_A')).send({ shopName: 'Fix Me', dealerName: 'Raj', district: 'Salem', width: 10, height: 4, scenario: 'CLIENT_PROVIDED' })).body.data.site._id;
    await api().post(`/api/v1/sites/${s}/approval`).set(as('OPS_A')).send({ level: 'ops', value: 'CORRECTION', note: 'Width looks wrong' });
    const toBd = (await forProject('BD', p._id)).find((x) => x.kind === 'approval');
    expect(toBd?.text).toContain('Operations asked for a correction on Fix Me: Width looks wrong');
    await waitFor(async () => sent.some((m) => m.to === 'bd@t.com'));
    await api().post(`/api/v1/sites/${s}/approval`).set(as('BD')).send({ level: 'bd', value: 'CORRECTION', note: 'Photo is blurry' });
    expect((await forProject('OPS_A', p._id)).find((x) => x.kind === 'approval')?.text).toContain('BD asked for a correction');
  });

  it('tells the assignee, by email, when BD cancels the project', async () => {
    mail.setMailSenderForTests(async (m) => void sent.push(m));
    const p = await make();
    await assign(p._id, 'OPS_A');
    await api().patch(`/api/v1/projects/${p._id}/status`).set(as('BD')).send({ status: 'CANCELLED', reason: 'Client postponed' });
    const n = (await forProject('OPS_A', p._id)).find((x) => x.kind === 'cancelled');
    expect(n?.text).toContain('Client postponed');
    await waitFor(async () => sent.some((m) => m.subject.includes('was cancelled')));
  });
});

describe('Operations see only the projects assigned to them', () => {
  let a: { _id: string; code: string };
  let b: { _id: string; code: string };
  let aSite = '';
  let aFile = '';

  beforeAll(async () => {
    a = await make({ campaign: 'Only A' });
    b = await make({ campaign: 'Only B', requirementType: 'ASO', expectedShops: undefined });
    await assign(a._id, 'OPS_A');
    await assign(b._id, 'OPS_B');
    aSite = (await api().post(`/api/v1/projects/${a._id}/sites`).set(as('OPS_A')).send({ shopName: 'A Shop', dealerName: 'Raj', district: 'Salem' })).body.data.site._id;
    const up = await api().post(`/api/v1/projects/${a._id}/files`).set(as('BD')).field('category', 'BD_CLIENT_DETAILS').attach('files', Buffer.concat([Buffer.from('PK'), Buffer.alloc(60, 5)]), { filename: 'a.xlsx' });
    aFile = up.body.data[0].id;
  });

  it('lists only their own projects, whatever the query parameters say', async () => {
    // Earlier tests in this file moved a few projects to OPS_B; the truth is whatever BD has assigned to OPS_B.
    const ownIds = (await api().get(`/api/v1/projects?limit=200&assigneeId=${uid.OPS_B}`).set(as('BD'))).body.data.map((p: { _id: string }) => p._id).sort();
    expect(ownIds).toContain(b._id);
    expect(ownIds).not.toContain(a._id);
    const mine = await api().get('/api/v1/projects?limit=200').set(as('OPS_B'));
    expect(mine.body.data.map((p: { _id: string }) => p._id).sort()).toEqual(ownIds);
    const sneaky = await api().get(`/api/v1/projects?limit=200&assigned=true&assigneeId=${uid.OPS_A}`).set(as('OPS_B'));
    expect(sneaky.body.data.every((p: { _id: string }) => p._id !== a._id)).toBe(true);
    const sneaky2 = await api().get('/api/v1/projects?limit=200&assigned=false').set(as('OPS_B'));
    expect(sneaky2.body.data).toHaveLength(0);
    const all = await api().get('/api/v1/projects?limit=200&assigned=true').set(as('BD'));
    expect(all.body.data.map((p: { _id: string }) => p._id)).toEqual(expect.arrayContaining([a._id, b._id]));
  });

  it('counts only their own projects on the dashboard', async () => {
    const own = (await api().get(`/api/v1/projects?limit=200&assigneeId=${uid.OPS_B}`).set(as('BD'))).body.meta.total as number;
    const s = await api().get('/api/v1/projects/summary').set(as('OPS_B'));
    expect(s.body.data.total).toBe(own);
    const everything = await api().get('/api/v1/projects/summary').set(as('BD'));
    expect(everything.body.data.total).toBeGreaterThan(own);
  });

  it('answers "not found" for another person\'s project on every path', async () => {
    const asB = (m: 'get' | 'post' | 'patch' | 'delete', url: string, body?: object) => {
      const r = api()[m](url).set(as('OPS_B'));
      return body ? r.send(body) : r;
    };
    const checks = [
      asB('get', `/api/v1/projects/${a._id}`),
      asB('get', `/api/v1/projects/${a._id}/history`),
      asB('get', `/api/v1/projects/${a._id}/requirement`),
      asB('get', `/api/v1/projects/${a._id}/survey-areas`),
      asB('post', `/api/v1/projects/${a._id}/stage`, { stage: 'PLANNING' }),
      asB('get', `/api/v1/projects/${a._id}/sites`),
      asB('get', `/api/v1/projects/${a._id}/sites/stats`),
      asB('post', `/api/v1/projects/${a._id}/sites`, { shopName: 'Intruder', dealerName: 'X', district: 'Y' }),
      asB('post', `/api/v1/projects/${a._id}/sites/approve-all`, { level: 'ops' }),
      asB('patch', `/api/v1/sites/${aSite}`, { remarks: 'hacked' }),
      asB('post', `/api/v1/sites/${aSite}/approval`, { level: 'ops', value: 'APPROVED' }),
      asB('delete', `/api/v1/sites/${aSite}`),
      asB('get', `/api/v1/projects/${a._id}/files`),
      asB('get', `/api/v1/files/${aFile}/url`),
    ];
    for (const [i, r] of (await Promise.all(checks)).entries()) expect(r.status, `check ${i}`).toBe(404);
    // Deleting a BD document is refused outright (Operations never writes that category), and never succeeds.
    expect([403, 404]).toContain((await asB('delete', `/api/v1/files/${aFile}`)).status);
    const up = await api().post(`/api/v1/projects/${a._id}/files`).set(as('OPS_B')).field('category', 'OPS_SURVEY_PROOF').attach('files', Buffer.concat([Buffer.from('PK'), Buffer.alloc(60, 6)]), { filename: 'x.xlsx' });
    expect(up.status).toBe(404);
  });

  it('keeps the activity feed to their own projects', async () => {
    const feed = await api().get('/api/v1/projects/activity').set(as('OPS_B'));
    expect(feed.status).toBe(200);
    const own = new Set((await api().get(`/api/v1/projects?limit=200&assigneeId=${uid.OPS_B}`).set(as('BD'))).body.data.map((p: { _id: string }) => p._id));
    expect(feed.body.data.length).toBeGreaterThan(0);
    expect(feed.body.data.every((x: { projectId: string }) => own.has(x.projectId))).toBe(true);
    expect(own.has(a._id)).toBe(false);
  });

  it('works for the assignee, for coordinators too, and not for BD-side roles being narrowed', async () => {
    expect((await api().get(`/api/v1/projects/${a._id}`).set(as('OPS_A'))).status).toBe(200);
    expect((await api().get(`/api/v1/projects/${a._id}/sites`).set(as('OPS_A'))).body.data).toHaveLength(1);
    expect((await api().get(`/api/v1/projects/${a._id}`).set(as('COORD'))).status).toBe(404);
    await assign(a._id, 'COORD');
    expect((await api().get(`/api/v1/projects/${a._id}`).set(as('COORD'))).status).toBe(200);
    expect((await api().get(`/api/v1/projects/${a._id}`).set(as('BD'))).status).toBe(200);
    expect((await api().get(`/api/v1/projects/${a._id}`).set(as('FINANCE'))).status).toBe(200);
  });

  it('moves access with the assignment: the old owner loses it, the new one gains it', async () => {
    const p = await make();
    await assign(p._id, 'OPS_A');
    expect((await api().get(`/api/v1/projects/${p._id}`).set(as('OPS_A'))).status).toBe(200);
    await assign(p._id, 'OPS_B');
    expect((await api().get(`/api/v1/projects/${p._id}`).set(as('OPS_A'))).status).toBe(404);
    expect((await api().get(`/api/v1/projects/${p._id}`).set(as('OPS_B'))).status).toBe(200);
  });
});

describe('live push to people who have the CRM open', () => {
  /** Opens the real SSE endpoint over HTTP and collects what the server sends. */
  async function listen(who: string | null) {
    const http = await import('node:http');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    let body = '';
    let status = 0;
    const req = http.get({ port, path: '/api/v1/notifications/stream', headers: who ? { Authorization: `Bearer ${tokens[who]}` } : {} }, (res) => {
      status = res.statusCode ?? 0;
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
    });
    req.on('error', () => undefined);
    return {
      status: () => status,
      body: () => body,
      close: () => {
        req.destroy();
        server.close();
      },
    };
  }
  const events = (body: string) =>
    body
      .split('\n\n')
      .map((b) => /event: (\w+)\ndata: (.*)/.exec(b))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ event: m[1]!, data: JSON.parse(m[2]!) }));

  it('refuses a stream without a login', async () => {
    const s = await listen(null);
    await waitFor(async () => s.status() !== 0);
    expect(s.status()).toBe(401);
    s.close();
  });

  it('delivers a new assignment to the assignee immediately, and to nobody else', async () => {
    const a = await listen('OPS_A');
    const b = await listen('OPS_B');
    await waitFor(async () => events(a.body()).some((e) => e.event === 'ready') && events(b.body()).some((e) => e.event === 'ready'));
    expect(a.status()).toBe(200);
    const p = await make({ campaign: 'Live push' });
    await assign(p._id, 'OPS_A');
    await waitFor(async () => events(a.body()).some((e) => e.event === 'notification'));
    const got = events(a.body()).find((e) => e.event === 'notification')!.data;
    expect(got).toMatchObject({ kind: 'assigned', title: 'New Project Assigned', projectId: p._id, projectCode: p.code, read: false });
    expect(got.text).toContain(p.code);
    await new Promise((r) => setTimeout(r, 150));
    expect(events(b.body()).some((e) => e.event === 'notification')).toBe(false);
    a.close();
    b.close();
  });

  it('still stores the notification when nobody is connected', async () => {
    const p = await make();
    await assign(p._id, 'OPS_B');
    expect((await forProject('OPS_B', p._id)).map((n) => n.kind)).toContain('assigned');
  });

  it('ends a stream when the login that opened it expires', async () => {
    const hub = await import('../src/modules/notifications/notification.hub');
    let ended = false;
    const written: string[] = [];
    const fake = { write: (c: string) => (written.push(c), true), end: () => void (ended = true), on: () => fake } as never;
    hub.subscribe('user-exp', fake, Date.now() + 1100);
    expect(hub.openConnections('user-exp')).toBe(1);
    expect(hub.publish('user-exp', 'notification', { x: 1 })).toBe(1);
    await waitFor(async () => ended, 3000);
    expect(hub.openConnections('user-exp')).toBe(0);
    expect(hub.publish('user-exp', 'notification', { x: 2 })).toBe(0);
  });
});
