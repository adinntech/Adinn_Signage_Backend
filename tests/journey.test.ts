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
let seq = 0;
const day = (n: number) => new Date(Date.now() + n * 86_400_000);
type Stage = { key: string; state: string; overdue: boolean; assignee: string | null; pendingActions: string[]; waitingOn: string[]; notes: { text: string }[]; detail: string | null };

const make = async (over: Record<string, unknown> = {}, withOrder = true) => {
  const { Client } = await import('../src/modules/clients/client.model');
  const { SalesOrder } = await import('../src/modules/sales/sales.model');
  const { Project } = await import('../src/modules/projects/project.model');
  const n = ++seq;
  const client = await Client.create({ name: `Journey Co ${n}`, code: `JC${n}`, clientNo: `CLI-9${n}`, contacts: [], status: 'ACTIVE' });
  const order = withOrder ? await SalesOrder.create({ orderNo: `JORD#${n}`, client: client._id, clientType: 'NEW', owner: uid.BD, csAssignee: uid.CS, createdBy: uid.BD, handover: { assignedAt: day(-10) } } as never) : null;
  const project = await Project.create({ code: `1000000${n}`, name: `Journey ${n}`, client: client._id, status: 'IN_PROGRESS', assignedTo: uid.OPS, assignedAt: day(-6), owner: uid.BD, targetDate: day(5), salesOrder: order?._id, ...over } as never);
  return { client, order, project };
};
const change = async (project: unknown, from: string, to: string, at: Date, reason?: string) => {
  const { AuditLog } = await import('../src/modules/audit/auditLog.model');
  await AuditLog.create({ user: uid.OPS, action: 'STATUS_CHANGE', entity: 'Project', entityId: project, project, changes: [{ field: 'status', oldValue: from, newValue: to }], reason, at } as never);
};
const journey = async (id: unknown, role = 'MGMT') => (await api().get(`/api/v1/journey/projects/${id}`).set(as(role))).body.data;
const byKey = (stages: Stage[]) => Object.fromEntries(stages.map((s) => [s.key, s])) as Record<string, Stage>;

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
  for (const [key, role] of [['BD', 'BD'], ['CS', 'CLIENT_SERVICING'], ['OPS', 'OPERATIONS'], ['MGMT', 'MANAGEMENT'], ['ADMIN', 'SUPER_ADMIN']] as const) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
});

