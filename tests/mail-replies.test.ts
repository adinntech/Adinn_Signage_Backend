import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import { findClientCode, findEstimates, findProjectCode, findVendorNo, freshText, requestIdsIn, senderAllowed } from '../src/modules/mailReplies/replyParser';
import type { OutgoingMail } from '../src/modules/notifications/mail.service';

const ID = 'ADN-Signage-prj-06122601';

describe('reply parser', () => {
  it('finds the request id in a reply subject, whatever the case', () => {
    expect(requestIdsIn(`Re: Project Code Request - ${ID}`)).toEqual([ID]);
    expect(requestIdsIn('RE: x - adn-signage-PRJ-06122601 and ADN-Signage-vnd-06122702')).toEqual([ID, 'ADN-Signage-vnd-06122702']); // mail clients change the case; ids come back in the stored spelling
    expect(requestIdsIn('RE: x - ADN-Signage-xyz-06122601 REQ-1234')).toEqual([]);
  });

  it('keeps only what the person wrote, not the quoted original', () => {
    const body = 'Project code is 11223344\n\nOn Fri, 6 Dec 2026 at 10:00, CS <cs@adinn.co.in> wrote:\n> Please create the project code 99999999\n> ' + ID;
    expect(freshText(body)).toBe('Project code is 11223344');
    expect(freshText('Done 11223344\n> quoted 55555555')).toBe('Done 11223344');
    expect(freshText('Hi\n-----Original Message-----\nFrom: a@b.com\n77777777')).toBe('Hi');
  });

  it('project code: one 8-digit number, never the request id, never when two differ', () => {
    expect(findProjectCode('Project code: 11223344').code).toBe('11223344');
    expect(findProjectCode('Created. 11223344 Thanks').code).toBe('11223344');
    expect(findProjectCode(`Re ${ID} created 11223344`).code).toBe('11223344'); // 06122601 is also 8 digits but belongs to the id
    const many = 'Project code 22068682\nEST-020456\nEST-020457\nEST-020456 again, est-12345678';
    expect(findProjectCode(many).code).toBe('22068682'); // an 8-digit estimate number is not a second project code
    expect(findEstimates(many)).toEqual(['EST-020456', 'EST-020457', 'EST-12345678']);
    expect(findEstimates('no estimates, TEST-123 is not one')).toEqual([]);
    expect(findProjectCode('Code 11223344 and 55667788')).toEqual({ code: null, ambiguous: ['11223344', '55667788'] });
    expect(findProjectCode('Mobile 9876543210, ref 1234567')).toEqual({ code: null, ambiguous: [] });
    expect(findProjectCode('Project code 11223344, project 11223344').code).toBe('11223344');
  });

  it('client code: only after the words "client code" and with a digit', () => {
    expect(findClientCode('Client code is CLI-0018').code).toBe('CLI-0018');
    expect(findClientCode('client code: ab12').code).toBe('AB12');
    expect(findClientCode('Client code is created, thanks').code).toBeNull();
    expect(findClientCode('The code is CLI-0018').code).toBeNull();
  });

  it('vendor id: labelled number or a reply that is just the number', () => {
    expect(findVendorNo('Vendor ID: 4521').code).toBe('4521');
    expect(findVendorNo('vendor no 88').code).toBe('88');
    expect(findVendorNo('4521\n\nRegards').code).toBe('4521');
    expect(findVendorNo('Registered, number 4521 for you').code).toBe('4521'); // the only number in the reply
  });

  it('only the people the mail went to (or their domain) may answer', () => {
    const to = ['codes@adinn.test', 'sm@adinn.test'];
    expect(senderAllowed(['codes@adinn.test'], to)).toBe(true);
    expect(senderAllowed(['Anyone@Adinn.Test'], to)).toBe(true); // reply from a member of the group mailbox
    expect(senderAllowed(['x@evil.com'], to)).toBe(false);
    expect(senderAllowed([], to)).toBe(false);
  });
});

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let setMailSender: (s: ((m: OutgoingMail) => Promise<void>) | undefined) => void;
let root: string;
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
let seq = 0;

