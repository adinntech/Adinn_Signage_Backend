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
  estDigits: number;
  /** Characters that may sit between EST and its digits (all read as "-"). */
  estSeparators: string;
  /** Extra project code formats (regex sources, case-insensitive), e.g. "PRJ[-_/ ]?\\d{4}[-_/ ]?\\d{3,5}". */
  extraProjectPatterns: string[];
}
export const DEFAULT_RULES: ReplyRules = { vendorMinDigits: 5, vendorMaxDigits: 12, projectMinDigits: 8, projectMaxDigits: 15, estDigits: 6, estSeparators: '-_/ ', extraProjectPatterns: [] };
export function rulesFromEnv(e: Record<string, string | undefined> = process.env): ReplyRules {
  const n = (v: string | undefined, d: number) => (v && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    vendorMinDigits: n(e.VENDOR_ID_MIN_DIGITS, DEFAULT_RULES.vendorMinDigits),
    vendorMaxDigits: n(e.VENDOR_ID_MAX_DIGITS, DEFAULT_RULES.vendorMaxDigits),
    projectMinDigits: n(e.PROJECT_CODE_MIN_DIGITS, DEFAULT_RULES.projectMinDigits),
    projectMaxDigits: DEFAULT_RULES.projectMaxDigits,
    estDigits: n(e.PROJECT_CODE_EST_DIGITS, DEFAULT_RULES.estDigits),
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

/** Estimate numbers (EST-20234, EST-020456): many can come with one project code. */
const EST_RE = /(?<![A-Z0-9])EST(?:\s*[-–—]\s*)?\d{3,10}(?!\d)/gi;
// Request IDs and estimate numbers are removed first, so their digits are never mistaken for a project code.
/** Bold / italic marks a mail app adds to plain text (*12543 - SRN MEDIA*, _text_, ~text~, `text`) are not part of what was written. */
export const plain = (s: string) => s.replace(/[*~`]+/g, '').replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, '');
const norm = (s: string) => plain(s).replace(ID_RE, ' ').replace(EST_RE, ' ').replace(/[ \t]+/g, ' ');
const uniq = <T,>(a: T[]) => [...new Set(a)];
/** Every estimate number in the reply, once each, in the order written, as EST-<digits>. */
export const findEstimates = (text: string): string[] => uniq([...text.matchAll(EST_RE)].map((m) => `EST-${m[0].replace(/\D/g, '')}`));

export type Found = { code: string | null; ambiguous: string[] };

/** What reading one kind of code from a reply gave. `raw` is what was written, `normalized` is what would be saved. */
export type CodeStatus = 'EXTRACTED' | 'REVIEW_REQUIRED' | 'INVALID' | 'CANCELLED' | 'PENDING' | 'NOT_FOUND';
export interface CodeRead {
  status: CodeStatus;
  raw: string | null;
  normalized: string | null;
  confidence: number;
  reason: string;
  candidates: string[];
  flags: string[];
}
const read = (status: CodeStatus, raw: string | null, normalized: string | null, confidence: number, reason: string, candidates: string[] = [], flags: string[] = []): CodeRead => ({ status, raw, normalized, confidence, reason, candidates, flags });
const toFound = (r: CodeRead): Found => (r.status === 'EXTRACTED' ? { code: r.normalized, ambiguous: [] } : { code: null, ambiguous: r.status === 'REVIEW_REQUIRED' ? r.candidates : [] });

/** Words after which the text is about something else (phone, GST, an amount, a quoted old mail), so a number there is not the code. */
const STOP = /\b(?:gst(?:in)?|pan|mobile|mob|phone|ph|contact|tel|cell|invoice|inv|amount|date|ref|po|quoted?|previous|aadhaar|bank|account|ifsc)\b/i;
const cutAtStop = (s: string) => {
  const i = s.search(STOP);
  return i >= 0 ? s.slice(0, i) : s;
};
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/gi;
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/gi;
const MOBILE = /^[6-9]\d{9}$/;
const isMobile = (d: string) => MOBILE.test(d);
/** After a label, up to the end of its line (and before any "GST:", "Mobile:" ...). */
function segmentsAfter(t: string, label: RegExp): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(label)) out.push(cutAtStop(t.slice(m.index! + m[0].length).split('\n')[0]!));
  return out;
}

/**
 * Vendor ID from Accounts' reply: DIGITS ONLY, `vendorMinDigits` or more in a row (letters around it are dropped:
 * "AB12345" gives 12345). In order of trust:
 * 1. after "vendor id / no / number / code" (the rest of that line, before GST / mobile / quoted text);
 * 2. after a bare "code" or "id";
 * 3. a number followed by a dash and a name: "Zoho Book - 12589 - SRN MEDIA", "12589 - SRN MEDIA";
 * 4. a line that is only the number;
 * 5. the only 5 to 9 digit number in the whole reply (phone numbers, GSTIN, dates, years and amounts are not counted).
 * Two different numbers at the same level is REVIEW_REQUIRED. A number broken by decoration ("12***345") is only a
 * candidate for a person (REVIEW_REQUIRED), never saved on its own.
 */
export function extractVendorId(text: string, rules: ReplyRules = DEFAULT_RULES): CodeRead {
  const min = rules.vendorMinDigits;
  const max = rules.vendorMaxDigits;
  const t = text.replace(ID_RE, ' ').replace(GSTIN, ' ').replace(PAN, ' ');
  const cancelled = /(?<!not\s)\b(cancel+ed|cancellation|revoked|withdrawn|terminated|void(?:ed)?)\b/i.test(t);
  const run = new RegExp(`(?<!\\d)([A-Za-z]{1,6}[-_/]?)?(\\d{${min},${max}})(?!\\d)`, 'g');
  const flags: string[] = [];
  const pick = (seg: string) => {
    const hits: { raw: string; id: string }[] = [];
    for (const m of seg.matchAll(run)) {
      if (isMobile(m[2]!)) { flags.push('PHONE_LIKE'); continue; }
      hits.push({ raw: m[0], id: m[2]! });
      if (m[1]) flags.push('LETTERS_DROPPED');
    }
    return hits;
  };
  const finish = (hits: { raw: string; id: string }[], conf: number, how: string): CodeRead | null => {
    if (!hits.length) return null;
    const ids = uniq(hits.map((h) => h.id));
    if (cancelled) return read('CANCELLED', hits[0]!.raw, null, 0.9, 'The reply says the registration is cancelled: the ID is not confirmed', ids, ['CANCELLED']);
    if (ids.length > 1) return read('REVIEW_REQUIRED', hits.map((h) => h.raw).join(' / '), null, 0.4, `More than one vendor ID in the reply (${ids.join(', ')}): a person decides`, ids, ['MULTIPLE_CANDIDATES']);
    return read('EXTRACTED', hits[0]!.raw, ids[0]!, conf, how, ids, uniq(flags));
  };

  // 1 and 2: after a label.
  const l1 = /(?:vendor|supplier)[\s_]*(?:registration[\s_]*)?(?:id|no\.?|number|code)(?:[\s_]*(?:is(?![a-z])|:|=|#|-))?/gi;
  let segs = segmentsAfter(t, l1);
  if (!segs.length) {
    const l2 = /(?<![a-z])(?:code|id)(?![a-z])(?:[\s_]*(?:is(?![a-z])|:|=|#|-))?/gi;
    segs = [...t.matchAll(l2)].filter((m) => !/(?:project|client|gst|pan|mobile|est|order|invoice)\W{0,4}$/i.test(t.slice(Math.max(0, m.index! - 14), m.index!))).map((m) => cutAtStop(t.slice(m.index! + m[0].length).split('\n')[0]!));
  }
  if (segs.length) {
    const r = finish(segs.flatMap(pick), 0.95, 'Found after the words "vendor id"');
    if (r) return r;
    // Nothing long enough: a number broken by decoration is only offered to a person.
    for (const seg of segs) {
      const chain = seg.match(/\d+(?:[\s]*[*#@~_]+[\s]*\d+)+/);
      const joined = chain?.[0].replace(/\D/g, '') ?? '';
      if (chain && joined.length >= min && joined.length <= max) return read(cancelled ? 'CANCELLED' : 'REVIEW_REQUIRED', chain[0], joined, 0.4, `The number is broken by symbols (${chain[0]}): joined it reads ${joined}. Check it against the mail before saving`, [joined], ['RECONSTRUCTED']);
    }
    const frag = segs.join(' ').match(/\d+/);
    if (frag) return read('INVALID', frag[0], null, 0.2, `The vendor ID needs ${min} or more digits in a row (found ${frag[0].length})`, [], ['TOO_SHORT']);
    return read(cancelled ? 'CANCELLED' : 'NOT_FOUND', null, null, 0, 'No number after the words "vendor id"');
  }

  // 3 to 5: no label.
  const n = norm(t);
  const named = [...n.matchAll(new RegExp(`(?<![\\d.])(\\d{${min},${max}})(?![\\d.])\\s*[-–—:]\\s*(?=[A-Za-z])`, 'g'))].map((m) => ({ raw: m[0].trim(), id: m[1]! }));
  let r = finish(named, 0.8, 'A number followed by a name');
  if (r) return r;
  const only = n.split('\n').map((l) => l.trim()).filter((l) => new RegExp(`^\\d{${min},${max}}$`).test(l) && !isMobile(l)).map((l) => ({ raw: l, id: l }));
  r = finish(only, 0.7, 'A line holding only the number');
  if (r) return r;
  const loose = n
    .replace(/(?:₹|rs\.?|inr)\s*[\d,]+(?:\.\d+)?/gi, ' ')
    .replace(/\b\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\b/g, ' ') // amounts
    .replace(/\+?\d[\d\s-]{8,}\d/g, ' ') // phone numbers
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, ' ') // dates
    .replace(/\b(19|20)\d{2}\b/g, ' '); // years
  const nums = [...loose.matchAll(new RegExp(`(?<![\\d.])(\\d{${min},9})(?![\\d.])`, 'g'))].filter((m) => !isMobile(m[1]!)).map((m) => ({ raw: m[1]!, id: m[1]! }));
  r = finish(nums, 0.55, 'The only number of that size in the reply (no "vendor id" label)');
  if (r) return r;
  const short = loose.match(/(?<![\d.])\d{2,4}(?![\d.])/);
  return short && /vendor|id\b|registered|created/i.test(t) ? read('INVALID', short[0], null, 0.15, `The vendor ID needs ${min} or more digits in a row`, [], ['TOO_SHORT']) : read(cancelled ? 'CANCELLED' : 'NOT_FOUND', null, null, 0, 'No vendor ID in the reply');
}
export const findVendorNo = (text: string, rules: ReplyRules = DEFAULT_RULES): Found => toFound(extractVendorId(text, rules));

/** Whitespace is always a separator (a trailing space is lost in an env file); the other characters come from PROJECT_CODE_EST_SEPARATORS. */
const sepClass = (seps: string) => `[\\s${[...seps.replace(/\s/g, ''), '–', '—'].map((c) => (/\w/.test(c) ? c : `\\${c}`)).join('')}]`;
const PENDING_WORDS = /\b(pending|expected|awaiting|yet\s+to|not\s+yet|tentative|will\s+be|to\s+be\s+(?:created|generated|issued)|shortly|soon|once\s+approved)\b/i;

/**
 * Project code: 8 or more digits in a row; or the separate EST-<6 digits> pattern (est, Est, "EST - 457435", EST_457435 all
 * give EST-457435); or an extra configured pattern. Looked for after "project code / no / number / id", "code generated". EST
 * numbers without such a label are only taken when the same line says it was approved / created / generated, otherwise they are
 * estimate numbers (see findEstimates). Digits of dates, amounts and phone numbers are never joined or used. A line that says
 * "pending" / "expected" does not confirm anything (PENDING).
 */
export function extractProjectCode(text: string, rules: ReplyRules = DEFAULT_RULES): CodeRead {
  const t = text.replace(ID_RE, ' ');
  const sep = sepClass(rules.estSeparators);
  const estRe = new RegExp(`(?<![A-Za-z0-9])EST${sep}*(\\d+)(?![\\dA-Za-z])`, 'gi');
  const numRe = new RegExp(`(?<![A-Za-z0-9.])(\\d+)(?![A-Za-z0-9]|\\.\\d)`, 'g');
  const extra = rules.extraProjectPatterns.flatMap((p) => { try { return [new RegExp(p, 'gi')]; } catch { return []; } });
  const flags: string[] = [];
  type Hit = { raw: string; code: string; line: string };
  const scan = (seg: string, line: string, labelled: boolean): { good: Hit[]; bad: { raw: string; why: string }[] } => {
    const good: Hit[] = [];
    const bad: { raw: string; why: string }[] = [];
    let rest = seg;
    for (const re of extra) { for (const m of rest.matchAll(re)) good.push({ raw: m[0], code: m[0].toUpperCase().replace(/[\s_/]+/g, '-'), line }); rest = rest.replace(re, ' '); }
    for (const m of rest.matchAll(estRe)) {
      if (m[1]!.length === rules.estDigits) good.push({ raw: m[0], code: `EST-${m[1]}`, line });
      else bad.push({ raw: m[0], why: `An EST code needs exactly ${rules.estDigits} digits (found ${m[1]!.length})` });
    }
    rest = rest.replace(estRe, ' ');
    for (const m of rest.matchAll(numRe)) {
      const d = m[1]!;
      if (d.length >= rules.projectMinDigits && d.length <= rules.projectMaxDigits && (labelled || !isMobile(d))) good.push({ raw: d, code: d, line });
      else if (d.length > rules.projectMaxDigits) bad.push({ raw: d, why: `A project code has at most ${rules.projectMaxDigits} digits (found ${d.length})` });
      else if (d.length === rules.estDigits) bad.push({ raw: d, why: `A ${d.length}-digit number is only a project code with the EST prefix` });
      else if (d.length >= 4 && d.length < rules.projectMinDigits) bad.push({ raw: d, why: `A project code needs ${rules.projectMinDigits} or more digits in a row (found ${d.length})` });
    }
    return { good, bad };
  };

  const label = /project[\s_]*(?:code|no\.?|number|id)?(?:[\s_]*is(?![a-z]))?|code[\s_]*(?:generated|created|issued)|(?:generated|created|issued)[\s_]*code/gi;
  const good: Hit[] = [];
  const bad: { raw: string; why: string }[] = [];
  for (const m of t.matchAll(label)) {
    const line = t.slice(m.index!).split('\n')[0]!;
    const seg = cutAtStop(t.slice(m.index! + m[0].length).split('\n')[0]!);
    const r = scan(seg, line, true);
    good.push(...r.good);
    bad.push(...r.bad);
  }
  if (!good.length && !bad.length) {
    // No label: a lone 8+ digit number, or an EST code on a line that says it was approved / created / generated.
    const cleaned = t.replace(/(?:₹|rs\.?|inr)\s*[\d,]+(?:\.\d+)?/gi, ' ').replace(/\b\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\b/g, ' ').replace(/\+?\d[\d\s-]{8,}\d/g, ' ').replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, ' ');
    for (const line of cleaned.split('\n')) {
      const clean = plain(line);
      const r = scan(clean, clean, false);
      good.push(...r.good.filter((h) => !/^EST-/.test(h.code) || /\b(approved|created|generated|issued|code)\b/i.test(clean)));
      if (!r.good.length) bad.push(...r.bad.filter((b) => !/^\d+$/.test(b.raw)));
    }
    if (good.length) flags.push('UNLABELLED');
  }
  // A numeric project code next to EST numbers: the EST numbers are estimates that came with it (see findEstimates), not codes.
  const numeric = good.filter((h) => /^\d+$/.test(h.code));
  const used = numeric.length ? numeric : good;
  const codes = uniq(used.map((h) => h.code));
  if (codes.length) {
    const pending = used.some((h) => PENDING_WORDS.test(h.line));
    if (pending) return read('PENDING', used[0]!.raw, null, 0.9, 'The reply says the code is pending / expected: nothing is confirmed', codes, ['PENDING']);
    if (codes.length > 1) return read('REVIEW_REQUIRED', used.map((h) => h.raw).join(' / '), null, 0.4, `More than one project code in the reply (${codes.join(', ')}): a person decides`, codes, ['MULTIPLE_CANDIDATES']);
    return read('EXTRACTED', used[0]!.raw, codes[0]!, flags.includes('UNLABELLED') ? 0.6 : 0.95, flags.includes('UNLABELLED') ? 'The only project code in the reply (no "project code" label)' : 'Found after the words "project code"', codes, numeric.length && numeric.length < good.length ? [...flags, 'ESTIMATES_IGNORED'] : flags);
  }
  if (bad.length) return read('INVALID', bad[0]!.raw, null, 0.2, bad[0]!.why, [], ['INVALID_FORMAT']);
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
