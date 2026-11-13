import type { AnalyzeInput, ReplyStatus, Workflow } from './replyAnalyzer';

/**
 * The reusable reply test suite: 180 cases for the three mail workflows (50 vendor ID, 50 vendor amount approval, 50 project
 * code) and 30 cross-workflow / email-security cases. The same list runs in the Vitest suite (tests/reply-cases.test.ts) and in
 * the admin Email Reply Test Lab ("Run all"). Every case is pure text: nothing here reads a mailbox or touches a record.
 */
export type CaseGroup = Workflow | 'CROSS';
export interface ReplyCase {
  id: string;
  group: CaseGroup;
  workflow: Workflow;
  /** Short description of what the case proves. */
  title: string;
  input: Omit<AnalyzeInput, 'workflow'>;
  expectStatus: ReplyStatus;
  /** What would be saved: the code, or null when nothing is saved. */
  expectValue: string | null;
  /** The cleaned candidate, when it is not the saved value (a person-review candidate). */
  expectNormalized?: string;
}

const VND = 'ADN-Signage-vnd-12112601';
const VAP = 'ADN-Signage-vap-12112601';
const CP = 'ADN-Signage-cp-12112601';
const ACC = 'accounts@adinn.co.in';
const ctx = (requestId: string, extra: Record<string, unknown> = {}) => ({ requestId, recipients: [ACC], ...extra });

const v = (n: number, title: string, body: string, expectStatus: ReplyStatus, expectValue: string | null, more: Partial<ReplyCase> & { html?: string } = {}): ReplyCase => {
  const { html, ...rest } = more;
  return { id: `V${String(n).padStart(2, '0')}`, group: 'VENDOR_ID', workflow: 'VENDOR_ID', title, input: { body, ...(html ? { html } : {}) }, expectStatus, expectValue, ...rest };
};
const r = (n: number, title: string, body: string, expectStatus: ReplyStatus, more: Partial<ReplyCase> & { html?: string; request?: AnalyzeInput['request'] } = {}): ReplyCase => {
  const { html, request, ...rest } = more;
  return { id: `R${String(n).padStart(2, '0')}`, group: 'RATE_APPROVAL', workflow: 'RATE_APPROVAL', title, input: { body, ...(html ? { html } : {}), ...(request ? { request, subject: `Re: ${VAP}`, sender: ACC } : {}) }, expectStatus, expectValue: expectStatus === 'APPROVED' || expectStatus === 'REJECTED' ? expectStatus : null, ...rest };
};
const p = (n: number, title: string, body: string, expectStatus: ReplyStatus, expectValue: string | null, more: Partial<ReplyCase> & { html?: string; subject?: string; rules?: AnalyzeInput['rules'] } = {}): ReplyCase => {
  const { html, subject, rules, ...rest } = more;
  return { id: `P${String(n).padStart(2, '0')}`, group: 'PROJECT_CODE', workflow: 'PROJECT_CODE', title, input: { body, ...(html ? { html } : {}), ...(subject ? { subject } : {}), ...(rules ? { rules } : {}) }, expectStatus, expectValue, ...rest };
};
const c = (n: number, workflow: Workflow, title: string, input: Omit<AnalyzeInput, 'workflow'>, expectStatus: ReplyStatus, expectValue: string | null): ReplyCase => ({ id: `C${String(n).padStart(2, '0')}`, group: 'CROSS', workflow, title, input, expectStatus, expectValue });

