import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as connectClient, type Socket } from 'socket.io-client';
import type { Express } from 'express';

let mongod: MongoMemoryServer;
let app: Express;
let server: ReturnType<Express['listen']>;
let disconnectDb: () => Promise<unknown>;
let root: string;
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
const PDF = Buffer.from('%PDF-1.4\n% test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const AUDIO = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('fake webm audio')]);
let projectId = '';
let projectChannel = '';
const B = '/api/v1/connect';

const post = (ch: string, role: string, body: Record<string, unknown>, files: [Buffer, string][] = []) => {
  const r = api().post(`${B}/channels/${ch}/messages`).set(as(role)).field('payload', JSON.stringify(body));
  for (const [buf, name] of files) r.attach('files', buf, name);
  return r;
};
const onDiskFile = (name: string) => (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(name)).length;
const connectSock = (role: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const s = connectClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { auth: { token: tokens[role] }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
const listMsgs = async (ch: string, role: string, q = '') => (await api().get(`${B}/channels/${ch}/messages${q}`).set(as(role))).body.data;
const channels = async (role: string) => (await api().get(`${B}/channels`).set(as(role))).body.data as { id: string; name: string; kind: string; unread: number; mentionUnread: number }[];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-connect-'));
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
  const client = await Client.create({ name: 'Chat Co', code: 'CHATCO', clientNo: 'CLI-5001', contacts: [], status: 'ACTIVE' });
  const order = await SalesOrder.create({ orderNo: 'CORD#1', client: client._id, clientType: 'NEW', owner: uid.BD, csAssignee: uid.CS, createdBy: uid.BD } as never);
  const project = await Project.create({ code: '10000001', name: 'Chat Project', client: client._id, status: 'IN_PROGRESS', owner: uid.BD, assignedTo: uid.OPS, salesOrder: order._id, createdBy: uid.BD } as never);
  projectId = String(project._id);
  const hub = await import('../src/modules/connect/connect.hub');
  server = app.listen(0);
  hub.initConnectSocket(server);
});
afterAll(async () => {
  (await import('../src/modules/connect/connect.hub')).closeConnectSocket();
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('project channels', () => {
  it('appear for the people on the project, with those people as members', async () => {
    for (const r of ['BD', 'CS', 'OPS']) {
      const mine = (await channels(r)).filter((c) => c.kind === 'PROJECT');
      expect(mine.map((c) => c.name), r).toEqual(['10000001']);
    }
    expect((await channels('FIN')).filter((c) => c.kind === 'PROJECT')).toEqual([]);
    projectChannel = (await channels('BD')).find((c) => c.kind === 'PROJECT')!.id;
    const d = (await api().get(`${B}/channels/${projectChannel}`).set(as('BD'))).body.data;
    expect(d.members.map((m: { name: string }) => m.name).sort()).toEqual(['BD', 'CS', 'OPS']);
  });

  it('hides it from people outside the project, lets Admin and Management browse and join it', async () => {
    expect((await api().get(`${B}/channels/${projectChannel}`).set(as('FIN'))).status).toBe(404);
    expect((await post(projectChannel, 'FIN', { body: 'hi' })).status).toBe(404);
    expect((await api().get(`${B}/channels/browse`).set(as('FIN'))).status).toBe(403);
    const browse = (await api().get(`${B}/channels/browse`).set(as('MGMT'))).body.data;
    expect(browse.map((c: { id: string }) => c.id)).toContain(projectChannel);
    const read = await api().get(`${B}/channels/${projectChannel}`).set(as('MGMT'));
    expect(read.status).toBe(200);
    expect(read.body.data.canPost).toBe(false);
    expect((await post(projectChannel, 'MGMT', { body: 'can I?' })).status).toBe(403);
    expect((await api().post(`${B}/channels/${projectChannel}/join`).set(as('MGMT'))).body.data.canPost).toBe(true);
  });

  it('can be opened by project id by the people on it, and refused to others', async () => {
    expect((await api().post(`${B}/channels/project/${projectId}`).set(as('CS'))).body.data.id).toBe(projectChannel);
    expect((await api().post(`${B}/channels/project/${projectId}`).set(as('FIN'))).status).toBe(404);
  });
});

describe('messages', () => {
  it('posts, lists, replies in a thread and counts unread until read', async () => {
    const first = (await post(projectChannel, 'BD', { body: 'Please confirm the site visit plan' })).body.data;
    expect(first.body).toBe('Please confirm the site visit plan');
    const reply = await post(projectChannel, 'OPS', { body: 'Sure, visiting on the 22nd', parent: first.id });
    expect(reply.status).toBe(201);
    expect((await post(projectChannel, 'CS', { body: 'nested', parent: reply.body.data.id })).status).toBe(409);
    const top = (await listMsgs(projectChannel, 'CS')).messages;
    expect(top.map((m: { id: string }) => m.id)).toEqual([first.id]);
    expect(top[0].replyCount).toBe(1);
    const thread = await listMsgs(projectChannel, 'CS', `?thread=${first.id}`);
    expect(thread.messages.map((m: { body: string }) => m.body)).toEqual(['Sure, visiting on the 22nd']);
    expect(thread.root.id).toBe(first.id);
    const unread = (await channels('CS')).find((c) => c.id === projectChannel)!;
    expect(unread.unread).toBe(2);
    await api().post(`${B}/channels/${projectChannel}/read`).set(as('CS'));
    expect((await channels('CS')).find((c) => c.id === projectChannel)!.unread).toBe(0);
    expect((await channels('BD')).find((c) => c.id === projectChannel)!.unread).toBe(1); // OPS replied after BD
  });

  it('validates the message and keeps mentions to people who can read the channel', async () => {
    expect((await post(projectChannel, 'BD', { body: '   ' })).status).toBe(422);
    expect((await post(projectChannel, 'BD', { body: 'x'.repeat(4001) })).status).toBe(422);
    const m = (await post(projectChannel, 'BD', { body: '@CS and @FIN look', mentions: [uid.CS, uid.FIN] })).body.data;
    expect(m.mentions).toEqual([uid.CS]);
    expect((await channels('CS')).find((c) => c.id === projectChannel)!.mentionUnread).toBe(1);
  });

  it('lets only the author edit; author, owner or Admin delete; deleting erases the files', async () => {
    const m = (await post(projectChannel, 'OPS', { body: 'plan attached' }, [[PDF, 'plan.pdf']])).body.data;
    expect(m.attachments[0]).toMatchObject({ name: 'plan.pdf', kind: 'document' });
    const filesOnDisk = () => (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('plan.pdf')).length;
    expect(filesOnDisk()).toBe(1);
    const edit = (role: string) => api().patch(`${B}/channels/${projectChannel}/messages/${m.id}`).set(as(role)).send({ body: 'plan v2' });
    expect((await edit('BD')).status).toBe(403);
    const edited = await edit('OPS');
    expect(edited.body.data).toMatchObject({ body: 'plan v2', edited: true });
    const del = (role: string) => api().delete(`${B}/channels/${projectChannel}/messages/${m.id}`).set(as(role));
    expect((await del('CS')).status).toBe(403);
    const gone = await del('OPS');
    expect(gone.body.data).toMatchObject({ deleted: true, body: '', attachments: [] });
    expect(filesOnDisk()).toBe(0);
    expect((await api().patch(`${B}/channels/${projectChannel}/messages/${m.id}`).set(as('OPS')).send({ body: 'again' })).status).toBe(409);
    // the owner of the channel (BD created the project) can remove someone else's message
    const other = (await post(projectChannel, 'CS', { body: 'off topic' })).body.data;
    expect((await api().delete(`${B}/channels/${projectChannel}/messages/${other.id}`).set(as('BD'))).status).toBe(200);
  });

  it('toggles reactions and pins messages', async () => {
    const m = (await post(projectChannel, 'BD', { body: 'important' })).body.data;
    const react = (role: string, emoji = '👍') => api().post(`${B}/channels/${projectChannel}/messages/${m.id}/reactions`).set(as(role)).send({ emoji });
    expect((await react('CS')).body.data.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    expect((await react('OPS')).body.data.reactions[0].count).toBe(2);
    expect((await react('CS')).body.data.reactions[0]).toMatchObject({ count: 1, mine: false });
    expect((await react('CS', 'abc')).status).toBe(422);
    const pin = await api().post(`${B}/channels/${projectChannel}/pins`).set(as('CS')).send({ messageId: m.id });
    expect(pin.body.data.pinned).toEqual([m.id]);
    expect((await api().get(`${B}/channels/${projectChannel}/pins`).set(as('BD'))).body.data.map((x: { id: string }) => x.id)).toEqual([m.id]);
    expect((await api().delete(`${B}/channels/${projectChannel}/pins/${m.id}`).set(as('CS'))).body.data.pinned).toEqual([]);
  });

  it('shares voice notes and files, previews them privately, and lists them under Files', async () => {
    const v = (await post(projectChannel, 'OPS', { body: '', voice: { durationSec: 12.4, peaks: [5, 60, 100, 30] } }, [[AUDIO, 'note.webm']])).body.data;
    expect(v.attachments[0]).toMatchObject({ voice: true, durationSec: 12, kind: 'audio', peaks: [5, 60, 100, 30] });
    expect((await post(projectChannel, 'OPS', { body: '', voice: { durationSec: 3, peaks: Array(65).fill(1) } }, [[AUDIO, 'many.webm']])).status).toBe(422);
    const url = await api().get(`${B}/channels/${projectChannel}/files/${v.attachments[0].fileId}/url`).set(as('BD'));
    expect(url.status).toBe(200);
    expect(url.body.data.url).toBeTruthy();
    expect((await api().get(`${B}/channels/${projectChannel}/files/${v.attachments[0].fileId}/url`).set(as('FIN'))).status).toBe(404);
    const files = (await api().get(`${B}/channels/${projectChannel}/files`).set(as('CS'))).body.data;
    expect(files.some((f: { name: string; voice: boolean }) => f.name === 'note.webm' && f.voice)).toBe(true);
    expect((await post(projectChannel, 'OPS', { body: 'bad' }, [[Buffer.from('MZ'), 'virus.exe']])).status).toBeGreaterThanOrEqual(400);
  });

  it('searches only the channels the person is in', async () => {
    await post(projectChannel, 'BD', { body: 'the quokka deadline is Friday' });
    const hit = await api().get(`${B}/search?q=quokka`).set(as('CS'));
    expect(hit.body.data).toHaveLength(1);
    expect(hit.body.data[0].channelName).toBe('10000001');
    expect((await api().get(`${B}/search?q=quokka`).set(as('FIN'))).body.data).toEqual([]);
    expect((await api().get(`${B}/search?q=q`).set(as('CS'))).status).toBe(422);
  });
});

describe('direct, private and team channels', () => {
  it('keeps a direct message between its two people, even from Super Admin', async () => {
    const dm = (await api().post(`${B}/channels`).set(as('BD')).send({ kind: 'DM', memberIds: [uid.CS] })).body.data;
    expect(dm.name).toBe('CS');
    const again = (await api().post(`${B}/channels`).set(as('CS')).send({ kind: 'DM', memberIds: [uid.BD] })).body.data;
    expect(again.id).toBe(dm.id);
    expect((await post(dm.id, 'BD', { body: 'private words' })).status).toBe(201);
    for (const r of ['ADMIN', 'MGMT', 'OPS']) expect((await api().get(`${B}/channels/${dm.id}/messages`).set(as(r))).status, r).toBe(404);
    expect((await api().post(`${B}/channels/${dm.id}/members`).set(as('BD')).send({ userIds: [uid.OPS] })).status).toBe(403);
    expect((await api().post(`${B}/channels`).set(as('BD')).send({ kind: 'DM', memberIds: [uid.BD] })).status).toBe(422);
    expect((await channels('CS')).find((c) => c.id === dm.id)).toMatchObject({ name: 'BD', unread: 1 });
  });

  it('manages members of a private channel', async () => {
    const ch = (await api().post(`${B}/channels`).set(as('BD')).send({ kind: 'PRIVATE', name: 'Quote review', memberIds: [uid.CS] })).body.data;
    expect((await api().get(`${B}/channels/${ch.id}`).set(as('OPS'))).status).toBe(404);
    expect((await api().post(`${B}/channels/${ch.id}/members`).set(as('CS')).send({ userIds: [uid.OPS] })).status).toBe(403);
    const added = await api().post(`${B}/channels/${ch.id}/members`).set(as('BD')).send({ userIds: [uid.OPS] });
    expect(added.body.data.members.map((m: { name: string }) => m.name).sort()).toEqual(['BD', 'CS', 'OPS']);
    expect((await api().get(`${B}/channels/${ch.id}`).set(as('OPS'))).status).toBe(200);
    expect((await api().delete(`${B}/channels/${ch.id}/members/${uid.OPS}`).set(as('CS'))).status).toBe(403);
    expect((await api().delete(`${B}/channels/${ch.id}/members/${uid.OPS}`).set(as('BD'))).status).toBe(200);
    expect((await api().get(`${B}/channels/${ch.id}`).set(as('OPS'))).status).toBe(404);
    expect((await api().delete(`${B}/channels/${ch.id}/members/${uid.BD}`).set(as('BD'))).status).toBe(409); // last owner
    const hist = (await api().get(`${B}/channels/${ch.id}/history`).set(as('BD'))).body.data.map((h: { action: string }) => h.action);
    expect(hist).toEqual(expect.arrayContaining(['CHANNEL_CREATED', 'MEMBER_ADDED', 'MEMBER_REMOVED']));
  });

  it('lets only Admin or Management create team channels, limited to chosen roles', async () => {
    const make = (role: string, body: Record<string, unknown>) => api().post(`${B}/channels`).set(as(role)).send({ kind: 'TEAM', ...body });
    expect((await make('BD', { name: 'ops-only' })).status).toBe(403);
    const t = (await make('MGMT', { name: 'ops-only', allowedRoles: ['OPERATIONS'] })).body.data;
    expect((await channels('OPS')).some((c) => c.id === t.id)).toBe(true);
    expect((await channels('BD')).some((c) => c.id === t.id)).toBe(false);
    expect((await api().get(`${B}/channels/${t.id}`).set(as('BD'))).status).toBe(404);
    const everyone = (await make('ADMIN', { name: 'general' })).body.data;
    for (const r of ['BD', 'CS', 'FIN']) expect((await channels(r)).some((c) => c.id === everyone.id), r).toBe(true);
    expect((await post(everyone.id, 'FIN', { body: 'hello all' })).status).toBe(201);
  });

  it('lists people to message without exposing contact details', async () => {
    const list = (await api().get(`${B}/people?q=CS`).set(as('BD'))).body.data;
    expect(list).toEqual([{ id: uid.CS, name: 'CS', role: 'CLIENT_SERVICING' }]);
  });
});

describe('realtime', () => {
  const connect = (role: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const s = connectClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { auth: { token: tokens[role] }, transports: ['websocket'] });
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  const join = (s: Socket, ch: string) => new Promise<boolean>((r) => s.emit('channel:join', ch, (a: { ok: boolean }) => r(a.ok)));

  it('refuses a connection without a valid token', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const s = connectClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { auth: { token: 'nope' }, transports: ['websocket'], reconnection: false });
        s.on('connect', () => resolve(s));
        s.on('connect_error', (e) => reject(e));
      }),
    ).rejects.toThrow();
  });

  it('delivers new messages only to people allowed in the channel', async () => {
    const cs = await connect('CS');
    const fin = await connect('FIN');
    try {
      expect(await join(cs, projectChannel)).toBe(true);
      expect(await join(fin, projectChannel)).toBe(false);
      const gotCs = new Promise<{ body: string }>((r) => cs.once('message:new', r));
      let leaked = false;
      fin.on('message:new', () => (leaked = true));
      const activity = new Promise<{ channelId: string; mention: boolean }>((r) => cs.once('connect:activity', r));
      await post(projectChannel, 'BD', { body: 'live hello', mentions: [uid.CS] });
      expect((await gotCs).body).toBe('live hello');
      expect(await activity).toMatchObject({ channelId: projectChannel, mention: true });
      await new Promise((r) => setTimeout(r, 150));
      expect(leaked).toBe(false);
    } finally {
      cs.close();
      fin.close();
    }
  });

  it('stops delivering to someone who is removed from the channel', async () => {
    const ch = (await api().post(`${B}/channels`).set(as('BD')).send({ kind: 'PRIVATE', name: 'live-private', memberIds: [uid.OPS] })).body.data;
    const ops = await connect('OPS');
    try {
      expect(await join(ops, ch.id)).toBe(true);
      await api().delete(`${B}/channels/${ch.id}/members/${uid.OPS}`).set(as('BD'));
      let got = false;
      ops.on('message:new', () => (got = true));
      await post(ch.id, 'BD', { body: 'after removal' });
      await new Promise((r) => setTimeout(r, 150));
      expect(got).toBe(false);
    } finally {
      ops.close();
    }
  });
});

