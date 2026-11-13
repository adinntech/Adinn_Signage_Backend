import { describe, expect, it } from 'vitest';
import { ALL_CASES, CROSS_CASES, PROJECT_CASES, RATE_CASES, VENDOR_CASES } from '../src/modules/mailReplies/replyTestCases'; // pure files: no config, no database, no mailbox
import { runReplyCase } from '../src/modules/mailReplies/replyTestRunner';

describe('reply test suite size', () => {
  it('has at least 180 cases in the four groups', () => {
    expect(VENDOR_CASES).toHaveLength(50);
    expect(RATE_CASES).toHaveLength(50);
    expect(PROJECT_CASES).toHaveLength(50);
    expect(CROSS_CASES).toHaveLength(30);
    expect(new Set(ALL_CASES.map((c) => c.id)).size).toBe(ALL_CASES.length);
  });
});

for (const [name, cases] of [['Vendor ID', VENDOR_CASES], ['Vendor amount approval', RATE_CASES], ['Project code', PROJECT_CASES], ['Cross-workflow and email security', CROSS_CASES]] as const) {
  describe(name, () => {
    it.each(cases.map((c) => [c.id, c.title, c] as const))('%s %s', (_id, _title, c) => {
      const r = runReplyCase(c);
      expect(r.failureReason).toBe('');
      expect(r.pass).toBe(true);
    });
  });
}

describe('nothing from a reply test touches a record', () => {
  it('the analyzer and runner import no database or mail code', async () => {
    const fs = await import('node:fs');
    for (const f of ['replyAnalyzer', 'replyParser', 'replyTestCases', 'replyTestRunner']) {
      const src = fs.readFileSync(new URL(`../src/modules/mailReplies/${f}.ts`, import.meta.url), 'utf8');
      expect(src).not.toMatch(/from '(mongoose|\.\.\/(vendors|sales|codeRequests|users)|\.\/mailReply\.service|\.\/replyMailbox)/);
    }
  });
});
