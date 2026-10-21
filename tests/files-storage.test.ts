import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATEGORY_RULES, buildFileKey, kindOfFile, safeSegment } from '../src/modules/files/file.categories';

let storage: typeof import('../src/modules/files/storage');
let root: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = 'mongodb://localhost:27017/unused';
  process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
  storage = await import('../src/modules/files/storage');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-store-'));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('folder scheme', () => {
  const base = { clientName: 'Coca Cola', projectCode: 'SGN-COCA-2026-001', now: new Date('2026-10-19T10:15:30Z'), random: 'abc123' };

  it('puts BD client documents under BD/Client_Details/<client>/<project>', () => {
    expect(buildFileKey({ ...base, category: 'BD_CLIENT_DETAILS', originalName: 'Shop List.xlsx' })).toBe(
      'BD/Client_Details/Coca_Cola/SGN-COCA-2026-001/20261019-101530_abc123_Shop_List.xlsx',
    );
  });

  it('keeps recce originals and edited photos in separate folders', () => {
    const o = buildFileKey({ ...base, category: 'RECCE_IMAGE_ORIGINAL', originalName: 'front.jpg' });
    const e = buildFileKey({ ...base, category: 'RECCE_IMAGE_EDITED', originalName: 'front.png' });
    expect(o).toContain('Recce/Coca_Cola/SGN-COCA-2026-001/Images/Original/');
    expect(e).toContain('Recce/Coca_Cola/SGN-COCA-2026-001/Images/Edited/');
  });

  it('cannot be steered out of its folder by hostile names', () => {
    const key = buildFileKey({ ...base, clientName: '../../etc', projectCode: 'a/../../b', category: 'BD_CLIENT_DETAILS', originalName: '../../../evil.xlsx' });
    expect(key.split('/')).not.toContain('..');
    expect(key.startsWith('BD/Client_Details/')).toBe(true);
    expect(safeSegment('///')).toBe('Unknown');
    expect(safeSegment('தமிழ்')).toBe('Unknown');
  });

  it('maps extensions to kinds and rejects executables', () => {
    expect(kindOfFile('a.XLSX')).toBe('sheet');
    expect(kindOfFile('a.jpg')).toBe('image');
    expect(kindOfFile('a.exe')).toBeNull();
    expect(CATEGORY_RULES.RECCE_IMAGE_ORIGINAL.evidence).toBe(true);
    expect(CATEGORY_RULES.BD_CLIENT_DETAILS.evidence).toBe(false);
  });
});

describe('LocalStorage', () => {
  it('writes, refuses to overwrite, deletes and blocks path traversal', async () => {
    const s = new storage.LocalStorage(root, 'secret-secret-secret-secret-1234', 'http://localhost:4000');
    await s.put('BD/Client_Details/AMUL/P1/a.csv', Buffer.from('x'), 'text/csv');
    expect(fs.existsSync(path.join(root, 'BD', 'Client_Details', 'AMUL', 'P1', 'a.csv'))).toBe(true);
    await expect(s.put('BD/Client_Details/AMUL/P1/a.csv', Buffer.from('y'), 'text/csv')).rejects.toThrow();
    await expect(s.put('../outside.txt', Buffer.from('z'), 'text/plain')).rejects.toThrow('Invalid storage key');
    await s.remove('BD/Client_Details/AMUL/P1/a.csv');
    expect(fs.existsSync(path.join(root, 'BD', 'Client_Details', 'AMUL', 'P1', 'a.csv'))).toBe(false);
    await s.remove('BD/Client_Details/AMUL/P1/missing.csv'); // not an error
  });

  it('signs links that expire and cannot be tampered with', () => {
    const s = new storage.LocalStorage(root, 'secret-secret-secret-secret-1234', 'http://localhost:4000');
    const exp = Math.floor(Date.now() / 1000) + 60;
    const sig = s.sign('k/a.jpg', exp);
    expect(s.verify('k/a.jpg', exp, sig)).toBe(true);
    expect(s.verify('k/b.jpg', exp, sig)).toBe(false);
    expect(s.verify('k/a.jpg', exp + 1, sig)).toBe(false);
    expect(s.verify('k/a.jpg', Math.floor(Date.now() / 1000) - 1, s.sign('k/a.jpg', Math.floor(Date.now() / 1000) - 1))).toBe(false);
  });
});

describe('SpacesStorage', () => {
  it('uploads privately under the signage/ prefix and deletes the same key', async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const client = { send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => void sent.push({ name: c.constructor.name, input: c.input }) };
    const s = new storage.SpacesStorage({ bucket: 'adinn-space', prefix: 'signage', client: client as never });
    await s.put('BD/Client_Details/AMUL/P1/a.xlsx', Buffer.from('x'), 'application/octet-stream');
    await s.remove('BD/Client_Details/AMUL/P1/a.xlsx');
    expect(sent[0]).toMatchObject({ name: 'PutObjectCommand', input: { Bucket: 'adinn-space', Key: 'signage/BD/Client_Details/AMUL/P1/a.xlsx', ACL: 'private' } });
    expect(sent[1]).toMatchObject({ name: 'DeleteObjectCommand', input: { Key: 'signage/BD/Client_Details/AMUL/P1/a.xlsx' } });
  });
});

describe('keyFromSpaceUrl (safe URL-based delete)', () => {
  const opts = { baseUrls: ['https://adinn-space.sgp1.digitaloceanspaces.com'], prefix: 'signage' };
  it('extracts the app key and decodes escapes', () => {
    expect(storage.keyFromSpaceUrl('https://adinn-space.sgp1.digitaloceanspaces.com/signage/BD/Client_Details/AMUL/P1/my%20file.xlsx', opts)).toBe('BD/Client_Details/AMUL/P1/my file.xlsx');
  });
  it('ignores local urls', () => {
    expect(storage.keyFromSpaceUrl('http://localhost:4000/uploads/a.jpg', opts)).toBeNull();
    expect(storage.keyFromSpaceUrl('/uploads/a.jpg', opts)).toBeNull();
    expect(storage.keyFromSpaceUrl('', opts)).toBeNull();
  });
  it('refuses other buckets, other apps in the same bucket, and traversal', () => {
    expect(() => storage.keyFromSpaceUrl('https://evil.example.com/signage/a.jpg', opts)).toThrow();
    expect(() => storage.keyFromSpaceUrl('https://adinn-space.sgp1.digitaloceanspaces.com/Roadshows/a.jpg', opts)).toThrow('outside this application folder');
    expect(() => storage.keyFromSpaceUrl('https://adinn-space.sgp1.digitaloceanspaces.com/signage/%2e%2e/Roadshows/a.jpg', opts)).toThrow();
  });
});
