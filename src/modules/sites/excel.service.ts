import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { AppError } from '../../common/errors';
import { FIELD_LABELS, type MappableField, type Scenario } from './site.fields';

export const MAX_ROWS = 20000;
const MAX_COLS = 100;

export function cellText(v: ExcelJS.CellValue | undefined): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join('').trim();
    if ('result' in o) return cellText(o.result as ExcelJS.CellValue);
    if ('text' in o) return cellText(o.text as ExcelJS.CellValue);
    if ('error' in o) return '';
    return '';
  }
  return String(v).trim();
}

export interface ParsedSheet {
  sheetName: string;
  headers: string[];
  rows: { rowNumber: number; raw: Record<string, string> }[];
}

export async function parseWorkbook(buffer: Buffer, fileName: string): Promise<ParsedSheet> {
  const wb = new ExcelJS.Workbook();
  const isCsv = /\.csv$/i.test(fileName);
  try {
    if (isCsv) await wb.csv.read(Readable.from(buffer));
    else await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw AppError.badRequest('Could not read the file. Upload a valid .xlsx or .csv file.');
  }
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0);
  if (!ws) throw AppError.badRequest('The file is empty');

  let headers: string[] | null = null;
  let headerRow = 0;
  const rows: ParsedSheet['rows'] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: string[] = [];
    const max = Math.min(Math.max(row.cellCount, headers?.length ?? 0), MAX_COLS);
    for (let c = 1; c <= max; c++) cells.push(cellText(row.getCell(c).value));
    if (cells.every((c) => c === '')) return;
    if (!headers) {
      headerRow = rowNumber;
      const seen = new Map<string, number>();
      headers = cells.map((h, i) => {
        const base = h || `Column ${i + 1}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        return n > 1 ? `${base} (${n})` : base;
      });
      return;
    }
    if (rowNumber <= headerRow) return;
    if (rows.length >= MAX_ROWS) throw AppError.badRequest(`Too many rows (limit ${MAX_ROWS}). Split the file and import in parts.`);
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => { raw[h] = cells[i] ?? ''; });
    rows.push({ rowNumber, raw });
  });
  if (!headers) throw AppError.badRequest('The file has no header row');
  if (!rows.length) throw AppError.badRequest('The file has a header but no data rows');
  return { sheetName: ws.name, headers, rows };
}

// ---------- export ----------
export const EXPORT_COLUMNS: Record<string, { header: string; get: (s: Record<string, any>) => unknown; width: number }> = {
  siteCode: { header: 'Site ID', get: (s) => s.siteCode, width: 26 },
  clientSiteCode: { header: 'Client Site Code', get: (s) => s.clientSiteCode, width: 16 },
  shopName: { header: 'Shop Name', get: (s) => s.shopName, width: 28 },
  dealerName: { header: 'Dealer Name', get: (s) => s.dealerName, width: 24 },
  location: { header: 'Location', get: (s) => s.location, width: 18 },
  district: { header: 'District', get: (s) => s.district, width: 16 },
  address1: { header: 'Address Line 1', get: (s) => s.address1, width: 30 },
  address2: { header: 'Address Line 2', get: (s) => s.address2, width: 24 },
  address3: { header: 'Address Line 3', get: (s) => s.address3, width: 24 },
  pincode: { header: 'Pincode', get: (s) => s.pincode, width: 10 },
  mobile: { header: 'Mobile', get: (s) => s.mobile, width: 14 },
  gstin: { header: 'GST No', get: (s) => s.gstin, width: 18 },
  contactPerson: { header: 'Contact Person', get: (s) => s.contactPerson, width: 18 },
  width: { header: 'Width', get: (s) => s.width, width: 9 },
  height: { header: 'Height', get: (s) => s.height, width: 9 },
  unit: { header: 'Unit', get: (s) => s.unit, width: 7 },
  quantity: { header: 'Qty', get: (s) => s.quantity, width: 7 },
  sqft: { header: 'Sq.ft', get: (s) => s.sqft, width: 9 },
  boardType: { header: 'Board Type', get: (s) => s.boardType, width: 20 },
  status: { header: 'Recce Status', get: (s) => s.status, width: 14 },
  scenario: { header: 'Scenario', get: (s) => (s.scenario === 'CLIENT_PROVIDED' ? 'Client measured' : 'Measure on site'), width: 16 },
  remarks: { header: 'Remarks', get: (s) => s.remarks, width: 30 },
};
export const DEFAULT_EXPORT = ['siteCode', 'shopName', 'dealerName', 'location', 'district', 'address1', 'address2', 'mobile', 'gstin', 'width', 'height', 'unit', 'quantity', 'sqft', 'boardType', 'status', 'remarks'];

/** Neutralise spreadsheet formula injection from user-supplied text. */
const safe = (v: unknown) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export async function buildSitesFile(sites: Record<string, any>[], columns: string[], format: 'xlsx' | 'csv', sheetName: string) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31) || 'Sites');
  const cols = columns.filter((c) => c in EXPORT_COLUMNS);
  ws.columns = cols.map((c) => ({ header: EXPORT_COLUMNS[c]!.header, key: c, width: EXPORT_COLUMNS[c]!.width }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const s of sites) ws.addRow(Object.fromEntries(cols.map((c) => [c, safe(EXPORT_COLUMNS[c]!.get(s))])));
  const buf = format === 'csv' ? await wb.csv.writeBuffer() : await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

/** `omit` drops columns (the BD shop list for Shop Details Only uses the client-measured columns without Size). */
export async function buildTemplate(scenario: Scenario, omit: MappableField[] = []) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sites');
  const base: MappableField[] = (scenario === 'CLIENT_PROVIDED'
    ? (['dealerName', 'shopName', 'district', 'size', 'address1', 'address2', 'mobile', 'gstin'] as MappableField[])
    : (['shopName', 'dealerName', 'location', 'district', 'address1', 'mobile', 'contactPerson'] as MappableField[])
  ).filter((f) => !omit.includes(f));
  ws.columns = base.map((f) => ({ header: f === 'size' ? 'Size (W x H)' : FIELD_LABELS[f], key: f, width: 24 }));
  // Scenario 2 follows the usual client sheet: customer, district, size, address lines, pin, phone, GST.
  const cols: [string, MappableField, number][] = scenario === 'CLIENT_PROVIDED'
    ? [['Customer Name', 'dealerName', 34], ['District', 'district', 16], ['Size (W x H)', 'size', 12], ['Remarks', 'remarks', 16], ['Address 1', 'address1', 30], ['Address 2', 'address2', 26], ['Address 3', 'address3', 18], ['Pin', 'pincode', 10], ['PH', 'mobile', 18], ['GST', 'gstin', 20]]
    : [['Shop Name', 'shopName', 26], ['Dealer Name', 'dealerName', 22], ['Location / Area', 'location', 18], ['District', 'district', 16], ['Address 1', 'address1', 30], ['Address 2', 'address2', 24], ['Address 3', 'address3', 18], ['Pin', 'pincode', 10], ['Mobile', 'mobile', 16], ['GST No', 'gstin', 20], ['Contact Person', 'contactPerson', 18], ['Remarks', 'remarks', 20]];
  // `omit` applies to the client sheet columns too (Shop Details Only: no Size).
  ws.columns = cols.filter(([, key]) => !omit.includes(key)).map(([header, key, width]) => ({ header, key, width }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.addRow(scenario === 'CLIENT_PROVIDED'
    ? { dealerName: 'FAYAZ HARDWARE (COLACHAL)', district: 'KANYAKUMARI', size: '10*4', remarks: 'Signage Board', address1: '30-1-D, MAIN ROAD', address2: '', address3: '', pincode: '629251', mobile: '+91 94436 07543', gstin: '33AAACA2094M1ZK' }
    : { shopName: 'ABC Traders', dealerName: 'Rajkumar', location: 'Katpadi', district: 'Vellore', address1: '12 Main Road', address2: 'Near Bus Stand', address3: '', pincode: '632007', mobile: '9876543210', gstin: '33AAACA2094M1ZK', contactPerson: 'Raj', remarks: 'Sells FMCG' });
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