const makeOrder = async () => {
  const { Client } = await import('../src/modules/clients/client.model');
  const { SalesOrder } = await import('../src/modules/sales/sales.model');
  const n = ++seq;
  const c = await Client.create({ name: `Reply Co ${n}`, code: `REPLYCO${n}`, clientNo: `CLI-7${n}`, contacts: [], status: 'ACTIVE' });
  return String((await SalesOrder.create({ orderNo: `2026ORD#${900 + n}`, client: c._id, clientType: 'NEW', owner: uid.BD, csAssignee: uid.CS, createdBy: uid.BD }))._id);
};
const sendProject = (order: string, key: string) =>
  api().post(`/api/v1/sales/orders/${order}/codes/send`).set(as('CS')).field('payload', JSON.stringify({ mails: [{ kinds: ['PROJECT_CODE'], to: ['codes@adinn.test'], cc: ['sm@adinn.test'], bcc: [], subject: 'Project code request', body: '<p>Please</p>' }], requestKey: key, includeClientDocs: [] }));
const view = async (order: string) => (await api().get(`/api/v1/sales/orders/${order}/codes`).set(as('CS'))).body.data;
let n = 0;
const reply = (requestId: string, over: Record<string, unknown> = {}) => ({
  messageId: `<m${++n}@adinn.test>`,
  from: ['codes@adinn.test'],
  subject: `Re: Project code request - ${requestId}`,
  text: `Project code is 11223344\n\nOn Fri wrote:\n> Please create ${requestId}`,
  ...over,
});

