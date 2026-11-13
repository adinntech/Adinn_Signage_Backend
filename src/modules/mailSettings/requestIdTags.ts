/**
 * Request ID tags (pure, no database). New IDs read Adn-Signage-VenReg-13112601 (tag + ddmmyy + serial).
 * Older IDs (ADN-Signage-vnd-13112601 ...) are still in the database and in sent mails, so they are still recognised.
 */
export const REQUEST_ID_TAGS = { CLIENT_CODE: 'CliCode', PROJECT_CODE: 'ProCode', COMBINED_CODE: 'CliProCode', VENDOR_REGISTRATION: 'VenReg', VENDOR_RATE_APPROVAL: 'VenRate' } as const;
export type RequestIdType = keyof typeof REQUEST_ID_TAGS;
export type RequestKind = 'vendor' | 'rate' | 'code';

const LEGACY_TAGS: Record<string, RequestKind> = { prj: 'code', cli: 'code', cp: 'code', vnd: 'vendor', vap: 'rate' };
const NEW_KIND: Record<string, RequestKind> = { procode: 'code', clicode: 'code', cliprocode: 'code', venreg: 'vendor', venrate: 'rate' };
const NEW_SPELLING: Record<string, string> = Object.fromEntries(Object.values(REQUEST_ID_TAGS).map((t) => [t.toLowerCase(), t]));

/** Matches both spellings, any letter case. Group 1 = tag, group 2 = date + serial. */
export const REQUEST_ID_PATTERN = 'ADN-Signage-(prj|cli|cp|vnd|vap|procode|clicode|cliprocode|venreg|venrate)-(\\d{7,})';

/** The stored spelling of a tag found in a mail: old tags stay lower case, new tags use their CamelCase form. */
export function canonicalRequestId(tag: string, digits: string): string {
  const t = tag.toLowerCase();
  return NEW_SPELLING[t] ? `Adn-Signage-${NEW_SPELLING[t]}-${digits}` : `ADN-Signage-${t}-${digits}`;
}

/** Which workflow a request ID belongs to. */
export function requestKindOf(id: string): RequestKind {
  const tag = /^adn-signage-([a-z]+)-/i.exec(id)?.[1]?.toLowerCase() ?? '';
  return NEW_KIND[tag] ?? LEGACY_TAGS[tag] ?? 'code';
}
