import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
const req = () => request(app);
const requirement = (over = {}) => ({ source: 'EMAIL', contact: { name: 'Amul Mktg', email: 'marketing@amul.com' }, expectedSites: 120, locations: ['Dindigul'], recceRequired: true, ...over });

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
  for (const role of ['BD', 'RECCE_COORDINATOR', 'FINANCE', 'RECCE_EXECUTIVE']) {
    const u = await User.create({ name: role, email: `${role.toLowerCase()}@t.com`, role: role as 'BD', passwordHash: await hashPassword('Passw0rd!x') });
    ids[role] = String(u._id);
    const r = await req().post('/api/v1/auth/login').send({ email: u.email, password: 'Passw0rd!x' });
    tokens[role] = r.body.data.accessToken;
  }
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

describe('clients', () => {
  it('BD creates, duplicate code conflicts, validation errors, soft delete', async () => {
    const c = await req().post('/api/v1/clients').set(as('BD')).send({ name: 'Amul', code: 'amul', contacts: [{ name: 'Raj', phone: '9876543210' }] });
    expect(c.status).toBe(201);
    expect(c.body.data.code).toBe('AMUL');
    ids.client = c.body.data._id;
    expect((await req().post('/api/v1/clients').set(as('BD')).send({ name: 'Amul 2', code: 'AMUL' })).status).toBe(409);
    const bad = await req().post('/api/v1/clients').set(as('BD')).send({ name: 'X', code: 'a', gstin: 'bad' });
    expect(bad.status).toBe(422);
    const list = await req().get('/api/v1/clients?q=amu').set(as('BD'));
    expect(list.body.meta.total).toBe(1);
    const other = await req().post('/api/v1/clients').set(as('BD')).send({ name: 'Gone', code: 'GONE' });
    expect((await req().delete(`/api/v1/clients/${other.body.data._id}`).set(as('BD'))).status).toBe(200);
    expect((await req().get(`/api/v1/clients/${other.body.data._id}`).set(as('BD'))).status).toBe(404);
  });

  it('enforces permissions and bad ids', async () => {
    expect((await req().get('/api/v1/clients')).status).toBe(401);
    expect((await req().post('/api/v1/clients').set(as('FINANCE')).send({ name: 'Zed', code: 'ZED' })).status).toBe(403);
    expect((await req().get('/api/v1/clients').set(as('FINANCE'))).status).toBe(200);
    expect((await req().get('/api/v1/clients').set(as('RECCE_EXECUTIVE'))).status).toBe(403);
    expect((await req().get('/api/v1/clients/not-an-id').set(as('BD'))).status).toBe(400);
  });
});