describe('replies to a code request', () => {
  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-replies-'));
    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI = mongod.getUri();
    expect(process.env.MONGODB_URI).toContain('127.0.0.1'); // never the real database
    process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
    process.env.STORAGE_TYPE = 'local';
    process.env.LOCAL_UPLOAD_PATH = root;
    const db = await import('../src/config/db');
    disconnectDb = db.disconnectDb;
    await db.connectDb();
    setMailSender = (await import('../src/modules/notifications/mail.service')).setMailSenderForTests;
    const { User } = await import('../src/modules/users/user.model');
    const { hashPassword } = await import('../src/modules/auth/auth.service');
    app = (await import('../src/app')).createApp();
    for (const [key, role] of [['BD', 'BD'], ['CS', 'CLIENT_SERVICING'], ['ADMIN', 'SUPER_ADMIN']] as const) {
      const u = await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
      uid[key] = String(u._id);
      tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
    }
    setMailSender(async () => undefined);
  });
  afterAll(async () => {
    setMailSender(undefined);
    await disconnectDb();
    await mongod.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('the sent mail carries the request id in its subject', async () => {
    const order = await makeOrder();
    const res = await sendProject(order, 'reply-key-0001');
    const row = res.body.data.requests[0];
    expect(row.requestId).toMatch(/^ADN-Signage-prj-\d{8,}$/);
    expect(row.mail.subject).toContain(row.requestId);
  });

  it('saves the code found in a reply for a person to verify (nothing is confirmed on its own)', async () => {
    const { processReply } = await import('../src/modules/mailReplies/mailReply.service');
    const order = await makeOrder();
    const row = (await sendProject(order, 'reply-key-0002')).body.data.requests[0];
    const m = reply(row.requestId);
    expect(await processReply(m)).toBe('saved');
    const after = (await view(order)).requests[0];
    expect(after.reply).toMatchObject({ from: 'codes@adinn.test', detectedCode: '11223344' });
    expect(after.status).toBe('PENDING_CONFIRMATION');
    expect(await processReply(m)).toBe('duplicate'); // the same mail read twice
    // a person verifies it with the normal confirm call
    const ok = await api().post(`/api/v1/sales/orders/${order}/codes/confirm`).set(as('CS')).send({ kind: 'PROJECT_CODE', code: after.reply.detectedCode, evidenceNote: 'from reply' });
    expect(ok.status).toBe(200);
  });

  it('a corrected reply overwrites the first; the person can edit the fetched code and estimates, and the edits are kept with who and when', async () => {
    const { processReply } = await import('../src/modules/mailReplies/mailReply.service');
    const order = await makeOrder();
    const row = (await sendProject(order, 'reply-key-0009')).body.data.requests[0];
    const first = reply(row.requestId);
    expect(await processReply({ ...first, messageId: '<c1@adinn.test>', text: 'Project code 20205768 EST-020456 EST-020457' })).toBe('saved');
    expect(await processReply({ ...first, messageId: '<c2@adinn.test>', text: 'Sorry, project code 20205769 EST-020456 EST-020458', receivedAt: new Date(Date.now() + 60_000) })).toBe('saved');
    const { CodeRequest } = await import('../src/modules/codeRequests/codeRequest.model');
    const got = (await CodeRequest.findOne({ requestId: row.requestId }).lean())!;
    expect(got.reply).toMatchObject({ detectedCode: '20205769', estimates: ['EST-020456', 'EST-020458'] });
    expect(got.replyHistory?.map((h) => h.detectedCode)).toEqual(['20205768', '20205769']);
    // the person fixes the code and drops one estimate before confirming
    const ok = await api().post(`/api/v1/sales/orders/${order}/codes/confirm`).set(as('CS')).send({ kind: 'PROJECT_CODE', code: '20205770', estimates: ['est-020456', 'EST-020459'], evidenceNote: 'edited' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const done = (await CodeRequest.findOne({ requestId: row.requestId }).lean())!;
    expect(done).toMatchObject({ confirmedCode: '20205770', estimates: ['EST-020456', 'EST-020459'] });
    expect(done.editHistory?.map((e) => [e.field, e.from, e.to, e.byName])).toEqual([['code', '20205769', '20205770', 'CS'], ['estimates', 'EST-020456, EST-020458', 'EST-020456, EST-020459', 'CS']]);
    expect(done.editHistory?.every((e) => e.at instanceof Date)).toBe(true);
    const bad = await api().post(`/api/v1/sales/orders/${(await makeOrder())}/codes/confirm`).set(as('CS')).send({ kind: 'PROJECT_CODE', code: '20205771', estimates: ['ABC'] });
    expect(bad.status).toBe(422);
  });

  it('the project code request mail sent from Project Assign (Recce): its reply is read onto the order, never saved as the code by itself', async () => {
    const { processReply } = await import('../src/modules/mailReplies/mailReply.service');
    const { SalesOrder } = await import('../src/modules/sales/sales.model');
    const order = await makeOrder();
    const id = 'ADN-Signage-prj-10112699';
    await SalesOrder.updateOne({ _id: order }, { $push: { salesprofile: { kind: 'PROJECT_CODE_REQUEST', to: ['codes@adinn.test'], cc: ['sm@adinn.test'], subject: `Project Code Request - ${id}`, status: 'SENT', requestId: id, sentBy: uid.CS } } });
    const m = (messageId: string, text: string, extra: Record<string, unknown> = {}) => ({ messageId, from: ['codes@adinn.test'], subject: `Re: Project Code Request - ${id}`, text, ...extra });
    expect(await processReply({ ...m('<s0@x>', 'Project code 22070277', {}), from: ['x@evil.com'] })).toBe('rejected');
    expect(await processReply(m('<s1@x>', 'Dear Sir,\nProject code 22070277\nEST-323343 EST-323344'))).toBe('saved');
    expect(await processReply(m('<s1@x>', 'Dear Sir,\nProject code 22070277'))).toBe('duplicate');
    // a corrected reply overwrites what is shown; both stay in the history
    expect(await processReply(m('<s2@x>', 'Sorry, project code 22070278 EST-323345', { receivedAt: new Date(Date.now() + 60_000) }))).toBe('saved');
    const got = (await SalesOrder.findById(order).lean())!;
    expect(got.recce?.codeReply).toMatchObject({ detectedCode: '22070278', estimates: ['EST-323345'] });
    expect(got.recce?.codeReplyHistory?.map((h) => h.detectedCode)).toEqual(['22070277', '22070278']);
    expect(got.recce?.projectCode).toBeUndefined(); // saved by a person in the Codes step only
  });

  it('ignores a reply from someone the request was not sent to, and mail that names no request', async () => {
    const { processReply } = await import('../src/modules/mailReplies/mailReply.service');
    const order = await makeOrder();
    const row = (await sendProject(order, 'reply-key-0003')).body.data.requests[0];
    expect(await processReply(reply(row.requestId, { from: ['x@evil.com'] }))).toBe('rejected');
    expect((await view(order)).requests[0].reply).toBeFalsy();
    expect(await processReply(reply('ADN-Signage-prj-01010100', {}))).toBe('unknown');
    expect(await processReply({ messageId: '<z@x>', from: ['codes@adinn.test'], subject: 'Lunch?', text: 'Project code 11223344' })).toBe('unknown');
  });

  it('keeps the reply but no code when it holds two different numbers', async () => {
    const { processReply } = await import('../src/modules/mailReplies/mailReply.service');
    const order = await makeOrder();
    const row = (await sendProject(order, 'reply-key-0004')).body.data.requests[0];
    expect(await processReply(reply(row.requestId, { text: 'Codes 11223344 and 55667788' }))).toBe('saved');
    const after = (await view(order)).requests[0];
    expect(after.reply.detectedCode).toBeUndefined();
    expect(after.reply.snippet).toContain('55667788');
  });

  it('reads the vendor ID from the reply of Accounts, from a recipient only, and never overwrites a saved one', async () => {
    const { processReply } = await import('../src/modules/mailReplies/mailReply.service');
    const { Vendor } = await import('../src/modules/vendors/vendor.model');
    const id = 'ADN-Signage-vnd-07112601';
    const v = await Vendor.create({ code: 'VND-9001', name: 'Reply Vendor', nameKey: 'reply vendor', type: 'ONE_MAN', mobile: '9876512345', mails: [{ to: ['accounts@adinn.test'], cc: [], subject: `Vendor registration request - ${id}`, status: 'SENT', requestId: id }] });
    const mail = { messageId: '<v1@adinn.test>', from: ['accounts@adinn.test'], subject: `Re: Vendor registration request - ${id}`, text: `Vendor ID: 4521\n\n> ${id}` };
    expect(await processReply({ ...mail, from: ['x@evil.com'] })).toBe('rejected');
    expect(await processReply(mail)).toBe('saved');
    expect(await processReply(mail)).toBe('duplicate');
    const got = (await Vendor.findById(v._id).lean())!;
    expect(got.registration?.reply).toMatchObject({ from: 'accounts@adinn.test', detectedVendorNo: '4521' });
    expect(got.zohoVendorNo).toBeUndefined(); // a person still saves the ID, which activates the vendor
    await Vendor.updateOne({ _id: v._id }, { $set: { 'registration.vendorIdAt': new Date() } });
    // a correction in the same thread overwrites what is shown, never the ID a person saved; both stay in the history with their time
    expect(await processReply({ ...mail, messageId: '<v2@adinn.test>', text: 'Sorry, wrong. Vendor ID: 9999', receivedAt: new Date(Date.now() + 60_000) })).toBe('saved');
    // an older mail read late does not replace the newer one
    expect(await processReply({ ...mail, messageId: '<v0@adinn.test>', text: 'Vendor ID: 1111', receivedAt: new Date(Date.now() - 3_600_000) })).toBe('saved');
    const after = (await Vendor.findById(v._id).lean())!;
    expect(after.registration?.reply?.detectedVendorNo).toBe('9999');
    expect(after.registration?.replyHistory?.map((h) => h.detectedVendorNo)).toEqual(['4521', '9999', '1111']);
    expect(after.registration?.replyHistory?.every((h) => h.at instanceof Date)).toBe(true);
    expect(after.zohoVendorNo).toBeUndefined();
  });

  it('confirms the code on its own only when auto-confirm is on for project code mails', async () => {
    const { processReply } = await import('../src/modules/mailReplies/mailReply.service');
    expect((await api().put('/api/v1/mail-settings/routing/PROJECT_CODE').set(as('ADMIN')).send({ to: ['codes@adinn.test'], cc: [], autoConfirm: true })).status).toBe(200);
    const order = await makeOrder();
    const row = (await sendProject(order, 'reply-key-0005')).body.data.requests[0];
    expect(await processReply(reply(row.requestId, { text: 'Project code 22334455' }))).toBe('confirmed');
    const after = await view(order);
    expect(after.kinds.PROJECT_CODE).toMatchObject({ state: 'CONFIRMED', code: '22334455' });

    // a code that is already used elsewhere is not forced through: it stays for a person
    const order2 = await makeOrder();
    const row2 = (await sendProject(order2, 'reply-key-0006')).body.data.requests[0];
    expect(await processReply(reply(row2.requestId, { text: 'Project code 22334455' }))).toBe('saved');
    const again = (await view(order2)).requests[0];
    expect(again.status).toBe('PENDING_CONFIRMATION');
    expect(again.reply.autoConfirmError).toMatch(/already/i);
  });
});
