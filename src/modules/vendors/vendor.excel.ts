import ExcelJS from 'exceljs';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { parseWorkbook } from '../sites/excel.service';
import { normKey, normalisePhone } from '../sites/site.fields';
import { Vendor } from './vendor.model';
import { checkVendor, createVendor, duplicateOf, kycComplete, vendorBody, type Issue, type VendorInput } from './vendor.service';

type ColKey = keyof VendorInput | 'bankAccount' | 'ifsc';
const COLUMNS: { header: string; key: ColKey; aliases: string[]; width: number; sample: string }[] = [
  { header: 'Vendor Name', key: 'name', aliases: ['vendorname', 'name', 'firmname', 'agencyname'], width: 28, sample: 'Balamurugan Signs' },
  { header: 'Type (One-man / Organization)', key: 'type', aliases: ['type', 'vendortype', 'typeonemanorganization'], width: 26, sample: 'One-man' },
  { header: 'Contact Person', key: 'contactPerson', aliases: ['contactperson', 'contact', 'ownername'], width: 20, sample: 'Balamurugan' },
  { header: 'Mobile', key: 'mobile', aliases: ['mobile', 'mobileno', 'phone', 'phoneno', 'contactno'], width: 16, sample: '9876543210' },
  { header: 'Email', key: 'email', aliases: ['email', 'emailid', 'mail'], width: 26, sample: 'bala@example.com' },
  { header: 'GST No', key: 'gstin', aliases: ['gst', 'gstno', 'gstin', 'gstnumber'], width: 18, sample: '33AAACA2094M1ZK' },
  { header: 'PAN', key: 'pan', aliases: ['pan', 'panno', 'pannumber'], width: 14, sample: 'ABCDE1234F' },
  { header: 'Address', key: 'address', aliases: ['address', 'fulladdress'], width: 34, sample: '12 Main Road, Theppakulam' },
  { header: 'District', key: 'district', aliases: ['district', 'city', 'location'], width: 16, sample: 'Madurai' },
  { header: 'Service Areas (comma separated)', key: 'serviceAreas', aliases: ['serviceareas', 'servicearea', 'areas'], width: 30, sample: 'Madurai, Theni, Dindigul' },
  { header: 'Rate per Shop', key: 'ratePerShop', aliases: ['rateperhop', 'pershoprate', 'rate', 'rateshop'], width: 14, sample: '250' },
  { header: 'Far Rate per Shop', key: 'farRatePerShop', aliases: ['farrate', 'farrateshop'], width: 16, sample: '350' },
  { header: 'Bank Account No', key: 'bankAccount', aliases: ['bankaccountno', 'accountno', 'accountnumber'], width: 22, sample: '123456789012' },
  { header: 'IFSC', key: 'ifsc', aliases: ['ifsc', 'ifsccode'], width: 14, sample: 'SBIN0001234' },
  { header: 'Notes', key: 'notes', aliases: ['notes', 'remarks'], width: 24, sample: '' },
];
const COLUMN_BY_ALIAS = new Map<string, ColKey>(COLUMNS.flatMap((c) => [c.header, ...c.aliases].map((a) => [normKey(a), c.key] as const)));

export async function vendorTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Vendors');
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key as string, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.addRow(Object.fromEntries(COLUMNS.map((c) => [c.key, c.sample])));
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

const typeOf = (s: string) => (/org|company|agency|firm|pvt|ltd/i.test(s) ? 'ORGANIZATION' : /one|man|individual|single|person/i.test(s) ? 'ONE_MAN' : undefined);
const numberOrUndefined = (s?: string) => (s && Number.isFinite(Number(s)) ? Number(s) : undefined);

export interface ImportRowResult { row: number; name: string; ok: boolean; duplicate?: string | undefined; errors: Issue[] }

/**
 * Reads an uploaded vendor sheet. With commit=false it only checks every row (preview); with commit=true it creates
 * each valid, non-duplicate row as PENDING_KYC and reports the rest.
 */
