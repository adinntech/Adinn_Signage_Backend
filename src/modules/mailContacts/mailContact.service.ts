import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import { escapeRegex, pageMeta, type Actor } from '../../common/query';
import { tabularFile } from '../../common/tabular';
import { recordAudit } from '../audit/audit.service';
import { MailContact } from './mailContact.model';
import type { bulkBody, contactBody, contactListQuery, contactPatch, suggestQuery } from './mailContact.validators';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_IMPORT_ROWS = 2000;
const view = (c: { _id: unknown; email: string; name?: string | null; group?: string | null; active?: boolean | null }) => ({ id: String(c._id), email: c.email, name: c.name ?? null, group: c.group ?? null, active: c.active !== false });

/** Suggestions while typing: addresses or names that start with (or have a word starting with) what was typed. */
export async function suggest(q: z.infer<typeof suggestQuery>) {
  const filter: Record<string, unknown> = { active: true };
  if (q.q) {
    const re = new RegExp(`(^|[\\s._-])${escapeRegex(q.q)}`, 'i');
    filter.$or = [{ email: re }, { name: re }];
  }
  const rows = await MailContact.find(filter).select('email name group').sort({ email: 1 }).limit(q.limit).lean();
  return rows.map(view);
}

type Filter = { q?: string; status?: 'active' | 'inactive'; group?: string };
function filterOf(f: Filter) {
  const and: Record<string, unknown>[] = [];
  if (f.q) {
    const re = new RegExp(escapeRegex(f.q), 'i');
    and.push({ $or: [{ email: re }, { name: re }, { group: re }] });
  }
  if (f.status) and.push(f.status === 'active' ? { active: { $ne: false } } : { active: false });
  if (f.group) and.push(f.group.toLowerCase() === 'none' ? { $or: [{ group: null }, { group: '' }, { group: { $exists: false } }] } : { group: new RegExp(`^${escapeRegex(f.group)}$`, 'i') });
  return and.length ? { $and: and } : {};
}

export async function list(q: z.infer<typeof contactListQuery>) {
  const filter = filterOf(q);
  const dir = q.dir === 'desc' ? -1 : 1;
  const field = q.sort === 'status' ? 'active' : q.sort;
  const sort: Record<string, 1 | -1> = field === 'email' ? { email: dir } : { [field]: dir, email: 1 };
  const [rows, total] = await Promise.all([
    MailContact.find(filter).collation({ locale: 'en', strength: 2 }).sort(sort).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    MailContact.countDocuments(filter),
  ]);
  return { items: rows.map(view), meta: pageMeta(q.page, q.limit, total) };
}

/** The groups in use, for the filter box. */
export async function groups() {
  const g = (await MailContact.distinct('group')) as (string | null)[];
  return g.filter((x): x is string => !!x && x.trim() !== '').sort((a, b) => a.localeCompare(b));
}

/** Activate, deactivate, regroup or delete many contacts at once (the ticked ones, or everything the filter shows). */
export async function bulk(input: z.infer<typeof bulkBody>, actor: Actor) {
  const filter = input.ids ? { _id: { $in: input.ids } } : filterOf(input.filter ?? {});
  const matched = await MailContact.countDocuments(filter);
  if (input.action === 'delete') await MailContact.deleteMany(filter);
  else {
    const set: Record<string, unknown> = { updatedBy: actor.id };
    if (input.action === 'activate') set.active = true;
    else if (input.action === 'deactivate') set.active = false;
    else set.group = input.group?.trim() || null;
    await MailContact.updateMany(filter, { $set: set });
  }
  await recordAudit({ actor, action: `MAIL_CONTACTS_BULK_${input.action.toUpperCase()}`, entity: 'MailContact', entityId: actor.id, reason: `${matched} contact(s)${input.action === 'group' ? ` moved to "${input.group?.trim() || '-'}"` : ''}` });
  return { matched, action: input.action };
}

