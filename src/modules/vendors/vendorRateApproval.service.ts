import type { Types } from 'mongoose';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { DEFAULT_RATES } from '../costing/costing.calc';
import { CostPolicy } from '../costing/costing.model';
import { postSignageMail } from '../codeRequests/signageCodeMail';
import { newRequestId, subjectWithId } from '../mailSettings/requestId';
import { routingOf } from '../mailSettings/mailRouting.service';
import { User } from '../users/user.model';
import { VendorRateApproval } from './vendorRateApproval.model';

export interface Rates { ratePerShop: number | null; farRatePerShop: number | null }

/** The company rates the Super Admin set in Admin > Cost Rates: a vendor cost above these needs a yes from the approver. */
export async function companyRates(): Promise<{ ratePerShop: number; farRatePerShop: number }> {
  const p = await CostPolicy.findOne({ key: 'default' }).lean();
  const d = p as Record<string, unknown> | null;
  return { ratePerShop: Number(d?.vendorRatePerShop ?? DEFAULT_RATES.vendorRatePerShop), farRatePerShop: Number(d?.vendorFarRatePerShop ?? DEFAULT_RATES.vendorFarRatePerShop) };
}

/** Does the typed cost go above the company rate (near price against the near rate, far price against the far rate)? */
export const exceedsLimit = (typed: Rates, limit: { ratePerShop: number; farRatePerShop: number }) =>
  (typed.ratePerShop != null && typed.ratePerShop > limit.ratePerShop) || (typed.farRatePerShop != null && typed.farRatePerShop > limit.farRatePerShop);

/** What is applied when the approver does not approve: every typed price, capped at the company rate. */
export const cappedAtLimit = (typed: Rates, limit: { ratePerShop: number; farRatePerShop: number }): Rates => ({
  ratePerShop: typed.ratePerShop == null ? null : Math.min(typed.ratePerShop, limit.ratePerShop),
  farRatePerShop: typed.farRatePerShop == null ? null : Math.min(typed.farRatePerShop, limit.farRatePerShop),
});

/** The vendor's known details (empty ones are left out). */
export interface VendorInfo { email?: string | null | undefined; mobile?: string | null | undefined; gstin?: string | null | undefined; pan?: string | null | undefined; city?: string | null | undefined; address?: string | null | undefined; createdByName?: string | null | undefined; contactCode?: string | null | undefined }
const compact = (i: VendorInfo = {}) => Object.fromEntries(Object.entries(i).filter(([, v]) => typeof v === 'string' && v.trim())) as Record<string, string>;

interface RequestInput {
  zohoContactId: string;
  vendor?: { _id: Types.ObjectId; name?: string | null; zohoVendorNo?: string | null } | null;
  vendorName: string;
  vendorNo?: string | null;
  info?: VendorInfo;
  requested: Rates;
  limit: { ratePerShop: number; farRatePerShop: number };
  current: Rates;
}

const rupees = (n: number | null | undefined) => (n == null ? '-' : `₹${n}`);

/**
 * Records the request and mails the approver (Admin > Mail settings > Vendor amount approval). If the mail cannot go, nothing is
 * kept and the error is raised, so a cost is never left waiting for a mail that was not sent.
 */
