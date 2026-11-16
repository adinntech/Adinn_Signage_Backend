/**
 * Reading a reply mail: which request it answers and which code it carries. Pure text functions (no database, no mailbox),
 * so every rule is unit-tested. A code is taken only when it is unambiguous; anything doubtful is left for a person.
 *
 * Business rules (one place, changeable with env, see `rulesFromEnv`):
 *  - Vendor ID: digits only, 5 or more in a row (letters around it, "AB12345", are dropped: 12345 is the ID).
 *  - Project code: 8 or more digits in a row, or the separate EST-<6 digits> pattern, or extra configured patterns.
 *  - Amount approval: APPROVED / NOT_APPROVED / HOLD, negatives are cut out first.
 */

import { REQUEST_ID_PATTERN, canonicalRequestId } from '../mailSettings/requestIdTags';

const ID_RE = new RegExp(REQUEST_ID_PATTERN, 'gi');

/** Every request ID mentioned (normalised to the stored spelling), first mention first. */
export function requestIdsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ID_RE)) {
    const id = canonicalRequestId(m[1]!, m[2]!);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The rules a reply is read with. Defaults match the business rules; every value can be set in the server env. */
export interface ReplyRules {
  vendorMinDigits: number;
  vendorMaxDigits: number;
  projectMinDigits: number;
  projectMaxDigits: number;
  /** Estimate numbers (after EST): this many digits or more, and at most estMaxDigits. */
  estDigits: number;
  estMaxDigits: number;
  /** Words that start another system's number (UF987654320): never read as a code. */
  unrelatedPrefixes: string[];
  /** Characters that may sit between EST and its digits (all read as "-"). */
  estSeparators: string;
  /** Extra project code formats (regex sources, case-insensitive), e.g. "PRJ[-_/ ]?\\d{4}[-_/ ]?\\d{3,5}". */
  extraProjectPatterns: string[];
}
export const DEFAULT_RULES: ReplyRules = { vendorMinDigits: 5, vendorMaxDigits: 12, projectMinDigits: 8, projectMaxDigits: 15, estDigits: 5, estMaxDigits: 12, unrelatedPrefixes: ['UF'], estSeparators: '-_/ ', extraProjectPatterns: [] };
export function rulesFromEnv(e: Record<string, string | undefined> = process.env): ReplyRules {
  const n = (v: string | undefined, d: number) => (v && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    vendorMinDigits: n(e.VENDOR_ID_MIN_DIGITS, DEFAULT_RULES.vendorMinDigits),
    vendorMaxDigits: n(e.VENDOR_ID_MAX_DIGITS, DEFAULT_RULES.vendorMaxDigits),
    projectMinDigits: n(e.PROJECT_CODE_MIN_DIGITS, DEFAULT_RULES.projectMinDigits),
    projectMaxDigits: DEFAULT_RULES.projectMaxDigits,
    estDigits: n(e.PROJECT_CODE_EST_DIGITS, DEFAULT_RULES.estDigits),
    estMaxDigits: n(e.PROJECT_CODE_EST_MAX_DIGITS, DEFAULT_RULES.estMaxDigits),
    unrelatedPrefixes: e.UNRELATED_CODE_PREFIXES === undefined ? DEFAULT_RULES.unrelatedPrefixes : e.UNRELATED_CODE_PREFIXES.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
    estSeparators: e.PROJECT_CODE_EST_SEPARATORS ?? DEFAULT_RULES.estSeparators,
    extraProjectPatterns: (e.PROJECT_CODE_EXTRA_PATTERNS ?? '').split('|||').map((s) => s.trim()).filter(Boolean),
  };
}

/** HTML mail to the text a person reads: quoted history (blockquote, Gmail / Outlook reply blocks), styles and scripts are dropped first. */
export function htmlToText(html: string): string {
  let h = html.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ').replace(/<div[^>]+(?:gmail_quote|appendonsend|divRplyFwdMsg|yahoo_quoted)[\s\S]*$/i, ' ');
  h = h.replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<\/t[dh]>/gi, '  ').replace(/<[^>]+>/g, ' ');
  const ent: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&rupee;': '₹' };
  h = h.replace(/&(nbsp|amp|lt|gt|quot|#39|rupee);/g, (m) => ent[m] ?? m).replace(/&#(\d+);/g, (_, c: string) => String.fromCodePoint(Number(c)));
  return h.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Only what the person wrote: drops quoted lines, "On ... wrote:" blocks, Outlook / forwarded headers, sign-offs ("Regards") and signatures after "-- ". */
export function freshText(text: string): string {
  const lines: string[] = [];
  let body = text.replace(/\r\n/g, '\n');
  // Gmail wraps the "On ... wrote:" line over two lines, so cut at it before reading line by line.
  const cut = body.search(/(^|\n)[ \t]*On [^\n]{5,200}(\n[^\n]{0,200})?[ \t]+wrote:/i);
  if (cut >= 0) body = body.slice(0, cut);
  const rows = body.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]!;
    const line = raw.trim();
    if (/^(on .{5,200} wrote:?|-{2,}\s*(original message|forwarded message)\s*-{2,}|_{5,}|from:\s.+@.+|sent from my |get outlook for |begin forwarded message)/i.test(line)) break;
    // Outlook: "From: Name" then "Sent: ..." (no address on the first line).
    if (/^from:\s/i.test(line) && /^(sent|date|to):/i.test((rows.slice(i + 1).find((r) => r.trim()) ?? '').trim())) break;
    if (/^--\s*$/.test(raw)) break;
    if (/^(with |best |warm |kind |thanks (?:&|and) |many thanks,? ?)?regards[,.! ]*$/i.test(line)) break;
    if (line.startsWith('>')) continue;
    lines.push(raw);
  }
  return lines.join('\n').trim();
}

/** Request IDs and estimate numbers are removed first, so their digits are never mistaken for a vendor ID or a project code. */
/** Bold / italic marks a mail app adds to plain text (*12543 - SRN MEDIA*, _text_, ~text~, `text`) are not part of what was written. */
export const plain = (s: string) => s.replace(/[*~`]+/g, '').replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, '');
const uniq = <T,>(a: T[]) => [...new Set(a)];
const digitsOf = (s: string) => s.replace(/\D/g, '');
const lineAt = (t: string, i: number) => {
  const a = t.lastIndexOf('\n', i) + 1;
  const b = t.indexOf('\n', i);
  return t.slice(a, b < 0 ? undefined : b).trim();
};

/** Whitespace is always a separator (a trailing space is lost in an env file); the other characters come from PROJECT_CODE_EST_SEPARATORS. */
const sepClass = (seps: string) => `[\\s${[...seps.replace(/\s/g, ''), '–', '—', ':'].map((c) => (/\w/.test(c) ? c : `\\${c}`)).join('')}]`;

/* ---------------------------------------------------------------------------------------------------------------------------
 * Candidates. A code is never read from a whole mail squashed into one number. The text is first cleaned of things that are
 * known to be something else (request IDs, estimate numbers, GSTIN, PAN, e-mail addresses, phone numbers, dates, amounts and
 * configured unrelated prefixes such as UF987654320); then it is cut into candidates (one word, ended by a space, comma, bar or
 * slash); and only inside ONE candidate are the digits taken, in the order written: "%3924&242*8fafdRW" gives 39242428.
 * --------------------------------------------------------------------------------------------------------------------------- */
const TOKEN_SPLIT = /[\s,;|/\\]+/;
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/gi;
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/gi;
const GST_TOKEN = /\d{2}[A-Za-z]{5}\d{4}[A-Za-z][A-Za-z\d]Z[A-Za-z\d]/;
const PAN_TOKEN = /[A-Za-z]{5}\d{4}[A-Za-z]/;
const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)';
/** Text that is known to be something else, replaced by a space (a phone number with a 10-digit run is left: see readTokens). */
const scrub = (s: string) =>
  s
    .replace(GSTIN, ' ')
    .replace(PAN, ' ')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g, ' ') // e-mail addresses
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/(?:₹|rs\.?|inr)\s*[\d,]+(?:\.\d+)?/gi, ' ') // amounts
    .replace(/\b\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\b/g, ' ')
    .replace(/\+91[\s-]?[6-9]\d{9}(?!\d)/g, ' ') // phone numbers written with a country code or in two groups
    .replace(/(?<!\d)[6-9]\d{4}[\s-]\d{5}(?!\d)/g, ' ')
    .replace(/\b(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:\d{4}|\d{2})\b/g, ' ') // dates 12/11/2026, 12-11-26
    .replace(new RegExp(`\\b\\d{1,2}[-\\s]${MONTHS}[a-z]*[-\\s,.]*\\d{2,4}\\b`, 'gi'), ' '); // 12 Nov 2026
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A word that starts with a configured unrelated prefix followed by digits (UF987654320, UF-903282) is another system's number. */
const isUnrelated = (tok: string, rules: ReplyRules) => rules.unrelatedPrefixes.some((p) => new RegExp(`^[^A-Za-z0-9]*${escapeRe(p)}[^A-Za-z0-9]*\\d`, 'i').test(tok));
const dropUnrelated = (s: string, rules: ReplyRules) => (rules.unrelatedPrefixes.length ? s.replace(/\S+/g, (tok) => (isUnrelated(tok, rules) ? ' ' : tok)) : s);

/** Estimate numbers: "EST" (any case, not inside a longer word: TEST, PREST, ESTIMATE are not it), the separators, then ONE candidate. */
const estRegex = (rules: ReplyRules) => new RegExp(`(?<![A-Za-z0-9])EST(?![A-Za-z])${sepClass(rules.estSeparators)}*([^\\s,;|/]*)`, 'gi');
const stripEstimates = (s: string, rules: ReplyRules) => s.replace(estRegex(rules), ' ');
const norm = (s: string, rules: ReplyRules = DEFAULT_RULES) => plain(stripEstimates(s, rules)).replace(ID_RE, ' ').replace(/[ \t]+/g, ' ');
/** A line that names another kind of code ("Project code: ...", "Vendor ID: ...", "Client code: ...") is not read for this kind when it carries no label of its own. */
const PROJECT_LINE = /project[\s_]*(?:code|no\.?|number|id)\b|\bproject\b\s*[:=#-]/i;
const VENDOR_LINE = /\b(?:vendor|supplier)[\s_]*(?:registration[\s_]*)?(?:id|no\.?|number|code)\b|\bv[\s_]*id\b/i;
const CLIENT_LINE = /client[\s_]*(?:code|id|no\.?|number)\b/i;
/** The text of a mail without the lines that belong to the other kinds, and each line cut at "Mobile", "Invoice", "GST" ... */
const withoutLines = (t: string, drop: RegExp[]) =>
  t.split('\n').filter((l) => !drop.some((d) => d.test(l))).map((l) => cutAtStop(l)).join('\n');
const CANCELLED_RE = /(?<!not\s)\b(cancel+ed|cancellation|revoked|withdrawn|terminated|void(?:ed)?)\b/i;

interface Cand {
  /** The candidate as written. */
  raw: string;
  /** Its digits, in the order written (a string: leading zeros stay). */
  id: string;
  /** Letters or symbols sit inside it. */
  mixed: boolean;
}
/** One segment cut into candidates. `good` have min..max digits; `short` are the digit counts that did not fit. */
function readTokens(seg: string, min: number, max: number, skipPhone: boolean): { good: Cand[]; short: string[]; phone: boolean; phones: string[] } {
  const good: Cand[] = [];
  const short: string[] = [];
  const phones: string[] = [];
  let phone = false;
  for (const tok of seg.split(TOKEN_SPLIT)) {
    if (!digitsOf(tok) || GST_TOKEN.test(tok) || PAN_TOKEN.test(tok)) continue;
    // 12345-67890: two numbers joined by a dash stay two candidates; 12-34-56-78 is one.
    const parts = tok.split(/[-–—]+/).filter(Boolean);
    const units = parts.filter((p) => digitsOf(p).length >= min).length >= 2 ? parts.filter((p) => digitsOf(p)) : [tok];
    for (const u of units) {
      const d = digitsOf(u);
      if (!d) continue;
      if (/^[\s+()\d–—-]+$/.test(u) && /^[6-9]\d{9}$/.test(d)) {
        phone = true;
        if (skipPhone) { phones.push(d); continue; }
      }
      if (d.length >= min && d.length <= max) good.push({ raw: u.replace(/[.,:;!?]+$/, ''), id: d, mixed: /\D/.test(u.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')) });
      else short.push(d);
    }
  }
  return { good, short, phone, phones };
}

/* ------------------------------------------------------------------ estimate numbers ------------------------------------------------------------------ */
export interface EstimateRead {
  /** The estimate as written, "EST-45@43#949". */
  raw: string;
  digits: string;
  /** What would be saved: EST-<digits>; null when the digits do not fit the rule. */
  normalized: string | null;
  valid: boolean;
  reason: string;
  context: string;
}
/** Every EST candidate in the text: valid (estMin..estMax digits) or with the reason it is not. A word after EST without digits is not an estimate. */
export function readEstimates(text: string, rules: ReplyRules = DEFAULT_RULES): EstimateRead[] {
  const out: EstimateRead[] = [];
  const t = dropUnrelated(scrub(text.replace(ID_RE, ' ')), rules);
  for (const m of t.matchAll(estRegex(rules))) {
    const d = digitsOf(m[1] ?? '');
    if (d.length < 2) continue;
    const valid = d.length >= rules.estDigits && d.length <= rules.estMaxDigits;
    out.push({
      raw: m[0].trim(),
      digits: d,
      normalized: valid ? `EST-${d}` : null,
      valid,
      reason: valid ? 'Digits after the EST prefix' : d.length < rules.estDigits ? `An estimate number needs ${rules.estDigits} or more digits (found ${d.length})` : `An estimate number has at most ${rules.estMaxDigits} digits (found ${d.length})`,
      context: lineAt(t, m.index!),
    });
  }
  return out;
}
/** Every valid estimate number in the reply, once each, in the order written, as EST-<digits>. */
export const findEstimates = (text: string, rules: ReplyRules = DEFAULT_RULES): string[] => uniq(readEstimates(text, rules).filter((e) => e.valid).map((e) => e.normalized!));

export type Found = { code: string | null; ambiguous: string[] };

/** What reading one kind of code from a reply gave. `raw` is what was written, `normalized` is what would be saved, `context` the line it came from. */
export type CodeStatus = 'EXTRACTED' | 'REVIEW_REQUIRED' | 'INVALID' | 'CANCELLED' | 'PENDING' | 'NOT_FOUND';
export interface CodeRead {
  status: CodeStatus;
  raw: string | null;
  normalized: string | null;
  confidence: number;
  reason: string;
  candidates: string[];
  flags: string[];
  context?: string | null;
}
const read = (status: CodeStatus, raw: string | null, normalized: string | null, confidence: number, reason: string, candidates: string[] = [], flags: string[] = []): CodeRead => ({ status, raw, normalized, confidence, reason, candidates, flags });
const toFound = (r: CodeRead): Found => (r.status === 'EXTRACTED' ? { code: r.normalized, ambiguous: [] } : { code: null, ambiguous: r.status === 'REVIEW_REQUIRED' ? r.candidates : [] });

/**
 * The estimate number of a reply, by itself ("EST-12abc345" gives EST-12345). One estimate is EXTRACTED; several different ones, or
 * a cancelled one, are left for a person; fewer digits than the rule is INVALID. The reply may carry many estimates for one project
 * (findEstimates lists them all); this is the single-value reading used when exactly one is expected.
 */
export function extractEstimate(text: string, rules: ReplyRules = DEFAULT_RULES): CodeRead {
  const reads = readEstimates(text, rules);
  const valid = reads.filter((e) => e.valid);
  const ids = uniq(valid.map((e) => e.normalized!));
  const cancelled = CANCELLED_RE.test(text);
  if (ids.length > 1) return { ...read('REVIEW_REQUIRED', valid.map((e) => e.raw).join(' / '), null, 0.4, `More than one estimate number (${ids.join(', ')}): a person decides`, ids, ['MULTIPLE_CANDIDATES']), context: valid[0]!.context };
  if (ids.length === 1) {
    const e = valid[0]!;
    if (cancelled) return { ...read('CANCELLED', e.raw, null, 0.9, 'The reply says it is cancelled: the estimate is not confirmed', ids, ['CANCELLED']), context: e.context };
    return { ...read('EXTRACTED', e.raw, e.normalized, /\D/.test(e.raw.replace(/^EST[\s_\-–—/:]*/i, '').replace(/[.,:;!?]+$/, '')) ? 0.8 : 0.95, e.reason, ids, /\D/.test(e.raw.replace(/^EST[\s_\-–—/:]*/i, '').replace(/[.,:;!?]+$/, '')) ? ['MIXED_CHARS'] : []), context: e.context };
  }
  if (reads.length) return { ...read('INVALID', reads[0]!.raw, null, 0.2, reads[0]!.reason, [], ['INVALID_FORMAT']), context: reads[0]!.context };
  return read('NOT_FOUND', null, null, 0, 'No estimate number (EST-...) in the reply');
}

/** Words after which the text is about something else (phone, GST, an amount, a quoted old mail), so a number there is not the code. */
const STOP = /\b(?:gst(?:in)?|pan|mobile|mob|phone|ph|contact|tel|cell|invoice|inv|amount|date|ref|po|quoted?|previous|aadhaar|bank|account|ifsc)\b/i;
const cutAtStop = (s: string) => {
  const i = s.search(STOP);
  return i >= 0 ? s.slice(0, i) : s;
};
const MOBILE = /^[6-9]\d{9}$/;
const isMobile = (d: string) => MOBILE.test(d);
/** After a label, up to the end of its line (and before any "GST:", "Mobile:" ...). */
function segmentsAfter(t: string, label: RegExp): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(label)) out.push(cutAtStop(t.slice(m.index! + m[0].length).split('\n')[0]!));
  return out;
}

/**
 * Vendor ID from Accounts' reply: DIGITS ONLY, `vendorMinDigits` or more, taken from ONE candidate (a word), letters and symbols in it
 * are dropped and the digits keep their order ("AB12CD345" and "78@95#4" give 12345 and 78954; "UF987654320" is another system's
 * number and is ignored). In order of trust:
 * 1. after "vendor id / no / number / code", "vendor:", "VId" (the rest of that line, before GST / mobile / quoted text);
 * 2. after a bare "code" or "id";
 * 3. a number followed by a dash and a name: "Zoho Book - 12589 - SRN MEDIA", "12589 - SRN MEDIA";
 * 4. a line that is only one word holding the number ("78@95#4", "12589");
 * 5. the only 5 to 9 digit number in the whole reply, or (last) the only word of mixed letters / digits that holds enough digits.
 * Two different numbers at the same level is REVIEW_REQUIRED. Phone numbers, GSTIN, PAN, dates, years and amounts are not counted.
 */
export function extractVendorId(text: string, rules: ReplyRules = DEFAULT_RULES): CodeRead {
  const out = { context: null as string | null };
  return { ...vendorCore(text, rules, out), context: out.context };
}
function vendorCore(text: string, rules: ReplyRules, out: { context: string | null }): CodeRead {
  const min = rules.vendorMinDigits;
  const max = rules.vendorMaxDigits;
  const t = stripEstimates(dropUnrelated(scrub(text.replace(ID_RE, ' ')), rules), rules);
  const cancelled = CANCELLED_RE.test(t);
  const flags: string[] = [];
  const finish = (hits: Cand[], conf: number, how: string, ctx: string): CodeRead | null => {
    if (!hits.length) return null;
    const ids = uniq(hits.map((h) => h.id));
    out.context = t.split('\n').map((l) => l.trim()).find((l) => ctx && l.includes(ctx.trim())) ?? ctx;
    for (const h of hits) if (h.mixed) flags.push(/[A-Za-z]/.test(h.raw) ? 'LETTERS_DROPPED' : 'SYMBOLS_DROPPED');
    if (cancelled) return read('CANCELLED', hits[0]!.raw, null, 0.9, 'The reply says the registration is cancelled: the ID is not confirmed', ids, ['CANCELLED']);
    if (ids.length > 1) return read('REVIEW_REQUIRED', hits.map((h) => h.raw).join(' / '), null, 0.4, `More than one vendor ID in the reply (${ids.join(', ')}): a person decides`, ids, ['MULTIPLE_CANDIDATES']);
    return read('EXTRACTED', hits[0]!.raw, ids[0]!, hits[0]!.mixed ? Math.min(conf, 0.7) : conf, how, ids, uniq(flags));
  };

  // 1 and 2: after a label.
  const l1 = /(?:(?:vendor|supplier)[\s_]*(?:registration[\s_]*)?(?:id|no\.?|number|code)|\bv[\s_]*id\b|(?:vendor|supplier)(?=[\s_]*[:=#-]))(?:[\s_]*(?:is(?![a-z])|:|=|#|-))?/gi;
  let segs = segmentsAfter(t, l1);
  if (!segs.length) {
    const l2 = /(?<![a-z])(?:code|id)(?![a-z])(?:[\s_]*(?:is(?![a-z])|:|=|#|-))?/gi;
    segs = [...t.matchAll(l2)].filter((m) => !/(?:project|client|gst|pan|mobile|est|order|invoice)\W{0,4}$/i.test(t.slice(Math.max(0, m.index! - 14), m.index!))).map((m) => cutAtStop(t.slice(m.index! + m[0].length).split('\n')[0]!));
  }
  segs = segs.map((s) => s.split(/project[\s_]*(?:code|no\.?|number|id)\b|client[\s_]*(?:code|id|no\.?|number)\b/i)[0]!);
  if (segs.length) {
    const reads = segs.map((s) => readTokens(s, min, max, true));
    if (reads.some((r) => r.phone)) flags.push('PHONE_LIKE');
    const r = finish(reads.flatMap((x) => x.good), 0.95, 'Found after the words "vendor id"', segs.find((s) => digitsOf(s)) ?? '');
    if (r) return r;
    const shorts = [...reads.flatMap((x) => x.short), ...reads.flatMap((x) => x.phones)];
    if (shorts.length) {
      const seg = segs.find((x) => digitsOf(x));
      out.context = (seg && t.split('\n').map((l) => l.trim()).find((l) => l.includes(seg.trim()))) || null;
      return read('INVALID', shorts[0]!, null, 0.2, `The vendor ID needs ${min} or more digits (found ${Math.max(...shorts.map((s) => s.length))})`, [], ['TOO_SHORT']);
    }
    // The words "vendor id" are there but no digits follow them on that line (the number sits on the next line, or the words come from
    // the quoted request): do not stop, read the reply the same way as when there is no label.
  }

  // 3 to 5: no label. Lines that are about a project or client code are not read for a vendor ID.
  const free = withoutLines(t, [PROJECT_LINE, CLIENT_LINE]);
  const n = norm(free, rules);
  const named = [...n.matchAll(new RegExp(`(?<![\\d.])(\\d{${min},${max}})(?![\\d.])\\s*[-–—:]\\s*(?=[A-Za-z])`, 'g'))].map((m) => ({ raw: m[0].trim(), id: m[1]!, mixed: false }));
  let r = finish(named, 0.8, 'A number followed by a name', named[0]?.raw ?? '');
  if (r) return r;
  const lines = free.split('\n').map((l) => l.trim()).filter(Boolean);
  const only: Cand[] = [];
  for (const l of lines) {
    if (/\s/.test(l)) continue;
    const rt = readTokens(l, min, max, true);
    if (rt.phone) flags.push('PHONE_LIKE');
    only.push(...rt.good);
  }
  r = finish(only, 0.7, 'A line holding only the number', only[0]?.raw ?? '');
  if (r) return r;
  const loose = n.replace(/\b(19|20)\d{2}\b/g, ' '); // years
  const nums = [...loose.matchAll(new RegExp(`(?<![\\d.])(\\d{${min},9})(?![\\d.])`, 'g'))].filter((m) => !isMobile(m[1]!)).map((m) => ({ raw: m[1]!, id: m[1]!, mixed: false }));
  r = finish(nums, 0.55, 'The only number of that size in the reply (no "vendor id" label)', nums[0]?.raw ?? '');
  if (r) return r;
  const mixedWords = readTokens(loose, min, max, true).good.filter((h) => h.mixed);
  r = finish(mixedWords, 0.5, 'The only word holding enough digits among letters / symbols (no "vendor id" label)', mixedWords[0]?.raw ?? '');
  if (r) return r;
  const whole = free.trim();
  const wholeDigits = digitsOf(whole);
  if (whole && !/\s/.test(whole) && wholeDigits.length >= 3 && wholeDigits.length < min) {
    out.context = whole;
    return read('INVALID', whole, null, 0.15, `The vendor ID needs ${min} or more digits (found ${wholeDigits.length})`, [], ['TOO_SHORT']);
  }
  const short = loose.match(/(?<![\d.])\d{2,4}(?![\d.])/);
  return short && /vendor|id\b|registered|created/i.test(t) ? read('INVALID', short[0], null, 0.15, `The vendor ID needs ${min} or more digits`, [], ['TOO_SHORT']) : read(cancelled ? 'CANCELLED' : 'NOT_FOUND', null, null, 0, 'No vendor ID in the reply');
}
export const findVendorNo = (text: string, rules: ReplyRules = DEFAULT_RULES): Found => toFound(extractVendorId(text, rules));

const PENDING_WORDS = /\b(pending|expected|awaiting|yet\s+to|not\s+yet|tentative|will\s+be|to\s+be\s+(?:created|generated|issued)|shortly|soon|once\s+approved)\b/i;

/**
 * Project code: `projectMinDigits` (8) or more digits taken from ONE candidate; letters and symbols inside it are dropped and the
 * digits keep their order ("12@34#56$78", "AB12CD34EF56GH78" and "12-34-56-78" give 12345678). After a "project code" label a code
 * written in groups ("1234 5678") is joined too. Without a label only a line holding a single word, or a plain 8+ digit number, is
 * taken; a mixed word inside a sentence is only offered to a person. An EST number is an estimate, never a project code (see
 * findEstimates / extractEstimate). Phone numbers, GSTIN, PAN, dates, amounts and unrelated prefixes (UF...) are never used. A line
 * that says "pending" / "expected" confirms nothing (PENDING), a cancelled one is not confirmed (CANCELLED).
 */
export function extractProjectCode(text: string, rules: ReplyRules = DEFAULT_RULES): CodeRead {
  const out = { context: null as string | null };
  return { ...projectCore(text, rules, out), context: out.context };
}
function projectCore(text: string, rules: ReplyRules, out: { context: string | null }): CodeRead {
  const min = rules.projectMinDigits;
  const max = rules.projectMaxDigits;
  const cleaned = dropUnrelated(scrub(text.replace(ID_RE, ' ')), rules);
  const estimates = readEstimates(cleaned, rules).filter((e) => e.valid);
  const t = stripEstimates(cleaned, rules);
  const cancelled = CANCELLED_RE.test(t);
  const extra = rules.extraProjectPatterns.flatMap((p) => { try { return [new RegExp(p, 'gi')]; } catch { return []; } });
  const flags: string[] = [];
  type Hit = { raw: string; code: string; line: string; mixed: boolean };
  const bad: { raw: string; why: string }[] = [];
  const tooShort = (d: string) => `A project code needs ${min} or more digits (found ${d.length})`;
  const tooLong = (d: string) => `A project code has at most ${max} digits (found ${d.length})`;
  const scan = (seg: string, line: string, labelled: boolean, single: boolean): { good: Hit[]; mixed: Hit[]; bad: { raw: string; why: string }[] } => {
    const good: Hit[] = [];
    const mixed: Hit[] = [];
    const badHere: { raw: string; why: string }[] = [];
    let rest = seg;
    for (const re of extra) { for (const m of rest.matchAll(re)) good.push({ raw: m[0], code: m[0].toUpperCase().replace(/[\s_/]+/g, '-'), line, mixed: false }); rest = rest.replace(re, ' '); }
    const r = readTokens(rest, min, max, !labelled);
    for (const c of r.good) {
      const hit = { raw: c.raw, code: c.id, line, mixed: c.mixed };
      if (labelled || single || !c.mixed) good.push(hit);
      else mixed.push(hit);
    }
    if (!r.good.length && labelled) {
      // "Project code: 1234 5678": groups after the label are one code.
      const groups = rest.split(TOKEN_SPLIT).filter((tok) => digitsOf(tok) && !GST_TOKEN.test(tok) && !PAN_TOKEN.test(tok));
      const joined = digitsOf(groups.join(''));
      if (groups.length > 1 && joined.length >= min && joined.length <= max) { good.push({ raw: groups.join(' '), code: joined, line, mixed: true }); flags.push('JOINED_GROUPS'); return { good, mixed, bad: badHere }; }
    }
    if (labelled || single) for (const d of r.short) { if (d.length > max) badHere.push({ raw: d, why: tooLong(d) }); else if (d.length >= 4) badHere.push({ raw: d, why: tooShort(d) }); }
    return { good, mixed, bad: badHere };
  };

  const label = /project[\s_]*(?:code|no\.?|number|id)?(?:[\s_]*is(?![a-z]))?|code[\s_]*(?:generated|created|issued)|(?:generated|created|issued)[\s_]*code/gi;
  const good: Hit[] = [];
  const mixedFree: Hit[] = [];
  for (const m of t.matchAll(label)) {
    const line = lineAt(t, m.index!);
    const seg = cutAtStop(t.slice(m.index! + m[0].length).split('\n')[0]!);
    const r = scan(seg, line, true, false);
    good.push(...r.good);
    bad.push(...r.bad);
  }
  if (!good.length && !bad.length) {
    // No label: a line that is one word, or a plain 8+ digit number inside a sentence.
    for (const raw of t.split('\n')) {
      if (VENDOR_LINE.test(raw) || CLIENT_LINE.test(raw)) continue;
      const line = cutAtStop(raw).trim();
      if (!line) continue;
      const r = scan(line, line, false, !/\s/.test(line));
      good.push(...r.good);
      mixedFree.push(...r.mixed);
      bad.push(...r.bad);
    }
    if (good.length) flags.push('UNLABELLED');
  }
  const codes = uniq(good.map((h) => h.code));
  if (codes.length) {
    out.context = good[0]!.line;
    const anyMixed = good.some((h) => h.mixed);
    if (anyMixed) flags.push('MIXED_CHARS');
    if (cancelled) return read('CANCELLED', good[0]!.raw, null, 0.9, 'The reply says the project is cancelled: the code is not confirmed', codes, ['CANCELLED']);
    if (good.some((h) => PENDING_WORDS.test(h.line))) return read('PENDING', good[0]!.raw, null, 0.9, 'The reply says the code is pending / expected: nothing is confirmed', codes, ['PENDING']);
    if (codes.length > 1) return read('REVIEW_REQUIRED', good.map((h) => h.raw).join(' / '), null, 0.4, `More than one project code in the reply (${codes.join(', ')}): a person decides`, codes, ['MULTIPLE_CANDIDATES']);
    const base = flags.includes('UNLABELLED') ? 0.6 : 0.95;
    return read('EXTRACTED', good[0]!.raw, codes[0]!, anyMixed ? Math.min(base, 0.75) : base, flags.includes('UNLABELLED') ? 'The only project code in the reply (no "project code" label)' : 'Found after the words "project code"', codes, uniq(flags));
  }
  if (bad.length) { out.context = null; return read('INVALID', bad[0]!.raw, null, 0.2, bad[0]!.why, [], ['INVALID_FORMAT']); }
  if (mixedFree.length) {
    const c = uniq(mixedFree.map((h) => h.code));
    out.context = mixedFree[0]!.line;
    return read('REVIEW_REQUIRED', mixedFree[0]!.raw, c.length === 1 ? c[0]! : null, 0.4, `A word with letters / symbols holds ${c.join(' / ')} but there is no "project code" label: a person checks`, c, ['MIXED_CHARS', 'UNLABELLED']);
  }
  if (estimates.length) return read('NOT_FOUND', null, null, 0, `Only an estimate number (${estimates.map((e) => e.normalized).join(', ')}) was found: an EST number is never a project code`, [], ['ESTIMATE_ONLY']);
  return read('NOT_FOUND', null, null, 0, 'No project code in the reply');
}
export const findProjectCode = (text: string, rules: ReplyRules = DEFAULT_RULES): Found => toFound(extractProjectCode(text, rules));

/** Client code: letters, digits and dashes (3 to 20, at least one digit). Only taken after the words "client code". */
export function findClientCode(text: string): Found {
  const t = norm(text);
  const all = [...t.matchAll(/client\s*(?:code|id|no\.?|number)\s*(?:is|:|-|=|#)?\s*([A-Z0-9][A-Z0-9-]{2,19})(?![A-Z0-9-])/gi)].map((m) => m[1]!.toUpperCase()).filter((c) => /\d/.test(c));
  const u = uniq(all);
  return u.length === 1 ? { code: u[0]!, ambiguous: [] } : { code: null, ambiguous: u };
}

const domainOf = (a: string) => a.split('@')[1]?.toLowerCase() ?? '';

/**
 * Anyone can email the reply mailbox, so only the people the request was sent to may answer it: a recipient's own address,
 * or a colleague on the same company domain (a reply to a group mailbox comes from a member's own address).
 */
export function senderAllowed(from: string[], recipients: string[]) {
  const addr = new Set(recipients.map((r) => r.toLowerCase()));
  const domains = new Set([...addr].map(domainOf).filter(Boolean));
  return from.some((f) => addr.has(f.toLowerCase()) || domains.has(domainOf(f)));
}

/** A short single-line preview for the screen. */
export const snippetOf = (text: string, max = 300) => plain(text).replace(/\s+/g, ' ').trim().slice(0, max);

export type Decision = 'APPROVED' | 'NOT_APPROVED';
// Strong words decide on their own. Weak words ("proceed", "go ahead", "fine") only count when no strong word is present, so
// "Not approved, proceed with the company rate" is still a no.
const NO_STRONG = /\b(not\s+approved|not\s+approve|disapproved?|un-?approved|reject(?:ed|s)?|declined?|denied|deny|refused?|not\s+allowed|not\s+ok(?:ay)?|not\s+agreed|cancel(?:led)?|do\s+not\s+approve|don'?t\s+approve|no\s+approval|not\s+accepted|not\s+(?:yet\s+)?(?:done|fine|good|sure|allowed|finali[sz]ed|confirmed|alright|ready|cleared|sorted|moved|processed|updated|released|completed|passed)|not\s+(?:possible|acceptable|given|permitted)|(?:did\s+not|didn'?t|does\s+not|doesn'?t|will\s+not|won'?t|cannot|can'?t|never|not|unable\s+to)\s+(?:\w+\s+)?(?:approv|accept|agree|allow|sanction|grant|permit|authori[sz])\w*)\b/;
/** Tanglish "no": venam / vendam, mudiyadhu, koodathu, illa. */
const NO_TA = /\b(?:venam|vendam|vendaam|mudiy(?:a|aa)dh?u|koodath?u|koodaadhu|illai|illa|approve\s+panna\s+mudiy\w+)\b/;
const NO_WEAK = /(?:\b(?:do\s+not\s+proceed|don'?t\s+proceed|no\s+need)\b|^\s*(?:no|nope|nah)\b)/;
// NO_STRONG also holds the negated yes words ("Not done", "not yet fine", "not finalised"): "Done" alone is a yes, "Not done" is a no.
// Hold words: neither yes nor no, the request keeps waiting (status stays "Waiting for approval").
const HOLD = /(?:\b(?:hold|on\s+hold|holding|wait|waiting|stop|stopped|pause[d]?|pending|postpone[d]?|defer(?:red)?|not\s+now|later|under\s+review|revert\s+back)\b|^\s*not\s+yet\W*$)/;
const YES_STRONG = /\b(approved|approve|accepted|accept|agreed|confirmed|ok|okay|sanctioned|granted)\b/;
const YES_WEAK = /\b(proceed|go\s+ahead|fine|sure|done|yes|alright|good\s+to\s+go|allowed|moved|processed|updated|released|completed|passed|cleared|sorted|finali[sz]ed|kindly\s+acknowledge|acknowledged|seri|sari|pannitten|panniten)\b/;
/** Someone waiting for or needing an approval is not giving it ("Awaiting approval", "Need approval"). "Kindly approve the same" / "Please approve" from the approver is an instruction to approve: a yes. */
const REQUEST = /\b(?:requesting|request|need|needs|awaiting|waiting\s+for)\b[^.\n]{0,25}?\b(?:approve|approval|sanction)\w*/g;
/** "Approved after finance confirms", "Proceed subject to management approval": a condition, not a yes. */
const COND = /\b(?:after|once|when|if|subject\s+to|provided|unless|until|upon|depends?\s+on|depending\s+on)\b[^.\n]{0,40}?\b(?:finance|accounts?|management|md|ceo|director|confirm(?:s|ed|ation)?|approval|approves?|clearance|verification|verif(?:y|ies)|review|check(?:s|ed)?|budget|funds?|sign\s*off)\b/g;
/** A yes with a different rate ("Okay, but reduce the rate") is a counter offer, not an approval of this request. */
const COUNTER = /\b(?:reduce|reduced|reduction|lower|decrease|less|revise|revised|negotiate|bring\s+down|come\s+down|increase|higher|modify|except)\b/;
/** "Earlier rejected, now approved": only an explicit then / now pair counts as a change of mind. */
const REVERSAL = /\b(?:earlier|previously|initially|before|at\s+first)\b.{0,60}?[,;.\s]\s*(?:but\s+|however,?\s+)?(?:now|currently|finally|at\s+present)\b[\s,:-]*(.*)$/;

export interface DecisionRead {
  decision: Decision | 'HOLD' | null;
  /** The words that decided it. */
  matched: string | null;
  reason: string;
  flags: string[];
}
const done = (decision: DecisionRead['decision'], matched: string | null, reason: string, flags: string[]): DecisionRead => ({ decision, matched, reason, flags });

/** Amounts written in the reply: "₹18,500", "Rs. 19000", "18,500/-", "INR 18500.50". */
export function extractAmounts(text: string): number[] {
  const out: number[] = [];
  const add = (s: string) => { const v = Number(s.replace(/,/g, '')); if (Number.isFinite(v) && v > 0) out.push(v); };
  for (const m of text.matchAll(/(?:₹|rs\.?|inr|rupees?)\s*([\d,]+(?:\.\d+)?)/gi)) add(m[1]!);
  for (const m of text.matchAll(/(?<![\d,.])(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?)(?![\d,])/g)) add(m[1]!);
  for (const m of text.matchAll(/(?<![\d,.])(\d{3,9}(?:\.\d+)?)\s*(?:\/-|rs\b|rupees)/gi)) add(m[1]!);
  return uniq(out);
}

/**
 * The answer to an amount approval request ("Approved", "OK, proceed", "approved after some time", "Rejected", "Not approved"...).
 * "Not approved" contains the word approved, so negatives are cut out first. A strong yes and a strong no together, or no
 * decision word at all, is left for a person (null). A request ("Awaiting approval"), a condition ("after finance approval") and a
 * hold ("wait") keep it waiting (HOLD); a yes with a changed rate is left for a person.
 */
export function readDecision(text: string): DecisionRead {
  const flags: string[] = [];
  let t = text.toLowerCase().replace(/_+/g, ' ').replace(/(?<=[a-z])[-–—]+(?=[a-z])/g, ' ');
  // A question ("Are you sure? Do you want to approve?") is not an answer, so sentences ending in ? are left out.
  const noQ = t.replace(/[^.\n]*\?/g, ' ');
  if (noQ !== t) flags.push('QUESTION');
  t = noQ.replace(/\s+/g, ' ').trim();
  const rev = t.match(REVERSAL);
  if (rev) { flags.push('REVERSAL'); t = rev[1]!.trim(); }
  const asked = new RegExp(REQUEST.source, 'g').test(t);
  t = t.replace(REQUEST, ' ');
  const cond = new RegExp(COND.source, 'g').test(t);
  t = t.replace(COND, ' ');
  const noS = NO_STRONG.test(t) || NO_TA.test(t);
  const strip = (s: string) => s.replace(new RegExp(NO_STRONG.source, 'g'), ' ').replace(new RegExp(NO_TA.source, 'g'), ' ');
  const yesS = YES_STRONG.test(strip(t));
  if (noS && yesS) return done(null, null, 'A yes and a no in the same reply: a person decides', [...flags, 'CONFLICT']);
  // Hold / wait / stop alone puts the request on hold. Mixed with a clear yes or no it is contradictory: a person decides.
  if (HOLD.test(t)) return noS || yesS ? done(null, null, 'Hold and a decision together: a person decides', [...flags, 'CONFLICT']) : done('HOLD', HOLD.exec(t)?.[0] ?? null, 'The reply says to wait', flags);
  const matchedNo = () => (NO_STRONG.exec(t) ?? NO_TA.exec(t) ?? NO_WEAK.exec(t))?.[0]?.trim() ?? null;
  if (noS) return done('NOT_APPROVED', matchedNo(), 'A negative decision word', flags);
  const yes = (matched: string | null): DecisionRead => {
    if (cond) return done('HOLD', matched, 'Approved only on a condition (after finance / management ...): not final', [...flags, 'CONDITIONAL']);
    if (COUNTER.test(t)) return done(null, matched, 'A yes with a changed rate: a person decides', [...flags, 'COUNTER_OFFER']);
    return done('APPROVED', matched, 'A positive decision word', flags);
  };
  if (yesS) return NO_WEAK.test(t) ? done(null, null, 'A yes and "do not proceed" together: a person decides', [...flags, 'CONFLICT']) : yes(YES_STRONG.exec(t)?.[0] ?? null);
  const noW = NO_WEAK.test(t);
  const yesW = YES_WEAK.test(t.replace(new RegExp(NO_WEAK.source, 'g'), ' '));
  if (noW && !yesW) return done('NOT_APPROVED', matchedNo(), 'A negative instruction', flags);
  if (yesW && !noW) return yes(YES_WEAK.exec(t)?.[0] ?? null);
  if (asked || cond) return done('HOLD', null, 'The reply asks for or waits on an approval: not an answer', [...flags, asked ? 'REQUEST' : 'CONDITIONAL']);
  // "Kindly give some time", "need more time": nobody has answered, the request keeps waiting.
  if (/\b(?:give\s+(?:me\s+|us\s+)?(?:some\s+|a\s+little\s+|a\s+few\s+)?(?:time|days?|hours?)|some\s+time|more\s+time|need\s+time|little\s+time|few\s+(?:days|hours))\b/.test(t)) return done('HOLD', null, 'The reply asks for time', [...flags, 'TIME']);
  const up = /[✅✔👍👌🆗]/.test(text);
  const down = /[❌🚫👎⛔]/.test(text);
  if (up !== down) return up ? yes('👍') : done('NOT_APPROVED', '👎', 'A negative emoji', flags);
  return done(null, null, flags.includes('QUESTION') ? 'The reply is a question, not an answer' : 'No clear decision word', flags);
}
export const findDecision = (text: string): Decision | 'HOLD' | null => readDecision(text).decision;
