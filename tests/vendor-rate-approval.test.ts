import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import { findDecision } from '../src/modules/mailReplies/replyParser'; // pure file: loads no config

let mongod: MongoMemoryServer;
let app: Express;
let disconnectDb: () => Promise<unknown>;
let root = '';
const tokens: Record<string, string> = {};
const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]}` });
const api = () => request(app);
const CONTACT = '555000000000001';
const put = (b: unknown) => api().put(`/api/v1/vendors/zoho-directory/${CONTACT}/price`).set(as('OPS')).send(b);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-approval-'));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  process.env.STORAGE_TYPE = 'local';
  process.env.LOCAL_UPLOAD_PATH = root;
  const db = await import('../src/config/db');
  disconnectDb = db.disconnectDb;
  await db.connectDb();
  expect(process.env.MONGODB_URI).toContain('127.0.0.1'); // never the real database
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  app = (await import('../src/app')).createApp();
  for (const [key, role] of [['ADMIN', 'SUPER_ADMIN'], ['OPS', 'OPERATIONS']] as const) {
    await User.create({ name: key, email: `${key.toLowerCase()}@t.com`, role, passwordHash: await hashPassword('Passw0rd!x') });
    tokens[key] = (await api().post('/api/v1/auth/login').send({ email: `${key.toLowerCase()}@t.com`, password: 'Passw0rd!x' })).body.data.accessToken;
  }
  const reg = await api().post('/api/v1/vendors').set(as('OPS')).send({ type: 'ONE_MAN', typeName: 'One-man / Freelancer', name: 'Approval Signs', mobile: '9876500077', zohoContactId: CONTACT, zohoVendorNo: '13100' });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
});
afterAll(async () => {
  await disconnectDb();
  await mongod.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('reading the approver\'s answer', () => {
  it('finds a clear yes or no, and leaves anything doubtful to a person', () => {
    expect(findDecision('APPROVED')).toBe('APPROVED');
    expect(findDecision('Approved, go ahead. Thanks')).toBe('APPROVED');
    expect(findDecision('NOT APPROVED')).toBe('NOT_APPROVED');
    expect(findDecision('Not approved, proceed with the company rate')).toBe('NOT_APPROVED');
    expect(findDecision('Rejected')).toBe('NOT_APPROVED');
    expect(findDecision('I do not approve this')).toBe('NOT_APPROVED');
    expect(findDecision('Thanks, will check')).toBeNull();
    expect(findDecision('approved for the near price but rejected for far')).toBeNull();
  });
});

describe('vendor cost above the company rate (Admin > Cost Rates: 300 near, 350 far)', () => {
  it('the Add cost box can read the company rates', async () => {
    expect((await api().get('/api/v1/vendors/company-rates').set(as('OPS'))).body.data).toEqual({ ratePerShop: 300, farRatePerShop: 350 });
  });

  it('a cost within the company rate saves at once', async () => {
    expect((await put({ ratePerShop: 280, farRatePerShop: 340 })).body.data).toMatchObject({ ratePerShop: 280, farRatePerShop: 340 });
  });

  it('refuses to hold a cost when nobody is set to approve it, and keeps the old cost', async () => {
    const res = await put({ ratePerShop: 500, farRatePerShop: 600 });
    expect(res.status).toBe(409);
    expect(res.body.error.message ?? res.body.message).toMatch(/Mail settings/);
    expect((await put({ ratePerShop: 280, farRatePerShop: 340 })).body.data).toMatchObject({ ratePerShop: 280 });
  });

  it('holds the cost, keeps the old one, and mails a request with its own ID', async () => {
    expect((await api().put('/api/v1/mail-settings/routing/VENDOR_RATE_APPROVAL').set(as('ADMIN')).send({ to: ['approver@t.com'], cc: ['boss@t.com'], replyTo: 'inbox@t.com' })).status).toBe(200);
    const res = await put({ ratePerShop: 500, farRatePerShop: 600 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ ratePerShop: 280, farRatePerShop: 340, pending: { ratePerShop: 500, farRatePerShop: 600, limitRate: 300, limitFar: 350 } });
    expect(res.body.data.pending.requestId).toMatch(/^ADN-Signage-vap-\d{8,}$/);
    const { VendorRateApproval } = await import('../src/modules/vendors/vendorRateApproval.model');
    const row = await VendorRateApproval.findOne({ requestId: res.body.data.pending.requestId }).lean();
    expect(row).toMatchObject({ status: 'PENDING', to: ['approver@t.com'], cc: ['boss@t.com'] });
    expect(row!.sentAt).toBeTruthy();
    // the list shows the cost is waiting
    expect((await api().get('/api/v1/vendors/zoho-directory?price=set').set(as('OPS'))).body.data[0].price.pending).toMatchObject({ ratePerShop: 500 });
  });

  it('a newer request replaces the one still waiting; a within-limit save also clears it', async () => {
    const { VendorRateApproval } = await import('../src/modules/vendors/vendorRateApproval.model');
    const first = (await VendorRateApproval.findOne({ status: 'PENDING' }).lean())!;
    const second = await put({ ratePerShop: 450, farRatePerShop: 500 });
    expect((await VendorRateApproval.findById(first._id).lean())!.status).toBe('REPLACED');
    expect(second.body.data.pending.requestId).not.toBe(first.requestId);
    expect((await put({ ratePerShop: 290, farRatePerShop: 330 })).body.data.pending).toBeUndefined();
    expect(await VendorRateApproval.countDocuments({ status: 'PENDING' })).toBe(0);
  });
});

describe('the approver replies', () => {
  const reply = (requestId: string, text: string, from = 'approver@t.com', messageId = `<${Math.random()}@t>`) => async () => {
    const { processReply } = await import('../src/modules/mailReplies/mailReply.service');
    return processReply({ messageId, from: [from], subject: `Re: Vendor amount approval - ${requestId}`, text });
  };
  const ask = async (rate: number, far: number) => (await put({ ratePerShop: rate, farRatePerShop: far })).body.data.pending.requestId as string;
  const price = async () => (await api().get('/api/v1/vendors/zoho-directory?price=set').set(as('OPS'))).body.data[0].price;

  it('APPROVED applies the typed cost', async () => {
    const id = await ask(500, 600);
    expect(await reply(id, 'APPROVED\n\n> quoted text')()).toBe('confirmed');
    expect(await price()).toMatchObject({ ratePerShop: 500, farRatePerShop: 600 });
    expect((await price()).pending).toBeUndefined();
    const { VendorRateApproval } = await import('../src/modules/vendors/vendorRateApproval.model');
    expect(await VendorRateApproval.findOne({ requestId: id }).lean()).toMatchObject({ status: 'APPROVED', decidedBy: 'approver@t.com', applied: { ratePerShop: 500, farRatePerShop: 600 } });
  });

  it('NOT APPROVED applies the company rate (each price capped at it)', async () => {
    const id = await ask(450, 700);
    expect(await reply(id, 'Not approved, proceed with the set amount')()).toBe('confirmed');
    expect(await price()).toMatchObject({ ratePerShop: 300, farRatePerShop: 350 });
  });

  it('a price already within the rate is kept as typed when the answer is NOT APPROVED', async () => {
    const id = await ask(280, 900); // near price is fine, only the far price is above 350
    expect(await reply(id, 'REJECTED')()).toBe('confirmed');
    expect(await price()).toMatchObject({ ratePerShop: 280, farRatePerShop: 350 });
  });

  it('a vendor whose first cost is still waiting is listed in Vendors with cost', async () => {
    const OTHER = '555000000000002';
    const { VendorRateApproval } = await import('../src/modules/vendors/vendorRateApproval.model');
    await VendorRateApproval.create({ requestId: 'ADN-Signage-vap-0000001', zohoContactId: OTHER, vendorName: 'Fresh Signs', vendorNo: '13200', requested: { ratePerShop: 600, farRatePerShop: 700 }, limit: { ratePerShop: 300, farRatePerShop: 350 }, current: {}, status: 'PENDING', requestedBy: new (await import('mongoose')).Types.ObjectId() });
    const rows = (await api().get('/api/v1/vendors/zoho-directory?price=set').set(as('OPS'))).body.data;
    const fresh = rows.find((r: { name: string }) => r.name === 'Fresh Signs');
    expect(fresh.price.pending).toMatchObject({ ratePerShop: 600 });
    expect(fresh.price.ratePerShop).toBeNull();
    await VendorRateApproval.deleteOne({ zohoContactId: OTHER });
  });

  it('ignores a sender who was not asked, an unclear answer stays waiting, a repeat does nothing', async () => {
    const id = await ask(520, 640);
    expect(await reply(id, 'APPROVED', 'stranger@evil.com')()).toBe('rejected');
    expect(await reply(id, 'Will let you know')()).toBe('saved');
    const { VendorRateApproval } = await import('../src/modules/vendors/vendorRateApproval.model');
    expect((await VendorRateApproval.findOne({ requestId: id }).lean())!.status).toBe('PENDING');
    expect(await price()).toMatchObject({ ratePerShop: 280 }); // nothing applied
    expect(await reply(id, 'APPROVED', 'someone@t.com', '<one@t>')()).toBe('confirmed'); // same company domain as the approver
    expect(await price()).toMatchObject({ ratePerShop: 520, farRatePerShop: 640 });
    expect(await reply(id, 'Approved', 'approver@t.com', '<one@t>')()).toBe('duplicate'); // the same mail read again
    expect(await reply(id, 'Approved, thanks', 'approver@t.com', '<same@t>')()).toBe('duplicate'); // same answer again: only logged
    // a corrected reply in a newer mail changes the answer, and the cost follows
    const later = new Date(Date.now() + 60_000);
    const { processReply } = await import('../src/modules/mailReplies/mailReply.service');
    expect(await processReply({ messageId: '<two@t>', from: ['approver@t.com'], subject: `Re: Vendor amount approval - ${id}`, text: 'Sorry, NOT APPROVED. Use the company rate.', receivedAt: later })).toBe('confirmed');
    expect(await price()).toMatchObject({ ratePerShop: 300, farRatePerShop: 350 });
    // an older mail read late never changes it back
    expect(await processReply({ messageId: '<old@t>', from: ['approver@t.com'], subject: `Re: Vendor amount approval - ${id}`, text: 'APPROVED', receivedAt: new Date(Date.now() - 3_600_000) })).toBe('duplicate');
    expect(await price()).toMatchObject({ ratePerShop: 300 });
    const row = (await VendorRateApproval.findOne({ requestId: id }).lean())!;
    expect(row.status).toBe('NOT_APPROVED');
    expect(row.history?.map((h) => h.outcome)).toEqual(expect.arrayContaining(['Decided: APPROVED', 'Same answer again (APPROVED)', 'Changed from APPROVED to NOT_APPROVED', 'Older mail, kept as NOT_APPROVED']));
    // the list shows the status
    expect((await price()).approval).toMatchObject({ requestId: id, status: 'NOT_APPROVED', appliedRate: 300 });
  });

  it('the LATEST reply decides: Okay, then a question, then "did not accept, rejected" ends as NOT_APPROVED with the company rate', async () => {
    const id = await ask(480, 590);
    const { processReply } = await import('../src/modules/mailReplies/mailReply.service');
    const at = (min: number) => new Date(Date.now() + min * 60_000);
    const send = (text: string, messageId: string, min: number) => processReply({ messageId, from: ['approver@t.com'], subject: `Re: Vendor amount approval - ${id}`, text, receivedAt: at(min) });
    expect(await send('Okay. Thanks & Regards', '<a@t>', 1)).toBe('confirmed');
    expect(await price()).toMatchObject({ ratePerShop: 480, farRatePerShop: 590 });
    expect(await send('Are you Sure! Do you want to approved?', '<b@t>', 2)).toBe('saved'); // a question: only logged
    expect(await price()).toMatchObject({ ratePerShop: 480 });
    expect(await send('Management did not accept it. Note it down as rejected.', '<c@t>', 3)).toBe('confirmed');
    expect(await price()).toMatchObject({ ratePerShop: 300, farRatePerShop: 350 });
    expect((await price()).approval).toMatchObject({ status: 'NOT_APPROVED' });
    expect(await send('Not okay', '<d@t>', 4)).toBe('duplicate'); // same answer again
  });

  it('Operations can change the status by hand, both ways, and it is written in the history', async () => {
    const id = await ask(560, 660);
    expect((await api().put(`/api/v1/vendors/rate-approvals/${id}/decision`).set(as('OPS')).send({ decision: 'APPROVED' })).status).toBe(200);
    expect(await price()).toMatchObject({ ratePerShop: 560, farRatePerShop: 660 });
    expect((await price()).approval).toMatchObject({ status: 'APPROVED', decidedBy: 'OPS (manual)' });
    expect((await api().put(`/api/v1/vendors/rate-approvals/${id}/decision`).set(as('OPS')).send({ decision: 'NOT_APPROVED' })).status).toBe(200);
    expect(await price()).toMatchObject({ ratePerShop: 300, farRatePerShop: 350 });
    expect((await api().put(`/api/v1/vendors/rate-approvals/${id}/decision`).set(as('OPS')).send({ decision: 'NOT_APPROVED' })).status).toBe(409); // already that status
    expect((await api().put(`/api/v1/vendors/rate-approvals/${id}/decision`).set(as('OPS')).send({ decision: 'MAYBE' })).status).toBe(422);
    const { VendorRateApproval } = await import('../src/modules/vendors/vendorRateApproval.model');
    expect((await VendorRateApproval.findOne({ requestId: id }).lean())!.history?.map((h) => h.outcome)).toEqual(['Status changed by OPS: PENDING to APPROVED', 'Status changed by OPS: APPROVED to NOT_APPROVED']);
    // a newer request takes over: the older one can no longer be changed
    await ask(570, 670);
    expect((await api().put(`/api/v1/vendors/rate-approvals/${id}/decision`).set(as('OPS')).send({ decision: 'APPROVED' })).status).toBe(409);
  });
});
