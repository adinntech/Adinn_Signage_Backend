import { describe, expect, it } from 'vitest';
import { findDecision, findEstimates, findProjectCode, findVendorNo } from '../src/modules/mailReplies/replyParser'; // pure file: loads no config

describe('vendor ID in the way Accounts really writes it', () => {
  it.each([
    ['Dear Sir,\n         Vendor Ledger Creator In Zoho Book -  12589 - SRN MEDIA', '12589'],
    ['Dear Sir,\nVendor Ledger Created in Zoho Books - 12589 - SRN MEDIA\nRegards', '12589'],
    ['12589 - SRN MEDIA', '12589'],
    ['Hi,\nDone. Vendor ID : 12589', '12589'],
    ['Hi\n12589\nThanks', '12589'],
    ['Created. ID 12589 ok', '12589'],
    // The vendor ID has 5 or more digits (business rule), so a 4-digit number is never taken.
    ['Dear Sir, created on 12/11/2026, call 98765 43210, vendor id 77881', '77881'],
    ['Dear Sir, created on 12/11/2026 by 98765 43210. Number 55661', '55661'],
    ['Vendor ID - AB12345', '12345'],
    ['Dear Sir, vendor id 7788', null],
  ])('%j -> %s', (text, code) => expect(findVendorNo(text).code).toBe(code));

  it('two different numbers are left for a person', () => {
    expect(findVendorNo('12589 - SRN MEDIA and 12590 - SRN MEDIA 2')).toMatchObject({ code: null, ambiguous: ['12589', '12590'] });
    expect(findVendorNo('Thanks, will do it soon').code).toBeNull();
    expect(findVendorNo('Dear Sir,\nCreated.').code).toBeNull();
  });

  it('the request ID digits are never taken for the vendor ID', () => {
    expect(findVendorNo('Re: Vendor Registration - ADN-Signage-vnd-10112601\n12589 - SRN MEDIA').code).toBe('12589');
    expect(findVendorNo('Re: ADN-Signage-vnd-10112601 done').code).toBeNull();
  });
});

describe('estimate numbers as people type them', () => {
  it('reads Est-121605, EST - 235673 and a repeated EST-235673 as two estimates, and never takes them for the project code', () => {
    const t = 'Dear Sir / Mam\n\nProject No - 22069111  - PRADEEP KUMAR (CHENNAI NEW FACTORY)\n\nEst-121605\n\nEST - 235673\nEST-235673 \n';
    expect(findEstimates(t)).toEqual(['EST-121605', 'EST-235673']);
    expect(findProjectCode(t)).toEqual({ code: '22069111', ambiguous: [] });
    expect(findEstimates('EST - 235673, Est- 235674')).toEqual(['EST-235673', 'EST-235674']);
    expect(findEstimates('Estimate sent on 2026')).toEqual([]);
  });
});

describe('the approver\'s answer, in many ways', () => {
  it.each([
    ['Approved', 'APPROVED'], ['APPROVED.', 'APPROVED'], ['Approved, thanks', 'APPROVED'], ['approved after some time', 'APPROVED'],
    ['OK', 'APPROVED'], ['Okay, proceed', 'APPROVED'], ['Proceed', 'APPROVED'], ['Go ahead', 'APPROVED'], ['Fine, accepted', 'APPROVED'], ['Yes', 'APPROVED'],
    ['Rejected', 'NOT_APPROVED'], ['Not approved', 'NOT_APPROVED'], ['NOT APPROVED, proceed with the set amount', 'NOT_APPROVED'],
    ['Declined', 'NOT_APPROVED'], ['Not ok', 'NOT_APPROVED'], ['Do not proceed', 'NOT_APPROVED'], ['Cancel this', 'NOT_APPROVED'], ['I do not approve', 'NOT_APPROVED'],
    ['Management did not accept it. Note it down as rejected.', 'NOT_APPROVED'], ['Management did not accept it', 'NOT_APPROVED'], ["Sorry, they won't agree", 'NOT_APPROVED'],
    ['Okay. Thanks & Regards', 'APPROVED'],
    // Real replies: a negative word makes it a no, even when the approval word comes in another form ("granted", "permitted").
    ['Sorry sorry Not Granted. On Wed, Nov 11, 2026 at 6:32 PM Karthiyayini T G wrote:', 'NOT_APPROVED'], ['Not granted', 'NOT_APPROVED'], ['Not yet granted', 'NOT_APPROVED'],
    ['Cannot be permitted', 'NOT_APPROVED'], ['Not possible', 'NOT_APPROVED'], ['Unable to approve this rate', 'NOT_APPROVED'], ['Not sanctioned', 'NOT_APPROVED'],
    ['Not done', 'NOT_APPROVED'], ['Not Done.', 'NOT_APPROVED'], ['Not yet finalised', 'NOT_APPROVED'], ['Done', 'APPROVED'], ['Moved.', 'APPROVED'], ['Moved', 'APPROVED'], ['Not moved', 'NOT_APPROVED'], ['Not yet moved.', 'NOT_APPROVED'], ['Updated', 'APPROVED'], ['Not updated', 'NOT_APPROVED'],
    ['Kindly approve the same.', 'APPROVED'], ['Kindly approved', 'APPROVED'], ['Kindly approve', 'APPROVED'], ['Please approve', 'APPROVED'], ['Approve pannunga', 'APPROVED'], ['Awaiting approval from management', 'HOLD'], ['Hold', 'HOLD'], ['Please wait', 'HOLD'], ['Stop', 'HOLD'], ['On hold for now', 'HOLD'], ['Not now', 'HOLD'], ['Not yet', 'HOLD'], ['Pending, will update later', 'HOLD'], ['Kindly give some time', 'HOLD'], ['Need more time', 'HOLD'], ['Please give us a few days', 'HOLD'],
    ['No', 'NOT_APPROVED'], ['No. Use the company rate', 'NOT_APPROVED'], ['Granted', 'APPROVED'], ['Approved. Nobody objects', 'APPROVED'],
  ])('%j -> %s', (text, d) => expect(findDecision(text)).toBe(d));

  it('anything doubtful stays with a person', () => {
    for (const t of ['Will check and let you know', 'approved for near but rejected for far', 'Approved. Actually do not proceed', 'Hmm', '', 'Are you Sure! Do you want to approved?']) expect(findDecision(t)).toBeNull();
  });
});

describe('estimate and project code as people type them', async () => {
  const { findEstimates, findProjectCode } = await import('../src/modules/mailReplies/replyParser');
  it('reads "Est - 021600" with spaces around the dash', () => {
    expect(findEstimates('Project No - 22069001 - PRADEEP KUMAR\n\nEst - 021600')).toEqual(['EST-021600']);
    expect(findEstimates('EST-020456 and Est - 020457')).toEqual(['EST-020456', 'EST-020457']);
    expect(findEstimates('estimate 12345 days')).toEqual([]);
  });
  it('takes the 8-digit project code and leaves a 7-digit number for a person', () => {
    expect(findProjectCode('Project No - 22069001 - PRADEEP KUMAR\nEst - 021600').code).toBe('22069001');
    expect(findProjectCode('Project No - 2206900 - PRADEEP KUMAR').code).toBeNull();
  });
});
