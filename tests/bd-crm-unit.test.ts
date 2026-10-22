import { beforeAll, describe, expect, it } from 'vitest';

// Pure business rules of the BD CRM; no database needed.
let html: typeof import('../src/common/html');
let quotation: typeof import('../src/modules/ratecards/quotation.service');
let approval: typeof import('../src/modules/sales/approval.service');
let pdf: typeof import('../src/modules/ratecards/quotation.pdf');
let v: typeof import('../src/modules/ratecards/ratecard.validators');
let clientV: typeof import('../src/modules/clients/client.validators');

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:1/unit-tests-never-connect';
  process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-123';
  html = await import('../src/common/html');
  quotation = await import('../src/modules/ratecards/quotation.service');
  approval = await import('../src/modules/sales/approval.service');
  pdf = await import('../src/modules/ratecards/quotation.pdf');
  v = await import('../src/modules/ratecards/ratecard.validators');
  clientV = await import('../src/modules/clients/client.validators');
});

describe('rich text sanitizer', () => {
  it('keeps simple formatting and strips scripts, attributes and unknown tags', () => {
    expect(html.sanitizeHtml('<p onclick="x()">Hi <script>alert(1)</script><b>there</b><a href="javascript:x">link</a></p>')).toBe('<p>Hi <b>there</b>link</p>');
    expect(html.sanitizeHtml('<ul><li style="color:red">One</li></ul><img src=x onerror=alert(1)>')).toBe('<ul><li>One</li></ul>');
    expect(html.sanitizeHtml('5 < 6 and <unknown attr="1">x</unknown>')).toBe('5 &lt; 6 and x');
  });
  it('converts to plain text', () => {
    expect(html.htmlToText('<p>Hello</p><ol><li>A &amp; B</li></ol>')).toBe('Hello\n\n• A & B');
  });
});

describe('quotation rules', () => {
  const line = { particulars: 'LED Glow Sign', unit: 'SQFT' as const, quotedRate: 450 };
  it('requires an override reason only when the quoted rate differs from the master rate', () => {
    const item = v.quotationBody.shape.items.element;
    expect(item.safeParse({ ...line, masterItemId: '0123456789abcdef01234567', masterRate: 500 }).success).toBe(false);
    expect(item.safeParse({ ...line, masterItemId: '0123456789abcdef01234567', masterRate: 500, overrideReason: 'Long term client' }).success).toBe(true);
    expect(item.safeParse({ ...line, masterItemId: '0123456789abcdef01234567', masterRate: 450 }).success).toBe(true);
    expect(item.safeParse({ ...line }).success).toBe(true); // custom line, no master rate
    expect(item.safeParse({ ...line, quotedRate: 0 }).success).toBe(false);
  });

  it('rejects unknown rate units and non-positive master rates', () => {
    expect(v.rateItemBody.safeParse({ particulars: 'ACP Facia', unit: 'SQFT', rate: 300 }).success).toBe(true);
    expect(v.rateItemBody.safeParse({ particulars: 'ACP Facia', unit: 'MILE', rate: 300 }).success).toBe(false);
    expect(v.rateItemBody.safeParse({ particulars: 'ACP Facia', unit: 'KM', rate: -1 }).success).toBe(false);
  });

  it('describes revision changes as added / updated / removed', () => {
    const base = { quotationDate: new Date('2026-10-10'), subject: 'S', contact: { name: 'Rohan' }, items: [{ particulars: 'A', unit: 'SQFT', quotedRate: 100 }, { particulars: 'B', unit: 'UNIT', quotedRate: 50 }] };
    expect(quotation.quotationChanges(null, base)[0]!.changeType).toBe('ADDED');
    expect(quotation.quotationChanges(base, { ...base })).toEqual([]);
    const next = { ...base, subject: 'S2', items: [{ particulars: 'A', unit: 'SQFT', quotedRate: 90 }, { particulars: 'C', unit: 'KM', quotedRate: 5 }] };
    const c = quotation.quotationChanges(base, next);
    expect(c).toEqual(
      expect.arrayContaining([
        { field: 'Subject', oldValue: 'S', newValue: 'S2', changeType: 'UPDATED' },
        { field: 'Quoted Rate (A)', oldValue: 100, newValue: 90, changeType: 'UPDATED' },
        expect.objectContaining({ field: 'Added Item (C)', changeType: 'ADDED' }),
        expect.objectContaining({ field: 'Removed Item (B)', changeType: 'REMOVED' }),
      ]),
    );
  });

  it('renders a real PDF', async () => {
    const buf = await pdf.renderQuotationPdf({
      quotationRef: 'ADINN/QTN/2026/0001',
      revisionLabel: 'v1.0',
      quotationDate: new Date('2026-10-10'),
      subject: 'Signage Solutions for Retail Outlets',
      clientName: 'Acme Retail Pvt. Ltd.',
      clientAddress: '123, Business Park, Andheri (E), Mumbai - 400069',
      contact: { name: 'Rohan Mehta', phone: '9876543210', email: 'rohan@acme.example' },
      items: Array.from({ length: 30 }, (_, i) => ({ particulars: `Item ${i + 1}`, specifications: 'ACP with UV print', unit: 'SQFT', quotedRate: 100 + i })),
      terms: quotation.DEFAULT_TERMS,
      regards: { name: 'Rahul Sharma', designation: 'BDM', mobile: '9820012345', email: 'rahul@adinn.example' },
    });
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(2000);
  });
});

describe('client approval rules', () => {
  it('new clients need a PO; existing clients need any written approval', () => {
    expect(approval.approvalGaps('NEW', [])).toHaveLength(1);
    expect(approval.approvalGaps('NEW', ['EMAIL_APPROVAL'])).toHaveLength(1);
    expect(approval.approvalGaps('NEW', ['PURCHASE_ORDER'])).toEqual([]);
    expect(approval.approvalGaps('EXISTING', [])).toHaveLength(1);
    expect(approval.approvalGaps('EXISTING', ['WHATSAPP_APPROVAL'])).toEqual([]);
  });
});

describe('new client registration validation', () => {
  const ok = { name: 'Acme Retail', email: 'info@acme.example', contacts: [{ name: 'Rohan', phone: '+91 98765 43210' }] };
  it('requires company email and at least one contact with a valid mobile', () => {
    const r = clientV.clientRegistration.safeParse(ok);
    expect(r.success).toBe(true);
    expect(r.data?.contacts[0]?.phone).toBe('9876543210');
    expect(clientV.clientRegistration.safeParse({ ...ok, email: '' }).success).toBe(false);
    expect(clientV.clientRegistration.safeParse({ ...ok, contacts: [] }).success).toBe(false);
    expect(clientV.clientRegistration.safeParse({ ...ok, contacts: [{ name: 'A' }] }).success).toBe(false);
    expect(clientV.clientRegistration.safeParse({ ...ok, pincode: '4000' }).success).toBe(false);
    expect(clientV.clientRegistration.safeParse({ ...ok, contacts: [{ name: 'A', phone: '9876543210' }, { name: 'B', phone: '9876543210' }] }).success).toBe(false);
  });
});
