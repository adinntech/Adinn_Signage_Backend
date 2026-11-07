import { AppError } from '../../common/errors';
import { zohoGet } from './zoho.client';
import { customerNoOf } from './zoho.mapper';

/** The fields of a Zoho Books estimate used here; `reference_number` is the project code. */
export interface ZohoEstimate {
  estimate_id: string;
  estimate_number?: string;
  reference_number?: string;
  customer_id?: string;
  customer_name?: string;
  date?: string;
  total?: number;
  status?: string;
  status_formatted?: string;
  salesperson_name?: string;
  location_name?: string;
}

/** Whose estimates: the Zoho contact id (exact) or, without one, the Zoho customer number (e.g. 31859). */
export interface EstimateOwner {
  contactId?: string | null;
  customerNo?: string | null;
}

const PER_PAGE = 200;
/** One client rarely has more than a few estimates; at most 5 pages (1000) are read. */
const MAX_PAGES = 5;

/** A token without the ZohoBooks.estimates.READ scope gets "You are not authorized to perform this operation". */
function scopeError(e: unknown): never {
  if (e instanceof AppError && e.code === 'ZOHO_ERROR' && /not authori[sz]ed/i.test(e.message)) {
    throw new AppError(502, 'ZOHO_SCOPE_MISSING', 'The Zoho project code token cannot read estimates. Put a ZOHO_ACCESS_TOKEN_projectcode with the ZohoBooks.estimates.READ scope in the backend .env.');
  }
  throw e;
}

export const belongsTo = (e: ZohoEstimate, owner: EstimateOwner) =>
  owner.contactId ? e.customer_id === owner.contactId : !!owner.customerNo && customerNoOf(e.customer_name) === owner.customerNo;

/** Every estimate of one client (all statuses), newest first. */
export async function listClientEstimates(owner: EstimateOwner): Promise<ZohoEstimate[]> {
  if (!owner.contactId && !owner.customerNo) return [];
  const filter = owner.contactId ? { customer_id: owner.contactId } : { search_text: owner.customerNo! };
  const all: ZohoEstimate[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await zohoGet<{ estimates?: ZohoEstimate[]; page_context?: { has_more_page?: boolean } }>('/estimates', {
      ...filter,
      page,
      per_page: PER_PAGE,
      sort_column: 'date',
      sort_order: 'D',
    }, 'v3', 'projectcode').catch(scopeError);
    all.push(...(r.estimates ?? []));
    if (!r.page_context?.has_more_page) break;
  }
  // search_text also matches other text (notes, reference numbers): only this customer's rows are kept.
  return all.filter((e) => belongsTo(e, owner));
}

/** One estimate, read again from Zoho when the codes are saved. */
export async function getZohoEstimate(estimateId: string): Promise<ZohoEstimate> {
  const r = await zohoGet<{ estimate: ZohoEstimate }>(`/estimates/${encodeURIComponent(estimateId)}`, {}, 'v3', 'projectcode').catch(scopeError);
  return r.estimate;
}
