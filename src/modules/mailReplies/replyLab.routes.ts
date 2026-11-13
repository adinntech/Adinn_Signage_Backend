import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { asyncHandler, ok } from '../../common/http';
import { analyzeReply, WORKFLOWS } from './replyAnalyzer';
import { rulesFromEnv } from './replyParser';
import { ALL_CASES } from './replyTestCases';
import { runReplyCases } from './replyTestRunner';

/**
 * Admin > Email Reply Test Lab. Every route here only reads text and returns what the reply parser makes of it: nothing is read
 * from or written to a vendor, project, request or mailbox, and no mail is sent, so a test can never change a live record.
 */
export const replyLabRouter = Router();
replyLabRouter.use(authenticate, requirePermission('mail:manage'));

const emailList = z.array(z.string().trim().toLowerCase().max(200)).max(20).default([]);
const analyzeBody = z.object({
  workflow: z.enum(WORKFLOWS as unknown as [string, ...string[]]),
  subject: z.string().max(500).default(''),
  body: z.string().max(50_000).default(''),
  html: z.string().max(100_000).optional(),
  sender: z.string().trim().toLowerCase().max(200).optional(),
  messageId: z.string().max(200).optional(),
  request: z
    .object({
      requestId: z.string().trim().max(60).optional(),
      recipients: emailList,
      state: z.enum(['PENDING', 'APPROVED', 'NOT_APPROVED']).optional(),
      requestedAmount: z.number().positive().max(1e9).optional(),
      existingValues: z.array(z.string().max(40)).max(50).default([]),
      processedMessageIds: z.array(z.string().max(200)).max(50).default([]),
      allowReversal: z.boolean().optional(),
    })
    .optional(),
  expectStatus: z.string().max(30).optional(),
  expectValue: z.string().max(60).nullish(),
});
const runBody = z.object({ ids: z.array(z.string().max(10)).max(500).optional(), group: z.enum(['VENDOR_ID', 'RATE_APPROVAL', 'PROJECT_CODE', 'CROSS']).optional() });

/** The rules in force (digits, EST pattern ...), so the Lab shows what it tests against. */
replyLabRouter.get('/rules', asyncHandler(async (_req, res) => ok(res, rulesFromEnv())));
replyLabRouter.get('/cases', asyncHandler(async (_req, res) => ok(res, ALL_CASES)));
replyLabRouter.post('/analyze', asyncHandler(async (req, res) => {
  const b = analyzeBody.parse(req.body);
  const result = analyzeReply({
    workflow: b.workflow as (typeof WORKFLOWS)[number],
    subject: b.subject,
    body: b.body,
    ...(b.html ? { html: b.html } : {}),
    ...(b.sender ? { sender: b.sender } : {}),
    ...(b.messageId ? { messageId: b.messageId } : {}),
    ...(b.request ? { request: { ...b.request, recipients: b.request.recipients.length ? b.request.recipients : undefined } as never } : {}),
    rules: rulesFromEnv(),
  });
  const failure: string[] = [];
  if (b.expectStatus && b.expectStatus !== result.status) failure.push(`status ${result.status} instead of ${b.expectStatus}`);
  if (b.expectValue !== undefined && (b.expectValue || null) !== result.value) failure.push(`value ${JSON.stringify(result.value)} instead of ${JSON.stringify(b.expectValue || null)}`);
  const expected = b.expectStatus !== undefined || b.expectValue !== undefined;
  ok(res, { result, expected, pass: expected ? failure.length === 0 : null, failureReason: failure.join('; ') });
}));
replyLabRouter.post('/run', asyncHandler(async (req, res) => {
  const b = runBody.parse(req.body ?? {});
  const cases = ALL_CASES.filter((c) => (!b.ids || b.ids.includes(c.id)) && (!b.group || c.group === b.group));
  const { rows, ...totals } = runReplyCases(cases);
  ok(res, { ...totals, rows: rows.map(({ result, ...r }) => ({ ...r, reason: result.reason, confidence: result.confidence, cleanedText: result.cleanedText, flags: result.flags })) });
}));
