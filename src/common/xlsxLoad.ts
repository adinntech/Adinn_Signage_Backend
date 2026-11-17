import ExcelJS from 'exceljs';
import JSZip from 'jszip';

/**
 * Loads an .xlsx into an ExcelJS workbook.
 *
 * Some tools (openpyxl and similar) write absolute part paths in the sheet relationships, for example
 * Target="/xl/tables/table1.xml". Excel opens these files, but ExcelJS resolves every target relative to the sheet and then
 * fails with "Cannot read properties of undefined (reading 'name')". When the first load fails, the targets are rewritten to
 * relative paths ("../tables/table1.xml") and the load is tried once more. Files that load the first time are not touched.
 */
export async function loadXlsx(wb: ExcelJS.Workbook, buffer: Buffer): Promise<void> {
  try {
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    return;
  } catch (first) {
    const fixed = await relativeSheetTargets(buffer).catch(() => null);
    if (!fixed) throw first;
    await wb.xlsx.load(fixed as unknown as ExcelJS.Buffer);
  }
}

/** The same file with absolute "/xl/..." targets in the worksheet relationship files made relative; null when nothing needed changing. */
async function relativeSheetTargets(buffer: Buffer): Promise<Buffer | null> {
  const zip = await JSZip.loadAsync(buffer);
  let changed = false;
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/_rels\/[^/]+\.rels$/i.test(name)) continue;
    const xml = await zip.file(name)!.async('string');
    const next = xml.replace(/Target="\/xl\//g, 'Target="../');
    if (next !== xml) {
      zip.file(name, next);
      changed = true;
    }
  }
  return changed ? zip.generateAsync({ type: 'nodebuffer' }) : null;
}
