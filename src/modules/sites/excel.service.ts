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

/** One worksheet as text cells: its non-blank rows (Excel row numbers), first MAX_ROWS + a few header rows. */
export interface SheetGrid {
  name: string;
  rows: { rowNumber: number; cells: string[] }[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const two = (n: number) => String(n).padStart(2, '0');

/** A date cell as its number format shows it (d, dd, ddd, m, mm, mmm, mmmm, yy, yyyy, h, hh, mm, ss, AM/PM). */
function formatDate(d: Date, fmt: string): string {
  const f = fmt.split(';')[0]!.replace(/\[[^\]]*\]/g, '').replace(/\\(.)/g, '$1').replace(/"([^"]*)"/g, '$1');
  if (!/[dy]/i.test(f) && !/h/i.test(f)) return d.toISOString().slice(0, 10);
  const ampm = /AM\/PM|A\/P/i.test(f);
  const tokens = f.match(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|A\/P|./gi) ?? [];
  let out = '';
  tokens.forEach((t, i) => {
    const lower = t.toLowerCase();
    // "m" / "mm" right after hours or before seconds is minutes, otherwise the month.
    const minute = (lower === 'm' || lower === 'mm') && (/^h/i.test(tokens.slice(0, i).reverse().find((x) => /[a-z]/i.test(x)) ?? '') || /^s/i.test(tokens.slice(i + 1).find((x) => /[a-z]/i.test(x)) ?? ''));
    const h = d.getUTCHours();
    if (lower === 'yyyy') out += d.getUTCFullYear();
    else if (lower === 'yy') out += two(d.getUTCFullYear() % 100);
    else if (lower === 'mmmm') out += MONTHS[d.getUTCMonth()];
    else if (lower === 'mmm') out += MONTHS[d.getUTCMonth()]!.slice(0, 3);
    else if (minute) out += lower === 'mm' ? two(d.getUTCMinutes()) : d.getUTCMinutes();
    else if (lower === 'mm') out += two(d.getUTCMonth() + 1);
    else if (lower === 'm') out += d.getUTCMonth() + 1;
    else if (lower === 'dddd') out += DAYS[d.getUTCDay()];
    else if (lower === 'ddd') out += DAYS[d.getUTCDay()]!.slice(0, 3);
    else if (lower === 'dd') out += two(d.getUTCDate());
    else if (lower === 'd') out += d.getUTCDate();
    else if (lower === 'hh' || lower === 'h') {
      const v = ampm ? h % 12 || 12 : h;
      out += lower === 'hh' ? two(v) : v;
    } else if (lower === 'ss') out += two(d.getUTCSeconds());
    else if (lower === 's') out += d.getUTCSeconds();
    else if (lower === 'am/pm') out += h < 12 ? 'AM' : 'PM';
    else if (lower === 'a/p') out += h < 12 ? 'A' : 'P';
    else out += t;
  });
  return out;
}

/** A number cell as its format shows it: fixed digits ("000000"), decimals, thousands separators, %, quoted text. */
function formatNumber(v: number, fmt: string): string {
  const plain = () => String(Number(v.toPrecision(15)));
  const section = fmt.split(';')[0]!.replace(/\[[^\]]*\]/g, '');
  if (!section || /^general$/i.test(section) || section === '@' || /[?/E]/.test(section)) return plain();
  // Split the format into literal text before / after and the digit placeholders (# 0 , . %).
  let pre = '';
  let post = '';
  let pattern = '';
  for (let k = 0; k < section.length; k++) {
    const c = section[k]!;
    let text = '';
    if (c === '"') {
      const end = section.indexOf('"', k + 1);
      text = section.slice(k + 1, end < 0 ? undefined : end);
      k = end < 0 ? section.length : end;
    } else if (c === '\\') text = section[++k] ?? '';
    else if (c === '_' || c === '*') k++;
    else if ('#0,.%'.includes(c)) {
      pattern += c;
      continue;
    } else text = c;
    if (pattern) post += text;
    else pre += text;
  }
  if (!/[#0]/.test(pattern)) return plain();
  const pct = pattern.includes('%');
  const [int = '', dec = ''] = pattern.replace(/%/g, '').split('.');
  const n = pct ? v * 100 : v;
  const keep = (dec.match(/0/g) ?? []).length;
  let [i = '', f = ''] = Math.abs(n).toFixed(dec.length).split('.');
  while (f.length > keep && f.endsWith('0')) f = f.slice(0, -1);
  i = i.padStart((int.match(/0/g) ?? []).length, '0');
  if (int.includes(',')) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}${pre}${i}${f ? `.${f}` : ''}${pct ? '%' : ''}${post}`;
}

/**
 * A cell as Excel displays it: number / date formats applied (leading zeros, decimals, dates), text kept as typed
 * (phone prefixes, GST, codes), formulas as their result.
 */
function cellString(cell: ExcelJS.Cell): string {
  const fmt = typeof cell.numFmt === 'string' ? cell.numFmt : '';
  let v = cell.value as unknown;
  if (v && typeof v === 'object' && !(v instanceof Date) && 'result' in (v as object)) v = (v as { result: unknown }).result;
  try {
    if (typeof v === 'number' && Number.isFinite(v)) return formatNumber(v, fmt);
    if (v instanceof Date) return fmt ? formatDate(v, fmt) : v.toISOString().slice(0, 10);
  } catch {
    /* unusual format: plain value below */
  }
  return cellText(v as ExcelJS.CellValue);
}

/**
 * Optional reader for legacy .xls workbooks (SheetJS, the `xlsx` package). Loaded only when installed, so the rest of
 * the import keeps working without it; formatted text is used so codes, phones and pincodes keep their zeros.
 */
function readXls(buffer: Buffer): SheetGrid[] {
  let XLSX: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    XLSX = require('xlsx');
  } catch {
    throw AppError.badRequest('.xls files cannot be read on this server yet. Save the file as .xlsx (Excel: File > Save As > Excel Workbook) and upload it again.');
  }
  let wb: any;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch {
    throw AppError.badRequest('Could not read the file. Upload a valid .xls, .xlsx or .csv file.');
  }
  return (wb.SheetNames as string[]).map((name) => {
    const aoa: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: true });
    const rows: SheetGrid['rows'] = [];
    aoa.forEach((r, i) => {
      const cells = r.slice(0, MAX_COLS).map((v) => (v == null ? '' : String(v).trim()));
      if (cells.some((c) => c !== '') && rows.length <= MAX_ROWS + 20) rows.push({ rowNumber: i + 1, cells });
    });
    return { name, rows };
  });
}

/** Every worksheet of an .xlsx / .xls / .csv file as text grids (header detection and mapping happen on top). */
export async function readGrids(buffer: Buffer, fileName: string): Promise<SheetGrid[]> {
  if (/\.xls$/i.test(fileName)) return readXls(buffer);
  const wb = new ExcelJS.Workbook();
  try {
    if (/\.csv$/i.test(fileName)) await wb.csv.read(Readable.from(buffer));
    else await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw AppError.badRequest('Could not read the file. Upload a valid .xlsx, .xls or .csv file (it may be damaged or password protected).');
  }
  return wb.worksheets.map((ws) => {
    const rows: SheetGrid['rows'] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rows.length > MAX_ROWS + 20) return;
      const cells: string[] = [];
      for (let c = 1; c <= Math.min(row.cellCount, MAX_COLS); c++) cells.push(cellString(row.getCell(c)));
      if (cells.some((c) => c !== '')) rows.push({ rowNumber, cells });
    });
    return { name: ws.name, rows };
  });
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
