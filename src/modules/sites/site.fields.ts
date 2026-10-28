// Pure field definitions, header auto-mapping, normalisation and validation for site rows.
// Shared by Excel import, manual add and inline edit so every path applies the same rules.

export const UNITS = ['ft', 'in', 'm', 'cm', 'mm'] as const;
export type Unit = (typeof UNITS)[number];
export const SCENARIOS = ['MEASUREMENT_REQUIRED', 'CLIENT_PROVIDED'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const MAPPABLE = [
  'shopName', 'dealerName', 'location', 'district', 'address1', 'address2', 'address3', 'pincode',
  'mobile', 'gstin', 'contactPerson', 'width', 'height', 'size', 'unit', 'boardType',
  'quantity', 'remarks', 'clientSiteCode',
] as const;
export type MappableField = (typeof MAPPABLE)[number];
export type MapTarget = MappableField | 'extra' | 'ignore';

export const FIELD_LABELS: Record<MappableField, string> = {
  shopName: 'Shop Name', dealerName: 'Dealer / Customer Name', location: 'Location / Area', district: 'District',
  address1: 'Address Line 1', address2: 'Address Line 2', address3: 'Address Line 3', pincode: 'Pincode', mobile: 'Mobile', gstin: 'GST No',
  contactPerson: 'Contact Person', width: 'Width', height: 'Height', size: 'Size (W � H)', unit: 'Unit',
  boardType: 'Board Type', quantity: 'Qty', remarks: 'Remarks', clientSiteCode: 'Client Site Code',
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// [field, exact normalised headers, "contains" fragments] � evaluated in this order.
const PATTERNS: [MappableField, string[], string[]][] = [
  ['size', ['size', 'sizewh', 'sizewxh', 'boardsize', 'signagesize', 'sizeinft', 'dimension', 'dimensions'], ['sizew', 'boardsize']],
  ['width', ['width', 'w', 'widthft', 'wft', 'widthin'], []],
  ['height', ['height', 'h', 'heightft', 'hft', 'heightin'], []],
  ['gstin', ['gst', 'gstno', 'gstnumber', 'gstin', 'gstnum'], ['gst']],
  ['mobile', ['mobile', 'mobileno', 'mobilenumber', 'phone', 'phoneno', 'ph', 'phonenumber', 'contactno', 'contactnumber', 'mobilenumberph'], ['mobile', 'phone']],
  ['district', ['district', 'dist'], ['district']],
  ['pincode', ['pincode', 'pin', 'zip', 'zipcode', 'postalcode'], ['pincode']],
  ['address3', ['addressline3', 'address3', 'addr3'], ['line3', 'address3']],
  ['address2', ['addressline2', 'address2', 'addr2'], ['line2', 'address2']],
  ['address1', ['addressline1', 'address1', 'address', 'addr', 'fulladdress', 'completeaddress'], ['address']],
  ['shopName', ['shopname', 'shop', 'storename', 'store', 'outletname', 'outlet', 'firmname', 'firm', 'businessname', 'dealershopname'], ['shopname', 'storename', 'outletname']],
  ['dealerName', ['dealername', 'dealer', 'customername', 'customer', 'customerdealername', 'partyname', 'party', 'ownername', 'name'], ['dealer', 'customer']],
  ['contactPerson', ['contactperson', 'contactname', 'contact'], ['contactperson']],
  ['location', ['location', 'area', 'locality', 'place', 'town', 'city'], ['location']],
  ['unit', ['unit', 'uom'], []],
  ['boardType', ['boardtype', 'signagetype', 'type'], ['boardtype']],
  ['quantity', ['qty', 'quantity', 'noofboards', 'boards', 'nos'], []],
  ['remarks', ['remarks', 'remark', 'notes', 'comments', 'comment'], ['remark']],
  ['clientSiteCode', ['sitecode', 'siteid', 'clientcode', 'storecode', 'dealercode', 'code', 'clientsitecode'], ['sitecode', 'storecode']],
];

/** Suggest header -> field. Each field is used at most once; unmatched headers become 'extra'. */
export function autoMap(headers: string[]): Record<string, MapTarget> {
  const out: Record<string, MapTarget> = {};
  const used = new Set<MappableField>();
  const n = headers.map(norm);
  for (const pass of [0, 1] as const) {
    for (const [field, exact, contains] of PATTERNS) {
      if (used.has(field)) continue;
      const idx = n.findIndex((h, i) => !(headers[i]! in out) && h !== '' && (pass === 0 ? exact.includes(h) : contains.some((c) => h.includes(c))));
      if (idx >= 0) {
        out[headers[idx]!] = field;
        used.add(field);
      }
    }
  }
  for (const h of headers) if (!(h in out)) out[h] = 'extra';
  return out;
}

export function validateMapping(mapping: Record<string, MapTarget>, scenario: Scenario): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const [header, t] of Object.entries(mapping)) {
    if (t === 'extra' || t === 'ignore') continue;
    if (seen.has(t)) problems.push(`"${FIELD_LABELS[t]}" is mapped to both "${seen.get(t)}" and "${header}"`);
    seen.set(t, header);
  }
  if (!seen.has('shopName') && !seen.has('dealerName')) problems.push('Map at least Shop Name or Dealer Name');
  const hasSize = seen.has('size') || (seen.has('width') && seen.has('height'));
  if (scenario === 'CLIENT_PROVIDED' && !hasSize) problems.push('Scenario 2 needs Size (W � H) or both Width and Height mapped');
  return problems;
}