describe('clearing a chat (Super Admin only)', () => {
  it('deletes the chosen messages for good, erasing their files, and only for Super Admin', async () => {
    const keep = (await post(projectChannel, 'BD', { body: 'keep me' })).body.data;
    const a = (await post(projectChannel, 'OPS', { body: 'remove one', parent: undefined }, [[PDF, 'bulk-a.pdf']])).body.data;
    const b = (await post(projectChannel, 'CS', { body: 'remove two' })).body.data;
    expect(onDiskFile('bulk-a.pdf')).toBe(1);
    const bulk = (role: string, ids: string[]) => api().post(`${B}/channels/${projectChannel}/messages/bulk-delete`).set(as(role)).send({ ids });
    for (const r of ['BD', 'OPS', 'MGMT']) expect((await bulk(r, [a.id])).status, r).toBe(403);
    expect((await bulk('ADMIN', [])).status).toBe(422);
    const done = await bulk('ADMIN', [a.id, b.id]);
    expect(done.body.data).toEqual({ deleted: 2 });
    expect(onDiskFile('bulk-a.pdf')).toBe(0);
    const list = (await listMsgs(projectChannel, 'BD')).messages;
    expect(list.find((m: { id: string }) => m.id === a.id)).toMatchObject({ deleted: true, body: '', attachments: [] });
    expect(list.find((m: { id: string }) => m.id === keep.id).deleted).toBe(false);
    expect((await bulk('ADMIN', [a.id])).body.data).toEqual({ deleted: 0 });
    const hist = (await api().get(`${B}/channels/${projectChannel}/history`).set(as('BD'))).body.data.map((h: { action: string }) => h.action);
    expect(hist).toContain('MESSAGES_DELETED');
  });

  it('clears a whole conversation', async () => {
    const ch = (await api().post(`${B}/channels`).set(as('ADMIN')).send({ kind: 'PRIVATE', name: 'to-clear', memberIds: [uid.BD] })).body.data;
    await post(ch.id, 'ADMIN', { body: 'one' });
    const second = (await post(ch.id, 'BD', { body: 'two' })).body.data;
    await post(ch.id, 'ADMIN', { body: 'reply', parent: second.id });
    expect((await api().post(`${B}/channels/${ch.id}/messages/clear`).set(as('BD'))).status).toBe(403);
    expect((await api().post(`${B}/channels/${ch.id}/messages/clear`).set(as('ADMIN'))).body.data).toEqual({ deleted: 3 });
    expect((await listMsgs(ch.id, 'ADMIN')).messages.every((m: { deleted: boolean }) => m.deleted)).toBe(true);
  });

  it('tells the other person a voice note arrived, with what is needed to play it', async () => {
    const cs = await connectSock('CS');
    try {
      const ev = new Promise<{ voice: { fileId: string; durationSec: number } | null; messageId: string }>((r) => cs.once('connect:activity', r));
      const m = (await post(projectChannel, 'BD', { body: '', voice: { durationSec: 9 } }, [[AUDIO, 'ping.webm']])).body.data;
      const got = await ev;
      expect(got.messageId).toBe(m.id);
      expect(got.voice).toEqual({ fileId: m.attachments[0].fileId, durationSec: 9 });
      const text = new Promise<{ voice: unknown }>((r) => cs.once('connect:activity', r));
      await post(projectChannel, 'BD', { body: 'just text' });
      expect((await text).voice).toBeNull();
    } finally {
      cs.close();
    }
  });
});

describe('cleanup', () => {
  it('deleting the project removes its channel, messages and stored files', async () => {
    const { ConnectChannel, ConnectMessage } = await import('../src/modules/connect/connect.model');
    await post(projectChannel, 'BD', { body: 'file to go' }, [[PDF, 'goes-away.pdf']]);
    const onDisk = () => (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('goes-away.pdf')).length;
    expect(onDisk()).toBe(1);
    const del = await api().delete(`/api/v1/projects/${projectId}`).set(as('ADMIN'));
    expect(del.status).toBe(200);
    expect(onDisk()).toBe(0);
    expect(await ConnectChannel.countDocuments({ project: projectId })).toBe(0);
    expect(await ConnectMessage.countDocuments({ channel: projectChannel })).toBe(0);
  });
});