const OK = 'EXTRACTED';
export const VENDOR_CASES: ReplyCase[] = [
  v(1, 'Plain 5-digit ID', 'Vendor ID: 78954', OK, '78954'),
  v(2, 'More than 5 digits', 'Vendor id is 123456', OK, '123456'),
  v(3, 'CamelCase label, 9 digits', 'VendorId: 987654321', OK, '987654321'),
  v(4, 'UPPERCASE label with dash', 'VENDOR CODE - 12345', OK, '12345'),
  v(5, 'Broken fragment then a valid ID', 'Vendor id is 7823** 78954 }}}', OK, '78954'),
  v(6, '5 digits followed by symbols', 'Vendor id is 78723**', OK, '78723'),
  v(7, 'Hashes and at-signs around the ID', 'Vendor ID: ##98765@@@', OK, '98765'),
  v(8, 'ID in brackets', 'Vendor ID: (123456)', OK, '123456'),
  v(9, 'No spaces at all', 'vendorIdIs78954', OK, '78954'),
  v(10, 'Letters before the digits: only the digits are the vendor ID', 'Vendor ID - AB12345', OK, '12345'),
  v(11, 'Fewer than 5 digits', 'Vendor ID: 1234', 'INVALID', null),
  v(12, 'Two valid IDs', 'Vendor ID: 12345, 67890', 'REVIEW_REQUIRED', null),
  v(13, 'Digits broken by stars: candidate only, never saved', 'Vendor ID: 12***345', 'REVIEW_REQUIRED', null, { expectNormalized: '12345' }),
  v(14, 'GSTIN in the same reply', 'Vendor ID: 98765 / GST: 33ABCDE1234F1Z5', OK, '98765'),
  v(15, 'Mobile number in the same reply', 'Vendor ID: 123456. Mobile: 9876543210', OK, '123456'),
  v(16, 'Label is only "code"', 'Registration completed, code 87654', OK, '87654'),
  v(17, 'Extra words after the ID', 'Vendor ID: 78954. Please proceed', OK, '78954'),
  v(18, 'Cancelled registration', 'Vendor ID: 78954 is cancelled', 'CANCELLED', null),
  v(19, 'Leading zeros kept', 'Vendor ID: 00078954', OK, '00078954'),
  v(20, 'Quoted older ID on the same line', 'Vendor ID: 98765, quoted previous mail: 12345', OK, '98765'),
  v(21, 'Fragments 787***23 joined: candidate only', 'Vendor ID: 787***23', 'REVIEW_REQUIRED', null, { expectNormalized: '78723' }),
  v(22, 'Decorated fragments', 'Vendor id is ****787***23***', 'REVIEW_REQUIRED', null, { expectNormalized: '78723' }),
  v(23, 'Letters after the digits', 'vendor id: 12345abc', OK, '12345'),
  v(24, 'Lower-case prefix with dash', 'VENDOR ID: ab-98765', OK, '98765'),
  v(25, 'Equals sign', 'VendorID=45678', OK, '45678'),
  v(26, '"Vendor No." label', 'Vendor No. 56789', OK, '56789'),
  v(27, '"Vendor number is"', 'vendor number is 67890', OK, '67890'),
  v(28, 'Digits split by a space only', 'Vendor Id : 123 456', 'INVALID', null),
  v(29, 'A 10-digit phone number is not an ID', 'Vendor ID: 9876543210', 'INVALID', null),
  v(30, 'Label but no digits', 'Vendor ID: ABCDE', 'NOT_FOUND', null),
  v(31, 'No ID at all', 'Thanks, created.', 'NOT_FOUND', null),
  v(32, 'Empty reply', '', 'NOT_FOUND', null),
  v(33, 'Two vendors in one mail', 'Vendor ID: 11111 for A\nVendor ID: 22222 for B', 'REVIEW_REQUIRED', null),
  v(34, 'The same ID written twice', 'Vendor ID: 78954\nVendor ID: 78954', OK, '78954'),
  v(35, 'Quoted line starting with >', 'Vendor ID: 55555\n> Vendor ID: 11111', OK, '55555'),
  v(36, 'Gmail "On ... wrote:" history', 'Vendor ID: 55555\n\nOn Wed, Nov 11, 2026 at 6:32 PM Accounts <a@x.com> wrote:\n> Vendor ID: 11111', OK, '55555'),
  v(37, 'Forwarded message below', 'Vendor ID: 44444\n---------- Forwarded message ---------\nVendor ID: 11111', OK, '44444'),
  v(38, 'Outlook From / Sent header', 'Vendor ID: 44444\n\nFrom: Karthi\nSent: Wednesday, 11 November 2026\nTo: Accounts\nVendor ID: 11111', OK, '44444'),
  v(39, 'HTML mail with quoted blockquote', '', OK, '77777', { html: '<p>Vendor ID: <b>77777</b></p><blockquote>Vendor ID: 11111</blockquote>' }),
  v(40, 'Signature after Regards holds another number', 'Vendor ID: 33333\n\nRegards,\nRaj\nMobile: 9876543210\nVendor ID 99999', OK, '33333'),
  v(41, 'Signature after "-- "', 'Vendor ID: 33333\n-- \nRaj 98765 43210', OK, '33333'),
  v(42, 'Table row written with a bar', 'Vendor ID | 12589', OK, '12589'),
  v(43, 'Tanglish sentence', 'Vendor create pannitten. Vendor ID: 24680', OK, '24680'),
  v(44, 'Emoji in the reply', 'Done ✅ Vendor ID: 13579', OK, '13579'),
  v(45, 'Unicode digits are not ASCII digits', 'Vendor ID: 𝟏𝟐𝟑𝟒𝟓', 'NOT_FOUND', null),
  v(46, 'Accounts style: ID then name', 'Dear Sir,\nVendor Ledger Created in Zoho Books - 12589 - SRN MEDIA\nRegards', OK, '12589'),
  v(47, 'Only "ID - NAME"', '12589 - SRN MEDIA', OK, '12589'),
  v(48, 'A line that is only the number', 'Hi\n12589\nThanks', OK, '12589'),
  v(49, 'Bare "ID" label', 'Created. ID 12589 ok', OK, '12589'),
  v(50, 'Date and phone before the ID', 'Dear Sir, created on 12/11/2026, call 98765 43210, vendor id 77881', OK, '77881'),
];

