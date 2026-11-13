import { analyzeReply, type AnalyzeInput, type AnalyzeResult } from './replyAnalyzer';
import { ALL_CASES, type CaseResult, type ReplyCase } from './replyTestCases';

/** Runs one case through the analyzer and says pass / fail with the reason. Pure: no database, no mailbox, no mail. */
export function runReplyCase(c: ReplyCase): CaseResult & { result: AnalyzeResult } {
  const result = analyzeReply({ workflow: c.workflow, ...c.input } as AnalyzeInput);
  const why: string[] = [];
  if (result.status !== c.expectStatus) why.push(`status ${result.status} instead of ${c.expectStatus} (${result.reason})`);
  if (result.value !== c.expectValue) why.push(`value ${JSON.stringify(result.value)} instead of ${JSON.stringify(c.expectValue)}`);
  if (c.expectNormalized !== undefined && result.normalized !== c.expectNormalized) why.push(`candidate ${JSON.stringify(result.normalized)} instead of ${JSON.stringify(c.expectNormalized)}`);
  return {
    id: c.id, group: c.group, workflow: c.workflow, title: c.title,
    rawReply: c.input.body?.trim() ? c.input.body : c.input.html ?? '',
    expectedValue: c.expectValue, expectedStatus: c.expectStatus,
    actualValue: result.value, actualStatus: result.status, actualNormalized: result.normalized,
    pass: why.length === 0, failureReason: why.join('; '), result,
  };
}

export function runReplyCases(cases: ReplyCase[] = ALL_CASES) {
  const rows = cases.map(runReplyCase);
  return { total: rows.length, passed: rows.filter((r) => r.pass).length, failed: rows.filter((r) => !r.pass).length, rows };
}