// ---------- normalisation ----------
export interface SiteInput {
  shopName?: string; dealerName?: string; location?: string; district?: string; address1?: string; address2?: string; address3?: string;
  pincode?: string; mobile?: string; mobileAlt?: string; gstin?: string; contactPerson?: string;
  width?: number; height?: number; unit?: Unit; boardType?: string; quantity?: number; remarks?: string; clientSiteCode?: string;
}
export interface RowIssue { field: string; code: string; message: string }
export interface Normalised { value: SiteInput; errors: RowIssue[]; warnings: RowIssue[] }

export const GST_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const UNIT_ALIASES: Record<string, Unit> = {
  ft: 'ft', feet: 'ft', foot: 'ft', "'": 'ft', in: 'in', inch: 'in', inches: 'in', '"': 'in', m: 'm', mtr: 'm', meter: 'm', metre: 'm', cm: 'cm', mm: 'mm',
};
const unitOf = (s?: string): Unit | undefined => (s ? UNIT_ALIASES[s.toLowerCase().trim()] : undefined);

export function normalisePhone(raw: string): { primary?: string; alt?: string; invalid: boolean } {
  const parts = raw.split(/[\/,;&]|\s{2,}/).map((p) => p.replace(/[^\d+]/g, '')).filter(Boolean);
  const ok: string[] = [];
  for (let p of parts) {
    p = p.replace(/^\+/, '');
    if (p.length === 12 && p.startsWith('91')) p = p.slice(2);
    else if (p.length === 11 && p.startsWith('0')) p = p.slice(1);
    if (/^[6-9]\d{9}$/.test(p)) ok.push(p);
  }
  const [primary, alt] = ok;
  return { ...(primary ? { primary } : {}), ...(alt ? { alt } : {}), invalid: raw.trim() !== '' && ok.length === 0 };
}

