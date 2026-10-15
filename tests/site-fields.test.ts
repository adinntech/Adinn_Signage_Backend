import { describe, expect, it } from 'vitest';
import { autoMap, normalise, normalisePhone, parseSize, sqftOf, validateMapping, dupKeyOf } from '../src/modules/sites/site.fields';

describe('autoMap', () => {
  it('maps the client Excel headers from the brief', () => {
    const m = autoMap(['S.No', 'Customer / Dealer Name', 'District', 'Size (W * H)', 'Address Line 1', 'Address Line 2', 'Mobile Number(PH)', 'GST Number', 'Region']);
    expect(m['Customer / Dealer Name']).toBe('dealerName');
    expect(m['District']).toBe('district');
    expect(m['Size (W * H)']).toBe('size');
    expect(m['Address Line 1']).toBe('address1');
    expect(m['Address Line 2']).toBe('address2');
    expect(m['Mobile Number(PH)']).toBe('mobile');
    expect(m['GST Number']).toBe('gstin');
    expect(m['S.No']).toBe('extra');
    expect(m['Region']).toBe('extra');
  });
  it('maps each field at most once', () => {
    const m = autoMap(['Shop Name', 'Shop', 'Mobile', 'Phone']);
    expect(Object.values(m).filter((v) => v === 'shopName').length).toBe(1);
    expect(Object.values(m).filter((v) => v === 'mobile').length).toBe(1);
  });
});

describe('validateMapping', () => {
  it('requires a name, and size for scenario 2, and rejects duplicates', () => {
    expect(validateMapping({ A: 'district' }, 'MEASUREMENT_REQUIRED').length).toBe(1);
    expect(validateMapping({ A: 'shopName' }, 'MEASUREMENT_REQUIRED')).toEqual([]);
    expect(validateMapping({ A: 'shopName' }, 'CLIENT_PROVIDED').length).toBe(1);
    expect(validateMapping({ A: 'shopName', B: 'size' }, 'CLIENT_PROVIDED')).toEqual([]);
    expect(validateMapping({ A: 'shopName', B: 'width', C: 'height' }, 'CLIENT_PROVIDED')).toEqual([]);
    expect(validateMapping({ A: 'shopName', B: 'shopName' }, 'MEASUREMENT_REQUIRED').length).toBe(1);
  });
});

describe('parsing', () => {
  it('parses sizes in several notations', () => {
    expect(parseSize('10 x 4')).toMatchObject({ w: 10, h: 4, invalid: false });
    expect(parseSize('10X4')).toMatchObject({ w: 10, h: 4 });
    expect(parseSize('8 * 10')).toMatchObject({ w: 8, h: 10 });
    expect(parseSize('336" x 72"')).toMatchObject({ w: 336, h: 72, unit: 'in' });
    expect(parseSize('10 ft x 4 ft')).toMatchObject({ w: 10, h: 4, unit: 'ft' });
    expect(parseSize('ten by four').invalid).toBe(true);
    expect(parseSize('0 x 4').invalid).toBe(true);
  });
  it('normalises phones', () => {
    expect(normalisePhone('98765 43210').primary).toBe('9876543210');
    expect(normalisePhone('+91 98765-43210').primary).toBe('9876543210');
    expect(normalisePhone('09876543210').primary).toBe('9876543210');
    expect(normalisePhone('9876543210 / 9123456780')).toMatchObject({ primary: '9876543210', alt: '9123456780' });
    expect(normalisePhone('12345').invalid).toBe(true);
  });
  it('computes sq.ft per unit', () => {
    expect(sqftOf(10, 4, 'ft')).toBe(40);
    expect(sqftOf(336, 72, 'in')).toBe(168);
    expect(sqftOf(2, 3, 'ft', 2)).toBe(12);
  });
});

describe('normalise', () => {
  it('flags errors vs warnings', () => {
    const r = normalise({ shopName: 'ABC', mobile: '123', gstin: 'BAD' }, { scenario: 'MEASUREMENT_REQUIRED' });
    expect(r.errors.map((e) => e.code).sort()).toEqual(['BAD_GST', 'BAD_MOBILE']);
    expect(r.warnings.map((e) => e.code).sort()).toEqual(['MISSING_ADDRESS', 'MISSING_DISTRICT']);
  });
  it('requires a name and, for scenario 2, a size', () => {
    expect(normalise({}, { scenario: 'MEASUREMENT_REQUIRED' }).errors[0]?.code).toBe('NAME_REQUIRED');
    expect(normalise({ shopName: 'A' }, { scenario: 'CLIENT_PROVIDED' }).errors.map((e) => e.code)).toContain('MISSING_SIZE');
    expect(normalise({ shopName: 'A' }, { scenario: 'MEASUREMENT_REQUIRED' }).errors).toEqual([]);
  });
  it('handles numeric excel cells and split width/height', () => {
    const r = normalise({ shopName: 'A', mobile: 9876543210, width: 10, height: '4.5', district: 'X', address1: 'y' }, { scenario: 'CLIENT_PROVIDED' });
    expect(r.errors).toEqual([]);
    expect(r.value).toMatchObject({ mobile: '9876543210', width: 10, height: 4.5, unit: 'ft' });
  });
  it('rejects bad measurements', () => {
    const r = normalise({ shopName: 'A', width: 'abc', height: '-3' }, { scenario: 'MEASUREMENT_REQUIRED' });
    expect(r.errors.map((e) => e.code).sort()).toEqual(['BAD_HEIGHT', 'BAD_WIDTH']);
  });
  it('dup key ignores case and punctuation', () => {
    expect(dupKeyOf({ shopName: 'ABC Traders', dealerName: 'Raj', district: 'Vellore' })).toBe(dupKeyOf({ shopName: 'abc  traders.', dealerName: 'RAJ', district: 'vellore' }));
  });
});