const dup = (e: unknown) => (e as { code?: number }).code === 11000;

export async function create(input: z.infer<typeof contactBody>, actor: Actor) {
  try {
    const c = await MailContact.create({ ...input, createdBy: actor.id, updatedBy: actor.id });
    await recordAudit({ actor, action: 'MAIL_CONTACT_ADDED', entity: 'MailContact', entityId: c._id, reason: input.email });
    return view(c);
  } catch (e) {
    if (dup(e)) throw AppError.conflict(`${input.email} is already in the address book`);
    throw e;
  }
}

export async function update(id: string, input: z.infer<typeof contactPatch>, actor: Actor) {
  try {
    const c = await MailContact.findByIdAndUpdate(id, { $set: { ...input, updatedBy: actor.id } }, { returnDocument: 'after' });
    if (!c) throw AppError.notFound('Contact not found');
    await recordAudit({ actor, action: 'MAIL_CONTACT_UPDATED', entity: 'MailContact', entityId: c._id, reason: c.email });
    return view(c);
  } catch (e) {
    if (dup(e)) throw AppError.conflict('That email address is already in the address book');
    throw e;
  }
}

export async function remove(id: string, actor: Actor) {
  const c = await MailContact.findByIdAndDelete(id);
  if (!c) throw AppError.notFound('Contact not found');
  await recordAudit({ actor, action: 'MAIL_CONTACT_REMOVED', entity: 'MailContact', entityId: c._id, reason: c.email });
}

/** Addresses saved in Mail settings join the address book on their own (nothing is overwritten). */
export async function learn(emails: string[]) {
  const list = [...new Set(emails.filter((e) => EMAIL.test(e)))];
  if (!list.length) return;
  await MailContact.bulkWrite(list.map((email) => ({ updateOne: { filter: { email }, update: { $setOnInsert: { email, active: true } }, upsert: true } })));
}

/* -------------------------------- Excel / CSV -------------------------------- */

const cellText = (v: ExcelJS.CellValue): string => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if ('text' in v) return String(v.text ?? '').trim(); // hyperlink cell: mailto:
    if ('result' in v) return String(v.result ?? '').trim();
    if ('richText' in v) return v.richText.map((r) => r.text).join('').trim();
    return '';
  }
  return String(v).trim();
};

/** "Active" / "Inactive" (also yes/no, true/false, 1/0) in a Status column; anything else leaves the contact as it is. */
const statusOf = (t: string): boolean | undefined => {
  const v = t.trim().toLowerCase();
  if (/^(active|yes|y|true|1|enabled)$/.test(v)) return true;
  if (/^(inactive|in-active|no|n|false|0|disabled|left|resigned)$/.test(v)) return false;
  return undefined;
};

/**
 * Reads the columns (any order, found by the heading in the first rows; S.No and other columns are ignored) from an .xlsx or
 * .csv file: Email (or "Email Address", "Email ID", "Mail"), Name, Group (or "Department") and Status (Active / Inactive).
 */