const NUM_RE = /^\s*(\d+(?:\.\d+)?)\s*(ft|feet|foot|in|inch|inches|mtr|meter|metre|cm|mm|m|'|")?\s*$/i;
export function parseDimension(raw: string): { n?: number; unit?: Unit; invalid: boolean } {
  const m = NUM_RE.exec(raw.replace(/,/g, ''));
  if (!m) return { invalid: raw.trim() !== '' };
  const n = Number(m[1]);
  const unit = unitOf(m[2]);
  return { n, ...(unit ? { unit } : {}), invalid: !(n > 0 && n <= 100000) };
}

const SIZE_RE = /^\s*(\d+(?:\.\d+)?)\s*(ft|feet|in|inch|inches|mtr|m|cm|mm|'|")?\s*[x�*]\s*(\d+(?:\.\d+)?)\s*(ft|feet|in|inch|inches|mtr|m|cm|mm|'|")?\s*$/i;
export function parseSize(raw: string): { w?: number; h?: number; unit?: Unit; invalid: boolean } {
  const m = SIZE_RE.exec(raw.replace(/,/g, ''));
  if (!m) return { invalid: raw.trim() !== '' };
  const w = Number(m[1]), h = Number(m[3]);
  const unit = unitOf(m[4]) ?? unitOf(m[2]);
  return { w, h, ...(unit ? { unit } : {}), invalid: !(w > 0 && h > 0 && w <= 100000 && h <= 100000) };
}

const TO_SQFT: Record<Unit, number> = { ft: 1, in: 1 / 144, m: 10.7639, cm: 1 / 929.0304, mm: 1 / 92903.04 };
export const sqftOf = (w?: number | null, h?: number | null, unit: Unit = 'ft', qty = 1) =>
  w && h ? Math.round(w * h * TO_SQFT[unit] * qty * 100) / 100 : undefined;

export const normKey = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const dupKeyOf = (v: { shopName?: string | undefined; dealerName?: string | undefined; district?: string | undefined }) => {
  const k = `${normKey(v.shopName)}|${normKey(v.dealerName)}|${normKey(v.district)}`;
  return k === '||' ? '' : k;
};
export const dealerKeyOf = (v: { dealerName?: string | undefined; district?: string | undefined }) =>
  v.dealerName ? `${normKey(v.dealerName)}|${normKey(v.district)}` : '';

type Raw = Partial<Record<MappableField | 'mobileAlt', string | number | null | undefined>>;
const s = (v: unknown) => (v == null ? '' : String(v).trim().replace(/\s+/g, ' '));

/** Raw text values (any source) -> normalised site fields + errors/warnings. */
export function normalise(raw: Raw, opts: { scenario: Scenario; defaultUnit?: Unit }): Normalised {
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const v: SiteInput = {};
  const err = (field: string, code: string, message: string) => errors.push({ field, code, message });
  const warn = (field: string, code: string, message: string) => warnings.push({ field, code, message });

  for (const f of ['shopName', 'dealerName', 'location', 'district', 'address1', 'address2', 'address3', 'contactPerson', 'boardType', 'remarks', 'clientSiteCode'] as const) {
    const t = s(raw[f]);
    if (t) v[f] = t.slice(0, f === 'remarks' ? 1000 : 250);
  }
  const pin = s(raw.pincode).replace(/\.0+$/, '');
  if (pin) {
    if (/^\d{6}$/.test(pin)) v.pincode = pin;
    else warn('pincode', 'BAD_PINCODE', 'Pincode should be 6 digits');
  }

  if (!v.shopName && !v.dealerName) err('shopName', 'NAME_REQUIRED', 'Shop name or dealer name is required');
  // Many client sheets put the town in brackets after the name, e.g. "FAYAZ HARDWARE (COLACHAL)"; use it (or address line 3) as the area.
  if (!v.location) {
    const m = /\(([^()]{2,40})\)\s*$/.exec(v.shopName ?? v.dealerName ?? '');
    const area = m?.[1]?.trim() ?? v.address3;
    if (area) v.location = area.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  if (!v.address1 && !v.address2 && !v.address3) warn('address1', 'MISSING_ADDRESS', 'Address is missing');
  if (!v.district) warn('district', 'MISSING_DISTRICT', 'District is missing');

  const phoneRaw = s(raw.mobile).replace(/\.0+$/, '');
  if (!phoneRaw) warn('mobile', 'MISSING_MOBILE', 'Mobile number is missing');
  else {
    const p = normalisePhone(phoneRaw);
    if (p.invalid) err('mobile', 'BAD_MOBILE', `Invalid mobile number "${phoneRaw}"`);
    else {
      if (p.primary) v.mobile = p.primary;
      if (p.alt) v.mobileAlt = p.alt;
    }
  }

  const gst = s(raw.gstin).toUpperCase().replace(/\s/g, '');
  if (gst) {
    if (GST_RE.test(gst)) v.gstin = gst;
    else err('gstin', 'BAD_GST', `Invalid GST number "${gst}"`);
  }

  // Measurements: a combined size cell wins over separate width/height.
  let unit: Unit | undefined = unitOf(s(raw.unit));
  if (s(raw.unit) && !unit) warn('unit', 'BAD_UNIT', `Unknown unit "${s(raw.unit)}", using ${opts.defaultUnit ?? 'ft'}`);
  const sizeRaw = s(raw.size);
  const wRaw = s(raw.width), hRaw = s(raw.height);
  if (sizeRaw) {
    const z = parseSize(sizeRaw);
    if (z.invalid || !z.w || !z.h) err('size', 'BAD_SIZE', `Invalid size "${sizeRaw}" (expected W x H)`);
    else { v.width = z.w; v.height = z.h; unit = unit ?? z.unit; }
  } else if (wRaw || hRaw) {
    const w = parseDimension(wRaw), h = parseDimension(hRaw);
    if (!wRaw) err('width', 'MISSING_WIDTH', 'Width is missing');
    else if (w.invalid || !w.n) err('width', 'BAD_WIDTH', `Invalid width "${wRaw}"`);
    else { v.width = w.n; unit = unit ?? w.unit; }
    if (!hRaw) err('height', 'MISSING_HEIGHT', 'Height is missing');
    else if (h.invalid || !h.n) err('height', 'BAD_HEIGHT', `Invalid height "${hRaw}"`);
    else { v.height = h.n; unit = unit ?? h.unit; }
  } else if (opts.scenario === 'CLIENT_PROVIDED') {
    err('size', 'MISSING_SIZE', 'Size (W � H) is required when the client provides measurements');
  }
  if (v.width && v.height) v.unit = unit ?? opts.defaultUnit ?? 'ft';
  const sq = sqftOf(v.width, v.height, v.unit ?? 'ft');
  if (sq && sq > 5000) warn('size', 'LARGE_BOARD', `Unusually large board (${sq} sq.ft)`);

  const q = s(raw.quantity);
  if (q) {
    const n = Number(q);
    if (Number.isInteger(n) && n > 0 && n <= 1000) v.quantity = n;
    else err('quantity', 'BAD_QTY', `Invalid quantity "${q}"`);
  }
  return { value: v, errors, warnings };
}
