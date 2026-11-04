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
  /** Kept on each version (older PDFs printed it); no longer printed. */
  subject?: string | null;
  clientName: string;
  /** "Bill To" line under the company name (usually the city). */
  clientAddress?: string | null;
  contact?: { name?: string | null; designation?: string | null; phone?: string | null; email?: string | null } | null;
  items: { particulars: string; specifications?: string | null; unit: string; quotedRate: number }[];
  terms?: string | null;
  /** Client Service person shown under Quote & Contact. */
  regards?: { name?: string | null; designation?: string | null; mobile?: string | null; email?: string | null } | null;
}

// Colours of the company quotation design (same values as the web preview, quotation-preview.tsx).
const INK = '#0F172A';
const SLATE = '#334155';
/** Dark text of the Bill To address, Quote & Contact labels and the specification column (easy to read when zoomed). */
const TEXT = '#1E293B';
const LABEL = '#475569';
const MUTED = '#64748B';
const LINE = '#E5E7EB';
const RED = '#C62828';
const HEAD_BG = '#F3F4F6';
const ZEBRA = '#FAFAF9';
const ROW_LINE = '#ECECEC';
const PAGE_NO = '#94A3B8';

const M = 34; // side margin
const PAGE_BOTTOM = 784; // content stops here; the footer sits below
const COLS = [34, 71, 250, 493, 564]; // S.NO | PARTICULARS | SPECIFICATION | RATE
const PAD = 11;
const R = 12; // card corner radius

/**
 * Manrope (assets/fonts, SIL Open Font License) is the font of the company quotation and has the rupee sign.
 * Without it DejaVu Sans is used, and without that the standard Helvetica ("₹" becomes "Rs.").
 */
const FONT_DIR = path.resolve(process.cwd(), 'assets/fonts');
const font = (f: string) => path.join(FONT_DIR, f);
const MANROPE = { regular: font('Manrope-Regular.ttf'), medium: font('Manrope-Medium.ttf'), semi: font('Manrope-SemiBold.ttf'), bold: font('Manrope-Bold.ttf') };
const DEJAVU = { regular: font('DejaVuSans.ttf'), bold: font('DejaVuSans-Bold.ttf') };
const allExist = (files: Record<string, string>) => Object.values(files).every((f) => fs.existsSync(f));

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
 * Quote & Contact cards (red headings), rate table card, Terms & Conditions with numbered rows, and a page footer.
 */