describe('project journey (admin monitoring)', () => {
  it('is for Super Admin and Management only', async () => {
    const { project } = await make();
    for (const r of ['BD', 'CS', 'OPS']) {
      expect((await api().get('/api/v1/journey/portfolio').set(as(r))).status, r).toBe(403);
      expect((await api().get(`/api/v1/journey/projects/${project._id}`).set(as(r))).status, r).toBe(403);
    }
    for (const r of ['MGMT', 'ADMIN']) expect((await api().get('/api/v1/journey/portfolio').set(as(r))).status, r).toBe(200);
  });

  it('builds the stages from the real status, dates and code requests', async () => {
    const { project, order } = await make();
    await change(project._id, 'RECCE_ASSIGNED', 'PLANNING', day(-5));
    await change(project._id, 'PLANNING', 'IN_PROGRESS', day(-2), 'Dealer visits booked');
    const { CodeRequest } = await import('../src/modules/codeRequests/codeRequest.model');
    await CodeRequest.create({ order: order!._id, client: order!.client, kind: 'CLIENT_CODE', status: 'CONFIRMED', active: true, confirmedCode: 'CLI-J001', confirmedAt: day(-8), sentAt: day(-9) });
    const j = await journey(project._id);
    const st = byKey(j.stages);
    expect(j.stages.map((s: Stage) => s.key)).toEqual(['HANDOVER', 'CLIENT_CODE', 'PROJECT_CODE', 'RECCE_ASSIGNED', 'PLANNING', 'FIELD_RECCE', 'CLIENT_APPROVAL', 'COMPLETED']);
    expect(['HANDOVER', 'CLIENT_CODE', 'PROJECT_CODE', 'RECCE_ASSIGNED', 'PLANNING'].map((k) => st[k]!.state)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED']);
    expect(st.FIELD_RECCE!.state).toBe('IN_PROGRESS');
    expect(st.FIELD_RECCE!.assignee).toBe('OPS');
    expect(st.FIELD_RECCE!.pendingActions).toEqual(['Send for client approval']);
    expect(st.FIELD_RECCE!.waitingOn).toEqual([]);
    expect(st.CLIENT_APPROVAL!.state).toBe('PENDING');
    expect(st.CLIENT_APPROVAL!.waitingOn).toEqual(['Field Recce']);
    expect(st.FIELD_RECCE!.notes[0]!.text).toBe('Dealer visits booked');
    expect(st.CLIENT_CODE!.detail).toContain('CLI-J001');
    expect(j.currentStage).toBe('FIELD_RECCE');
    expect(j.overdue).toBe(false);
    expect(j.progress).toBe(63);
  });

  it('shows a pending client code and flags overdue work', async () => {
    const { project, order } = await make({ status: 'RECCE_ASSIGNED', targetDate: day(-2) });
    const { CodeRequest } = await import('../src/modules/codeRequests/codeRequest.model');
    await CodeRequest.create({ order: order!._id, client: order!.client, kind: 'CLIENT_CODE', status: 'PENDING_CONFIRMATION', active: true, sentAt: day(-6) });
    const j = await journey(project._id, 'ADMIN');
    const st = byKey(j.stages);
    expect(st.CLIENT_CODE!.state).toBe('IN_PROGRESS');
    expect(st.CLIENT_CODE!.overdue).toBe(true);
    expect(st.CLIENT_CODE!.pendingActions).toEqual(['Enter the confirmed client code']);
    expect(st.RECCE_ASSIGNED!.overdue).toBe(true);
    expect(j.overdue).toBe(true);
  });

  it('marks the stage a held project stopped at as blocked, and a project without an order has no client code step', async () => {
    const { project } = await make({ status: 'ON_HOLD' }, false);
    await change(project._id, 'PLANNING', 'ON_HOLD', day(-1), 'Client asked to pause');
    const st = byKey((await journey(project._id)).stages);
    expect(st.PLANNING!.state).toBe('BLOCKED');
    expect(st.CLIENT_CODE!.state).toBe('NOT_APPLICABLE');
  });

  it('lists the portfolio with a state per stage, filters and summary counts', async () => {
    await make({ status: 'COMPLETED' });
    const res = await api().get('/api/v1/journey/portfolio?limit=50').set(as('MGMT'));
    expect(res.status).toBe(200);
    const done = res.body.data.find((p: { status: string }) => p.status === 'COMPLETED');
    expect(done.states[7]).toBe('COMPLETED');
    expect(res.body.meta.summary.total).toBeGreaterThanOrEqual(5);
    expect(res.body.meta.stages).toHaveLength(8);
    const overdue = await api().get('/api/v1/journey/portfolio?overdue=true').set(as('MGMT'));
    expect(overdue.body.data.length).toBeGreaterThan(0);
    expect(overdue.body.data.every((p: { overdue: boolean }) => p.overdue)).toBe(true);
    const stage = await api().get('/api/v1/journey/portfolio?stage=COMPLETED').set(as('MGMT'));
    expect(stage.body.data.every((p: { status: string }) => p.status === 'COMPLETED')).toBe(true);
    expect((await api().get('/api/v1/journey/portfolio?status=nonsense').set(as('MGMT'))).status).toBe(422);
    expect((await api().get('/api/v1/journey/projects/not-an-id').set(as('MGMT'))).status).toBe(422);
  });
});

describe('stage comments', () => {
  it('lets Management comment on a stage, shows it newest first, and only the author or Super Admin removes it', async () => {
    const { project } = await make();
    const post = (role: string, body: unknown) => api().post(`/api/v1/journey/projects/${project._id}/comments`).set(as(role)).send(body);
    expect((await post('BD', { stage: 'PLANNING', body: 'x' })).status).toBe(403);
    expect((await post('MGMT', { stage: 'NOPE', body: 'x' })).status).toBe(422);
    expect((await post('MGMT', { stage: 'PLANNING', body: '   ' })).status).toBe(422);
    expect((await post('MGMT', { stage: 'PLANNING', body: 'x'.repeat(501) })).status).toBe(422);
    expect((await post('MGMT', { stage: 'PLANNING', body: 'Waiting for the client PO' })).status).toBe(201);
    const res = await post('MGMT', { stage: 'PLANNING', body: 'Chased on call' });
    const stages = byKey(res.body.data.stages) as Record<string, { comments: { id: string; text: string; author: string }[] }>;
    expect(stages.PLANNING!.comments.map((c) => c.text)).toEqual(['Chased on call', 'Waiting for the client PO']);
    expect(stages.FIELD_RECCE!.comments).toHaveLength(0);
    const id = stages.PLANNING!.comments[0]!.id;
    const del = (role: string) => api().delete(`/api/v1/journey/projects/${project._id}/comments/${id}`).set(as(role));
    expect((await del('BD')).status).toBe(403);
    expect((await del('ADMIN')).status).toBe(200);
    expect(((await journey(project._id)) as { stages: Stage[] }).stages.find((s) => s.key === 'PLANNING')).toBeTruthy();
  });
});
