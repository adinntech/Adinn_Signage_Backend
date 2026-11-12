/**
 * The city of a Zoho vendor. Zoho's own billing city is used when it is filled and usable; many vendors only have a full address
 * that ends with the city ("No.6, Pasumpon Thevar Street, Ellis Nagar, Madurai -625010"), so the city is read from the end of it.
 */

/** Different spellings of one city read as one. */
const CANON: Record<string, string> = {
  bangalore: 'Bengaluru', bangaluru: 'Bengaluru', bengaluru: 'Bengaluru', bengalore: 'Bengaluru', bengalaru: 'Bengaluru',
  chengai: 'Chengalpattu', chengalpet: 'Chengalpattu', chengalpattu: 'Chengalpattu',
  'new delhi': 'New Delhi', delhi: 'New Delhi', noida: 'Noida', gurgaon: 'Gurugram', gurugram: 'Gurugram',
  madras: 'Chennai', chennai: 'Chennai', madurai: 'Madurai', mumbai: 'Mumbai', bombay: 'Mumbai', thane: 'Thane', pune: 'Pune',
  trichy: 'Tiruchirappalli', tiruchirappalli: 'Tiruchirappalli', tiruchi: 'Tiruchirappalli', coimbatore: 'Coimbatore', kovai: 'Coimbatore',
  tuticorin: 'Thoothukudi', thoothukudi: 'Thoothukudi', pondicherry: 'Puducherry', puducherry: 'Puducherry',
  hyderabad: 'Hyderabad', kolkata: 'Kolkata', calcutta: 'Kolkata', ahmedabad: 'Ahmedabad', ahmadabad: 'Ahmedabad', jaipur: 'Jaipur',
  salem: 'Salem', erode: 'Erode', tirunelveli: 'Tirunelveli', nellai: 'Tirunelveli', dindigul: 'Dindigul', theni: 'Theni', karur: 'Karur',
  vellore: 'Vellore', tiruppur: 'Tiruppur', thanjavur: 'Thanjavur', kochi: 'Kochi', cochin: 'Kochi', trivandrum: 'Thiruvananthapuram',
  thiruvananthapuram: 'Thiruvananthapuram', mysore: 'Mysuru', mysuru: 'Mysuru', hosur: 'Hosur', virudhunagar: 'Virudhunagar',
  sivakasi: 'Sivakasi', kanyakumari: 'Kanyakumari', nagercoil: 'Nagercoil', ramanathapuram: 'Ramanathapuram', sivagangai: 'Sivaganga',
  sivaganga: 'Sivaganga', pudukkottai: 'Pudukkottai', kumbakonam: 'Kumbakonam', tiruvallur: 'Tiruvallur', kanchipuram: 'Kanchipuram',
};
const KNOWN = new RegExp(`\\b(${Object.keys(CANON).sort((a, b) => b.length - a.length).map((k) => k.replace(/ /g, '\\s+')).join('|')})\\b`, 'i');

const STATES = ['tamil nadu', 'tamilnadu', 'tn', 'karnataka', 'kerala', 'andhra pradesh', 'telangana', 'maharashtra', 'delhi', 'gujarat', 'uttar pradesh', 'west bengal', 'rajasthan', 'haryana', 'punjab', 'odisha', 'madhya pradesh', 'bihar', 'goa', 'puducherry', 'india'];
/** A part of an address that is a street, a building or a locality, not a city. */
const NOT_CITY = /\b(street|st|road|rd|nagar|hotel|floor|main|cross|colony|avenue|plot|no|door|opp|opposite|near|complex|building|bldg|tower|market|bazaar|bazar|stand|lane|layout|extension|ext|park|garden|city|post|po|dist|district|taluk|village|village|ward|sector|phase|block|cell|mobile|phone|ph|tel)\b/i;

const title = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());

/** One piece of text read as a city: a known city anywhere in it, otherwise the last word group after any hyphen. Null when it is not a city. */
export function canonicalCity(raw?: string | null): string | null {
  const text = (raw ?? '').replace(/[^\p{L}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const hit = KNOWN.exec(text);
  if (hit) return CANON[hit[1]!.toLowerCase().replace(/\s+/g, ' ')] ?? null;
  const piece = text.split('-').map((p) => p.trim()).filter(Boolean).pop() ?? '';
  if (piece.replace(/\s/g, '').length < 3 || piece.split(' ').length > 3 || NOT_CITY.test(piece)) return null;
  return title(piece);
}

/** The city at the end of a full address: pin code, country and state are taken off, then the last part that is a city. */
export function cityFromAddress(address?: string | null): string | null {
  if (!address) return null;
  const parts = address
    .replace(/\b\d{3}\s?\d{3}\b/g, ' ')
    .split(/[,\n;|]|\s-\s|-(?=\s|$)/)
    .map((p) => p.replace(/[^\p{L}\s.-]/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 1);
  while (parts.length && STATES.includes(parts[parts.length - 1]!.toLowerCase().replace(/\./g, ''))) parts.pop();
  for (let i = parts.length - 1; i >= Math.max(0, parts.length - 3); i--) {
    const c = canonicalCity(parts[i]);
    if (c) return c;
  }
  return null;
}

export function cityOf(billingCity?: string | null, address?: string | null): string | null {
  return canonicalCity(billingCity) ?? cityFromAddress(address);
}
