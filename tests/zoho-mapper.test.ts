import { describe, expect, it } from 'vitest';
import { toClientFields } from '../src/modules/zoho/zoho.mapper';

describe('Zoho contact -> client mapping', () => {
  const base = { contact_id: '131627200002319999', company_name: 'AGNI STEELS PRIVATE LIMITED', gst_no: '33aaaca1234a1z5', email: 'Accounts@Agni.com' };

  it('normalises GSTIN, email and company fields', () => {
    const f = toClientFields({ ...base, billing_address: { address: 'Plot 1', city: 'Chennai', state: 'Tamil Nadu', zip: '600001' } });
    expect(f).toMatchObject({ name: 'AGNI STEELS PRIVATE LIMITED', gstin: '33AAACA1234A1Z5', email: 'accounts@agni.com', city: 'Chennai', pincode: '600001' });
  });

  it('drops invalid mobile, GSTIN and pincode instead of importing dirty data', () => {
    const f = toClientFields({ ...base, gst_no: 'BAD', billing_address: { zip: '12' }, contact_persons: [{ first_name: 'Ravi', mobile: '12345', email: 'nope' }] });
    expect(f.gstin).toBeUndefined();
    expect(f.pincode).toBeUndefined();
    expect(f.contacts[0]).toMatchObject({ name: 'Ravi', phone: undefined, email: undefined });
  });

  it('keeps 10-digit mobiles (strips +91), one primary, and removes repeated phones', () => {
    const f = toClientFields({ ...base, contact_persons: [{ first_name: 'A', mobile: '+91 98765 43210' }, { first_name: 'B', phone: '9876543210' }] });
    expect(f.contacts.map((c) => c.phone)).toEqual(['9876543210', undefined]);
    expect(f.contacts.filter((c) => c.isPrimary)).toHaveLength(1);
  });
});

describe('Zoho customer number as Client Code', () => {
  it('reads the number before " - " in the contact name', async () => {
    const { customerNoOf } = await import('../src/modules/zoho/zoho.mapper');
    expect(customerNoOf('30196 - AGNI STEELS PRIVATE LIMITED')).toBe('30196');
    expect(customerNoOf('*Milestone Brandcom Private Ltd')).toBeUndefined();
    expect(customerNoOf('11017-JJ truss Engineering  Work')).toBe('11017');
  });

  it('drops the number prefix from the company name', () => {
    expect(toClientFields({ contact_id: '1', contact_name: '30196 - AGNI STEELS PRIVATE LIMITED' }).name).toBe('AGNI STEELS PRIVATE LIMITED');
  });
});
