import { AppError } from '../../common/errors';
import { env } from '../../config/env';

/**
 * Existing clients come from Zoho (Books contacts or CRM Accounts, set by ZOHO_PRODUCT). Until the OAuth keys are in
 * the environment a fixed sample list is served, so Order Management and Lead Management work the same either way.
 *
 * NOTE: the live field mapping below follows Zoho's documented APIs and must be checked against the real account the
 * first time the keys are added (custom fields such as GST in CRM differ per account).
 */
export interface ZohoClient {
  zohoId: string;
  /** Company name. */
  name: string;
  /** Contact / client name shown with the company, when Zoho has one. */
  clientName?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  gstin?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
}

export const zohoMode = (): 'live' | 'sample' => (env.zohoCustomersLive ? 'live' : 'sample');

const SAMPLE: ZohoClient[] = [
  { zohoId: 'sample-1001', name: 'Aditya Birla Fashion and Retail Ltd', clientName: 'Suresh Kumar', email: 'accounts@abfrl.example.com', phone: '02266917000', gstin: '27AAACP7247N1ZS', city: 'Mumbai', state: 'Maharashtra' },
  { zohoId: 'sample-1002', name: 'Asian Paints Limited', clientName: 'Meena Iyer', email: 'marketing@asianpaints.example.com', phone: '02262181000', gstin: '27AAACA3622K1ZN', city: 'Mumbai', state: 'Maharashtra' },
  { zohoId: 'sample-1003', name: 'Britannia Industries Limited', clientName: 'Rahul Nair', email: 'trade@britannia.example.com', phone: '08039400080', gstin: '29AAACB2066P1ZK', city: 'Bengaluru', state: 'Karnataka' },
  { zohoId: 'sample-1004', name: 'Dalmia Cement (Bharat) Limited', clientName: 'Karthikeyan R', email: 'brand@dalmia.example.com', phone: '04423457100', gstin: '33AAACD3765G1ZB', city: 'Chennai', state: 'Tamil Nadu' },
  { zohoId: 'sample-1005', name: 'Havells India Limited', clientName: 'Pooja Sharma', email: 'btl@havells.example.com', phone: '01203331000', gstin: '09AAACH0351E1ZX', city: 'Noida', state: 'Uttar Pradesh' },
  { zohoId: 'sample-1006', name: 'Kansai Nerolac Paints Limited', clientName: 'Vivek Menon', email: 'dealers@nerolac.example.com', phone: '02224934001', gstin: '27AAACK2829M1Z5', city: 'Mumbai', state: 'Maharashtra' },
  { zohoId: 'sample-1007', name: 'Polycab India Limited', clientName: 'Anand Raj', email: 'signage@polycab.example.com', phone: '02267351400', gstin: '24AAACP8213F1ZE', city: 'Vadodara', state: 'Gujarat' },
  { zohoId: 'sample-1008', name: 'Ramco Cements Limited', clientName: 'Senthil Kumar', email: 'marketing@ramco.example.com', phone: '04428478666', gstin: '33AAACT5131A1Z9', city: 'Chennai', state: 'Tamil Nadu' },
  { zohoId: 'sample-1009', name: 'Saint-Gobain India Private Limited', clientName: 'Divya Prakash', email: 'retail@saint-gobain.example.com', phone: '04466291000', gstin: '33AAACS6574L1ZU', city: 'Chennai', state: 'Tamil Nadu' },
  { zohoId: 'sample-1010', name: 'TVS Motor Company Limited', clientName: 'Arun Prasad', email: 'dealer.branding@tvs.example.com', phone: '04428332115', gstin: '33AAACT2307Q1ZW', city: 'Chennai', state: 'Tamil Nadu' },
  { zohoId: 'sample-1011', name: 'UltraTech Cement Limited', clientName: 'Rasic Ahamed', email: 'rasic@ultratech.example.com', phone: '02266917800', gstin: '27AAACL6442L1ZB', city: 'Mumbai', state: 'Maharashtra' },
  { zohoId: 'sample-1012', name: 'V-Guard Industries Limited', clientName: 'Joseph Mathew', email: 'brand@vguard.example.com', phone: '04844335000', gstin: '32AABCV1281A1ZL', city: 'Kochi', state: 'Kerala' },
];

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const cleanGstin = (v: unknown) => {
  const g = clean(v)?.toUpperCase();
  return g && GSTIN.test(g) ? g : undefined;
};
const digits = (v: unknown) => {
  const d = clean(v)?.replace(/\D/g, '');
  return d && d.length >= 10 ? d.slice(-12) : undefined;
};

/* ------------------------------- OAuth token ------------------------------- */

let token: { value: string; expiresAt: number } | null = null;