async function readRows(file: { originalname: string; buffer: Buffer }) {
  const wb = new ExcelJS.Workbook();
  try {
    if (/\.csv$/i.test(file.originalname)) await wb.csv.read(Readable.from(file.buffer));
    else if (/\.xlsx$/i.test(file.originalname)) await wb.xlsx.load(file.buffer as never);
    else throw AppError.badRequest('Upload an .xlsx or .csv file');
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw AppError.badRequest('The file could not be read. Use the sample sheet.');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw AppError.badRequest('The file has no sheet');
  const norm = (t: string) => t.toLowerCase().replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
  let headRow = 0;
  let col: { email?: number; name?: number; group?: number; status?: number } = {};
  for (let n = 1; n <= Math.min(ws.rowCount, 6) && !col.email; n++) {
    const found: typeof col = {};
    ws.getRow(n).eachCell((c, i) => {
      const h = norm(cellText(c.value));
      if (!h) return;
      if (found.email == null && /(^|\s)(e ?mail|mail)(\s|$)/.test(h)) found.email = i;
      else if (found.name == null && /(^|\s)name$/.test(h)) found.name = i;
      else if (found.group == null && /^(group|department|dept)$/.test(h)) found.group = i;
      else if (found.status == null && /^(status|active)$/.test(h)) found.status = i;
    });
    if (found.email) { col = found; headRow = n; }
  }
  if (!col.email) throw AppError.badRequest('The sheet needs an "Email" or "Email Address" column (and optionally "Name", "Group" and "Status")');
  if (ws.rowCount - headRow > MAX_IMPORT_ROWS) throw AppError.badRequest(`Import at most ${MAX_IMPORT_ROWS} rows at a time`);
  const rows: { row: number; email: string; name: string; group: string; active?: boolean }[] = [];
  ws.eachRow((r, n) => {
    if (n <= headRow) return;
    const email = cellText(r.getCell(col.email!).value).toLowerCase();
    if (!email) return;
    rows.push({ row: n, email, name: col.name ? cellText(r.getCell(col.name).value) : '', group: col.group ? cellText(r.getCell(col.group).value) : '', active: col.status ? statusOf(cellText(r.getCell(col.status).value)) : undefined });
  });
  return rows;
}

export async function importContacts(file: { originalname: string; buffer: Buffer } | undefined, actor: Actor) {
  if (!file) throw AppError.badRequest('Choose a file to import');
  const rows = await readRows(file);
  const bad: { row: number; email: string; reason: string }[] = [];
  const seen = new Set<string>();
  const good = rows.filter((r) => {
    if (!EMAIL.test(r.email) || r.email.length > 200) return bad.push({ row: r.row, email: r.email.slice(0, 80), reason: 'Not a valid email address' }), false;
    if (seen.has(r.email)) return bad.push({ row: r.row, email: r.email, reason: 'Repeated in the file' }), false;
    seen.add(r.email);
    return true;
  });
  const existing = new Set((await MailContact.find({ email: { $in: good.map((g) => g.email) } }).select('email').lean()).map((c) => c.email));
  if (good.length) {
    await MailContact.bulkWrite(
      good.map((g) => ({
        updateOne: {
          filter: { email: g.email },
          // The address is the key, so importing the same sheet again edits the contacts and never adds a second one. A blank cell never wipes a saved name or group.
          update: { $set: { updatedBy: actor.id, ...(g.name ? { name: g.name.slice(0, 120) } : {}), ...(g.group ? { group: g.group.slice(0, 60) } : {}), ...(g.active !== undefined ? { active: g.active } : {}) }, $setOnInsert: { email: g.email, createdBy: actor.id, ...(g.active === undefined ? { active: true } : {}) } },
          upsert: true,
        },
      })),
    );
  }
  const result = { added: good.length - existing.size, updated: existing.size, skipped: bad };
  await recordAudit({ actor, action: 'MAIL_CONTACTS_IMPORTED', entity: 'MailContact', entityId: actor.id, reason: `${result.added} added, ${result.updated} updated, ${bad.length} skipped (${file.originalname})` });
  return result;
}

/** A sample sheet people can fill in and import. */
export const sampleSheet = () =>
  tabularFile('xlsx', 'Contacts', [{ header: 'S.No', value: (r) => r.no, width: 6 }, { header: 'Name', value: (r) => r.name }, { header: 'Email Address', value: (r) => r.email, width: 32 }, { header: 'Group', value: (r) => r.group }, { header: 'Status', value: (r) => r.status, width: 10 }], [
    { no: 1, name: 'Project desk', email: 'project@adinn.co.in', group: 'Signage', status: 'Active' },
    { no: 2, name: 'Full stack team', email: 'fullstack@adinn.co.in', group: 'IT', status: 'Active' },
  ]);
