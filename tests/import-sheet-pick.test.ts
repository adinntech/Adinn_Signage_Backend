import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseWorkbook } from '../src/modules/sites/excel.service';

const HEAD = ['S.no', 'Shop Name', 'Recce Date', 'Owner Name', 'Address', 'Mobile no', 'GST', 'Area', 'District'];
const shop = (i: number) => [i, `Shop ${i}`, '2026-06-19', `Owner ${i}`, `${i} Main Road`, 9000000000 + i, '', 'Oddanchatram', 'Dindigul'];

async function book(build: (wb: ExcelJS.Workbook) => void) {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('which sheet and which header row the importer uses', () => {
  it('skips a hidden old sheet and a pivot sheet, and the title line above the header', async () => {
    const buf = await book((wb) => {
      const old = wb.addWorksheet('Sheet1');
      old.addRow(HEAD);
      for (let i = 1; i <= 25; i++) old.addRow(shop(i));
      old.state = 'hidden';
      const pivot = wb.addWorksheet('Report');
      pivot.addRow(['District', '(All)']);
      pivot.addRow(['Row Labels', 'Count of Shop Name']);
      pivot.addRow(['Dindigul', 73]);
      const real = wb.addWorksheet('73 Shops');
      real.addRow(['LISHA - Branding list | Mr.Haree TSM - 95791 23657 ( Display boards, Foam & One way vision )']);
      real.addRow(HEAD);
      for (let i = 1; i <= 79; i++) real.addRow(shop(i));
      // rows hidden by a filter are still the client's shops
      for (let r = 10; r <= 60; r++) real.getRow(r).hidden = true;
    });
    const p = await parseWorkbook(buf, 'list.xlsx');
    expect(p.sheetName).toBe('73 Shops');
    expect(p.headers[1]).toBe('Shop Name');
    expect(p.rows).toHaveLength(79);
    expect(p.rows[0]!.rowNumber).toBe(3);
    expect(p.sheets.find((s) => s.name === 'Sheet1')!.note).toMatch(/hidden/i);
    expect(p.sheets.find((s) => s.name === 'Report')!.used).toBe(false);
  });

  it('a plain sheet with the header on row 1 still works', async () => {
    const buf = await book((wb) => {
      const ws = wb.addWorksheet('Shops');
      ws.addRow(HEAD);
      for (let i = 1; i <= 5; i++) ws.addRow(shop(i));
    });
    const p = await parseWorkbook(buf, 'a.xlsx');
    expect(p.rows).toHaveLength(5);
    expect(p.rows[0]!.rowNumber).toBe(2);
  });

  it('says so when every sheet is hidden', async () => {
    const buf = await book((wb) => {
      const ws = wb.addWorksheet('Shops');
      ws.addRow(HEAD);
      ws.addRow(shop(1));
      ws.state = 'hidden';
    });
    await expect(parseWorkbook(buf, 'a.xlsx')).rejects.toThrow(/hidden/i);
  });
});