export function renderQuotationPdf(q: QuotationPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `Signage Rate Card ${q.quotationRef} ${q.revisionLabel}`, Author: COMPANY.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const manrope = allExist(MANROPE);
    const dejavu = !manrope && allExist(DEJAVU);
    if (manrope) {
      doc.registerFont('Body', MANROPE.regular);
      doc.registerFont('Medium', MANROPE.medium);
      doc.registerFont('Semi', MANROPE.semi);
      doc.registerFont('Bold', MANROPE.bold);
    } else if (dejavu) {
      doc.registerFont('Body', DEJAVU.regular);
      doc.registerFont('Bold', DEJAVU.bold);
    }
    const custom = manrope || dejavu;
    const REG = custom ? 'Body' : 'Helvetica';
    const MED = manrope ? 'Medium' : REG;
    const BOLD = custom ? 'Bold' : 'Helvetica-Bold';
    const SEMI = manrope ? 'Semi' : BOLD;
    const t = (s: string) => (custom ? s : s.replace(/₹\s?/g, 'Rs. '));
    const W = COLS[4]! - M;

    /** Writes text at an exact position without moving onto a new page. */
    const put = (s: string, x: number, y: number, o: { font?: string; size: number; color?: string; width?: number; align?: 'left' | 'right' | 'center'; spacing?: number; lineGap?: number }) =>
      doc
        .font(o.font ?? REG)
        .fontSize(o.size)
        .fillColor(o.color ?? INK)
        .text(t(s), x, y, { width: o.width, align: o.align ?? 'left', characterSpacing: o.spacing ?? 0, lineBreak: !!o.width, lineGap: o.lineGap ?? 1.5 });
    const height = (s: string, f: string, size: number, width: number, lineGap = 1.5) => doc.font(f).fontSize(size).heightOfString(t(s), { width, lineGap });
    const card = (x: number, y: number, w: number, h: number, fill = '#FFFFFF', stroke = LINE, r = R) => doc.roundedRect(x, y, w, h, r).lineWidth(0.8).fillAndStroke(fill, stroke);
    const hline = (x1: number, x2: number, y: number, color = LINE, w = 0.6) => doc.moveTo(x1, y).lineTo(x2, y).lineWidth(w).strokeColor(color).stroke();
    /** Small red tracked heading of the Bill To / Quote & Contact cards. */
    const heading = (s: string, x: number, y: number) => put(s, x, y, { font: BOLD, size: 7, color: RED, spacing: 1.3 });

    // ---- page header (every page) ----
    const header = () => {
      card(M, 29, W, 79);
      const lw = 107;
      const s = lw / LOGO_VIEWBOX.width;
      doc.save().translate(M + 18, 29 + (79 - LOGO_VIEWBOX.height * s) / 2).scale(s);
      for (const p of LOGO_PATHS) doc.path(p.d).fill(p.fill, p.evenOdd ? 'even-odd' : 'non-zero');
      doc.restore();
      doc.moveTo(175, 42).lineTo(175, 95).lineWidth(0.8).strokeColor(LINE).stroke();
      put(COMPANY.name, 196, 38, { font: BOLD, size: 13.25 });
      put(`GSTIN: ${COMPANY.gstin}`, 196, 56.5, { font: BOLD, size: 9 });
      COMPANY.address.forEach((l, i) => put(l, 196, 70 + i * 12.5, { font: SEMI, size: 9.25, color: SLATE }));
    };
    const newPage = () => {
      doc.addPage({ size: 'A4', margin: 0 });
      header();
      return 122;
    };

    header();

    // ---- Bill To / Quote & Contact ----
    const top = 120;
    const gap = 13;
    const leftW = (W - gap) / 2;
    const rightX = M + leftW + gap;
    const rightW = W - leftW - gap;
    const textW = leftW - 30;
    const addr = q.clientAddress?.trim() ?? '';
    const attn = q.contact?.name ? `Kind Attn : ${q.contact.name}` : '';
    const nameH = height(q.clientName, BOLD, 11, textW);
    const addrH = addr ? height(addr, SEMI, 9, textW) : 0;
    const attnH = attn ? height(attn, SEMI, 9, textW) : 0;
    const quoteRows: [string, string][] = [
      ['DATE', dateText(q.quotationDate)],
      ['CLIENT SERVICE', q.regards?.name ?? ''],
      ['EMAIL ID', q.regards?.email ?? ''],
      ['PHONE NUMBER', phoneText(q.regards?.mobile)],
      ['WEBSITE', COMPANY.website],
    ];
    const ROW = 18.8;
    const cardH = Math.max(141, 23.5 + nameH + (addr ? 3 + addrH : 0) + (attn ? 3 + attnH : 0) + 12, 34 + (quoteRows.length - 1) * ROW + 32);
    card(M, top, leftW, cardH);
    card(rightX, top, rightW, cardH);
    heading('BILL TO', M + 15, top + 10.5);
    let y = top + 23.5;
    put(q.clientName, M + 15, y, { font: BOLD, size: 11, width: textW });
    y += nameH + 3;
    if (addr) {
      put(addr, M + 15, y, { font: SEMI, size: 9, color: TEXT, width: textW });
      y += addrH + 3;
    }
    if (attn) put(attn, M + 15, y, { font: SEMI, size: 9, color: TEXT, width: textW });
    heading('QUOTE & CONTACT', rightX + 15, top + 10.5);
    // Label left, value right, a thin line between rows.
    const valueX = rightX + 15 + 80;
    const valueW = rightW - 30 - 80;
    quoteRows.forEach(([k, v], i) => {
      const c = top + 34 + i * ROW;
      put(k, rightX + 15, c - 4.8, { font: BOLD, size: 7, color: TEXT, spacing: 1 });
      put(v || '-', valueX, c - 6, { font: BOLD, size: 8.75, width: valueW, align: 'right' });
      if (i < quoteRows.length - 1) hline(rightX + 15, rightX + rightW - 15, c + ROW / 2);
    });

    // ---- rate table (a rounded card on each page it runs over) ----
    // Cells: S.NO, PARTICULARS (bold), SPECIFICATION (slate), RATE; text from the top with 11pt padding.
    const CELL = [
      { font: SEMI, size: 8.5, color: INK },
      { font: BOLD, size: 9, color: INK },
      { font: MED, size: 8.25, color: TEXT },
      { font: SEMI, size: 8.5, color: INK },
    ];
    const HEAD_H = 26;
    // The rate column keeps a smaller right padding so "120/ Running Feet" wraps to two lines, as on the company sheet.
    const colW = (j: number) => COLS[j + 1]! - COLS[j]! - PAD * 2 + (j === 3 ? 7 : 0);
    const rows = q.items.map((it, i) => {
      const cells = [String(i + 1), it.particulars, it.specifications?.trim() || '-', rateText(it.quotedRate, it.unit)];
      return { cells, h: Math.max(32, ...cells.map((c, j) => height(c, CELL[j]!.font, CELL[j]!.size, colW(j), 2) + 22)) };
    });
    const drawTable = (ty: number, from: number, to: number) => {
      const segH = HEAD_H + rows.slice(from, to).reduce((s, r) => s + r.h, 0);
      doc.save();
      doc.roundedRect(M, ty, W, segH, R).clip();
      doc.rect(M, ty, W, HEAD_H).fill(HEAD_BG);
      ['S.NO', 'PARTICULARS', 'SPECIFICATION', 'RATE / SQFT'].forEach((h, j) => put(h, COLS[j]! + PAD, ty + 8.2, { font: BOLD, size: 7, color: LABEL, spacing: 0.8 }));
      let ry = ty + HEAD_H;
      hline(M, M + W, ry);
      for (let i = from; i < to; i++) {
        const r = rows[i]!;
        if (i % 2 === 1) doc.rect(M, ry, W, r.h).fill(ZEBRA);
        r.cells.forEach((c, j) => put(c, COLS[j]! + PAD, ry + PAD, { ...CELL[j]!, width: colW(j), lineGap: 2 }));
        if (i < to - 1) hline(M, M + W, ry + r.h);
        ry += r.h;
      }
      doc.restore();
      doc.roundedRect(M, ty, W, segH, R).lineWidth(0.8).strokeColor(LINE).stroke();
      return ty + segH;
    };
    // No subject strip: the rate table follows the Bill To / Quote & Contact cards.
    let ty = top + cardH + 12;
    let from = 0;
    let body = ty + HEAD_H;
    if (!rows.length) {
      y = drawTable(ty, 0, 0);
    } else {
      for (let i = 0; i < rows.length; i++) {
        if (body + rows[i]!.h > PAGE_BOTTOM && i > from) {
          drawTable(ty, from, i);
          ty = newPage();
          from = i;
          body = ty + HEAD_H;
        }
        body += rows[i]!.h;
      }
      y = drawTable(ty, from, rows.length);
    }

    // ---- terms & conditions (numbered rows; continues on the next page when long) ----
    // Spacing (same numbers as the web preview, quotation-preview.tsx): 50pt heading strip, rows from 14pt below it,
    // 18pt square number badge, 9pt above / below the text in a row, 3pt between wrapped lines, 8pt between rows.
    const terms = termsList(q.terms);
    const rowX = M + 18;
    const rowW = W - 36;
    const textX = rowX + 38; // badge at rowX + 10, 18 wide
    const termW = rowW - 50;
    const TERM_GAP = 3;
    const STRIP = 50;
    const FIRST = STRIP + 14;
    const termH = (s: string) => height(s, REG, 8, termW, TERM_GAP);
    const rowH = (s: string) => Math.max(32, termH(s) + 18);
    let k = 0;
    y += 14;
    while (k < terms.length) {
      if (y + FIRST + rowH(terms[k]!) + 17 > PAGE_BOTTOM) y = newPage() + 4;
      let fit = k;
      let h = FIRST;
      while (fit < terms.length && y + h + rowH(terms[fit]!) + 17 <= PAGE_BOTTOM) h += rowH(terms[fit++]!) + 8;
      if (fit === k) h += rowH(terms[fit++]!) + 8; // a single very long term still goes somewhere
      const ch = h + 9;
      card(M, y, W, ch);
      doc.save();
      doc.roundedRect(M, y, W, ch, R).clip();
      doc.rect(M, y, W, STRIP).fill('#F8F9FA');
      doc.restore();
      doc.roundedRect(M, y, W, ch, R).lineWidth(0.8).strokeColor(LINE).stroke();
      hline(M, M + W, y + STRIP, LINE, 0.8);
      put(k === 0 ? 'Terms & Conditions' : 'Terms & Conditions (continued)', M + 18, y + 17.3, { font: SEMI, size: 11.25 });
      // "Subject To Availability" pill on the right of the heading strip.
      const pill = 'Subject To Availability';
      const pw = doc.font(SEMI).fontSize(7.5).widthOfString(pill) + 20;
      doc.roundedRect(M + W - 18 - pw, y + 15.5, pw, 19, 9.5).lineWidth(0.8).fillAndStroke('#FEF2F2', '#FECACA');
      put(pill, M + W - 18 - pw, y + 20, { font: SEMI, size: 7.5, color: '#B91C1C', width: pw, align: 'center' });
      let ry = y + FIRST;
      for (; k < fit; k++) {
        const rh = rowH(terms[k]!);
        doc.roundedRect(rowX, ry, rowW, rh, 6).lineWidth(0.6).fillAndStroke(ZEBRA, ROW_LINE);
        doc.roundedRect(rowX + 10, ry + (rh - 18) / 2, 18, 18, 4).fill(INK);
        put(String(k + 1).padStart(2, '0'), rowX + 10, ry + (rh - 18) / 2 + 4.6, { font: BOLD, size: 7, color: '#FFFFFF', width: 18, align: 'center' });
        put(terms[k]!, textX, ry + (rh - termH(terms[k]!)) / 2 + TERM_GAP / 2, { size: 8, width: termW, lineGap: TERM_GAP });
        ry += rh + 8;
      }
      y = y + ch + 14;
    }

    // ---- footer: thank-you note on the last page, page number centred on every page ----
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      if (i === range.start + range.count - 1) {
        hline(M, M + W, 792);
        put(`Thank You For Choosing ${COMPANY.name}.`, M, 798, { font: BOLD, size: 8.25 });
        put('This Is A System-Generated Quotation And Does Not Require A Digital Signature.', M, 810.5, { size: 7.5, color: MUTED });
      }
      put(`PAGE ${i + 1} OF ${range.count}`, M, 826, { font: SEMI, size: 7.5, color: PAGE_NO, width: W, align: 'center', spacing: 1 });
    }
    doc.end();
  });
}
