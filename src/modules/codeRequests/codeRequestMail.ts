import { htmlToText } from '../../common/html';
import type { CodeKind } from './codeRequest.model';
import type { SignageCodeMailInput, SignageMailType } from './signageCodeMail';

/** What the PHP mail template needs about the client and order; everything is read from the CRM, nothing is retyped. */
export interface CodeMailSource {
  order: { orderNo: string; declaredShopTotal?: number | null; shopList?: { total?: number | null } | null; handoverNotes?: string | null };
  client: {
    name?: string | null;
    clientNo?: string | null;
    gstin?: string | null;
    address?: string | null;
    email?: string | null;
    phone?: string | null;
    approvedCode?: string | null;
    onboarding?: { pan?: string | null } | null;
    contacts?: { name?: string | null; email?: string | null; phone?: string | null; isPrimary?: boolean | null }[] | null;
  };
}

export const signageMailTypeOf = (kinds: CodeKind[]): SignageMailType => (kinds.length === 2 ? 'combined' : kinds[0] === 'CLIENT_CODE' ? 'client' : 'project');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 30 Oct 2026 (the format the mail template prints). */
export const mailDate = (d = new Date()) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/** Stable per email, so a retry of a failed email carries the same Request ID. */
export const requestIdOf = (mailBatchId: string) => `REQ-${mailBatchId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

const clean = (v?: string | null) => (v ?? '').trim() || undefined;

/**
 * The structured fields for one code request email. The project is not created yet at this stage, so its name is the
 * client and order number; type and business unit are fixed for the Signage CRM. `bodyHtml` is the text Client Servicing
 * typed in the composer: it goes out as "Additional Notes".
 */
export function buildCodeMail(src: CodeMailSource, kinds: CodeKind[], mailBatchId: string, bodyHtml: string): SignageCodeMailInput {
  const { order, client } = src;
  const primary = client.contacts?.find((c) => c.isPrimary) ?? client.contacts?.[0];
  const shops = order.declaredShopTotal ?? order.shopList?.total ?? null;
  const description = [shops ? `Total shops: ${shops}` : '', clean(order.handoverNotes) ?? ''].filter(Boolean).join('. ');
  const note = htmlToText(bodyHtml).trim();
  return {
    mailType: signageMailTypeOf(kinds),
    requestId: requestIdOf(mailBatchId),
    requestDate: mailDate(),
    source: 'Client Servicing Team',
    ...(note ? { message: note } : {}),
    client: {
      clientName: clean(client.name),
      clientCode: clean(client.approvedCode),
      contactPerson: clean(primary?.name),
      email: clean(primary?.email) ?? clean(client.email),
      phone: clean(primary?.phone) ?? clean(client.phone),
      gstNumber: clean(client.gstin),
      panNumber: clean(client.onboarding?.pan),
      address: clean(client.address),
    },
    ...(kinds.includes('PROJECT_CODE')
      ? { project: { projectName: `${client.name ?? 'Client'} - ${order.orderNo}`, projectType: 'Signage', businessUnit: 'Signage Solutions', ...(description ? { description } : {}) } }
      : {}),
  };
}
