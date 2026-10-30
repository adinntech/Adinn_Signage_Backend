import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/env', () => ({
  env: { SIGNAGE_MAIL_URL: 'https://mail.example/index_signage.php', SIGNAGE_MAIL_KEY: 'test-key', signageMailEnabled: true },
}));

import { buildCodeMail, mailDate, requestIdOf, signageMailTypeOf } from '../src/modules/codeRequests/codeRequestMail';
import { sendSignageCodeMail } from '../src/modules/codeRequests/signageCodeMail';

const src = {
  order: { orderNo: '20261030ORD#1', declaredShopTotal: 12, handoverNotes: 'Urgent' },
  client: {
    name: 'UltraTech Cement Limited',
    gstin: '33AAACU5678G1Z2',
    address: '123, Industrial Estate, Guindy, Chennai',
    approvedCode: 'CLI-0018',
    onboarding: { pan: 'AAACU5678G' },
    contacts: [{ name: 'Other', email: 'o@x.com', phone: '1' }, { name: 'Jeeva', email: 'j@x.com', phone: '9789056789', isPrimary: true }],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('buildCodeMail', () => {
  it('maps the kinds to the PHP mailtype', () => {
    expect(signageMailTypeOf(['CLIENT_CODE'])).toBe('client');
    expect(signageMailTypeOf(['PROJECT_CODE'])).toBe('project');
    expect(signageMailTypeOf(['CLIENT_CODE', 'PROJECT_CODE'])).toBe('combined');
  });

  it('combined: client from the primary contact, project from the order, note from the body', () => {
    const m = buildCodeMail(src, ['CLIENT_CODE', 'PROJECT_CODE'], '123e4567-e89b-12d3-a456-426614174000', '<p>Please create both.</p>');
    expect(m.mailType).toBe('combined');
    expect(m.requestId).toBe('REQ-123E4567');
    expect(m.client).toMatchObject({ clientName: 'UltraTech Cement Limited', contactPerson: 'Jeeva', email: 'j@x.com', phone: '9789056789', gstNumber: '33AAACU5678G1Z2', panNumber: 'AAACU5678G', clientCode: 'CLI-0018' });
    expect(m.project).toMatchObject({ projectName: 'UltraTech Cement Limited - 20261030ORD#1', projectType: 'Signage', businessUnit: 'Signage Solutions', description: 'Total shops: 12. Urgent' });
    expect(m.message).toBe('Please create both.');
  });

  it('client only: no project block', () => {
    expect(buildCodeMail(src, ['CLIENT_CODE'], 'abcdefgh-0000', '').project).toBeUndefined();
  });

  it('formats dates and request ids', () => {
    expect(mailDate(new Date(2026, 9, 30))).toBe('30 Oct 2026');
    expect(requestIdOf('abcd-ef12-3456')).toBe('REQ-ABCDEF12');
  });
});

describe('sendSignageCodeMail', () => {
  const mail = { mailType: 'client' as const, to: ['a@x.com'], requestId: 'REQ-1', client: { clientName: 'X' }, attachments: [{ filename: 'a.pdf', content: Buffer.from('%PDF') }] };

  it('posts the structured payload with the API key and base64 attachments', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'success' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendSignageCodeMail(mail);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://mail.example/index_signage.php');
    expect(init.headers['X-API-Key']).toBe('test-key');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ mailtype: 'client', toEmail: ['a@x.com'], ccEmail: [], requestId: 'REQ-1', attachments: [{ filename: 'a.pdf', base64: Buffer.from('%PDF').toString('base64') }] });
  });

  it('throws the API message when the PHP service rejects the mail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'error', message: 'Unauthorized' }), { status: 401 })));
    await expect(sendSignageCodeMail(mail)).rejects.toThrow('Unauthorized');
  });

  it('throws a clear error when the service is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(sendSignageCodeMail(mail)).rejects.toThrow('could not be reached');
  });
});