const REQ = (state: 'PENDING' | 'APPROVED' | 'NOT_APPROVED' = 'PENDING', requestedAmount?: number, extra: Record<string, unknown> = {}) => ({ requestId: VAP, recipients: [ACC], state, ...(requestedAmount !== undefined ? { requestedAmount } : {}), ...extra });
export const RATE_CASES: ReplyCase[] = [
  r(1, 'Approved', 'Approved', 'APPROVED'),
  r(2, 'Granted', 'Granted', 'APPROVED'),
  r(3, 'Proceed', 'Proceed', 'APPROVED'),
  r(4, 'Okay', 'Okay', 'APPROVED'),
  r(5, 'Accepted', 'Accepted', 'APPROVED'),
  r(6, 'Done', 'Done', 'APPROVED'),
  r(7, 'Moved', 'Moved', 'APPROVED'),
  r(8, 'Kindly acknowledge', 'Kindly acknowledge', 'APPROVED'),
  r(9, 'Shouting with punctuation', 'APPROVED!!!', 'APPROVED'),
  r(10, 'Mixed case', 'aPpRoVeD', 'APPROVED'),
  r(11, 'Approved with the matching amount', 'Okay, proceed with ₹18,500', 'APPROVED', { request: REQ('PENDING', 18500) }),
  r(12, 'Not Approved', 'Not Approved', 'REJECTED'),
  r(13, 'Mixed case negation', 'NOt granted', 'REJECTED'),
  r(14, 'Not accepted', 'Not accepted', 'REJECTED'),
  r(15, 'Not done', 'Not done', 'REJECTED'),
  r(16, 'Underscore between the words', 'NOT_APPROVED', 'REJECTED'),
  r(17, 'Hyphen and punctuation', 'Not-Approved!!!', 'REJECTED'),
  r(18, 'Cannot approve', 'Cannot approve', 'REJECTED'),
  r(19, 'A question is not an answer', 'Approved?', 'REVIEW_REQUIRED'),
  r(20, 'Please approve is a yes', 'Please approve', 'APPROVED'),
  r(21, 'Approval waits for finance', 'Approved after finance confirms', 'PENDING'),
  r(22, 'Earlier no, now yes (explicit change)', 'Earlier rejected, now approved', 'APPROVED', { request: REQ('NOT_APPROVED') }),
  r(23, 'Earlier yes, now no (explicit change)', 'Approved earlier, now rejected', 'REJECTED', { request: REQ('APPROVED') }),
  r(24, 'Yes but with a different rate', 'Okay, but reduce the rate', 'REVIEW_REQUIRED'),
  r(25, 'Approved amount differs from the request', 'Approved for ₹19,000, requested ₹18,500', 'REVIEW_REQUIRED', { request: REQ('PENDING', 18500) }),
  r(26, 'Rejected', 'Rejected', 'REJECTED'),
  r(27, 'Declined', 'Declined', 'REJECTED'),
  r(28, 'Do not proceed', 'Do not proceed', 'REJECTED'),
  r(29, 'No with an instruction after it', 'Not approved - proceed with company rate', 'REJECTED'),
  r(30, 'Quoted history says rejected, new text approves', 'Okay\n\nOn Wed, Nov 11, 2026 at 6:32 PM X <x@y.com> wrote:\n> Not approved', 'APPROVED'),
  r(31, 'Only the quoted part approves: not an approval', 'Thanks\n> Approved', 'REVIEW_REQUIRED'),
  r(32, 'Proceed after finance approval', 'Proceed after finance approval', 'PENDING'),
  r(33, 'Hold', 'Hold', 'PENDING'),
  r(34, 'Please wait', 'Please wait', 'PENDING'),
  r(35, 'A yes and a no together', 'Approved but also rejected', 'REVIEW_REQUIRED'),
  r(36, 'Tanglish yes', 'Seri, approve pannitten', 'APPROVED'),
  r(37, 'Tanglish approve', 'Approve pannunga', 'APPROVED'),
  r(38, 'Tanglish no', 'Approve panna mudiyadhu', 'REJECTED'),
  r(39, 'Thumbs-up emoji only', '✅', 'APPROVED'),
  r(40, 'Cross emoji only', '❌', 'REJECTED'),
  r(41, 'Sure with an emoji', 'Sure 👍', 'APPROVED'),
  r(42, 'Yes', 'Yes', 'APPROVED'),
  r(43, 'No', 'No', 'REJECTED'),
  r(44, 'Nothing clear', 'Hmm', 'REVIEW_REQUIRED'),
  r(45, 'Empty reply', '', 'REVIEW_REQUIRED'),
  r(46, 'Signature below Regards says not approved', 'Approved!!!\n\nRegards,\nRaj\nNot approved earlier', 'APPROVED'),
  r(47, 'HTML mail, blockquote says rejected', '', 'APPROVED', { html: '<div>Approved</div><blockquote>Rejected</blockquote>' }),
  r(48, 'Only whitespace around the word', 'APPROVED  \n\n  ', 'APPROVED'),
  r(49, 'Letters spaced out are not a word', 'a p p r o v e d', 'REVIEW_REQUIRED'),
  r(50, 'Not Done with a full stop', 'Not Done.', 'REJECTED'),
];