describe('projects', () => {
  it('creates project + requirement with sequential codes and audit', async () => {
    const body = { clientId: ids.client, campaign: 'Dindigul Retail', priority: 'HIGH', requirement: requirement() };
    const a = await req().post('/api/v1/projects').set(as('BD')).send(body);
    expect(a.status).toBe(201);
    const year = new Date().getFullYear();
    expect(a.body.data.code).toBe(`SGN-AMUL-${year}-001`);
    expect(a.body.data.requirement.source).toBe('EMAIL');
    expect(a.body.data.owner.name).toBe('BD');
    ids.project = a.body.data._id;
    const b = await req().post('/api/v1/projects').set(as('BD')).send(body);
    expect(b.body.data.code).toBe(`SGN-AMUL-${year}-002`);
    const h = await req().get(`/api/v1/projects/${ids.project}/history`).set(as('BD'));
    expect(h.body.data[0].action).toBe('CREATE');
  });

  it('creates unique codes under concurrency', async () => {
    const body = { clientId: ids.client, campaign: 'Race', requirement: requirement() };
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => req().post('/api/v1/projects').set(as('BD')).send(body)));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.data.code)).size).toBe(5);
  });

  it('rejects unknown client, inactive client, missing requirement and non-writers', async () => {
    const base = { campaign: 'X', requirement: requirement() };
    expect((await req().post('/api/v1/projects').set(as('BD')).send({ ...base, clientId: '64b000000000000000000000' })).status).toBe(400);
    const off = await req().post('/api/v1/clients').set(as('BD')).send({ name: 'Off', code: 'OFF', status: 'INACTIVE' });
    expect((await req().post('/api/v1/projects').set(as('BD')).send({ ...base, clientId: off.body.data._id })).status).toBe(400);
    expect((await req().post('/api/v1/projects').set(as('BD')).send({ clientId: ids.client, campaign: 'X' })).status).toBe(422);
    expect((await req().post('/api/v1/projects').set(as('RECCE_COORDINATOR')).send({ ...base, clientId: ids.client })).status).toBe(403);
  });

  it('lists with filters, pagination and summary', async () => {
    const l = await req().get('/api/v1/projects?limit=2&page=1&priority=HIGH').set(as('RECCE_COORDINATOR'));
    expect(l.status).toBe(200);
    expect(l.body.data.length).toBe(2);
    expect(l.body.data[0].client.code).toBe('AMUL');
    const all = await req().get('/api/v1/projects?limit=2').set(as('BD'));
    expect(all.body.meta.total).toBe(7);
    expect(all.body.meta.totalPages).toBe(4);
    expect((await req().get('/api/v1/projects?limit=500').set(as('BD'))).status).toBe(422);
    const s = await req().get('/api/v1/projects/summary').set(as('BD'));
    expect(s.body.data).toMatchObject({ total: 7, newRequests: 7 });
  });

  it('status change needs reason for hold/cancel, writes audit + timeline', async () => {
    const p = `/api/v1/projects/${ids.project}/status`;
    expect((await req().patch(p).set(as('BD')).send({ status: 'ON_HOLD' })).status).toBe(422);
    const ok = await req().patch(p).set(as('BD')).send({ status: 'ON_HOLD', reason: 'Client paused' });
    expect(ok.body.data.status).toBe('ON_HOLD');
    const h = await req().get(`/api/v1/projects/${ids.project}/history`).set(as('BD'));
    expect(h.body.data[0]).toMatchObject({ action: 'STATUS_CHANGE', reason: 'Client paused' });
    expect(h.body.data[0].changes[0]).toMatchObject({ field: 'status', oldValue: 'NEW', newValue: 'ON_HOLD' });
    const t = await req().get(`/api/v1/communications/messages?projectId=${ids.project}&type=SYSTEM`).set(as('BD'));
    expect(t.body.meta.total).toBe(2);
  });

  it('updates project fields and requirement with field-level audit', async () => {
    const u = await req().patch(`/api/v1/projects/${ids.project}`).set(as('BD')).send({ priority: 'URGENT' });
    expect(u.body.data.priority).toBe('URGENT');
    const r = await req().put(`/api/v1/projects/${ids.project}/requirement`).set(as('BD')).send(requirement({ expectedSites: 250 }));
    expect(r.body.data.expectedSites).toBe(250);
    const h = await req().get(`/api/v1/projects/${ids.project}/history`).set(as('BD'));
    const reqAudit = h.body.data.find((a: { entity: string }) => a.entity === 'Requirement');
    expect(reqAudit.changes).toEqual([{ field: 'expectedSites', oldValue: 120, newValue: 250 }]);
  });
});

