import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readGrids } from '../src/modules/sites/excel.service';
import { resolveImport } from '../src/modules/sales/handover.service';
import { soContactsBody } from '../src/modules/sales/sales.validators';

const book = async (sheets: { name: string; rows: unknown[][]; fmt?: Record<string, string> }[]) => {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const r of s.rows) ws.addRow(r);
    for (const [addr, f] of Object.entries(s.fmt ?? {})) ws.getCell(addr).numFmt = f;
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
};
const fail = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as { statusCode: number; code: string; message: string; details?: { preview?: Record<string, unknown> } };
  }
  throw new Error('expected an error');
};

describe('shop list import: reading the workbook', () => {
  it('keeps leading zeros of digit-formatted numbers and text cells', async () => {
    const g = await readGrids(await book([{ name: 'S', rows: [['Shop Name', 'Outlet Code', 'PIN'], ['A', 7, '600001']], fmt: { B2: '000' } }]), 'x.xlsx');
    expect(g[0]!.rows[1]!.cells).toEqual(['A', '007', '600001']);
  });

  it('turns a damaged file into a 400, not a 500', async () => {
    await expect(readGrids(Buffer.from('not a workbook'), 'x.xlsx')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('explains .xls when the optional reader is not installed (or reads it when it is)', async () => {
    const r = await readGrids(Buffer.from('junk'), 'x.xls').catch((e: { statusCode: number; message: string }) => e);
    expect((r as { statusCode: number }).statusCode).toBe(400);
  });
});

describe('shop list import: sheet, header row and mapping', () => {
  it('maps other header names in any order, finds a header below a title row and keeps extra columns', async () => {
    const g = await readGrids(await book([{ name: 'S', rows: [['Dealer list Q3'], ['Outlet Code', 'PIN', 'Phone No', 'Retailer', 'Beat'], ['007', '600001', '9876543210', 'Kumar Stores', 'North']] }]), 'x.xlsx');
    const r = resolveImport(g, {}, 'SHOP_DETAILS');
    expect(r.mapping).toMatchObject({ Retailer: 'shopName', 'Phone No': 'mobile', PIN: 'pincode', 'Outlet Code': 'clientSiteCode', Beat: 'extra' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.raw.Beat).toBe('North');
  });

  it('Shop Details Only keeps a size column as an extra column (no measurements needed)', async () => {
    const g = await readGrids(await book([{ name: 'S', rows: [['Shop Name', 'Size'], ['A', '10x4']] }]), 'x.xlsx');
    expect(resolveImport(g, {}, 'SHOP_DETAILS').mapping.Size).toBe('extra');
    expect(resolveImport(g, {}, 'SHOP_MEASUREMENT').mapping.Size).toBe('size');
  });

  it('asks for a mapping when no shop / dealer column is recognised, and accepts the chosen one', async () => {
    const g = await readGrids(await book([{ name: 'S', rows: [['Name of party', 'Town'], ['Sri Balaji', 'Salem']] }]), 'x.xlsx');
    const e = fail(() => resolveImport(g, {}, 'SHOP_DETAILS'));
    expect(e.statusCode).toBe(422);
    expect(e.code).toBe('SHOP_MAPPING_REQUIRED');
    expect(e.details?.preview).toMatchObject({ sheet: 'S', headers: ['Name of party', 'Town'] });
    const r = resolveImport(g, { headerRow: 1, mapping: { 'Name of party': 'shopName', Town: 'district' } }, 'SHOP_DETAILS');
    expect(r.rows[0]!.raw['Name of party']).toBe('Sri Balaji');
  });

  it('asks which sheet when several have a shop list, picks the only one that has', async () => {
    const two = await readGrids(await book([{ name: 'A', rows: [['Shop Name'], ['x']] }, { name: 'B', rows: [['Shop Name'], ['y']] }]), 'x.xlsx');
    const e = fail(() => resolveImport(two, {}, 'SHOP_DETAILS'));
    expect(e.code).toBe('SHOP_MAPPING_REQUIRED');
    expect((e.details?.preview?.sheets as { name: string }[]).map((s) => s.name)).toEqual(['A', 'B']);
    expect(resolveImport(two, { sheet: 'B' }, 'SHOP_DETAILS').rows[0]!.raw['Shop Name']).toBe('y');
    const withNotes = await readGrids(await book([{ name: 'Notes', rows: [['Fill the list on the next sheet']] }, { name: 'List', rows: [['Shop Name'], ['z']] }]), 'x.xlsx');
    expect(resolveImport(withNotes, {}, 'SHOP_DETAILS').sheet).toBe('List');
  });

  it('rejects an empty workbook and a header with no rows clearly', async () => {
    expect(fail(() => resolveImport([{ name: 'S', rows: [] }], {}, 'SHOP_DETAILS')).statusCode).toBe(400);
    const g = await readGrids(await book([{ name: 'S', rows: [['Shop Name', 'Mobile']] }]), 'x.xlsx');
    expect(fail(() => resolveImport(g, {}, 'SHOP_DETAILS')).statusCode).toBe(422);
  });
});

describe('ASO SO contacts', () => {
  it('drops blank rows, needs name + mobile, email optional, one primary', () => {
    const r = soContactsBody.parse({ contacts: [{ name: '', phone: '', email: '' }, { name: 'Ravi', phone: '98765 43210' }, { name: 'Mala', phone: '9123456780', email: 'mala@x.example' }] });
    expect(r.contacts).toEqual([
      { name: 'Ravi', phone: '9876543210', email: undefined, isPrimary: true },
      { name: 'Mala', phone: '9123456780', email: 'mala@x.example', isPrimary: false },
    ]);
    expect(soContactsBody.parse({ contacts: [] }).contacts).toEqual([]);
    expect(soContactsBody.safeParse({ contacts: [{ name: 'Ravi' }] }).success).toBe(false);
    expect(soContactsBody.safeParse({ contacts: [{ phone: '9876543210' }] }).success).toBe(false);
    expect(soContactsBody.safeParse({ contacts: [{ name: 'A', phone: '9876543210' }, { name: 'B', phone: '9876543210' }] }).success).toBe(false);
    const p = soContactsBody.parse({ contacts: [{ name: 'A', phone: '9876543210' }, { name: 'B', phone: '9123456780', isPrimary: true }] });
    expect(p.contacts.map((c) => c.isPrimary)).toEqual([false, true]);
  });
});
