import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { COMPANY } from '../../config/company';
import { LOGO_PATHS, LOGO_VIEWBOX } from '../ratecards/adinn-logo';

export interface OnboardingPerson {
  name?: string | null;
  designation?: string | null;
  mobile?: string | null;
  email?: string | null;
}
export interface OnboardingPdfInput {
  orderNo: string;
  date: Date;
  companyName: string;
  companyEmail?: string | null;
  gstin?: string | null;
  organisationType?: string | null;
  pan?: string | null;
  msmeApplicable?: boolean | null;
  msmeNumber?: string | null;
  primaryPhone?: string | null;
  registered?: Partial<Record<'floorNo' | 'buildingNo' | 'premises' | 'road' | 'locality' | 'city' | 'district' | 'state' | 'pincode', string | null>> | null;
  branchAddress?: string | null;
  keyManagement: OnboardingPerson[];
  accounts?: { primary?: OnboardingPerson | null; escalation?: OnboardingPerson | null } | null;
  finance?: { primary?: OnboardingPerson | null; escalation?: OnboardingPerson | null } | null;
}

/** The general terms printed on ADINN's Customer Onboarding Form. */
export const ONBOARDING_TERMS = [
  'All details provided above are true and correct to the best of our knowledge.',
  'Any change in company information must be communicated in writing within 7 working days.',
  'The company reserves the right to verify the information and request additional documents.',
  'Payments are to be made as per the agreed schedule. Applicable statutory taxes (GST/TDS or others) will be charged as per law.',
  'All customer information will be kept confidential and used only for business purposes.',
  'Valid documents such as PAN, GST, or MSME details are requested for compliance purposes.',
];

const RED = '#E3000F';
const DARK = '#1E2235';
const MUTED = '#5B6475';
const LINE = '#E4E7EC';
const HEAD_BG = '#EEF0F3';
const ZEBRA = '#FAFAFB';
const PINK = '#FDF0F0';
const PINK_LINE = '#F4CFCF';
const PILL = '#1F2433';
const M = 34;
const W = 564 - M;
const PAGE_BOTTOM = 795;

