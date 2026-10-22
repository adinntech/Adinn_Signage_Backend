import PDFDocument from 'pdfkit';
import { htmlToText } from '../../common/html';
import { RATE_UNIT_LABELS } from './ratecard.model';

export interface QuotationPdfInput {
  quotationRef: string;
  revisionLabel: string;
  quotationDate: Date;
  subject: string;
  clientName: string;
  clientAddress?: string | null;
  contact?: { name?: string | null; designation?: string | null; phone?: string | null; email?: string | null } | null;
  items: { particulars: string; specifications?: string | null; unit: string; quotedRate: number }[];
  terms?: string | null;
  regards?: { name?: string | null; designation?: string | null; mobile?: string | null; email?: string | null } | null;
}

const RED = '#E5322D';
const NAVY = '#102449';
const MUTED = '#5B6B86';
const LINE = '#E1E7F0';
const M = 48; // page margin

const date = (d: Date) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const money = (n: number) => `Rs. ${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/**
 * Quotation PDF with the same structure as the on-screen preview: branded header, client details, rate table,
 * terms & conditions and best-regards block. Standard fonts only (no font files on the server).
 */
export function renderQuotationPdf(q: QuotationPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: `Signage Rate Card ${q.quotationRef}`, Author: 'ADINN Signage' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - M * 2;
    const bottom = () => doc.page.height - M - 30;
    const ensure = (h: number) => {
      if (doc.y + h > bottom()) doc.addPage();
    };

    // Header band
    doc.rect(0, 0, doc.page.width, 6).fill(RED);
    doc.font('Helvetica-Bold').fontSize(26).fillColor(RED).text('ADINN', M, 30);
    doc.font('Helvetica').fontSize(8).fillColor(NAVY).text('S I G N A G E', M + 2, 60);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`Quotation Ref: ${q.quotationRef}`, M, 34, { width: W, align: 'right' });
    doc.text(`Date: ${date(q.quotationDate)}`, M, 47, { width: W, align: 'right' });
    doc.text(`Revision: ${q.revisionLabel}`, M, 60, { width: W, align: 'right' });

    doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY).text('Signage Rate Card', M, 96);
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text('Quotation for Branding Solutions');
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text('Subject: ', { continued: true }).font('Helvetica').text(q.subject);
    doc.moveDown(0.8);

    // Client details
    const rows: [string, string][] = [
      ['Client Name', q.clientName],
      ['Address', q.clientAddress ?? '-'],
      ['Contact Person', [q.contact?.name, q.contact?.designation].filter(Boolean).join(', ') || '-'],
      ['Contact Number', q.contact?.phone ?? '-'],
      ['Email', q.contact?.email ?? '-'],
    ];
    doc.font('Helvetica-Bold').fontSize(11).fillColor(RED).text('Client Details');
    doc.moveDown(0.3);
    for (const [k, v] of rows) {
      const y = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(k, M, y, { width: 110 });
      doc.font('Helvetica').fontSize(9).fillColor(NAVY).text(`: ${v}`, M + 110, y, { width: W - 110 });
      doc.moveDown(0.2);
    }
    doc.moveDown(0.8);

    // Rate table
    const cols = [
      { h: '#', w: 26, align: 'left' as const },
      { h: 'Signage Particulars', w: 140, align: 'left' as const },
      { h: 'Specifications', w: W - 26 - 140 - 80 - 90, align: 'left' as const },
      { h: 'Rate Unit', w: 80, align: 'left' as const },
      { h: 'Rate (INR)', w: 90, align: 'right' as const },
    ];
    const drawHead = () => {
      const y = doc.y;
      doc.rect(M, y, W, 22).fill(NAVY);
      let x = M;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF');
      for (const c of cols) {
        doc.text(c.h, x + 6, y + 7, { width: c.w - 12, align: c.align });
        x += c.w;
      }
      doc.y = y + 22;
    };
    ensure(60);
    drawHead();
    q.items.forEach((it, i) => {
      const cells = [String(i + 1), it.particulars, it.specifications ?? '-', RATE_UNIT_LABELS[it.unit as keyof typeof RATE_UNIT_LABELS] ?? it.unit, money(it.quotedRate)];
      doc.font('Helvetica').fontSize(9);
      const h = Math.max(...cells.map((c, j) => doc.heightOfString(c, { width: cols[j]!.w - 12 }))) + 12;
      if (doc.y + h > bottom()) {
        doc.addPage();
        drawHead();
      }
      const y = doc.y;
      if (i % 2 === 1) doc.rect(M, y, W, h).fill('#F6F8FB');
      let x = M;
      cells.forEach((c, j) => {
        doc.font(j === 1 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(NAVY).text(c, x + 6, y + 6, { width: cols[j]!.w - 12, align: cols[j]!.align });
        x += cols[j]!.w;
      });
      doc.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.y = y + h;
    });
    doc.x = M;
    doc.moveDown(1.2);

    // Terms
    const terms = htmlToText(q.terms ?? '');
    if (terms) {
      ensure(60);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(RED).text('Terms & Conditions', M);
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(9).fillColor(NAVY).text(terms, M, doc.y, { width: W, lineGap: 2 });
      doc.moveDown(1.2);
    }

    // Best regards
    ensure(70);
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text('Best Regards,', M);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text(q.regards?.name ?? '');
    doc.font('Helvetica').fontSize(9).fillColor(NAVY).text(q.regards?.designation ?? '');
    doc.text([q.regards?.mobile && `+91 ${q.regards.mobile}`, q.regards?.email].filter(Boolean).join('  |  '));

    // Footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // writing inside the bottom margin must not start a new page
      const y = doc.page.height - M + 4;
      doc.moveTo(M, y - 8).lineTo(M + W, y - 8).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(RED).text('Partnering for a Brighter Tomorrow', M, y, { width: W / 2, lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`Page ${i + 1} of ${range.count}`, M + W / 2, y, { width: W / 2, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
