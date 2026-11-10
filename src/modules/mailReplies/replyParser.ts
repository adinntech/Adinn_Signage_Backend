/**
 * Reading a reply mail: which request it answers and which code it carries. Pure text functions (no database, no mailbox),
 * so every rule is unit-tested. A code is taken only when it is unambiguous; anything doubtful is left for a person.
 */

const ID_RE = /ADN-Signage-(prj|cli|cp|vnd|vap)-(\d{7,})/gi;

/** Every request ID mentioned (normalised to the stored spelling), first mention first. */
export function requestIdsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ID_RE)) {
    const id = `ADN-Signage-${m[1]!.toLowerCase()}-${m[2]}`;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Only what the person wrote: drops quoted lines, "On ... wrote:" blocks, forwarded headers and signatures after "-- ". */
export function freshText(text: string): string {
  const lines: string[] = [];
  let body = text.replace(/\r\n/g, '\n');
  // Gmail wraps the "On ... wrote:" line over two lines, so cut at it before reading line by line.
  const cut = body.search(/(^|\n)[ \t]*On [^\n]{5,200}(\n[^\n]{0,200})?[ \t]+wrote:/i);
  if (cut >= 0) body = body.slice(0, cut);
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (/^(on .{5,200} wrote:?|-{2,}\s*(original message|forwarded message)\s*-{2,}|_{5,}|from:\s.+@.+|sent from my )/i.test(line)) break;
    if (/^--\s*$/.test(raw)) break;
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
const one = (all: string[]): Found => {
  const u = uniq(all);
  return u.length === 1 ? { code: u[0]!, ambiguous: [] } : { code: null, ambiguous: u };
};

/** Project code: 8 digits. Prefers "project code ... 12345678"; else a lone 8-digit number. Request ID digits are ignored. */
export function findProjectCode(text: string): Found {
  const t = norm(text);
  const labelled = [...t.matchAll(/project\s*(?:code|no\.?|number|id)?\s*(?:is|:|-|=|#)?\s*(\d{8})(?!\d)/gi)].map((m) => m[1]!);
  if (labelled.length) return one(labelled);
  return one([...t.matchAll(/(?<![\d.])(\d{8})(?![\d.])/g)].map((m) => m[1]!));
}

/** Client code: letters, digits and dashes (3 to 20, at least one digit). Only taken after the words "client code". */
export function findClientCode(text: string): Found {
  const t = norm(text);
  const all = [...t.matchAll(/client\s*(?:code|id|no\.?|number)\s*(?:is|:|-|=|#)?\s*([A-Z0-9][A-Z0-9-]{2,19})(?![A-Z0-9-])/gi)].map((m) => m[1]!.toUpperCase()).filter((c) => /\d/.test(c));
  return one(all);
}

/**
 * Vendor ID from Accounts (2 to 8 digits). In order of trust:
 * 1. after "vendor id / no / number / code";
 * 2. a number followed by a dash and a name: "Zoho Book - 12589 - SRN MEDIA", "12589 - SRN MEDIA";
 * 3. a line that is only the number;
 * 4. the only 4 to 8 digit number in the whole reply (phone numbers, dates and years are not counted).
 * Two different numbers at the same level is ambiguous: nothing is picked and a person decides.
 */
export function findVendorNo(text: string): Found {
  const t = norm(text);
  const labelled = [...t.matchAll(/vendor\s*(?:id|no\.?|number|code)\s*(?:is|:|-|=|#)?\s*(\d{2,8})(?!\d)/gi)].map((m) => m[1]!);
  if (labelled.length) return one(labelled);
  const named = [...t.matchAll(/(?<![\d.])(\d{3,8})(?![\d.])\s*[-–—:]\s*(?=[A-Za-z])/g)].map((m) => m[1]!);
  if (named.length) return one(named);
  const only = t.split('\n').map((l) => l.trim()).filter((l) => /^\d{2,8}$/.test(l));
  if (only.length) return one(only);
  const loose = t
    .replace(/\+?\d[\d\s-]{8,}\d/g, ' ') // phone numbers
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, ' ') // dates
    .replace(/\b(19|20)\d{2}\b/g, ' '); // years
  const nums = [...loose.matchAll(/(?<![\d.])(\d{4,8})(?![\d.])/g)].map((m) => m[1]!);
  return nums.length ? one(nums) : { code: null, ambiguous: [] };
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
const NO_STRONG = /\b(not\s+approved|not\s+approve|disapproved?|un-?approved|reject(?:ed|s)?|declined?|denied|deny|refused?|not\s+allowed|not\s+ok(?:ay)?|not\s+agreed|cancel(?:led)?|do\s+not\s+approve|don'?t\s+approve|no\s+approval|not\s+accepted|(?:did\s+not|didn'?t|does\s+not|doesn'?t|will\s+not|won'?t|cannot|can'?t|never|not)\s+(?:\w+\s+)?(?:approve|accept|agree|allow|sanction|grant))\b/;
const NO_WEAK = /\b(do\s+not\s+proceed|don'?t\s+proceed|hold\s+on|on\s+hold|not\s+now|no\s+need)\b/;
const YES_STRONG = /\b(approved|approve|accepted|accept|agreed|confirmed|ok|okay|sanctioned|granted)\b/;
const YES_WEAK = /\b(proceed|go\s+ahead|fine|sure|done|yes|alright|good\s+to\s+go|allowed)\b/;
/**
 * The answer to an amount approval request ("Approved", "OK, proceed", "approved after some time", "Rejected", "Not approved"...).
 * "Not approved" contains the word approved, so negatives are cut out first. A strong yes and a strong no together, or no
 * decision word at all, is left for a person (null).
 */
export function findDecision(text: string): Decision | null {
  // A question ("Are you sure? Do you want to approve?") is not an answer, so sentences ending in ? are left out.
  const t = text.toLowerCase().replace(/[^.\n]*\?/g, ' ').replace(/\s+/g, ' ');
  const noS = NO_STRONG.test(t);
  const yesS = YES_STRONG.test(t.replace(new RegExp(NO_STRONG.source, 'g'), ' '));
  if (noS && yesS) return null;
  if (noS) return 'NOT_APPROVED';
  if (yesS) return NO_WEAK.test(t) ? null : 'APPROVED';
  const noW = NO_WEAK.test(t);
  const yesW = YES_WEAK.test(t.replace(new RegExp(NO_WEAK.source, 'g'), ' '));
  if (noW && !yesW) return 'NOT_APPROVED';
  if (yesW && !noW) return 'APPROVED';
  return null;
}
