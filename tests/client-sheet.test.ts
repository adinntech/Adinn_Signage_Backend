import { describe, expect, it } from 'vitest';
import { autoMap, normalise, validateMapping } from '../src/modules/sites/site.fields';

// The shape clients actually send: S.No, Customer Name, District, Size, Remarks, Address 1-3, Dis, Pin, PH, GST.
const HEADERS = ['S.No', 'Customer Name', 'District', 'Size', 'Remarks', 'Address 1', 'Address 2', 'Address 3', 'Dis', 'Pin', 'PH', 'GST'];

describe('client measurement sheet', () => {
  it('maps every column without any manual work', () => {
    const m = autoMap(HEADERS);
    expect(m['Customer Name']).toBe('dealerName');
    expect(m['District']).toBe('district');
    expect(m['Size']).toBe('size');
    expect(m['Remarks']).toBe('remarks');
    expect(m['Address 1']).toBe('address1');
    expect(m['Address 2']).toBe('address2');
    expect(m['Address 3']).toBe('address3');
    expect(m['Pin']).toBe('pincode');
    expect(m['PH']).toBe('mobile');
    expect(m['GST']).toBe('gstin');
    expect(validateMapping(m, 'CLIENT_PROVIDED')).toEqual([]);
  });

  it('reads 10*4 sizes, +91 phones, GST, and takes the town from the brackets', () => {
    const n = normalise(
      { dealerName: 'FAYAZ HARDWREAS  (COLACHAL)', district: 'KANYAKUMARI', size: '10*4', remarks: 'Signage Board', address1: '30-1-D, MAIN ROAD', pincode: '629251', mobile: '+91 94436 07543', gstin: '33GXOPM0159M1ZY' },
      { scenario: 'CLIENT_PROVIDED' },
    );
    expect(n.errors).toEqual([]);
    expect(n.value).toMatchObject({ width: 10, height: 4, unit: 'ft', mobile: '9443607543', pincode: '629251', location: 'Colachal', gstin: '33GXOPM0159M1ZY' });
    const small = normalise({ dealerName: 'N.R.S. MATHA LEKSHMI TRADERS (KADAYAL)', size: '8*4', address3: 'KALIYAL' }, { scenario: 'CLIENT_PROVIDED' });
    expect(small.value).toMatchObject({ width: 8, height: 4, location: 'Kadayal', address3: 'KALIYAL' });
  });

  it('uses address line 3 as the area when the name has no brackets', () => {
    const n = normalise({ dealerName: 'K.R.K. TRADERS', size: '10*4', address3: 'CHITHIRAMCODE' }, { scenario: 'CLIENT_PROVIDED' });
    expect(n.value.location).toBe('Chithiramcode');
  });

  it('keeps a location that was given', () => {
    expect(normalise({ dealerName: 'A (B)', location: 'Madurai' }, { scenario: 'MEASUREMENT_REQUIRED' }).value.location).toBe('Madurai');
  });
});
