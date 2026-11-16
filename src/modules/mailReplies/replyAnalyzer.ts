import { DEFAULT_RULES, extractAmounts, extractProjectCode, extractVendorId, freshText, htmlToText, readDecision, requestIdsIn, senderAllowed, type ReplyRules } from './replyParser';

/**
 * One function that reads a reply the way the CRM does, for the three mail workflows, and says what it found and why. It is pure
 * (no database, no mailbox, no mail sent), so the automated test suite and the admin Email Reply Test Lab both use it and can
 * never update a live record. The live reader (mailReply.service) uses the same parser functions.
 */
export type Workflow = 'VENDOR_ID' | 'RATE_APPROVAL' | 'PROJECT_CODE';
export const WORKFLOWS: readonly Workflow[] = ['VENDOR_ID', 'RATE_APPROVAL', 'PROJECT_CODE'];
export type ReplyStatus = 'EXTRACTED' | 'REVIEW_REQUIRED' | 'INVALID' | 'CANCELLED' | 'PENDING' | 'NOT_FOUND' | 'UNMATCHED' | 'DUPLICATE' | 'APPROVED' | 'REJECTED';

/** What the outgoing request looked like (the Test Lab and the tests give this by hand; the live reader reads it from the database). */
export interface RequestContext {
  requestId?: string;
  /** Everyone the request mail was sent to (To, CC, BCC). */
  recipients?: string[];
  /** For an amount approval: PENDING, or what it was already decided as. */
  state?: 'PENDING' | 'APPROVED' | 'NOT_APPROVED';
  requestedAmount?: number;
  /** Values already used by another vendor / project (a duplicate needs a person). */
  existingValues?: string[];
  processedMessageIds?: string[];
  /** A newer clear reply may change an already decided request (the live behaviour). */
  allowReversal?: boolean;
}
export interface AnalyzeInput {
  workflow: Workflow;
  subject?: string;
  body?: string;
  html?: string;
  sender?: string;
  messageId?: string;
  request?: RequestContext;
  rules?: Partial<ReplyRules>;
}
export interface AnalyzeResult {
  workflow: Workflow;
  status: ReplyStatus;
  /** What would be saved (the code, or APPROVED / REJECTED). */
  value: string | null;
  /** What was written in the reply. */
  raw: string | null;
  normalized: string | null;
  confidence: number;
  reason: string;
  candidates: string[];
  flags: string[];
  amounts: number[];
  cleanedText: string;
  match: { requestIdsFound: string[]; requestMatched: boolean | null; senderAuthorized: boolean | null; state: string | null; duplicateMessage: boolean };
}

export function analyzeReply(input: AnalyzeInput): AnalyzeResult {
  const rules: ReplyRules = { ...DEFAULT_RULES, ...input.rules };
  const subject = input.subject ?? '';
  const body = input.body?.trim() ? input.body : input.html ? htmlToText(input.html) : '';
  const cleaned = freshText(body);
  const ctx = input.request;
  const ids = requestIdsIn(`${subject}\n${body}`);
  const requestMatched = ctx?.requestId ? ids.includes(ctx.requestId) : null;
  const senderAuthorized = ctx?.recipients?.length ? senderAllowed(input.sender ? [input.sender] : [], ctx.recipients) : null;
  const duplicateMessage = !!(input.messageId && ctx?.processedMessageIds?.includes(input.messageId));
  const match = { requestIdsFound: ids, requestMatched, senderAuthorized, state: ctx?.state ?? null, duplicateMessage };
  const base = { workflow: input.workflow, value: null, raw: null, normalized: null, confidence: 0, candidates: [], flags: [], amounts: [] as number[], cleanedText: cleaned, match };
  const stop = (status: ReplyStatus, reason: string, flag: string): AnalyzeResult => ({ ...base, status, reason, flags: [flag] });

  // The reply must belong to this request, come from someone it was sent to, and not have been read already.
  if (requestMatched === false) return stop('UNMATCHED', ids.length ? `The reply names ${ids.join(', ')}, not ${ctx!.requestId}` : `The reply does not carry the request ID ${ctx!.requestId}`, 'REQUEST_MISMATCH');
  if (senderAuthorized === false) return stop('REVIEW_REQUIRED', `${input.sender ?? 'The sender'} is not one of the people the request was sent to`, 'UNAUTHORIZED_SENDER');
  if (duplicateMessage) return stop('DUPLICATE', 'This mail was already read', 'DUPLICATE_MESSAGE');

  if (input.workflow === 'RATE_APPROVAL') {
    const d = readDecision(cleaned);
    const amounts = extractAmounts(cleaned);
    const flags = [...d.flags];
    const out = (status: ReplyStatus, reason: string, conf: number, extra: string[] = []): AnalyzeResult => ({ ...base, status, value: status === 'APPROVED' || status === 'REJECTED' ? status : null, raw: d.matched, normalized: status === 'APPROVED' || status === 'REJECTED' ? status : null, confidence: conf, reason, flags: [...flags, ...extra], amounts });
    if (d.decision === null) return out('REVIEW_REQUIRED', d.reason, 0.3);
    if (d.decision === 'HOLD') return out('PENDING', d.reason, 0.8);
    const status: ReplyStatus = d.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
    const conf = d.matched && /^(approved|approve|accepted|granted|rejected|declined|not\s+approved|not\s+granted|not\s+accepted)$/.test(d.matched) ? 0.95 : 0.8;
    if (status === 'APPROVED' && amounts.length) {
      if (ctx?.requestedAmount !== undefined && amounts.some((a) => a !== ctx.requestedAmount)) return out('REVIEW_REQUIRED', `The reply mentions an amount different from the requested ${ctx.requestedAmount} (${amounts.join(', ')}): verify before applying`, 0.4, ['AMOUNT_MISMATCH']);
      if (ctx?.requestedAmount === undefined) flags.push('AMOUNT_UNVERIFIED');
    }
    const decided = ctx?.state && ctx.state !== 'PENDING' ? ctx.state : null;
    if (decided && (decided === 'APPROVED') !== (status === 'APPROVED')) {
      if (ctx?.allowReversal === false) return out('REVIEW_REQUIRED', `The request is already ${decided}: a change needs a person`, 0.4, ['CHANGES_DECIDED_REQUEST']);
      flags.push('CHANGES_DECIDED_REQUEST');
    }
    return out(status, d.reason, conf);
  }

  const r = input.workflow === 'VENDOR_ID' ? extractVendorId(cleaned, rules) : extractProjectCode(cleaned, rules);
  const dup = r.status === 'EXTRACTED' && r.normalized && ctx?.existingValues?.includes(r.normalized);
  const status: ReplyStatus = dup ? 'REVIEW_REQUIRED' : r.status;
  return { ...base, status, value: status === 'EXTRACTED' ? r.normalized : null, raw: r.raw, normalized: r.normalized, confidence: dup ? 0.3 : r.confidence, reason: dup ? `${r.normalized} is already used by another record: a person decides` : r.reason, candidates: r.candidates, flags: dup ? [...r.flags, 'DUPLICATE_VALUE'] : r.flags };
}