describe('communications', () => {
  let mailId: string;

  it('logs inbound mail, replies with threading and recipients', async () => {
    const m = await req().post('/api/v1/communications/messages').set(as('BD')).send({
      type: 'EMAIL', direction: 'INBOUND', from: { name: 'Amul Mktg', email: 'marketing@amul.com' },
      to: [{ email: 'bd@adinn.co.in' }, { email: 'bd@t.com' }], cc: [{ email: 'ops@adinn.co.in' }],
      subject: 'New Signage Requirement - AMUL', body: 'Please find 120 shops', attachments: [{ name: 'Shops.xlsx', size: 1200 }],
    });
    expect(m.status).toBe(201);
    expect(m.body.data.deliveryStatus).toBe('RECEIVED');
    mailId = m.body.data._id;
    const reply = await req().post('/api/v1/communications/messages').set(as('BD')).send({ type: 'EMAIL', mode: 'reply_all', replyToId: mailId, body: 'Noted' });
    expect(reply.status).toBe(201);
    expect(reply.body.data.threadId).toBe(mailId);
    expect(reply.body.data.subject).toBe('Re: New Signage Requirement - AMUL');
    expect(reply.body.data.to.map((a: { email: string }) => a.email).sort()).toEqual(['bd@adinn.co.in', 'marketing@amul.com']);
    expect(reply.body.data.deliveryStatus).toBe('LOGGED');
    const fwd = await req().post('/api/v1/communications/messages').set(as('BD')).send({ type: 'EMAIL', mode: 'forward', replyToId: mailId, to: [{ email: 'recce@adinn.co.in' }], body: 'FYI' });
    expect(fwd.body.data.subject).toBe('Fwd: New Signage Requirement - AMUL');
    expect(fwd.body.data.attachments[0].name).toBe('Shops.xlsx');
    const th = await req().get(`/api/v1/communications/messages?threadId=${mailId}`).set(as('BD'));
    expect(th.body.meta.total).toBe(3);
  });

  it('validates messages and permissions', async () => {
    expect((await req().post('/api/v1/communications/messages').set(as('BD')).send({ type: 'EMAIL', body: 'x' })).status).toBe(422);
    expect((await req().post('/api/v1/communications/messages').set(as('BD')).send({ type: 'NOTE', body: '  ' })).status).toBe(422);
    expect((await req().post('/api/v1/communications/messages').set(as('FINANCE')).send({ type: 'NOTE', body: 'hi' })).status).toBe(403);
    expect((await req().post('/api/v1/communications/messages').set(as('BD')).send({ type: 'NOTE', body: 'hi', projectId: '64b000000000000000000000' })).status).toBe(400);
  });

  it('mail-to-task creates a linked project, copies attachments, blocks re-conversion', async () => {
    const un = await req().get('/api/v1/communications/messages?unlinked=true&type=EMAIL').set(as('BD'));
    expect(un.body.data.some((m: { _id: string }) => m._id === mailId)).toBe(true);
    const body = { clientId: ids.client, campaign: 'From Mail', expectedSites: 120 };
    expect((await req().post(`/api/v1/communications/messages/${mailId}/create-project`).set(as('RECCE_COORDINATOR')).send(body)).status).toBe(403);
    const p = await req().post(`/api/v1/communications/messages/${mailId}/create-project`).set(as('BD')).send(body);
    expect(p.status).toBe(201);
    expect(p.body.data.requirement.attachments[0].name).toBe('Shops.xlsx');
    expect(p.body.data.requirement.sourceMessage).toBe(mailId);
    const m = await req().get(`/api/v1/communications/messages/${mailId}`).set(as('BD'));
    expect(m.body.data.actioned).toBe(true);
    expect(m.body.data.project.code).toBe(p.body.data.code);
    expect((await req().post(`/api/v1/communications/messages/${mailId}/create-project`).set(as('BD')).send(body)).status).toBe(409);
  });

  it('approval request: only the requested approver can decide, once', async () => {
    const ap = await req().post(`/api/v1/communications/messages/${mailId}/request-approval`).set(as('BD')).send({ to: [ids.RECCE_COORDINATOR], comment: 'ok?' });
    expect(ap.status).toBe(201);
    const id = ap.body.data._id;
    expect((await req().patch(`/api/v1/communications/messages/${id}/approval`).set(as('FINANCE')).send({ status: 'APPROVED' })).status).toBe(403);
    const d = await req().patch(`/api/v1/communications/messages/${id}/approval`).set(as('RECCE_COORDINATOR')).send({ status: 'APPROVED' });
    expect(d.body.data.approval.status).toBe('APPROVED');
    expect((await req().patch(`/api/v1/communications/messages/${id}/approval`).set(as('RECCE_COORDINATOR')).send({ status: 'REJECTED' })).status).toBe(409);
    expect((await req().post(`/api/v1/communications/messages/${mailId}/request-approval`).set(as('BD')).send({ to: ['64b000000000000000000000'] })).status).toBe(400);
  });

  it('mark actioned toggles', async () => {
    const m = await req().post('/api/v1/communications/messages').set(as('BD')).send({ type: 'NOTE', body: 'call client', projectId: ids.project });
    const a = await req().patch(`/api/v1/communications/messages/${m.body.data._id}/actioned`).set(as('BD')).send({ actioned: true, note: 'done' });
    expect(a.body.data.actioned).toBe(true);
    const b = await req().patch(`/api/v1/communications/messages/${m.body.data._id}/actioned`).set(as('BD')).send({ actioned: false });
    expect(b.body.data.actioned).toBe(false);
  });

  it('channels: upsert, link, intro message; one per kind', async () => {
    const url = `/api/v1/communications/projects/${ids.project}/channels`;
    const body = { participants: [{ name: 'Kishore', role: 'BD', phone: '9876543210', included: true }, { name: 'Deva', role: 'Recce', phone: '9000011111', included: true }, { name: 'Off', phone: '9000022222', included: false }] };
    const c = await req().put(`${url}/WITH_CLIENT`).set(as('BD')).send(body);
    expect(c.body.data.status).toBe('NOT_CREATED');
    const linked = await req().put(`${url}/WITH_CLIENT`).set(as('BD')).send({ ...body, externalGroupUrl: 'https://chat.whatsapp.com/abc' });
    expect(linked.body.data.status).toBe('LINKED');
    await req().put(`${url}/INTERNAL`).set(as('BD')).send(body);
    expect((await req().get(url).set(as('BD'))).body.data.length).toBe(2);
    const intro = await req().get(`${url}/WITH_CLIENT/intro`).set(as('BD'));
    expect(intro.body.data.phones).toEqual(['9876543210', '9000011111']);
    expect(intro.body.data.text).toContain('Kishore (BD)');
    expect(intro.body.data.text).not.toContain('Off');
    expect((await req().put(`${url}/BOGUS`).set(as('BD')).send(body)).status).toBe(422);
  });

  it('user lookup returns only active users of requested roles', async () => {
    const r = await req().get('/api/v1/users/lookup?roles=BD,RECCE_COORDINATOR').set(as('BD'));
    expect(r.body.data.map((u: { role: string }) => u.role).sort()).toEqual(['BD', 'RECCE_COORDINATOR']);
    expect(r.body.data[0].passwordHash).toBeUndefined();
  });
});

