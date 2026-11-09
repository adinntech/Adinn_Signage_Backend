/**
 * Reading a reply mail: which request it answers and which code it carries. Pure text functions (no database, no mailbox),
 * so every rule is unit-tested. A code is taken only when it is unambiguous; anything doubtful is left for a person.
 */

const ID_RE = /ADN-Signage-(prj|cli|cp|vnd)-(\d{7,})/gi;

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
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (/^(on .{5,200} wrote:?|-{2,}\s*(original message|forwarded message)\s*-{2,}|_{5,}|from:\s.+@.+|sent from my )/i.test(line)) break;
    if (/^--\s*$/.test(raw)) break;
    if (line.startsWith('>')) continue;
    lines.push(raw);
  }
  return lines.join('\n').trim();
}

const norm = (s: string) => s.replace(ID_RE, ' ').replace(/[ \t]+/g, ' ');
const uniq = <T,>(a: T[]) => [...new Set(a)];

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
