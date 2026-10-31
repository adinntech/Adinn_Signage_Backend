import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const FONT_DIR = path.resolve(process.cwd(), 'assets/fonts');
const FONTS = { regular: path.join(FONT_DIR, 'DejaVuSans.ttf'), bold: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf') };
const NAVY = '#102449';
const LINE = '#D5DCE8';
const MUTED = '#5B6B82';
const HEAD_FILL = '#EEF2F8';
const MARGIN = 28;
const PAD = 3;
const THUMB = 40;

export interface ShopListPdfInput {
  title: string;
  subtitle: string;
  headers: string[];
  rows: string[][];
  /** Shop + Measurement: each row's images (JPEG / PNG bytes, a few per row) and its total image count. */
  images?: { files: Buffer[]; count: number }[];
}

/**
 * The shop table as a PDF: every column and row as saved, the header repeated on every page, rows never split across
 * pages, page numbers in the footer. Wide tables go on A3 landscape with a smaller font. Shop + Measurement adds an
 * Images column with thumbnails.
 */
export function renderShopListPdf(t: ShopListPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const withImages = !!t.images;
    const cols = t.headers.length + (withImages ? 1 : 0);
    const size = cols > 10 ? 'A3' : 'A4';
    const doc = new PDFDocument({ size, layout: 'landscape', margin: MARGIN, bufferPages: true, info: { Title: t.title } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const custom = fs.existsSync(FONTS.regular) && fs.existsSync(FONTS.bold);
    if (custom) {
      doc.registerFont('Body', FONTS.regular);
      doc.registerFont('Bold', FONTS.bold);
    }
    const REG = custom ? 'Body' : 'Helvetica';
    const BOLD = custom ? 'Bold' : 'Helvetica-Bold';
    const fontSize = cols > 24 ? 5.5 : cols > 16 ? 6.5 : 7.5;
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const bottom = pageH - MARGIN - 14;
    const usable = pageW - MARGIN * 2;

    // Column widths from the longest value (sampled), so short codes stay narrow and addresses get room.
    const imgW = withImages ? THUMB * 2 + PAD * 3 : 0;
    const textW = usable - imgW;
    const sample = t.rows.slice(0, 500);
    const want = t.headers.map((h, i) => Math.min(60, Math.max(4, h.length, ...sample.map((r) => (r[i] ?? '').length))));
    const sum = want.reduce((a, b) => a + b, 0) || 1;
    const widths = want.map((w) => Math.max(30, (w / sum) * textW));
    const scale = textW / widths.reduce((a, b) => a + b, 0);
    for (let i = 0; i < widths.length; i++) widths[i] = widths[i]! * scale;
    if (withImages) widths.push(imgW);
    const heads = withImages ? [...t.headers, 'Images'] : t.headers;

    const cellH = (s: string, w: number, font: string) => doc.font(font).fontSize(fontSize).heightOfString(s || ' ', { width: w - PAD * 2, lineGap: 0.5 });
    const headH = Math.max(...heads.map((h, i) => cellH(h, widths[i]!, BOLD))) + PAD * 2;

    let y = MARGIN;
    const title = () => {
      doc.font(BOLD).fontSize(12).fillColor(NAVY).text(t.title, MARGIN, MARGIN, { width: usable });
      doc.font(REG).fontSize(8).fillColor(MUTED).text(t.subtitle, MARGIN, MARGIN + 16, { width: usable });
      y = MARGIN + 32;
    };
    const header = () => {
      let x = MARGIN;
      doc.rect(MARGIN, y, usable, headH).fillAndStroke(HEAD_FILL, LINE);
      heads.forEach((h, i) => {
        doc.font(BOLD).fontSize(fontSize).fillColor(NAVY).text(h, x + PAD, y + PAD, { width: widths[i]! - PAD * 2, lineGap: 0.5 });
        x += widths[i]!;
      });
      y += headH;
    };

    title();
    header();
    t.rows.forEach((r, ri) => {
      const img = t.images?.[ri];
      const textH = Math.max(...t.headers.map((_, i) => cellH(r[i] ?? '', widths[i]!, REG)));
      const imgRows = img?.files.length ? Math.ceil(img.files.length / 2) : 0;
      const h = Math.min(bottom - MARGIN - headH, Math.max(textH, imgRows * (THUMB + PAD) + (img && img.count > img.files.length ? 10 : 0)) + PAD * 2);
      if (y + h > bottom) {
        doc.addPage({ size, layout: 'landscape', margin: MARGIN });
        y = MARGIN;
        header();
      }
      let x = MARGIN;
      if (ri % 2) doc.rect(MARGIN, y, usable, h).fill('#FAFBFD');
      t.headers.forEach((_, i) => {
        doc.font(REG).fontSize(fontSize).fillColor('#1F2937').text(r[i] ?? '', x + PAD, y + PAD, { width: widths[i]! - PAD * 2, height: h - PAD * 2, lineGap: 0.5, ellipsis: true });
        x += widths[i]!;
      });
      if (img) {
        img.files.forEach((b, k) => {
          try {
            doc.image(b, x + PAD + (k % 2) * (THUMB + PAD), y + PAD + Math.floor(k / 2) * (THUMB + PAD), { fit: [THUMB, THUMB] });
          } catch {
            // An image pdfkit cannot read is left out; the count below still shows it.
          }
        });
        if (img.count > img.files.length || !img.files.length)
          doc.font(REG).fontSize(fontSize).fillColor(MUTED).text(img.count ? `${img.count} image${img.count === 1 ? '' : 's'}` : '-', x + PAD, y + PAD + imgRows * (THUMB + PAD), { width: imgW - PAD * 2 });
      }
      // Cell borders.
      doc.lineWidth(0.4).strokeColor(LINE);
      doc.rect(MARGIN, y, usable, h).stroke();
      let bx = MARGIN;
      for (const w of widths.slice(0, -1)) {
        bx += w;
        doc.moveTo(bx, y).lineTo(bx, y + h).stroke();
      }
      y += h;
    });
    if (!t.rows.length) doc.font(REG).fontSize(9).fillColor(MUTED).text('No shops in the table.', MARGIN, y + 8);

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      // The footer sits in the bottom margin; without this pdfkit would start a new page for it.
      doc.page.margins.bottom = 0;
      doc.font(REG).fontSize(7).fillColor(MUTED).text(`${t.title} · Page ${i + 1} of ${range.count}`, MARGIN, pageH - MARGIN, { width: usable, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
