import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/env', () => ({
  env: { SIGNAGE_MAIL_URL: 'https://mail.example/index_signage.php', SIGNAGE_MAIL_KEY: 'test-key', signageMailEnabled: true, isProd: true, NODE_ENV: 'production' },
}));

import { buildSignageVendorPayload, explainSignageError, safeFileName, sendSignageVendorMail, signageAttachmentProblem, type SignageVendorMail } from '../src/modules/vendors/signageVendorMail';

const mail: SignageVendorMail = {
  to: ['accounts@t.com'],
  cc: ['ops@t.com'],
  bcc: ['boss@t.com'],
  subject: 'Vendor registration request: NEW VENDOR (VND-0008)',
  requestId: 'VND-0008',
  requestDate: '03 Nov 2026',
  replyTo: 'ops@adinn.co.in',
  vendor: { vendorName: 'NEW VENDOR', vendorType: 'One-man / Freelancer', vendorCode: 'VND-0008' },
  bodyHtml: '<p>Hi Team,</p>',
  attachments: [{ filename: 'pan.pdf', content: Buffer.from('%PDF-1.4 x'), label: 'PAN card' }, { filename: 'bank.png', content: Buffer.from('png-bytes') }],
};

afterEach(() => vi.unstubAllGlobals());

describe('vendor registration mail payload (PHP mailtype "vendor")', () => {
  it('maps the mail to the PHP API fields, files as base64 with their document label', () => {
    const p = buildSignageVendorPayload(mail) as Record<string, any>;
    expect(p).toMatchObject({
      mailtype: 'vendor',
      toEmail: ['accounts@t.com'],
      ccEmail: ['ops@t.com'],
      bccEmail: ['boss@t.com'],
      subject: mail.subject,
      requestId: 'VND-0008',
      requestDate: '03 Nov 2026',
      source: 'Operations Team',
      replyTo: 'ops@adinn.co.in',
      vendor: { vendorName: 'NEW VENDOR', vendorType: 'One-man / Freelancer', vendorCode: 'VND-0008' },
      bodyHtml: '<p>Hi Team,</p>',
    });
    expect(p.attachments).toEqual([
      { filename: 'pan.pdf', base64: Buffer.from('%PDF-1.4 x').toString('base64'), label: 'PAN card' },
      { filename: 'bank.png', base64: Buffer.from('png-bytes').toString('base64') },
    ]);
  });

  it('leaves out bcc and replyTo when there are none', () => {
    const p = buildSignageVendorPayload({ ...mail, bcc: [], replyTo: undefined }) as Record<string, unknown>;
    expect('bccEmail' in p).toBe(false);
    expect('replyTo' in p).toBe(false);
  });

  it('cleans file names for the PHP API (no folders, at most 160 characters, extension kept)', () => {
    expect(safeFileName('C:\\scans\\pan card.pdf')).toBe('pan card.pdf');
    expect(safeFileName('a/b/c.png')).toBe('c.png');
    const long = safeFileName(`${'x'.repeat(300)}.jpeg`);
    expect(long.length).toBe(150);
    expect(long.endsWith('.jpeg')).toBe(true);
  });
});

describe('attachment limits of the PHP API', () => {
  it('accepts up to 8 files of 8 MB, 12 MB together', () => {
    expect(signageAttachmentProblem(Array.from({ length: 8 }, () => ({ name: 'a.pdf', size: 1024 })))).toBeNull();
  });
  it('explains too many files, a big file and a big total', () => {
    expect(signageAttachmentProblem(Array.from({ length: 9 }, () => ({ name: 'a.pdf', size: 1 })))).toMatch(/At most 8 documents/);
    expect(signageAttachmentProblem([{ name: 'scan.pdf', size: 9 * 1024 * 1024 }])).toMatch(/scan\.pdf is over 8 MB/);
    expect(signageAttachmentProblem([{ size: 7 * 1024 * 1024 }, { size: 7 * 1024 * 1024 }])).toMatch(/over 12 MB together/);
  });
});

describe('sendSignageVendorMail', () => {
  it('POSTs the JSON with the API key and resolves on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'success', message: 'Email accepted by SMTP server' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await sendSignageVendorMail(mail);
    expect(r).toMatchObject({ status: 'success' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://mail.example/index_signage.php');
    expect(init.method).toBe('POST');
    expect(init.headers['X-API-Key']).toBe('test-key');
    expect(JSON.parse(String(init.body))).toMatchObject({ mailtype: 'vendor', requestId: 'VND-0008', attachments: [{ filename: 'pan.pdf' }, { filename: 'bank.png' }] });
  });

  it('throws the PHP message when the service refuses the mail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'error', message: 'Invalid PDF' }), { status: 422 })));
    await expect(sendSignageVendorMail(mail)).rejects.toThrow('Invalid PDF');
  });

  it('throws a clear error when the service cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(sendSignageVendorMail(mail)).rejects.toThrow(/could not be reached: ECONNREFUSED/);
  });

  it('refuses too many files before calling the service', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const many = { ...mail, attachments: Array.from({ length: 9 }, (_, i) => ({ filename: `d${i}.pdf`, content: Buffer.from('%PDF') })) };
    await expect(sendSignageVendorMail(many)).rejects.toThrow(/At most 8 documents/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('what the person is told when the PHP service refuses', () => {
  it('names the files and the fix for an unsupported file name', () => {
    const msg = explainSignageError('Unsupported attachment filename', mail);
    expect(msg).toMatch(/pan.pdf, bank.png/);
    expect(msg).toMatch(/upload the latest/);
    expect(msg).toContain('Unsupported attachment filename');
  });
  it('explains HTTP 413 with the size sent', async () => {
    expect(explainSignageError('413 Payload Too Large', mail)).toMatch(/refused the size of this mail \(0 MB of documents\).*client_max_body_size/s);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('413 Payload Too Large', { status: 413 })));
    await expect(sendSignageVendorMail(mail)).rejects.toThrow(/raise its upload limit/);
  });
  it('leaves other messages as they are', () => {
    expect(explainSignageError('Invalid PDF', mail)).toBe('Invalid PDF');
  });
});