export async function requestRateApproval(input: RequestInput, actor: Actor) {
  const routing = await routingOf('VENDOR_RATE_APPROVAL');
  if (!routing.to.length) throw AppError.conflict('This cost is above the company rate and needs approval, but nobody is set to approve it. Set the recipients in Admin > Mail settings > Vendor amount approval.');
  const by = await User.findById(actor.id).select('name').lean();
  // A newer request for the same vendor takes over from one that is still waiting.
  await VendorRateApproval.updateMany({ zohoContactId: input.zohoContactId, status: 'PENDING' }, { $set: { status: 'REPLACED', decidedAt: new Date(), decidedBy: 'Replaced by a newer request' } });
  const requestId = await newRequestId('VENDOR_RATE_APPROVAL');
  const now = new Date();
  const row = await VendorRateApproval.create({
    requestId,
    zohoContactId: input.zohoContactId,
    ...(input.vendor ? { vendor: input.vendor._id } : {}),
    vendorName: input.vendorName,
    ...(input.vendorNo ? { vendorNo: input.vendorNo } : {}),
    info: compact(input.info),
    requested: input.requested,
    limit: { ratePerShop: input.limit.ratePerShop, farRatePerShop: input.limit.farRatePerShop },
    current: input.current,
    requestedBy: actor.id,
    requestedByName: by?.name,
    to: routing.to,
    cc: routing.cc,
    bcc: routing.bcc,
  });
  try {
    await postSignageMail({
      mailtype: 'rateapproval',
      toEmail: routing.to,
      ccEmail: routing.cc,
      ...(routing.bcc.length ? { bccEmail: routing.bcc } : {}),
      subject: subjectWithId(`Vendor amount approval - ${input.vendorName}`, requestId),
      requestId,
      requestDate: now.toISOString(),
      source: 'Operations Team',
      ...(routing.replyTo ? { replyTo: routing.replyTo } : {}),
      vendor: { vendorName: input.vendorName, vendorNo: input.vendorNo ?? '', ...compact(input.info) },
      amounts: {
        requestedRate: rupees(input.requested.ratePerShop),
        requestedFar: rupees(input.requested.farRatePerShop),
        limitRate: rupees(input.limit.ratePerShop),
        limitFar: rupees(input.limit.farRatePerShop),
        currentRate: rupees(input.current.ratePerShop),
        currentFar: rupees(input.current.farRatePerShop),
        requestedBy: by?.name ?? '',
      },
    });
  } catch (e) {
    await VendorRateApproval.deleteOne({ _id: row._id });
    throw new AppError(502, 'MAIL_FAILED', `The approval mail could not be sent: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`);
  }
  await VendorRateApproval.updateOne({ _id: row._id }, { $set: { sentAt: new Date() } });
  return (await VendorRateApproval.findById(row._id).lean())!;
}

/** The latest request of each Zoho vendor that was not replaced (waiting, approved or not approved), with its history, for the status tag and the status change. */
export async function latestApprovals(contactIds: string[]) {
  const rows = await VendorRateApproval.find({ zohoContactId: { $in: contactIds }, status: { $ne: 'REPLACED' } }).sort({ createdAt: -1 }).lean();
  const out = new Map<string, {
    requestId: string; status: string; ratePerShop: number | null; farRatePerShop: number | null; limitRate: number | null; limitFar: number | null;
    appliedRate: number | null; appliedFar: number | null; decidedAt?: Date; decidedBy?: string;
    history: { at?: Date; receivedAt?: Date; from?: string; snippet?: string; outcome?: string }[];
  }>();
  for (const r of rows) {
    if (out.has(r.zohoContactId)) continue;
    out.set(r.zohoContactId, {
      requestId: r.requestId, status: r.status ?? 'PENDING', ratePerShop: r.requested.ratePerShop ?? null, farRatePerShop: r.requested.farRatePerShop ?? null,
      limitRate: r.limit.ratePerShop ?? null, limitFar: r.limit.farRatePerShop ?? null, appliedRate: r.applied?.ratePerShop ?? null, appliedFar: r.applied?.farRatePerShop ?? null,
      decidedAt: r.decidedAt ?? undefined, decidedBy: r.decidedBy ?? undefined, history: (r.history ?? []).map((h) => ({ at: h.at ?? undefined, receivedAt: h.receivedAt ?? undefined, from: h.from ?? undefined, snippet: h.snippet ?? undefined, outcome: h.outcome ?? undefined })),
    });
  }
  return out;
}

/** The waiting request of each Zoho vendor (for the "waiting for approval" tag in Vendor master). */
export async function pendingApprovals(contactIds: string[]) {
  const rows = await VendorRateApproval.find({ zohoContactId: { $in: contactIds }, status: 'PENDING' }).lean();
  return new Map(rows.map((r) => [r.zohoContactId, { requestId: r.requestId, ratePerShop: r.requested.ratePerShop ?? null, farRatePerShop: r.requested.farRatePerShop ?? null, limitRate: r.limit.ratePerShop ?? null, limitFar: r.limit.farRatePerShop ?? null, requestedAt: r.createdAt ?? null }]));
}
