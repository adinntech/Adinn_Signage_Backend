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
const EST_RE = /(?<![A-Z0-9])EST-?\d{3,10}(?!\d)/gi;
// Request IDs and estimate numbers are removed first, so their digits are never mistaken for a project code.
const norm = (s: string) => s.replace(ID_RE, ' ').replace(EST_RE, ' ').replace(/[ \t]+/g, ' ');
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

/** Vendor ID from Accounts: 2 to 8 digits after "vendor id / no / number / code", or a first line that is only the number. */
export function findVendorNo(text: string): Found {
  const t = norm(text);
  const labelled = [...t.matchAll(/vendor\s*(?:id|no\.?|number|code)\s*(?:is|:|-|=|#)?\s*(\d{2,8})(?!\d)/gi)].map((m) => m[1]!);
  if (labelled.length) return one(labelled);
  const first = t.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return /^\d{2,8}$/.test(first) ? { code: first, ambiguous: [] } : { code: null, ambiguous: [] };
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
export const snippetOf = (text: string, max = 300) => text.replace(/\s+/g, ' ').trim().slice(0, max);

export type Decision = 'APPROVED' | 'NOT_APPROVED';
/**
 * The answer to an amount approval request. "Not approved", "rejected", "declined" or "denied" win over "approved" (a reply
 * such as "not approved" contains the word approved). Both kinds of word, or neither, is left for a person (null).
 */
export function findDecision(text: string): Decision | null {
  const t = text.toLowerCase();
  const no = /\b(not\s+approved|disapproved|un-?approved|rejected|declined|denied|not\s+allowed|do\s+not\s+approve|don'?t\s+approve|no\s+approval)\b/.test(t);
  const yes = /\b(approved|approve|ok\s+to\s+proceed|go\s+ahead)\b/.test(t.replace(/\b(not\s+approved|disapproved|un-?approved|do\s+not\s+approve|don'?t\s+approve)\b/g, ' '));
  if (no && !yes) return 'NOT_APPROVED';
  if (yes && !no) return 'APPROVED';
  return null;
}
