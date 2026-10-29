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

describe('shop list import: the sheet as it is', () => {
  it('keeps the exact headers (blank and repeated too), column order, blank cells and displayed values', async () => {
    const g = await readGrids(
      await book([
        {
          name: 'S',
          rows: [
            ['Customer Name', 'District', 'Remarks', 'contact person number', 'Address 2', 'Address 3', 'Pin', 'PH', 'GST', 'reference NO', 'reference image', '', 'PH'],
            ['FAYAZ HARDWARE', 'KANYAKUMARI', '', '+91 94436 07543', '', 'COLACHAL', 629251, '+91 94436 07543', '33AAACA2094M1ZK', 7, 'img-1.jpg', 'x', '0422 2345678'],
          ],
          fmt: { J2: '0000' },
        },
      ]),
      'x.xlsx',
    );
    const r = resolveImport(g, {}, 'SHOP_DETAILS');
    expect(r.headers).toEqual(['Customer Name', 'District', 'Remarks', 'contact person number', 'Address 2', 'Address 3', 'Pin', 'PH', 'GST', 'reference NO', 'reference image', '', 'PH']);
    expect(r.rows[0]!.cells).toEqual(['FAYAZ HARDWARE', 'KANYAKUMARI', '', '+91 94436 07543', '', 'COLACHAL', '629251', '+91 94436 07543', '33AAACA2094M1ZK', '0007', 'img-1.jpg', 'x', '0422 2345678']);
    // Internally the recognisable columns feed shop fields; the table keeps every column regardless.
    expect(r.mapping['Customer Name']).toBe('dealerName');
    expect(r.mapping.Pin).toBe('pincode');
  });

  it('shows dates and numbers as Excel formats them', async () => {
    const g = await readGrids(
      await book([{ name: 'S', rows: [['Name', 'Date', 'Amount', 'Pct', 'Price'], ['A', new Date(Date.UTC(2026, 9, 5)), 1234567.5, 0.125, 99]], fmt: { B2: 'dd-mm-yyyy', C2: '#,##0.00', D2: '0.0%', E2: '"Rs."0' } }]),
      'x.xlsx',
    );
    expect(g[0]!.rows[1]!.cells).toEqual(['A', '05-10-2026', '1,234,567.50', '12.5%', 'Rs.99']);
  });

  it('imports a sheet with no template columns at all (nothing rejected)', async () => {
    const g = await readGrids(await book([{ name: 'S', rows: [['Party', 'Beat'], ['Sri Balaji', 'North']] }]), 'x.xlsx');
    const r = resolveImport(g, {}, 'SHOP_DETAILS');
    expect(r.headers).toEqual(['Party', 'Beat']);
    expect(r.rows).toHaveLength(1);
  });

  it('finds the header below a title row', async () => {
    const g = await readGrids(await book([{ name: 'S', rows: [['Dealer list Q3'], ['Shop Name', 'Mobile'], ['A', '9876543210']] }]), 'x.xlsx');
    const r = resolveImport(g, {}, 'SHOP_DETAILS');
    expect(r.headers).toEqual(['Shop Name', 'Mobile']);
    expect(r.rows.map((x) => x.cells[0])).toEqual(['A']);
  });

  it('lets the BD pick the sheet when several have lists, and uses the only list otherwise', async () => {
    const two = await readGrids(await book([{ name: 'A', rows: [['Shop Name'], ['x']] }, { name: 'B', rows: [['Shop Name'], ['y']] }]), 'x.xlsx');
    const e = fail(() => resolveImport(two, {}, 'SHOP_DETAILS'));
    expect(e.code).toBe('SHOP_MAPPING_REQUIRED');
    expect((e.details?.preview?.sheets as { name: string }[]).map((s) => s.name)).toEqual(['A', 'B']);
    expect(resolveImport(two, { sheet: 'B' }, 'SHOP_DETAILS').rows[0]!.cells).toEqual(['y']);
    const withNotes = await readGrids(await book([{ name: 'Notes', rows: [['Fill the list on the next sheet']] }, { name: 'List', rows: [['Shop Name'], ['z']] }]), 'x.xlsx');
    expect(resolveImport(withNotes, {}, 'SHOP_DETAILS').sheet).toBe('List');
  });

  it('rejects only an empty workbook or a header with no rows', async () => {
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
