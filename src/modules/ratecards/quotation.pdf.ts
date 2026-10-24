import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { COMPANY } from '../../config/company';
import { htmlToText } from '../../common/html';
import { LOGO_PATHS, LOGO_VIEWBOX } from './adinn-logo';

export interface QuotationPdfInput {
  quotationRef: string;
  revisionLabel: string;
  quotationDate: Date;
  subject: string;
  clientName: string;
  /** "Bill To" line under the company name (usually the city). */
  clientAddress?: string | null;
  contact?: { name?: string | null; designation?: string | null; phone?: string | null; email?: string | null } | null;
  items: { particulars: string; specifications?: string | null; unit: string; quotedRate: number }[];
  terms?: string | null;
  /** Business Analyst shown under Quote & Contact. */
  regards?: { name?: string | null; designation?: string | null; mobile?: string | null; email?: string | null } | null;
}

const RED = '#E3000F';
const DARK = '#1E2235';
const MUTED = '#5B6475';
const LINE = '#E4E7EC';
const HEAD_BG = '#EEF0F3';
const ZEBRA = '#FAFAFB';
const PINK = '#FDF0F0';
const PINK_LINE = '#F4CFCF';
const PILL = '#1F2433';

const M = 34; // side margin
const PAGE_BOTTOM = 795; // content stops here; the footer sits below
const COLS = [34, 71, 250, 493, 564]; // S.NO | PARTICULARS | SPECIFICATION | RATE
const PAD = 11;

/** DejaVu Sans (assets/fonts) has the rupee sign; without it the standard Helvetica is used and "₹" becomes "Rs.". */
const FONT_DIR = path.resolve(process.cwd(), 'assets/fonts');
const FONTS = { regular: path.join(FONT_DIR, 'DejaVuSans.ttf'), bold: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf') };
const hasFonts = () => fs.existsSync(FONTS.regular) && fs.existsSync(FONTS.bold);

const dateText = (d: Date) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const num = (n: number) => String(Math.round(n * 100) / 100);
const phoneText = (p?: string | null) => (p && /^\d{10}$/.test(p) ? `+91 ${p.slice(0, 5)} ${p.slice(5)}` : (p ?? ''));

/** Rate column text, e.g. "70/ sqft", "120/ Running Feet", "3000/ Unit", "12 Per Km". */
export const rateText = (rate: number, unit: string) =>
  unit === 'KM' ? `${num(rate)} Per Km` : `${num(rate)}/ ${({ SQFT: 'sqft', RFT: 'Running Feet', UNIT: 'Unit' } as Record<string, string>)[unit] ?? unit}`;

/** Terms editor HTML -> one entry per term (list items, else lines), without any typed numbering. */
export function termsList(html?: string | null): string[] {
  const src = String(html ?? '');
  const items = [...src.matchAll(/<li>([\s\S]*?)<\/li>/gi)].map((m) => htmlToText(m[1]!));
  const lines = items.length ? items : htmlToText(src).split(/\n+/);
  return lines.map((t) => t.replace(/\s+/g, ' ').trim().replace(/^(?:\d{1,2}\s*[.)]|\d{2}\s|[-•*])\s*/, '')).filter(Boolean);
}

/**
 * ADINN rate card PDF, laid out like the company's own quotation: header card on every page, Bill To and
 * Quote & Contact cards, subject bar, rate table, Terms & Conditions with numbered rows, and a page footer.
 */
