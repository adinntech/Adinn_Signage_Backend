import ExcelJS from 'exceljs';
import { z } from 'zod';

/** One export column: heading, how to read the cell from a row, and the Excel column width. */
export interface ExportColumn<T> {
  header: string;
  value: (row: T) => string | number | Date | null | undefined;
  width?: number;
}

export const EXPORT_FORMATS = ['xlsx', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const exportFormat = z.enum(EXPORT_FORMATS).default('xlsx');

/** Typed text must never become a spreadsheet formula. */
const safe = (v: unknown) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const cell = (v: string | number | Date | null | undefined) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ?? '');

/** The same rows as an Excel sheet or a CSV file (UTF-8 with a BOM so Excel shows Tamil and other scripts correctly). */
export async function tabularFile<T>(format: ExportFormat, sheet: string, columns: ExportColumn<T>[], rows: T[]) {
  if (format === 'csv') {
    const esc = (v: unknown) => {
      const t = String(safe(v) ?? '');
      return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [columns.map((c) => esc(c.header)).join(','), ...rows.map((r) => columns.map((c) => esc(cell(c.value(r)))).join(','))];
    return { buffer: Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8'), contentType: 'text/csv; charset=utf-8', ext: 'csv' as const };
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.columns = columns.map((c, i) => ({ header: c.header, key: `c${i}`, width: c.width ?? 18 }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) ws.addRow(Object.fromEntries(columns.map((c, i) => [`c${i}`, safe(cell(c.value(r)))])));
  return {
    buffer: Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx' as const,
  };
}