const EST_RULE = ['PRJ[-_/ ]?\\d{4}[-_/ ]?\\d{3,5}'];
export const PROJECT_CASES: ReplyCase[] = [
  p(1, '8 digits', 'Project Code: 12345678', OK, '12345678'),
  p(2, '10 digits', 'ProjectCode: 1234567890', OK, '1234567890'),
  p(3, 'Sentence form', 'Project code is 12345678', OK, '12345678'),
  p(4, 'No spaces at all', 'ProjectCodeIs12345678', OK, '12345678'),
  p(5, 'EST code', 'Project code: EST-457435', OK, 'EST-457435'),
  p(6, 'EST code in lower case', 'Project code: est-457435', OK, 'EST-457435'),
  p(7, 'EST code with spaces around the dash', 'Project code: est - 457435', OK, 'EST-457435'),
  p(8, 'EST code with underscore', 'Project code: EST_457435', OK, 'EST-457435'),
  p(9, 'EST code with slash', 'Project code: EST / 457435', OK, 'EST-457435'),
  p(10, '7 digits is too short', 'Project code: 1234567', 'INVALID', null),
  p(11, 'EST needs 6 digits', 'Project code: EST-45743', 'INVALID', null),
  p(12, 'Configured structured pattern', 'Project code: PRJ-2026-1045', OK, 'PRJ-2026-1045', { rules: { extraProjectPatterns: EST_RULE } }),
  p(13, 'Symbols around the code', 'Project Code: ##12345678@@', OK, '12345678'),
  p(14, 'Two valid codes', 'Project code: 12345678 / 87654321', 'REVIEW_REQUIRED', null),
  p(15, '"Code generated:" label', 'Code generated: EST-457435', OK, 'EST-457435'),
  p(16, 'Pending, expected code is not confirmed', 'Project code pending, expected EST-457435', 'PENDING', null),
  p(17, 'EST code with "approved and created"', 'EST - 457435 approved and created', OK, 'EST-457435'),
  p(18, 'Leading zeros kept', 'Project Code: 00001234', OK, '00001234'),
  p(19, 'Subject has an old code, the new body wins', 'Project Code: 87654321', OK, '87654321', { subject: 'Re: Project code 12345678 ADN-Signage-cp-12112601' }),
  p(20, 'A 6-digit number alone is not a project code', 'Project code: 457435', 'INVALID', null),
  p(21, 'Code then name', 'Project code - 22069111 - PRADEEP KUMAR (CHENNAI)', OK, '22069111'),
  p(22, 'Project code with estimates below (estimates are not codes)', 'Dear Sir / Mam\n\nProject No - 22069111  - PRADEEP KUMAR (CHENNAI NEW FACTORY)\n\nEst-121605\n\nEST - 235673\nEST-235673 \n', OK, '22069111'),
  p(23, '7 digits after "Project No"', 'Project No - 2206900', 'INVALID', null),
  p(24, '15 digits', 'Project code: 123456789012345', OK, '123456789012345'),
  p(25, '16 digits is too long', 'Project code: 1234567890123456', 'INVALID', null),
  p(26, 'Date after the code', 'Project code: 12345678 dated 12/11/2026', OK, '12345678'),
  p(27, 'Amount after the code', 'Project code: 12345678 amount ₹1,25,000', OK, '12345678'),
  p(28, 'Phone after the code', 'Project code: 12345678 Mobile: 9876543210', OK, '12345678'),
  p(29, 'Lone 8-digit number, no label', 'Created 12345678', OK, '12345678'),
  p(30, 'Two EST codes', 'Project Code: EST-457435 and EST-457436', 'REVIEW_REQUIRED', null),
  p(31, 'Estimates after a labelled code', 'Project No - 22069111\nEst-121605\nEST - 235673', OK, '22069111'),
  p(32, 'Upper-case label', 'PROJECTCODE: 12345678', OK, '12345678'),
  p(33, 'No colon', 'project code 12345678', OK, '12345678'),
  p(34, 'Bold marks', 'Project Code : *12345678*', OK, '12345678'),
  p(35, 'Dash label', 'ProjectCode-12345678', OK, '12345678'),
  p(36, 'HTML mail with quoted blockquote', '', OK, '12345678', { html: '<p>Project Code: <b>12345678</b></p><blockquote>Project Code: 87654321</blockquote>' }),
  p(37, 'Quoted line starting with >', 'Project Code: 12345678\n> Project Code: 87654321', OK, '12345678'),
  p(38, 'Forwarded message below', 'Project Code: 12345678\n---------- Forwarded message ---------\nProject Code: 87654321', OK, '12345678'),
  p(39, 'Signature below Regards', 'Project Code: 12345678\nRegards,\nRaj 9876543210', OK, '12345678'),
  p(40, 'No code', 'Thanks, done.', 'NOT_FOUND', null),
  p(41, 'Empty reply', '', 'NOT_FOUND', null),
  p(42, 'Digits split by a dash are not joined', 'Project code: 1234-5678', 'INVALID', null),
  p(43, 'Digits split by a space are not joined', 'Project code: 1234 5678', 'INVALID', null),
  p(44, 'EST code, then an unrelated estimate line', 'Project code: EST-457435\nEstimate EST-111222', OK, 'EST-457435'),
  p(45, 'Mixed-case EST with a space', 'Project code: ESt 457435', OK, 'EST-457435'),
  p(46, 'EST with 7 digits', 'Project code: EST-0457435', 'INVALID', null),
  p(47, 'Trailing full stop', 'Project code: 12345678.', OK, '12345678'),
  p(48, 'Vendor ID after the project code is not a project code', 'Project Code: 98765432 / Vendor ID: 55555', OK, '98765432'),
  p(49, 'The same code twice', 'Project code: 12345678 12345678', OK, '12345678'),
  p(50, 'Leading zero 8 digits', 'Project code: 08765432', OK, '08765432'),
];