export function renderQuotationPdf(q: QuotationPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `Signage Rate Card ${q.quotationRef} ${q.revisionLabel}`, Author: COMPANY.name } });
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
    const t = (s: string) => (custom ? s : s.replace(/₹\s?/g, 'Rs. '));
    const W = COLS[4]! - M;

    /** Writes text at an exact position without moving onto a new page. */
    const put = (s: string, x: number, y: number, o: { font?: string; size: number; color?: string; width?: number; align?: 'left' | 'right' | 'center'; spacing?: number }) =>
      doc
        .font(o.font ?? REG)
        .fontSize(o.size)
        .fillColor(o.color ?? DARK)
        .text(t(s), x, y, { width: o.width, align: o.align ?? 'left', characterSpacing: o.spacing ?? 0, lineBreak: !!o.width, lineGap: 1.5 });
    const height = (s: string, font: string, size: number, width: number) => doc.font(font).fontSize(size).heightOfString(t(s), { width, lineGap: 1.5 });
    const card = (x: number, y: number, w: number, h: number, fill = '#FFFFFF', stroke = LINE, r = 10) => doc.roundedRect(x, y, w, h, r).lineWidth(0.8).fillAndStroke(fill, stroke);

    // ---- page header (every page) ----
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
    const newPage = () => {
      doc.addPage({ size: 'A4', margin: 0 });
      header();
      return 122;
    };

    header();

    // ---- Bill To / Quote & Contact ----
    const top = 118;
    const leftW = 260;
    const rightX = M + leftW + 12;
    const rightW = COLS[4]! - rightX;
    const titled = (x: number, title: string) => {
      doc.roundedRect(x + 13, top + 11, 4, 15, 2).fill(RED);
      put(title, x + 26, top + 14, { font: BOLD, size: 9.5 });
    };
    const textW = leftW - 26;
    const addr = q.clientAddress?.trim() ?? '';
    const attn = q.contact?.name ? `Kind Attn : ${q.contact.name}` : '';
    let y = top + 40;
    const nameH = height(q.clientName, BOLD, 10.5, textW);
    const addrH = addr ? height(addr, REG, 8.5, textW) : 0;
    const attnH = attn ? height(attn, REG, 8.5, textW) : 0;
    const quoteRows: [string, string][] = [
      ['DATE', dateText(q.quotationDate)],
      ['BUSINESS ANALYST', q.regards?.name ?? ''],
      ['EMAIL ID', q.regards?.email ?? ''],
      ['PHONE NUMBER', phoneText(q.regards?.mobile)],
      ['WEBSITE', COMPANY.website],
    ];
    const cardH = Math.max(132, 40 + nameH + addrH + attnH + 24, 37 + quoteRows.length * 16.5 + 20);
    card(M, top, leftW, cardH);
    card(rightX, top, rightW, cardH);
    titled(M, 'BILL TO');
    doc.moveTo(M + 13, top + 30).lineTo(M + leftW - 13, top + 30).lineWidth(0.8).strokeColor(LINE).stroke();
    put(q.clientName, M + 13, y, { font: BOLD, size: 10.5, width: textW });
    y += nameH + 4;
    if (addr) {
      put(addr, M + 13, y, { size: 8.5, color: MUTED, width: textW });
      y += addrH + 4;
    }
    if (attn) put(attn, M + 13, y, { size: 8.5, color: MUTED, width: textW });
    titled(rightX, 'QUOTE & CONTACT');
    quoteRows.forEach(([k, v], i) => {
      const ry = top + 37 + i * 16.5;
      put(k, rightX + 17, ry, { size: 7.5, color: MUTED });
      put(':', rightX + 94, ry, { size: 8, color: MUTED });
      put(v, rightX + 103, ry, { size: 8, width: rightW - 110 });
    });

    // ---- subject bar ----
    const sy = top + cardH + 8;
    card(M, sy, W, 26, PINK, PINK_LINE, 6);
    put('SUBJECT', 56, sy + 8.5, { font: BOLD, size: 9, color: RED });
    doc.moveTo(124, sy + 5).lineTo(124, sy + 21).lineWidth(1.2).strokeColor(RED).stroke();
    put(q.subject, 137, sy + 8, { font: BOLD, size: 9.5, width: M + W - 137 - 12 });

    // ---- rate table ----
    const BODY = 8;
    // The rate column keeps a smaller right padding so "120/ Running Feet" wraps to two lines, as on the company sheet.
    const colW = (j: number) => COLS[j + 1]! - COLS[j]! - PAD * 2 + (j === 3 ? 7 : 0);
    const tableHead = (hy: number) => {
      doc.rect(M, hy, W, 23).fill(HEAD_BG);
      ['S.NO', 'PARTICULARS', 'SPECIFICATION', 'RATE / SQFT'].forEach((h, j) => put(h, COLS[j]! + PAD, hy + 8, { font: BOLD, size: 7.5 }));
      return hy + 23;
    };
    y = tableHead(sy + 26 + 8);
    q.items.forEach((it, i) => {
      const cells = [String(i + 1), it.particulars, it.specifications?.trim() || '-', rateText(it.quotedRate, it.unit)];
      const h = Math.max(30, ...cells.map((c, j) => height(c, REG, BODY, colW(j)) + 16));
      if (y + h > PAGE_BOTTOM) y = tableHead(newPage());
      if (i % 2 === 1) doc.rect(M, y, W, h).fill(ZEBRA);
      cells.forEach((c, j) => put(c, COLS[j]! + PAD, y + (h - height(c, REG, BODY, colW(j))) / 2, { size: BODY, width: colW(j) }));
      for (const x of COLS.slice(1, 4)) doc.moveTo(x, y).lineTo(x, y + h).lineWidth(0.6).strokeColor(LINE).stroke();
      doc.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.6).strokeColor(LINE).stroke();
      y += h;
    });

    // ---- terms & conditions (numbered rows; continues on the next page when long) ----
    const terms = termsList(q.terms);
    const rowX = M + 11;
    const rowW = W - 22;
    const textX = rowX + 41;
    const rowH = (s: string) => Math.max(18, height(s, REG, 7.5, rowW - 50) + 8);
    let k = 0;
    y += 19;
    while (k < terms.length) {
      if (y + 44 + rowH(terms[k]!) + 10 > PAGE_BOTTOM) y = newPage() + 4;
      let fit = k;
      let h = 44;
      while (fit < terms.length && y + h + rowH(terms[fit]!) + 10 <= PAGE_BOTTOM) h += rowH(terms[fit++]!) + 5;
      card(M, y, W, h + 5);
      put(k === 0 ? 'Terms & Conditions' : 'Terms & Conditions (continued)', M + 15, y + 15, { font: BOLD, size: 11 });
      const bw = 104;
      card(M + W - 14 - bw, y + 9, bw, 20, PINK, PINK_LINE, 10);
      put('Subject To Availability', M + W - 14 - bw, y + 15, { font: BOLD, size: 7.5, color: RED, width: bw, align: 'center' });
      doc.moveTo(M + 14, y + 35).lineTo(M + W - 14, y + 35).lineWidth(0.8).strokeColor(LINE).stroke();
      let ry = y + 44;
      for (; k < fit; k++) {
        const rh = rowH(terms[k]!);
        doc.roundedRect(rowX, ry, rowW, rh, 4).lineWidth(0.6).fillAndStroke('#F7F7F8', '#ECEDEF');
        doc.roundedRect(rowX + 8, ry + (rh - 11) / 2, 23, 11, 3).fill(PILL);
        put(String(k + 1).padStart(2, '0'), rowX + 8, ry + (rh - 11) / 2 + 2.2, { font: BOLD, size: 6.5, color: '#FFFFFF', width: 23, align: 'center' });
        put(terms[k]!, textX, ry + (rh - height(terms[k]!, REG, 7.5, rowW - 50)) / 2, { size: 7.5, width: rowW - 50 });
        ry += rh + 5;
      }
      y = ry + 10;
    }

    // ---- footer on every page ----
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const last = i === range.start + range.count - 1;
      doc.moveTo(M, 810).lineTo(M + W, 810).lineWidth(0.6).strokeColor(LINE).stroke();
      if (last) {
        put(`Thank You For Choosing ${COMPANY.name}.`, M, 817, { font: BOLD, size: 8 });
        put('This Is A System-Generated Quotation And Does Not Require A Digital Signature.', M, 829, { size: 7, color: MUTED });
      } else {
        put(COMPANY.website, M, 820, { size: 8, color: MUTED });
      }
      put(`PAGE ${i + 1} OF ${range.count}`, M, last ? 829 : 820, { size: 7.5, color: MUTED, width: W, align: 'right', spacing: 1.5 });
    }
    doc.end();
  });
}
