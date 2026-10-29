import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
const PDF = Buffer.from('%PDF-1.4\n% test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const AUDIO = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('fake webm audio')]);
let projectId = '';
let orderId = '';
const W = () => `/api/v1/workspace/projects/${projectId}`;
const onDisk = (name: string) => (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(name)).length;

const addNote = (role: string, body: Record<string, unknown>, files: [Buffer, string][] = []) => {
  const r = api().post(`${W()}/notes`).set(as(role)).field('payload', JSON.stringify(body));
  for (const [buf, name] of files) r.attach('files', buf, name);
  return r;
};
const addVoice = (role: string, body: Record<string, unknown>, file: [Buffer, string] | null = [AUDIO, 'rec.webm']) => {
  const r = api().post(`${W()}/voice-notes`).set(as(role)).field('payload', JSON.stringify(body));
  if (file) r.attach('files', file[0], file[1]);
  return r;
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-workspace-'));
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
  for (const [key, role] of [['BD', 'BD'], ['CS', 'CLIENT_SERVICING'], ['OPS', 'OPERATIONS'], ['FIN', 'FINANCE'], ['MGMT', 'MANAGEMENT'], ['ADMIN', 'SUPER_ADMIN']] as const) {
    const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    uid[key] = String(u._id);
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const { Client } = await import('../src/modules/clients/client.model');
  const { SalesOrder } = await import('../src/modules/sales/sales.model');
  const { Project } = await import('../src/modules/projects/project.model');
  const client = await Client.create({ name: 'Work Co', code: 'WORKCO', clientNo: 'CLI-6001', contacts: [], status: 'ACTIVE' });
  const order = await SalesOrder.create({ orderNo: 'WORD#1', client: client._id, clientType: 'NEW', owner: uid.BD, csAssignee: uid.CS, createdBy: uid.BD } as never);
  const project = await Project.create({ code: '20000001', name: 'Workspace Project', client: client._id, status: 'IN_PROGRESS', owner: uid.BD, assignedTo: uid.OPS, salesOrder: order._id, createdBy: uid.BD } as never);
  projectId = String(project._id);
  orderId = String(order._id);
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('access', () => {
  it('is for the people on the project and Admin / Management', async () => {
    for (const r of ['BD', 'CS', 'OPS', 'MGMT', 'ADMIN']) expect((await api().get(`${W()}/notes`).set(as(r))).status, r).toBe(200);
    for (const path of ['notes', 'voice-notes', 'activity', 'note-draft']) expect((await api().get(`${W()}/${path}`).set(as('FIN'))).status, path).toBe(404);
  });
});

describe('notes', () => {
  it('adds a note with a file and a mention, and notifies the person mentioned', async () => {
    const res = await addNote('BD', { body: '@CS please check', mentions: [uid.CS, uid.FIN], visibility: 'PROJECT' }, [[PDF, 'brief.pdf']]);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ body: '@CS please check', visibility: 'PROJECT', mentions: [uid.CS], canEdit: true });
    expect(res.body.data.attachments[0]).toMatchObject({ name: 'brief.pdf', kind: 'document' });
    const { Notification } = await import('../src/modules/notifications/notification.model');
    // The notification is sent in the background.
    await vi.waitFor(async () => expect((await Notification.findOne({ recipient: uid.CS, kind: 'ACTIVITY' }).lean())?.title).toContain('mentioned you'));
    expect(await Notification.countDocuments({ recipient: uid.FIN })).toBe(0);
    const url = await api().get(`${W()}/notes/${res.body.data.id}/files/${res.body.data.attachments[0].fileId}/url`).set(as('OPS'));
    expect(url.status).toBe(200);
  });

  it('validates the note', async () => {
    expect((await addNote('BD', { body: '   ' })).status).toBe(422);
    expect((await addNote('BD', { body: 'x'.repeat(4001) })).status).toBe(422);
    expect((await addNote('BD', { body: 'hi', visibility: 'EVERYONE' })).status).toBe(422);
  });

  it('keeps a private note to its author, even from Admin', async () => {
    const mine = (await addNote('OPS', { body: 'my own reminder', visibility: 'PRIVATE', mentions: [uid.BD] })).body.data;
    expect(mine.mentions).toEqual([]);
    const seen = (role: string) => api().get(`${W()}/notes`).set(as(role)).then((r) => r.body.data.notes.map((n: { id: string }) => n.id));
    expect(await seen('OPS')).toContain(mine.id);
    for (const r of ['BD', 'CS', 'ADMIN', 'MGMT']) expect(await seen(r), r).not.toContain(mine.id);
    expect((await api().patch(`${W()}/notes/${mine.id}`).set(as('ADMIN')).send({ body: 'x' })).status).toBe(404);
    expect((await api().delete(`${W()}/notes/${mine.id}`).set(as('ADMIN'))).status).toBe(404);
  });

  it('lets only the author edit, and the author or a manager delete (erasing the files)', async () => {
    const n = (await addNote('CS', { body: 'first draft of the plan' }, [[PDF, 'plan.pdf']])).body.data;
    expect(onDisk('plan.pdf')).toBe(1);
    const edit = (role: string) => api().patch(`${W()}/notes/${n.id}`).set(as(role)).send({ body: 'plan v2' });
    expect((await edit('BD')).status).toBe(403);
    expect((await edit('CS')).body.data).toMatchObject({ body: 'plan v2', edited: true });
    expect((await api().delete(`${W()}/notes/${n.id}`).set(as('OPS'))).status).toBe(403);
    expect((await api().delete(`${W()}/notes/${n.id}`).set(as('MGMT'))).status).toBe(200);
    expect(onDisk('plan.pdf')).toBe(0);
    const list = (await api().get(`${W()}/notes`).set(as('CS'))).body.data.notes.map((x: { id: string }) => x.id);
    expect(list).not.toContain(n.id);
  });

  it('autosaves a draft, restores it, and clears it when the note is posted', async () => {
    expect((await api().get(`${W()}/note-draft`).set(as('BD'))).body.data).toBeNull();
    const saved = await api().put(`${W()}/note-draft`).set(as('BD')).send({ body: 'half written', visibility: 'PRIVATE' });
    expect(saved.body.data).toMatchObject({ body: 'half written', visibility: 'PRIVATE' });
    expect((await api().get(`${W()}/note-draft`).set(as('BD'))).body.data.body).toBe('half written');
    expect((await api().get(`${W()}/note-draft`).set(as('OPS'))).body.data).toBeNull();
    await addNote('BD', { body: 'half written, now done' });
    expect((await api().get(`${W()}/note-draft`).set(as('BD'))).body.data).toBeNull();
    await api().put(`${W()}/note-draft`).set(as('BD')).send({ body: 'again', visibility: 'PROJECT' });
    expect((await api().put(`${W()}/note-draft`).set(as('BD')).send({ body: '  ', visibility: 'PROJECT' })).body.data).toBeNull();
    expect((await api().get(`${W()}/note-draft`).set(as('BD'))).body.data).toBeNull();
  });
});

describe('voice notes', () => {
  it('saves a recording with its length and waveform, plays it privately, and deletes it', async () => {
    const res = await addVoice('OPS', { title: 'Site discussion', durationSec: 28.4, peaks: [10, 40, 80, 20] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ title: 'Site discussion', durationSec: 28, peaks: [10, 40, 80, 20], canDelete: true });
    const id = res.body.data.id;
    expect(onDisk('rec.webm')).toBe(1);
    const list = (await api().get(`${W()}/voice-notes`).set(as('BD'))).body.data;
    expect(list.map((v: { id: string }) => v.id)).toContain(id);
    expect(list.find((v: { id: string }) => v.id === id).canDelete).toBe(false);
    expect((await api().get(`${W()}/voice-notes/${id}/url`).set(as('CS'))).body.data.url).toBeTruthy();
    expect((await api().get(`${W()}/voice-notes/${id}/url`).set(as('FIN'))).status).toBe(404);
    expect((await api().delete(`${W()}/voice-notes/${id}`).set(as('BD'))).status).toBe(403);
    expect((await api().delete(`${W()}/voice-notes/${id}`).set(as('OPS'))).status).toBe(200);
    expect(onDisk('rec.webm')).toBe(0);
  });

  it('rejects an empty recording, a missing file and a file that is not audio', async () => {
    expect((await addVoice('OPS', { durationSec: 0 })).status).toBe(422);
    expect((await addVoice('OPS', { durationSec: 5 }, null)).status).toBe(422);
    expect((await addVoice('OPS', { durationSec: 5 }, [PDF, 'doc.pdf'])).status).toBeGreaterThanOrEqual(400);
    expect(onDisk('doc.pdf')).toBe(0);
    expect((await addVoice('OPS', { durationSec: 5, peaks: Array(65).fill(1) })).status).toBe(422);
  });

  it('lets a manager delete someone else\'s recording', async () => {
    const id = (await addVoice('CS', { durationSec: 5 })).body.data.id;
    expect((await api().delete(`${W()}/voice-notes/${id}`).set(as('MGMT'))).status).toBe(200);
  });
});

describe('activity', () => {
  it('lists business events from the project, its order and its code requests, newest first, without shop-level noise', async () => {
    const { AuditLog } = await import('../src/modules/audit/auditLog.model');
    const { CodeRequest } = await import('../src/modules/codeRequests/codeRequest.model');
    const req = await CodeRequest.create({ order: orderId, client: (await (await import('../src/modules/projects/project.model')).Project.findById(projectId))!.client, kind: 'CLIENT_CODE', status: 'CONFIRMED', active: true, confirmedCode: 'CLI-W001' });
    const log = (over: Record<string, unknown>) => AuditLog.create({ user: uid.CS, entity: 'Project', entityId: projectId, project: projectId, action: 'UPDATE', ...over } as never);
    await log({ action: 'CREATE' });
    await log({ action: 'STATUS_CHANGE', changes: [{ field: 'status', oldValue: 'PLANNING', newValue: 'IN_PROGRESS' }] });
    await log({ action: 'ASSIGN', reason: 'Assigned to OPS' });
    await log({ entity: 'SalesOrder', entityId: orderId, project: undefined, action: 'UPLOAD', reason: 'Shop list shops.xlsx: 40 rows' });
    await log({ entity: 'SalesOrder', entityId: orderId, project: undefined, action: 'EMAIL_SENT', reason: 'Project code request email sent to a@b.c' });
    await log({ entity: 'CodeRequest', entityId: String(req._id), project: undefined, action: 'CODE_CONFIRMED', reason: 'Client code confirmed: CLI-W001' });
    await log({ entity: 'Site', entityId: projectId, action: 'UPDATE' });
    await log({ entity: 'ConnectChannel', entityId: projectId, action: 'MESSAGE_PINNED', reason: 'pin' });
    const res = (await api().get(`${W()}/activity?limit=50`).set(as('MGMT'))).body.data;
    const titles = res.events.map((e: { title: string }) => e.title);
    expect(titles).toEqual(expect.arrayContaining(['Project created', 'Stage changed: Planning → In Progress', 'Assigned to OPS', 'Shop list shops.xlsx: 40 rows', 'Project code request email sent to a@b.c', 'Client code confirmed: CLI-W001']));
    expect(titles).not.toContain('pin');
    expect(titles).not.toContain('Site updated');
    const cats = Object.fromEntries(res.events.map((e: { title: string; category: string }) => [e.title, e.category]));
    expect(cats['Project created']).toBe('PROJECT');
    expect(cats['Stage changed: Planning → In Progress']).toBe('STAGE');
    expect(cats['Assigned to OPS']).toBe('ASSIGNMENT');
    expect(cats['Shop list shops.xlsx: 40 rows']).toBe('DOCUMENTS');
    expect(cats['Project code request email sent to a@b.c']).toBe('MAIL');
    expect(cats['Client code confirmed: CLI-W001']).toBe('CODES');
    expect(res.events[0].by).toMatchObject({ name: expect.any(String) });
    const times = res.events.map((e: { at: string }) => +new Date(e.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('filters by area, pages with a cursor, shows note events, and is closed to outsiders', async () => {
    const codes = (await api().get(`${W()}/activity?category=CODES`).set(as('CS'))).body.data;
    expect(codes.events.length).toBeGreaterThan(0);
    expect(codes.events.every((e: { category: string }) => e.category === 'CODES')).toBe(true);
    const p1 = (await api().get(`${W()}/activity?limit=3`).set(as('CS'))).body.data;
    expect(p1.events).toHaveLength(3);
    expect(p1.hasMore).toBe(true);
    const p2 = (await api().get(`${W()}/activity?limit=3&before=${p1.nextBefore}`).set(as('CS'))).body.data;
    expect(p2.events.map((e: { id: string }) => e.id).filter((i: string) => p1.events.some((x: { id: string }) => x.id === i))).toEqual([]);
    const notes = (await api().get(`${W()}/activity?category=NOTES`).set(as('CS'))).body.data.events.map((e: { title: string }) => e.title);
    expect(notes).toEqual(expect.arrayContaining(['Note added with 1 file', 'Voice note added: Site discussion']));
    expect((await api().get(`${W()}/activity`).set(as('FIN'))).status).toBe(404);
    expect((await api().get(`${W()}/activity?category=NOPE`).set(as('CS'))).status).toBe(422);
  });

  it('does not log private notes, so they cannot be seen through the history', async () => {
    const before = (await api().get(`${W()}/activity?category=NOTES&limit=100`).set(as('CS'))).body.data.events.length;
    await addNote('OPS', { body: 'secret thing', visibility: 'PRIVATE' });
    expect((await api().get(`${W()}/activity?category=NOTES&limit=100`).set(as('CS'))).body.data.events.length).toBe(before);
  });
});

describe('cleanup', () => {
  it('deleting the project removes its notes, drafts, voice notes and files', async () => {
    const { ProjectNote, NoteDraft, ProjectVoiceNote } = await import('../src/modules/workspace/workspace.model');
    await addNote('BD', { body: 'bye' }, [[PDF, 'gone-note.pdf']]);
    await addVoice('BD', { durationSec: 4 }, [AUDIO, 'gone-voice.webm']);
    await api().put(`${W()}/note-draft`).set(as('CS')).send({ body: 'unsent', visibility: 'PROJECT' });
    expect(onDisk('gone-note.pdf')).toBe(1);
    expect(onDisk('gone-voice.webm')).toBe(1);
    expect((await api().delete(`/api/v1/projects/${projectId}`).set(as('ADMIN'))).status).toBe(200);
    expect(onDisk('gone-note.pdf')).toBe(0);
    expect(onDisk('gone-voice.webm')).toBe(0);
    for (const m of [ProjectNote, NoteDraft, ProjectVoiceNote] as { countDocuments: (q: object) => Promise<number> }[]) expect(await m.countDocuments({ project: projectId })).toBe(0);
  });
});

describe('overview', () => {
  it('gives the workspace header and the people who can be mentioned', async () => {
    const { Project } = await import('../src/modules/projects/project.model');
    const { Client } = await import('../src/modules/clients/client.model');
    const c = await Client.create({ name: 'Overview Co', code: 'OVCO', clientNo: 'CLI-6002', contacts: [], status: 'ACTIVE' });
    const p = await Project.create({ code: '20000002', name: 'Overview Project', client: c._id, status: 'PLANNING', owner: uid.BD, assignedTo: uid.OPS, createdBy: uid.BD } as never);
    const res = await api().get(`/api/v1/workspace/projects/${p._id}`).set(as('BD'));
    expect(res.body.data.project).toMatchObject({ code: '20000002', status: 'PLANNING', client: { name: 'Overview Co' } });
    expect(res.body.data.people.map((x: { name: string }) => x.name).sort()).toEqual(['BD', 'OPS']);
    expect(res.body.data.counts).toEqual({ notes: 0, voiceNotes: 0 });
    expect((await api().get(`/api/v1/workspace/projects/${p._id}`).set(as('CS'))).status).toBe(404);
  });
});