const FONT_DIR = path.resolve(process.cwd(), 'assets/fonts');
const FONTS = { regular: path.join(FONT_DIR, 'DejaVuSans.ttf'), bold: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf') };
const hasFonts = () => fs.existsSync(FONTS.regular) && fs.existsSync(FONTS.bold);
const dateText = (d: Date) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const phoneText = (p?: string | null) => (p && /^\d{10}$/.test(p) ? `+91 ${p.slice(0, 5)} ${p.slice(5)}` : (p ?? ''));
const v = (s?: string | null) => (s && String(s).trim()) || '-';

/** Customer Onboarding Form PDF, in the same ADINN style as the rate card (header card, red section markers, footer). */
export function renderOnboardingPdf(f: OnboardingPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `Customer Onboarding Form ${f.companyName}`, Author: COMPANY.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const custom = hasFonts();
    if (custom) {
      doc.registerFont('Body', FONTS.regular);
      doc.registerFont('Bold', FONTS.bold);
    }
    const REG = custom ? 'Body' : 'Helvetica';
    const BOLD = custom ? 'Bold' : 'Helvetica-Bold';
    const put = (s: string, x: number, y: number, o: { font?: string; size: number; color?: string; width?: number; align?: 'left' | 'right' | 'center' }) =>
      doc
        .font(o.font ?? REG)
        .fontSize(o.size)
        .fillColor(o.color ?? DARK)
        .text(s, x, y, { width: o.width, align: o.align ?? 'left', lineBreak: !!o.width, lineGap: 1.5 });
    const height = (s: string, font: string, size: number, width: number) => doc.font(font).fontSize(size).heightOfString(s, { width, lineGap: 1.5 });
    const card = (x: number, y: number, w: number, h: number, fill = '#FFFFFF', stroke = LINE, r = 10) => doc.roundedRect(x, y, w, h, r).lineWidth(0.8).fillAndStroke(fill, stroke);

    const header = () => {
      card(M, 29, W, 79);
      const lw = 120;
      const s = lw / LOGO_VIEWBOX.width;
      doc.save().translate(M + 20, 29 + (79 - LOGO_VIEWBOX.height * s) / 2).scale(s);
      for (const p of LOGO_PATHS) doc.path(p.d).fill(p.fill, p.evenOdd ? 'even-odd' : 'non-zero');
      doc.restore();
      doc.moveTo(191, 43).lineTo(191, 94).lineWidth(0.8).strokeColor(LINE).stroke();
      put(COMPANY.name, 207, 41, { font: BOLD, size: 13.5 });
      put(`GSTIN: ${COMPANY.gstin}`, 207, 60, { font: BOLD, size: 8.5 });
      COMPANY.address.forEach((l, i) => put(l, 207, 74 + i * 11, { size: 8, color: MUTED }));
    };
    let y = 0;
    const newPage = () => {
      doc.addPage({ size: 'A4', margin: 0 });
      header();
      y = 122;
    };
    const ensure = (h: number) => {
      if (y + h > PAGE_BOTTOM) newPage();
    };

    header();
    // Title bar
    y = 118;
    card(M, y, W, 30, PINK, PINK_LINE, 6);
    put('CUSTOMER ONBOARDING FORM', M + 16, y + 10, { font: BOLD, size: 11, color: RED });
    put(`${f.orderNo}  ·  ${dateText(f.date)}`, M, y + 11, { size: 8.5, color: MUTED, width: W - 16, align: 'right' });
    y += 42;

    /** Section card title with the red marker; returns the y where the content starts. */
    const sectionTitle = (title: string, top: number) => {
      doc.roundedRect(M + 13, top + 11, 4, 15, 2).fill(RED);
      put(title, M + 26, top + 14, { font: BOLD, size: 9.5 });
      doc.moveTo(M + 13, top + 31).lineTo(M + W - 13, top + 31).lineWidth(0.8).strokeColor(LINE).stroke();
      return top + 40;
    };

    /** Label / value grid, two columns (a `full` row spans both). */
    const fields = (title: string, rows: { label: string; value: string; full?: boolean }[]) => {
      const colW = (W - 26 - 16) / 2;
      const rowH = (r: { label: string; value: string; full?: boolean }) => 13 + height(r.value, REG, 8.5, r.full ? W - 26 : colW) + 8;
      const lines: { label: string; value: string; full?: boolean }[][] = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        if (r.full || !rows[i + 1] || rows[i + 1]!.full) lines.push([r]);
        else lines.push([r, rows[++i]!]);
      }
      // A section is always shorter than a page, so it moves to the next page whole instead of splitting.
      const total = 40 + lines.reduce((n, l) => n + Math.max(...l.map(rowH)), 0) + 6;
      ensure(total);
      card(M, y, W, total);
      let ry = sectionTitle(title, y);
      for (const l of lines) {
        const lh = Math.max(...l.map(rowH));
        l.forEach((r, j) => {
          const x = M + 13 + j * (colW + 16);
          put(r.label.toUpperCase(), x, ry, { size: 6.8, color: MUTED });
          put(r.value, x, ry + 11, { size: 8.5, width: r.full ? W - 26 : colW });
        });
        ry += lh;
      }
      y = ry + 14;
    };

    /** People table: Name | Designation | Mobile No | Email ID (optional first "Contact" column). */
    const people = (title: string, rows: { tag?: string; p: OnboardingPerson | null | undefined }[]) => {
      const tagged = rows.some((r) => r.tag);
      const cols = tagged ? [M, M + 80, M + 200, M + 310, M + 400, M + W] : [M, M + 150, M + 280, M + 380, M + W];
      const heads = tagged ? ['CONTACT', 'NAME', 'DESIGNATION', 'MOBILE NO', 'EMAIL ID'] : ['NAME', 'DESIGNATION', 'MOBILE NO', 'EMAIL ID'];
      const cells = (r: (typeof rows)[number]) => [...(tagged ? [r.tag ?? ''] : []), v(r.p?.name), v(r.p?.designation), v(phoneText(r.p?.mobile)), v(r.p?.email)];
      const cw = (j: number) => cols[j + 1]! - cols[j]! - 16;
      const rh = (r: (typeof rows)[number]) => Math.max(24, ...cells(r).map((c, j) => height(c, REG, 8, cw(j)) + 12));
      const list = rows.length ? rows : [{ p: null }];
      ensure(40 + 22 + rh(list[0]!) + 14);
      const top = y;
      const body = list.reduce((n, r) => n + rh(r), 0);
      card(M, top, W, 40 + 22 + body + 8);
      let ry = sectionTitle(title, top);
      doc.rect(M + 1, ry - 2, W - 2, 22).fill(HEAD_BG);
      heads.forEach((h, j) => put(h, cols[j]! + 8, ry + 5, { font: BOLD, size: 7 }));
      ry += 20;
      list.forEach((r, i) => {
        const h = rh(r);
        if (i % 2 === 1) doc.rect(M + 1, ry, W - 2, h).fill(ZEBRA);
        cells(r).forEach((c, j) => put(c, cols[j]! + 8, ry + (h - height(c, REG, 8, cw(j))) / 2, { size: 8, width: cw(j), font: tagged && j === 0 ? BOLD : REG }));
        doc.moveTo(M + 1, ry + h).lineTo(M + W - 1, ry + h).lineWidth(0.5).strokeColor(LINE).stroke();
        ry += h;
      });
      y = ry + 22;
    };

    const ORG: Record<string, string> = { PROPRIETORSHIP: 'Proprietorship', PARTNERSHIP: 'Partnership', PVT_LTD: 'Pvt. Ltd.', LLP: 'LLP', PUBLIC_LTD: 'Public Ltd.', OTHERS: 'Others' };
    fields('1. COMPANY DETAILS', [
      { label: 'Company Name', value: v(f.companyName), full: true },
      { label: 'Type of Organisation', value: v(f.organisationType ? (ORG[f.organisationType] ?? f.organisationType) : null) },
      { label: 'PAN', value: v(f.pan) },
      { label: 'GST No.', value: v(f.gstin) },
      { label: 'MSME Applicable', value: f.msmeApplicable === undefined || f.msmeApplicable === null ? '-' : f.msmeApplicable ? 'Yes' : 'No' },
      { label: 'MSME Number', value: v(f.msmeApplicable ? f.msmeNumber : null) },
      { label: 'Primary Telephone No', value: v(phoneText(f.primaryPhone)) },
      { label: 'Company Mail ID', value: v(f.companyEmail), full: true },
    ]);
    const r = f.registered ?? {};
    fields('2. REGISTERED & BRANCH ADDRESSES', [
      { label: 'Floor No.', value: v(r.floorNo) },
      { label: 'Building No. / Flat No.', value: v(r.buildingNo) },
      { label: 'Name of Premises / Building', value: v(r.premises), full: true },
      { label: 'Road / Street', value: v(r.road), full: true },
      { label: 'Locality / Sub Locality', value: v(r.locality) },
      { label: 'City / Town / Village', value: v(r.city) },
      { label: 'District', value: v(r.district) },
      { label: 'State', value: v(r.state) },
      { label: 'PIN Code', value: v(r.pincode) },
      { label: 'Branch Office Address (if any)', value: v(f.branchAddress), full: true },
    ]);
    people('3. KEY MANAGEMENT DETAILS', f.keyManagement.map((p) => ({ p })));
    people('4. ACCOUNTS TEAM CONTACT DETAILS', [
      { tag: 'Primary', p: f.accounts?.primary },
      { tag: 'Escalation', p: f.accounts?.escalation },
    ]);
    people('5. FINANCE TEAM CONTACT DETAILS', [
      { tag: 'Primary', p: f.finance?.primary },
      { tag: 'Escalation', p: f.finance?.escalation },
    ]);

    // 6. Terms: numbered rows, like the rate card terms.
    const rowW = W - 22;
    const termH = (s: string) => Math.max(18, height(s, REG, 7.5, rowW - 50) + 8);
    const termsH = 44 + ONBOARDING_TERMS.reduce((n, t) => n + termH(t) + 5, 0) + 5;
    ensure(termsH);
    card(M, y, W, termsH);
    put('6. General Terms & Conditions', M + 15, y + 15, { font: BOLD, size: 11 });
    doc.moveTo(M + 14, y + 35).lineTo(M + W - 14, y + 35).lineWidth(0.8).strokeColor(LINE).stroke();
    let ty = y + 44;
    ONBOARDING_TERMS.forEach((t, i) => {
      const h = termH(t);
      doc.roundedRect(M + 11, ty, rowW, h, 4).lineWidth(0.6).fillAndStroke('#F7F7F8', '#ECEDEF');
      doc.roundedRect(M + 19, ty + (h - 11) / 2, 23, 11, 3).fill(PILL);
      put(String(i + 1).padStart(2, '0'), M + 19, ty + (h - 11) / 2 + 2.2, { font: BOLD, size: 6.5, color: '#FFFFFF', width: 23, align: 'center' });
      put(t, M + 52, ty + (h - height(t, REG, 7.5, rowW - 50)) / 2, { size: 7.5, width: rowW - 50 });
      ty += h + 5;
    });

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const last = i === range.start + range.count - 1;
      doc.moveTo(M, 810).lineTo(M + W, 810).lineWidth(0.6).strokeColor(LINE).stroke();
      if (last) {
        put(`Thank You For Choosing ${COMPANY.name}.`, M, 817, { font: BOLD, size: 8 });
        put('This Is A System-Generated Form Filled From The Details Shared By The Client.', M, 829, { size: 7, color: MUTED });
      } else put(COMPANY.website, M, 820, { size: 8, color: MUTED });
      put(`PAGE ${i + 1} OF ${range.count}`, M, last ? 829 : 820, { size: 7.5, color: MUTED, width: W, align: 'right' });
    }
    doc.end();
  });
}
