import { normalizeMobile } from '../../common/validators/contact';

/** Shape of the Zoho Books contact fields we read (everything else is ignored). */
export interface ZohoContact {
  contact_id: string;
  contact_name?: string;
  company_name?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  gst_no?: string;
  status?: string;
  industry_type?: string;
  billing_address?: { address?: string; street2?: string; city?: string; state?: string; zip?: string };
  contact_persons?: { first_name?: string; last_name?: string; email?: string; phone?: string; mobile?: string; designation?: string; is_primary_contact?: boolean }[];
}

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const MOBILE = /^[6-9]\d{9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (v: string | undefined, max: number) => (v ?? '').trim().slice(0, max) || undefined;
/** Zoho data is free text; anything that is not a valid 10-digit mobile or email is dropped rather than imported dirty. */
const mobile = (v?: string) => {
  const m = normalizeMobile(v ?? '');
  return MOBILE.test(m) ? m : undefined;
};
const email = (v?: string) => {
  const e = (v ?? '').trim().toLowerCase();
  return EMAIL.test(e) ? e : undefined;
};

/** Zoho's customer number: the digits before " - " in the contact name ("30196 - AGNI STEELS" -> "30196"). Used as the Client Code. */
export const customerNoOf = (contactName?: string) => /^\s*(\d{2,8})\s*-/.exec(contactName ?? '')?.[1];

/** Zoho Books contact -> fields of our Client record. */
export function toClientFields(z: ZohoContact) {
  const name = clean((z.company_name || z.contact_name || '').replace(/^\s*\d{2,8}\s*-\s*/, ''), 120) ?? 'Unnamed';
  const gst = (z.gst_no ?? '').trim().toUpperCase();
  const seenPhone = new Set<string>();
  const seenMail = new Set<string>();
  const contacts = (z.contact_persons ?? []).flatMap((p) => {
    const cName = [p.first_name, p.last_name].filter(Boolean).join(' ').trim().slice(0, 120);
    if (!cName) return [];
    const phone = mobile(p.mobile) ?? mobile(p.phone);
    const mail = email(p.email);
    // The client rules reject a mobile or email repeated inside one client's contact list.
    const dupPhone = !!phone && seenPhone.has(phone);
    const dupMail = !!mail && seenMail.has(mail);
    if (phone) seenPhone.add(phone);
    if (mail) seenMail.add(mail);
    return [{ name: cName, designation: clean(p.designation, 80), phone: dupPhone ? undefined : phone, email: dupMail ? undefined : mail, isPrimary: !!p.is_primary_contact }];
  });
  if (contacts.length && !contacts.some((c) => c.isPrimary)) contacts[0]!.isPrimary = true;
  const b = z.billing_address ?? {};
  return {
    name,
    email: email(z.email),
    industry: clean(z.industry_type, 120),
    address: clean([b.address, b.street2].filter(Boolean).join(', '), 500),
    city: clean(b.city, 80),
    state: clean(b.state, 80),
    pincode: /^\d{6}$/.test((b.zip ?? '').trim()) ? b.zip!.trim() : undefined,
    gstin: GSTIN.test(gst) ? gst : undefined,
    contacts,
    status: z.status === 'inactive' ? ('INACTIVE' as const) : ('ACTIVE' as const),
  };
}