const base = (workflow: Workflow, requestId: string, body: string, sender = ACC, extra: Omit<AnalyzeInput, 'workflow' | 'body' | 'sender' | 'request' | 'subject'> & { request?: Record<string, unknown>; subject?: string } = {}): Omit<AnalyzeInput, 'workflow'> => {
  const { request, subject, ...rest } = extra;
  return { subject: subject ?? `Re: ${requestId}`, body, sender, request: { requestId, recipients: [ACC], ...(request ?? {}) } as NonNullable<AnalyzeInput['request']>, ...rest };
};
export const CROSS_CASES: ReplyCase[] = [
  c(1, 'VENDOR_ID', 'Correct vendor request, authorised sender', base('VENDOR_ID', VND, 'Vendor ID: 78954'), OK, '78954'),
  c(2, 'VENDOR_ID', 'Reply names another vendor request', base('VENDOR_ID', VND, 'Vendor ID: 78954', ACC, { subject: 'Re: ADN-Signage-vnd-99999999' }), 'UNMATCHED', null),
  c(3, 'VENDOR_ID', 'Reply carries no request ID', base('VENDOR_ID', VND, 'Vendor ID: 78954', ACC, { subject: 'Re: hello' }), 'UNMATCHED', null),
  c(4, 'VENDOR_ID', 'Unauthorised sender', base('VENDOR_ID', VND, 'Vendor ID: 78954', 'stranger@evil.com'), 'REVIEW_REQUIRED', null),
  c(5, 'VENDOR_ID', 'Colleague on the same company domain', base('VENDOR_ID', VND, 'Vendor ID: 78954', 'other@adinn.co.in'), OK, '78954'),
  c(6, 'VENDOR_ID', 'Same mail read twice', base('VENDOR_ID', VND, 'Vendor ID: 78954', ACC, { messageId: '<m1>', request: { processedMessageIds: ['<m1>'] } }), 'DUPLICATE', null),
  c(7, 'VENDOR_ID', 'Vendor ID already used by another vendor', base('VENDOR_ID', VND, 'Vendor ID: 78954', ACC, { request: { existingValues: ['78954'] } }), 'REVIEW_REQUIRED', null),
  c(8, 'VENDOR_ID', 'Cancelled registration with context', base('VENDOR_ID', VND, 'Vendor ID: 78954 is cancelled'), 'CANCELLED', null),
  c(9, 'RATE_APPROVAL', 'Approved on a pending request', base('RATE_APPROVAL', VAP, 'Approved', ACC, { request: { state: 'PENDING' } }), 'APPROVED', 'APPROVED'),
  c(10, 'RATE_APPROVAL', 'Approval for another request', base('RATE_APPROVAL', VAP, 'Approved', ACC, { subject: 'Re: ADN-Signage-vap-99999999' }), 'UNMATCHED', null),
  c(11, 'RATE_APPROVAL', 'Approval from an unauthorised sender', base('RATE_APPROVAL', VAP, 'Approved', 'stranger@evil.com'), 'REVIEW_REQUIRED', null),
  c(12, 'RATE_APPROVAL', 'Already approved, newer clear "not approved" changes it', base('RATE_APPROVAL', VAP, 'Management did not accept it, note it as rejected', ACC, { request: { state: 'APPROVED' } }), 'REJECTED', 'REJECTED'),
  c(13, 'RATE_APPROVAL', 'Already approved, change not allowed: person decides', base('RATE_APPROVAL', VAP, 'Not approved', ACC, { request: { state: 'APPROVED', allowReversal: false } }), 'REVIEW_REQUIRED', null),
  c(14, 'RATE_APPROVAL', 'Already approved, same answer again', base('RATE_APPROVAL', VAP, 'Approved', ACC, { request: { state: 'APPROVED' } }), 'APPROVED', 'APPROVED'),
  c(15, 'RATE_APPROVAL', 'Old approval only in the quoted history', base('RATE_APPROVAL', VAP, 'Thanks for the update\n\nOn Tue, Nov 10, 2026 at 5:00 PM Raj <r@x.com> wrote:\n> Approved'), 'REVIEW_REQUIRED', null),
  c(16, 'RATE_APPROVAL', 'Same amount as requested', base('RATE_APPROVAL', VAP, 'Approved ₹18,500', ACC, { request: { requestedAmount: 18500 } }), 'APPROVED', 'APPROVED'),
  c(17, 'RATE_APPROVAL', 'Different amount than requested', base('RATE_APPROVAL', VAP, 'Approved ₹17,000', ACC, { request: { requestedAmount: 18500 } }), 'REVIEW_REQUIRED', null),
  c(18, 'RATE_APPROVAL', 'Same mail read twice', base('RATE_APPROVAL', VAP, 'Approved', ACC, { messageId: '<m2>', request: { processedMessageIds: ['<m2>'] } }), 'DUPLICATE', null),
  c(19, 'PROJECT_CODE', 'Correct project code request', base('PROJECT_CODE', CP, 'Project code: 12345678'), OK, '12345678'),
  c(20, 'PROJECT_CODE', 'Reply names another request', base('PROJECT_CODE', CP, 'Project code: 12345678', ACC, { subject: 'Re: ADN-Signage-cp-99999999' }), 'UNMATCHED', null),
  c(21, 'PROJECT_CODE', 'Unauthorised sender', base('PROJECT_CODE', CP, 'Project code: 12345678', 'stranger@evil.com'), 'REVIEW_REQUIRED', null),
  c(22, 'PROJECT_CODE', 'Old code in the subject, new code in the body', base('PROJECT_CODE', CP, 'Project code: 87654321', ACC, { subject: `Re: 12345678 ${CP}` }), OK, '87654321'),
  c(23, 'PROJECT_CODE', 'Code already used by another project', base('PROJECT_CODE', CP, 'Project code: 12345678', ACC, { request: { existingValues: ['12345678'] } }), 'REVIEW_REQUIRED', null),
  c(24, 'PROJECT_CODE', 'Pending code', base('PROJECT_CODE', CP, 'Project code pending, expected EST-457435'), 'PENDING', null),
  c(25, 'PROJECT_CODE', 'A vendor ID is not a project code', base('PROJECT_CODE', CP, 'Vendor ID: 12345'), 'NOT_FOUND', null),
  c(26, 'VENDOR_ID', 'HTML-only mail', { subject: `Re: ${VND}`, body: '', html: '<div>Vendor ID: <b>55555</b></div><div class="gmail_quote">Vendor ID: 11111</div>', sender: ACC, request: { requestId: VND, recipients: [ACC] } }, OK, '55555'),
  c(27, 'RATE_APPROVAL', 'HTML-only mail with quoted rejection', { subject: `Re: ${VAP}`, body: '', html: '<p>Approved</p><blockquote>Rejected</blockquote>', sender: ACC, request: { requestId: VAP, recipients: [ACC], state: 'PENDING' } }, 'APPROVED', 'APPROVED'),
  c(28, 'RATE_APPROVAL', 'Gmail mobile signature', base('RATE_APPROVAL', VAP, 'Approved\n\nSent from my iPhone'), 'APPROVED', 'APPROVED'),
  c(29, 'VENDOR_ID', 'Outlook reply header', base('VENDOR_ID', VND, 'Vendor ID: 55555\n\nFrom: A\nSent: Monday\nTo: B\nSubject: Re: x\nVendor ID: 11111'), OK, '55555'),
  c(30, 'VENDOR_ID', 'Request ID written in lower case', base('VENDOR_ID', VND, 'Vendor ID: 78954', ACC, { subject: 'RE: adn-signage-vnd-12112601' }), OK, '78954'),
];

export const ALL_CASES: ReplyCase[] = [...VENDOR_CASES, ...RATE_CASES, ...PROJECT_CASES, ...CROSS_CASES];

export interface CaseResult {
  id: string;
  group: CaseGroup;
  workflow: Workflow;
  title: string;
  rawReply: string;
  expectedValue: string | null;
  expectedStatus: ReplyStatus;
  actualValue: string | null;
  actualStatus: ReplyStatus;
  actualNormalized: string | null;
  pass: boolean;
  failureReason: string;
}