async function accessToken() {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const url = new URL(`https://accounts.zoho.${env.ZOHO_DC}/oauth/v2/token`);
  url.search = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN!,
    client_id: env.ZOHO_CLIENT_ID!,
    client_secret: env.ZOHO_CLIENT_SECRET!,
    grant_type: 'refresh_token',
  }).toString();
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15_000) }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { access_token?: string; expires_in?: number; error?: string } | null;
  if (!res?.ok || !body?.access_token) throw new AppError(502, 'ZOHO_ERROR', `Could not sign in to Zoho${body?.error ? ` (${body.error})` : ''}. Check the Zoho keys.`);
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return token.value;
}

async function zohoGet<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const url = new URL(`https://www.zohoapis.${env.ZOHO_DC}${path}`);
  url.search = new URLSearchParams(params).toString();
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${await accessToken()}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res) throw new AppError(502, 'ZOHO_ERROR', 'Zoho did not answer. Try again in a moment.');
  if (res.status === 204 || res.status === 404) return null; // CRM search with no match answers 204
  if (res.status === 401) token = null;
  if (!res.ok) throw new AppError(502, 'ZOHO_ERROR', `Zoho returned an error (${res.status}). Try again in a moment.`);
  return (await res.json()) as T;
}

/* --------------------------------- mapping --------------------------------- */

type BooksContact = { contact_id: string; contact_name?: string; company_name?: string; email?: string; phone?: string; mobile?: string; gst_no?: string; billing_address?: { city?: string; state?: string } };
const fromBooks = (c: BooksContact): ZohoClient => {
  const company = clean(c.company_name) ?? clean(c.contact_name) ?? 'Unnamed customer';
  const person = clean(c.contact_name);
  return {
    zohoId: String(c.contact_id),
    name: company,
    clientName: person && person !== company ? person : undefined,
    email: clean(c.email)?.toLowerCase(),
    phone: digits(c.phone) ?? digits(c.mobile),
    gstin: cleanGstin(c.gst_no),
    city: clean(c.billing_address?.city),
    state: clean(c.billing_address?.state),
  };
};

type CrmAccount = { id: string; Account_Name?: string; Phone?: string; Email?: string; GSTIN?: string; GST_No?: string; Billing_City?: string; Billing_State?: string };
const fromCrm = (a: CrmAccount): ZohoClient => ({
  zohoId: String(a.id),
  name: clean(a.Account_Name) ?? 'Unnamed account',
  email: clean(a.Email)?.toLowerCase(),
  phone: digits(a.Phone),
  gstin: cleanGstin(a.GSTIN ?? a.GST_No),
  city: clean(a.Billing_City),
  state: clean(a.Billing_State),
});

/* --------------------------------- queries --------------------------------- */

/** Up to 25 Zoho customers matching `q` (company or contact name), A-Z. */
export async function searchZohoClients(q: string): Promise<ZohoClient[]> {
  const term = q.trim();
  if (!env.zohoCustomersLive) {
    const t = term.toLowerCase();
    return SAMPLE.filter((c) => !t || c.name.toLowerCase().includes(t) || c.clientName?.toLowerCase().includes(t) || c.gstin?.toLowerCase().includes(t)).slice(0, 25);
  }
  if (env.ZOHO_PRODUCT === 'books') {
    if (!env.ZOHO_ORG_ID) throw new AppError(502, 'ZOHO_ERROR', 'ZOHO_ORG_ID is not set for Zoho Books.');
    const r = await zohoGet<{ contacts?: BooksContact[] }>('/books/v3/contacts', {
      organization_id: env.ZOHO_ORG_ID,
      contact_type: 'customer',
      filter_by: 'Status.Active',
      sort_column: 'contact_name',
      per_page: '25',
      ...(term ? { search_text: term } : {}),
    });
    return (r?.contacts ?? []).map(fromBooks);
  }
  // CRM search needs at least two characters; without a term the first page of Accounts is listed.
  const r =
    term.length >= 2
      ? await zohoGet<{ data?: CrmAccount[] }>('/crm/v2/Accounts/search', { word: term, per_page: '25' })
      : await zohoGet<{ data?: CrmAccount[] }>('/crm/v2/Accounts', { per_page: '25', sort_by: 'Account_Name', sort_order: 'asc' });
  return (r?.data ?? []).map(fromCrm);
}

/** One Zoho customer by id (null when Zoho no longer has it). */
export async function getZohoClient(zohoId: string): Promise<ZohoClient | null> {
  if (!env.zohoCustomersLive) return SAMPLE.find((c) => c.zohoId === zohoId) ?? null;
  if (env.ZOHO_PRODUCT === 'books') {
    if (!env.ZOHO_ORG_ID) throw new AppError(502, 'ZOHO_ERROR', 'ZOHO_ORG_ID is not set for Zoho Books.');
    const r = await zohoGet<{ contact?: BooksContact }>(`/books/v3/contacts/${encodeURIComponent(zohoId)}`, { organization_id: env.ZOHO_ORG_ID });
    return r?.contact ? fromBooks(r.contact) : null;
  }
  const r = await zohoGet<{ data?: CrmAccount[] }>(`/crm/v2/Accounts/${encodeURIComponent(zohoId)}`, {});
  return r?.data?.[0] ? fromCrm(r.data[0]) : null;
}
