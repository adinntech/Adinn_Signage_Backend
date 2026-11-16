import { describe, expect, it } from 'vitest';
import { ESTIMATE_CASES, MIXED_CROSS_CASES, MIXED_PROJECT_CASES, MIXED_VENDOR_CASES, type EstimateCase } from '../src/modules/mailReplies/replyTestCasesMixed'; // pure files: no config, no database, no mailbox
import { runReplyCase } from '../src/modules/mailReplies/replyTestRunner';
import { DEFAULT_RULES, extractEstimate, extractProjectCode, extractVendorId, findEstimates, freshText, htmlToText, rulesFromEnv } from '../src/modules/mailReplies/replyParser';

/** One estimate case through the same cleaning the live reader does (quoted history out), without any record. */
export function runEstimateCase(c: EstimateCase) {
  const body = c.body.trim() ? c.body : c.html ? htmlToText(c.html) : '';
  const r = extractEstimate(freshText(body), { ...DEFAULT_RULES, ...c.rules });
  const digits = r.status === 'EXTRACTED' ? (r.normalized ?? '').replace(/^EST-/, '') : null;
  const why: string[] = [];
  if (r.status !== c.expectStatus) why.push(`status ${r.status} instead of ${c.expectStatus} (${r.reason})`);
  if (digits !== c.expectDigits) why.push(`digits ${JSON.stringify(digits)} instead of ${JSON.stringify(c.expectDigits)}`);
  return { case: c, result: r, actualDigits: digits, pass: why.length === 0, failureReason: why.join('; ') };
}

describe('mixed-character suite size (business table + 40 extra boundary / negative cases per workflow)', () => {
  it('has the business table plus 40 or more extra cases for each workflow', () => {
    expect(MIXED_VENDOR_CASES.length).toBeGreaterThanOrEqual(15 + 40);
    expect(MIXED_PROJECT_CASES.length).toBeGreaterThanOrEqual(20 + 40);
    expect(ESTIMATE_CASES.length).toBeGreaterThanOrEqual(15 + 40);
    expect(new Set([...MIXED_VENDOR_CASES, ...MIXED_PROJECT_CASES, ...MIXED_CROSS_CASES].map((c) => c.id)).size).toBe(MIXED_VENDOR_CASES.length + MIXED_PROJECT_CASES.length + MIXED_CROSS_CASES.length);
    expect(new Set(ESTIMATE_CASES.map((c) => c.id)).size).toBe(ESTIMATE_CASES.length);
  });
});

for (const [name, cases] of [['Vendor ID, mixed characters', MIXED_VENDOR_CASES], ['Project code, mixed characters', MIXED_PROJECT_CASES], ['Request, sender, duplicate, wrong type (mixed)', MIXED_CROSS_CASES]] as const) {
  describe(name, () => {
    it.each(cases.map((c) => [c.id, c.title, c] as const))('%s %s', (_id, _title, c) => {
      const r = runReplyCase(c);
      expect(r.failureReason).toBe('');
      expect(r.pass).toBe(true);
    });
  });
}

describe('Estimate number, mixed characters', () => {
  it.each(ESTIMATE_CASES.map((c) => [c.id, c.title, c] as const))('%s %s', (_id, _title, c) => {
    const r = runEstimateCase(c);
    expect(r.failureReason).toBe('');
  });
});

describe('the three kinds never borrow each other\'s numbers', () => {
  it('E13: an 8-digit estimate is an estimate, not a project code', () => {
    expect(findEstimates('EST-12345678')).toEqual(['EST-12345678']);
    expect(extractProjectCode('EST-12345678')).toMatchObject({ status: 'NOT_FOUND', normalized: null });
  });
  it('E14: project code and estimate from one line', () => {
    const t = 'Project 12345678 EST-12@34#5';
    expect(extractProjectCode(t)).toMatchObject({ status: 'EXTRACTED', normalized: '12345678' });
    expect(findEstimates(t)).toEqual(['EST-12345']);
  });
  it('P20: "Project: 12345678, Estimate: EST-903282" gives the project only as the code', () => {
    const t = 'Project: 12345678, Estimate: EST-903282';
    expect(extractProjectCode(t).normalized).toBe('12345678');
    expect(findEstimates(t)).toEqual(['EST-903282']);
  });
  it('the vendor ID never takes the digits of an estimate or a project code', () => {
    expect(extractVendorId('Project code: 12345678 EST-903282').status).toBe('NOT_FOUND');
    expect(extractVendorId('Vendor ID: 78954 EST-903282 Project code: 12345678').normalized).toBe('78954');
  });
  it('only the digits of ONE candidate are used: separate words are never joined', () => {
    expect(extractVendorId('Vendor ID: 78 954').status).toBe('INVALID');
    expect(extractProjectCode('Job 1234 done, then 5678 shipped').status).toBe('NOT_FOUND');
    expect(extractProjectCode('Thanks 1234, Regards 5678').status).toBe('NOT_FOUND');
  });
});

describe('result keeps the raw candidate, the normalized value, the source line and the validation reason', () => {
  it('vendor', () => {
    const r = extractVendorId('Hi\nVendor ID: 78@95#4 thanks');
    expect(r).toMatchObject({ status: 'EXTRACTED', raw: '78@95#4', normalized: '78954', context: 'Vendor ID: 78@95#4 thanks' });
    expect(r.reason).toMatch(/vendor id/i);
    expect(r.flags).toContain('SYMBOLS_DROPPED');
  });
  it('project code: leading zeros stay (a string)', () => {
    const r = extractProjectCode('Project code: 000@123#45');
    expect(r).toMatchObject({ status: 'EXTRACTED', raw: '000@123#45', normalized: '00012345' });
    expect(typeof r.normalized).toBe('string');
  });
  it('estimate', () => {
    const r = extractEstimate('est-45@43#949');
    expect(r).toMatchObject({ status: 'EXTRACTED', raw: 'est-45@43#949', normalized: 'EST-4543949' });
  });
});

describe('env rules', () => {
  it('defaults: estimate 5..12 digits, UF is an unrelated prefix', () => {
    const r = rulesFromEnv({});
    expect(r).toMatchObject({ vendorMinDigits: 5, projectMinDigits: 8, estDigits: 5, estMaxDigits: 12, unrelatedPrefixes: ['UF'] });
  });
  it('the prefix list can be changed or emptied', () => {
    expect(rulesFromEnv({ UNRELATED_CODE_PREFIXES: 'uf, ab' }).unrelatedPrefixes).toEqual(['UF', 'AB']);
    expect(rulesFromEnv({ UNRELATED_CODE_PREFIXES: '' }).unrelatedPrefixes).toEqual([]);
    expect(rulesFromEnv({ PROJECT_CODE_EST_DIGITS: '6', PROJECT_CODE_EST_MAX_DIGITS: '9' })).toMatchObject({ estDigits: 6, estMaxDigits: 9 });
  });
});