export async function importVendors(file: { buffer: Buffer; originalname: string }, commit: boolean, actor: Actor) {
  const sheet = await parseWorkbook(file.buffer, file.originalname);
  const keyFor = new Map<string, ColKey>();
  for (const h of sheet.headers) {
    const k = COLUMN_BY_ALIAS.get(normKey(h));
    if (k) keyFor.set(h, k);
  }
  if (![...keyFor.values()].includes('name')) throw AppError.badRequest('Vendor Name column not found. Download the template and keep its headings.');
  const results: ImportRowResult[] = [];
  const seenMobile = new Set<string>();
  let created = 0;
  for (const r of sheet.rows) {
    const cell: Partial<Record<ColKey, string>> = {};
    for (const [h, k] of keyFor) cell[k] = (r.raw[h] ?? '').trim();
    const issues: Issue[] = [];
    const type = typeOf(cell.type ?? '');
    if (!type) issues.push({ field: 'type', message: 'Type must be One-man or Organization' });
    const parsed = vendorBody.safeParse({
      name: cell.name, type: type ?? 'ONE_MAN', contactPerson: cell.contactPerson, mobile: cell.mobile ?? '', email: cell.email, gstin: cell.gstin, pan: cell.pan,
      address: cell.address, district: cell.district,
      serviceAreas: cell.serviceAreas ? cell.serviceAreas.split(/[,;]/).map((x) => x.trim()).filter(Boolean) : undefined,
      bank: cell.bankAccount || cell.ifsc ? { accountNo: cell.bankAccount, ifsc: cell.ifsc } : undefined,
      ratePerShop: numberOrUndefined(cell.ratePerShop), farRatePerShop: numberOrUndefined(cell.farRatePerShop), notes: cell.notes,
    });
    if (!parsed.success) for (const i of parsed.error.issues) issues.push({ field: i.path.join('.'), message: i.message });
    let duplicate: string | undefined;
    if (parsed.success) {
      const { errors } = checkVendor(parsed.data);
      issues.push(...errors);
      if (!errors.length) {
        const m = normalisePhone(parsed.data.mobile).primary;
        duplicate = (m && seenMobile.has(m) ? `Mobile ${m} appears twice in this file` : undefined) ?? (await duplicateOf({ mobile: m, name: parsed.data.name, district: parsed.data.district })) ?? undefined;
        if (m) seenMobile.add(m);
      }
    }
    const ok = issues.length === 0 && !duplicate && parsed.success;
    if (ok && commit && parsed.success) {
      await createVendor(parsed.data, actor, 'IMPORT');
      created++;
    }
    results.push({ row: r.rowNumber, name: cell.name ?? '', ok, duplicate, errors: issues });
  }
  if (commit) await recordAudit({ actor, action: 'IMPORT', entity: 'Vendor', entityId: actor.id, reason: `${created} vendor(s) imported from ${file.originalname}` });
  return {
    fileName: file.originalname, total: results.length, valid: results.filter((x) => x.ok).length,
    duplicates: results.filter((x) => x.duplicate).length, errors: results.filter((x) => x.errors.length).length, created, rows: results.slice(0, 500),
  };
}

// Typed text must never become a spreadsheet formula.
const safe = (v: unknown) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v);

export async function exportVendors() {
  const items = await Vendor.find({ deletedAt: null }).sort({ code: 1 }).limit(20000).lean();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Vendors');
  const cols: [string, string, number][] = [
    ['Code', 'code', 12], ['Vendor Name', 'name', 28], ['Type', 'type', 14], ['Status', 'status', 14], ['Contact Person', 'contactPerson', 20], ['Mobile', 'mobile', 14],
    ['Email', 'email', 24], ['GST No', 'gstin', 18], ['PAN', 'pan', 12], ['District', 'district', 16], ['Service Areas', 'areas', 28], ['Rate per Shop', 'ratePerShop', 12],
    ['Far Rate', 'farRatePerShop', 10], ['KYC complete', 'kyc', 12],
  ];
  ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
  ws.getRow(1).font = { bold: true };
  for (const v of items) {
    ws.addRow({
      code: v.code, name: safe(v.name), type: v.type === 'ONE_MAN' ? 'One-man' : 'Organization', status: v.status, contactPerson: safe(v.contactPerson), mobile: v.mobile,
      email: v.email, gstin: v.gstin, pan: v.pan, district: safe(v.district), areas: safe((v.serviceAreas ?? []).join(', ')),
      ratePerShop: v.ratePerShop, farRatePerShop: v.farRatePerShop, kyc: kycComplete(v as never) ? 'Yes' : 'No',
    });
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
