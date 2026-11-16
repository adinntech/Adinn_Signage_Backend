import type { ReplyRules } from './replyParser';
import type { AnalyzeInput, ReplyStatus, Workflow } from './replyAnalyzer';
import type { ReplyCase } from './replyTestCases';

/**
 * Mixed-character reply cases: numbers written with letters, symbols, hyphens, line breaks (the digits of ONE candidate are taken in
 * the order written), plus the boundary and negative cases around them. Part 1 of each list is the table given by the business
 * (V01-V15, P01-P20, E01-E15); part 2 is the extra boundary / negative set (40+ per workflow). Pure text: nothing here reads a
 * mailbox or touches a record. The vendor and project cases also run in the admin Email Reply Test Lab ("Run all").
 */
const VND = 'ADN-Signage-vnd-12112601';
const CP = 'ADN-Signage-cp-12112601';
const ACC = 'accounts@adinn.co.in';
const OK = 'EXTRACTED';
type More = Partial<ReplyCase> & { html?: string; rules?: Partial<ReplyRules> };

const mk = (prefix: string, group: Workflow, workflow: Workflow) => (n: number, title: string, body: string, expectStatus: ReplyStatus, expectValue: string | null, more: More = {}): ReplyCase => {
  const { html, rules, ...rest } = more;
  return { id: `${prefix}${String(n).padStart(2, '0')}`, group: group as ReplyCase['group'], workflow, title, input: { body, ...(html ? { html } : {}), ...(rules ? { rules } : {}) }, expectStatus, expectValue, ...rest };
};
const mv = mk('MV', 'VENDOR_ID', 'VENDOR_ID');
const mp = mk('MP', 'PROJECT_CODE', 'PROJECT_CODE');

export const MIXED_VENDOR_CASES: ReplyCase[] = [
  // ---- the business table V01-V15 ----
  mv(1, 'V01 continuous number', '78954', OK, '78954'),
  mv(2, 'V02 symbols inside the number', '78@95#4', OK, '78954'),
  mv(3, 'V03 letters inside after "VENDOR:"', 'VENDOR: 12AB345', OK, '12345'),
  mv(4, 'V04 stars and symbols around', '***98@76#5***', OK, '98765'),
  mv(5, 'V05 "VId" label, leading zeros', 'VId: 0@0#0$4%5', OK, '00045'),
  mv(6, 'V06 letters between the digits', '12a34b5', OK, '12345'),
  mv(7, 'V07 trailing symbols', '78*9@54#', OK, '78954'),
  mv(8, 'V08 only 4 digits: invalid', '1@2#3$4', 'INVALID', null),
  mv(9, 'V09 UF prefix is another system: ignored', 'UF987654320', 'NOT_FOUND', null),
  mv(10, 'V10 mobile number: ignored', 'Mobile: 9876543210', 'NOT_FOUND', null),
  mv(11, 'V11 labelled, symbols inside', 'Vendor ID 78@95#4', OK, '78954'),
  mv(12, 'V12 two different IDs: person decides', 'Vendor ID 12345 / 67890', 'REVIEW_REQUIRED', null),
  mv(13, 'V13 GSTIN: ignored', 'GST: 33ABCDE1234F1Z5', 'NOT_FOUND', null),
  mv(14, 'V14 leading zeros kept (6 digits)', 'Vendor ID: 000@123', OK, '000123'),
  mv(15, 'V15 cancelled: not confirmed', 'Vendor ID: 12345 cancelled', 'CANCELLED', null),
  // ---- extra boundary and negative cases ----
  mv(16, 'Exactly the minimum (5)', 'Vendor ID: 12345', OK, '12345'),
  mv(17, 'One below the minimum (4)', 'Vendor ID: 1234', 'INVALID', null),
  mv(18, 'Minimum split by symbols (12@3#45)', 'Vendor ID: 12@3#45', OK, '12345'),
  mv(19, 'One below the minimum split by symbols', 'Vendor ID: 1@2#34', 'INVALID', null),
  mv(20, 'Maximum (12 digits)', 'Vendor ID: 123456789012', OK, '123456789012'),
  mv(21, 'One above the maximum (13 digits)', 'Vendor ID: 1234567890123', 'INVALID', null),
  mv(22, 'Leading zeros only', 'Vendor ID: 00000', OK, '00000'),
  mv(23, 'Leading zeros split by symbols', 'Vendor ID: 0@0#0$0%1', OK, '00001'),
  mv(24, 'CamelCase label, no space', 'VendorId78954', OK, '78954'),
  mv(25, 'Label and number glued with a colon', 'vendorid:78954', OK, '78954'),
  mv(26, 'Digits separated by single hyphens', 'VENDORID 7-8-9-5-4', OK, '78954'),
  mv(27, 'Label, then the number on the next line', 'Vendor ID:\n78954', OK, '78954'),
  mv(28, 'Label, then a mixed number on the next line', 'Vendor ID\n98@54#3', OK, '98543'),
  mv(29, 'Number in brackets and a full stop', 'Vendor ID: (78954).', OK, '78954'),
  mv(30, 'Number in quotes', 'Vendor ID: "78954"', OK, '78954'),
  mv(31, 'Exclamation after the number', 'Vendor ID - 78954!', OK, '78954'),
  mv(32, 'Digits in groups with spaces are not joined', 'Vendor ID: 78 954', 'INVALID', null),
  mv(33, 'Two numbers separated by a space', 'Vendor ID: 12345 67890', 'REVIEW_REQUIRED', null),
  mv(34, 'Two numbers joined by a hyphen stay two', 'Vendor ID: 12345-67890', 'REVIEW_REQUIRED', null),
  mv(35, 'A number then a name joined by a hyphen', 'Vendor ID: 12345-ABC', OK, '12345'),
  mv(36, 'Letters on both sides', 'Vendor ID: AB12345CD', OK, '12345'),
  mv(37, 'Letters and hyphens between digit groups', 'Vendor ID: ab-12-cd-345', OK, '12345'),
  mv(38, 'Unknown prefix (not configured) keeps its digits', 'Vendor ID: XY12345', OK, '12345'),
  mv(39, 'UF prefix after the label: ignored', 'Vendor ID: UF987654320', 'NOT_FOUND', null),
  mv(40, 'UF with a dash: ignored', 'UF-903282', 'NOT_FOUND', null),
  mv(41, 'A configured extra unrelated prefix is ignored', 'Vendor ID: XY12345', 'NOT_FOUND', null, { rules: { unrelatedPrefixes: ['UF', 'XY'] } }),
  mv(42, 'Phone number as the vendor ID', 'Vendor ID: 9876543210', 'INVALID', null),
  mv(43, 'Phone number in two groups', 'Vendor ID 98765 43210', 'NOT_FOUND', null),
  mv(44, 'Phone number with country code', 'Vendor ID: +91 9876543210', 'NOT_FOUND', null),
  mv(45, 'Phone before the ID is not the ID', 'Mobile: 98765 43210 Vendor ID: 78954', OK, '78954'),
  mv(46, 'GSTIN after the label', 'Vendor ID: 33ABCDE1234F1Z5', 'NOT_FOUND', null),
  mv(47, 'GSTIN beside a valid ID', 'Vendor ID 78954 GST 33ABCDE1234F1Z5', OK, '78954'),
  mv(48, 'PAN alone', 'PAN: ABCDE1234F', 'NOT_FOUND', null),
  mv(49, 'Numeric date alone', 'Created on 12/11/2026', 'NOT_FOUND', null),
  mv(50, 'Date with a month name', 'Done 12 Nov 2026', 'NOT_FOUND', null),
  mv(51, 'Date after a valid ID', 'Vendor ID: 78954 on 12-11-2026', OK, '78954'),
  mv(52, 'Amount in lakhs after the ID', 'Vendor ID: 78954 amount ₹1,25,000', OK, '78954'),
  mv(53, 'Amount alone', '₹12,345,678', 'NOT_FOUND', null),
  mv(54, 'Rs. amount alone', 'Rs. 12345', 'NOT_FOUND', null),
  mv(55, 'Year after the ID', 'Vendor ID: 78954 FY 2026', OK, '78954'),
  mv(56, 'EST number beside the ID is not the ID', 'Vendor ID: 78954 EST-903282', OK, '78954'),
  mv(57, 'EST number alone', 'EST-903282', 'NOT_FOUND', null),
  mv(58, 'Same ID twice', 'Vendor ID: 78954 and Vendor ID: 78954', OK, '78954'),
  mv(59, 'Two different IDs on two lines', 'Vendor ID: 11111\nVendor ID: 22222', 'REVIEW_REQUIRED', null),
  mv(60, 'Only the quoted mail has an ID', 'Thanks\n> Vendor ID: 11111', 'NOT_FOUND', null),
  mv(61, 'New ID above a quoted old one', 'Vendor ID: 78954\n> Vendor ID: 11111', OK, '78954'),
  mv(62, 'HTML mail: symbols inside, quote ignored', '', OK, '78954', { html: '<p>Vendor ID: <b>78@95#4</b></p><blockquote>Vendor ID: 11111</blockquote>' }),
  mv(63, 'Cancelled with a mixed ID', 'Vendor ID: 78@95#4 cancelled', 'CANCELLED', null),
  mv(64, '"not cancelled" does not cancel', 'Vendor ID: 78954 not cancelled', OK, '78954'),
  mv(65, 'Wrong request type: a project code reply', 'Project code: 12345678', 'NOT_FOUND', null),
  mv(66, 'Wrong request type: a client code reply', 'Client code: 12345678', 'NOT_FOUND', null),
  mv(67, '"Supplier ID" label', 'Supplier ID 78@95#4', OK, '78954'),
  mv(68, '"V ID" label with a space', 'V ID: 78954', OK, '78954'),
  mv(69, 'No label: a mixed word inside a sentence', 'Done. 12a34b5', OK, '12345'),
  mv(70, 'No label: two mixed words are ambiguous', 'numbers 12a34b5 and 98c76d5', 'REVIEW_REQUIRED', null),
  mv(71, 'No label: letters around a plain number', 'Thanks. Registered as AB78954CD', OK, '78954'),
  mv(72, 'An invoice number is not a vendor ID', 'Invoice 12345', 'NOT_FOUND', null),
  mv(73, 'Higher minimum from the rules (6): 5 digits invalid', 'Vendor ID: 12345', 'INVALID', null, { rules: { vendorMinDigits: 6 } }),
  mv(74, 'Higher minimum from the rules (6): 6 digits valid', 'Vendor ID: 123456', OK, '123456', { rules: { vendorMinDigits: 6 } }),
  mv(75, 'Lower maximum from the rules (8): 9 digits invalid', 'Vendor ID: 123456789', 'INVALID', null, { rules: { vendorMaxDigits: 8 } }),
  mv(76, 'Unicode digits are not digits', 'Vendor ID: ١٢٣٤٥', 'NOT_FOUND', null),
  mv(77, 'Empty reply', '', 'NOT_FOUND', null),
  mv(78, 'Thanks only', 'Thanks, created.', 'NOT_FOUND', null),
];

export const MIXED_PROJECT_CASES: ReplyCase[] = [
  // ---- the business table P01-P20 ----
  mp(1, 'P01 continuous 8 digits', '12345678', OK, '12345678'),
  mp(2, 'P02 symbols and letters, order kept', '%3924&242*8fafdRW', OK, '39242428'),
  mp(3, 'P03 symbols between pairs', '12@34#56$78', OK, '12345678'),
  mp(4, 'P04 letters between pairs', 'AB12CD34EF56GH78', OK, '12345678'),
  mp(5, 'P05 stars around groups', '***9876***5432***', OK, '98765432'),
  mp(6, 'P06 label with letters inside', 'PrOjEcT: 12a34b56c78', OK, '12345678'),
  mp(7, 'P07 a symbol after every digit', '1@2#3$4%5^6&7*8', OK, '12345678'),
  mp(8, 'P08 hyphens between pairs', '12-34-56-78', OK, '12345678'),
  mp(9, 'P09 leading zeros kept', '000@123#45', OK, '00012345'),
  mp(10, 'P10 groups with a space: not joined without the label', '1234 5678', 'NOT_FOUND', null),
  mp(11, 'P11 letters around 8 digits', 'AB12345678XYZ', OK, '12345678'),
  mp(12, 'P12 9 digits among letters', '123abc456def789', OK, '123456789'),
  mp(13, 'P13 7 digits: invalid', '%123&456*7', 'INVALID', null),
  mp(14, 'P14 7 digits: invalid', '1234@567', 'INVALID', null),
  mp(15, 'P15 UF prefix is another system: ignored', 'UF987654320', 'NOT_FOUND', null),
  mp(16, 'P16 mobile number: ignored', 'Mobile: 9876543210', 'NOT_FOUND', null),
  mp(17, 'P17 GSTIN: ignored', 'GST: 33ABCDE1234F1Z5', 'NOT_FOUND', null),
  mp(18, 'P18 currency: ignored', '₹12,345,678', 'NOT_FOUND', null),
  mp(19, 'P19 labelled, symbols inside', 'Project Code: 12@34#56$78', OK, '12345678'),
  mp(20, 'P20 project code and an estimate: the project only', 'Project: 12345678, Estimate: EST-903282', OK, '12345678'),
  // ---- extra boundary and negative cases ----
  mp(21, 'P10 labelled groups are joined', 'Project Code: 1234 5678', OK, '12345678'),
  mp(22, 'Labelled groups that are 7 digits together', 'Project code: 1234 567', 'INVALID', null),
  mp(23, 'One below the minimum with symbols', 'Project code: 12@34#56$7', 'INVALID', null),
  mp(24, 'One above the minimum (9)', 'Project code: 123456789', OK, '123456789'),
  mp(25, 'Maximum (15 digits)', 'Project code: 123456789012345', OK, '123456789012345'),
  mp(26, 'One above the maximum (16 digits)', 'Project code: 1234567890123456', 'INVALID', null),
  mp(27, 'Leading zeros split by symbols', 'Project code: 00@12#3456', OK, '00123456'),
  mp(28, 'All zeros but the last digit', 'Project code: 00000008', OK, '00000008'),
  mp(29, 'Label glued to the number', 'ProjectCode:12@34#56$78', OK, '12345678'),
  mp(30, 'Letters between every digit', 'projectcode is 1a2b3c4d5e6f7g8h', OK, '12345678'),
  mp(31, 'CamelCase label with "Is"', 'ProjectCodeIs12@34#56$78', OK, '12345678'),
  mp(32, 'Letters and hyphens after the label', 'Project Code - AB-12-34-56-78', OK, '12345678'),
  mp(33, 'Label, then the number on the next line', 'Project code:\n12345678', OK, '12345678'),
  mp(34, 'Label, then a mixed number on the next line', 'Project code is\n12@34#56$78', OK, '12345678'),
  mp(35, 'Eight digits, three symbols, no label', '%123&456*78', OK, '12345678'),
  mp(36, 'Five digits only', 'Project code: 12345', 'INVALID', null),
  mp(37, 'Three digits are not even a candidate', 'Project code: 123', 'NOT_FOUND', null),
  mp(38, 'Two valid candidates, one mixed', 'Project code: 12@34#56$78 / 87654321', 'REVIEW_REQUIRED', null),
  mp(39, 'Two lines, two codes', 'Project code: 12345678\nProject code: 87654321', 'REVIEW_REQUIRED', null),
  mp(40, 'The same code on two lines', 'Project code: 12345678\nProject code: 12345678', OK, '12345678'),
  mp(41, 'The same code, plain and mixed', 'Project code: 12345678 / 12@34#56$78', OK, '12345678'),
  mp(42, 'Cancelled project', 'Project code: 12345678 cancelled', 'CANCELLED', null),
  mp(43, '"not cancelled" does not cancel', 'Project code: 12345678 not cancelled', OK, '12345678'),
  mp(44, 'Cancelled with a mixed code', 'Project 12@34#56$78 is cancelled', 'CANCELLED', null),
  mp(45, 'Pending: no code yet', 'Project code pending', 'NOT_FOUND', null),
  mp(46, 'Pending with a number: not confirmed', 'Project code pending 12345678', 'PENDING', null),
  mp(47, 'Expected with a mixed number: not confirmed', 'Project code expected: 12@34#56$78', 'PENDING', null),
  mp(48, 'UF prefix after the label: ignored', 'Project code: UF12345678', 'NOT_FOUND', null),
  mp(49, 'UF code beside a real code', 'Project code: UF-12345678 / 87654321', OK, '87654321'),
  mp(50, 'Unknown prefix keeps its digits', 'Project code: XY12345678', OK, '12345678'),
  mp(51, 'A configured extra unrelated prefix is ignored', 'Project code: XY12345678', 'NOT_FOUND', null, { rules: { unrelatedPrefixes: ['UF', 'XY'] } }),
  mp(52, 'Labelled 10 digits (not a phone when labelled)', 'Project code: 9876543210', OK, '9876543210'),
  mp(53, 'Mobile before the label', 'Mobile: 9876543210 Project code: 12345678', OK, '12345678'),
  mp(54, 'Phone in two groups, then a code', 'Call 98765 43210 for 12345678', OK, '12345678'),
  mp(55, 'Phone with country code alone', 'Mobile: +91 98765 43210', 'NOT_FOUND', null),
  mp(56, 'GSTIN before a labelled code', 'GST: 33ABCDE1234F1Z5 Project code: 12345678', OK, '12345678'),
  mp(57, 'PAN alone', 'PAN: ABCDE1234F', 'NOT_FOUND', null),
  mp(58, 'Numeric date alone', 'Date: 12/11/2026', 'NOT_FOUND', null),
  mp(59, 'Date with dashes', 'Created on 12-11-2026', 'NOT_FOUND', null),
  mp(60, 'Date with a month name', 'Created on 12 Nov 2026', 'NOT_FOUND', null),
  mp(61, 'Amount with the rupee sign', 'Amount ₹12345678', 'NOT_FOUND', null),
  mp(62, 'Amount with Rs. and commas', 'Rs. 12,345,678', 'NOT_FOUND', null),
  mp(63, 'Amount with INR', 'INR 12345678', 'NOT_FOUND', null),
  mp(64, 'Invoice number is not a project code', 'Invoice 12345678', 'NOT_FOUND', null),
  mp(65, 'Code before an invoice number', 'Created 12345678 Invoice 99999999', OK, '12345678'),
  mp(66, 'A mixed word inside a sentence: a person checks', 'Order 20261112ORD#3 created', 'REVIEW_REQUIRED', null),
  mp(67, 'Only the request ID', 'ADN-Signage-cp-12112601', 'NOT_FOUND', null),
  mp(68, 'A code beside the request ID', 'Project code: 12345678 ref ADN-Signage-cp-12112601', OK, '12345678'),
  mp(69, 'Wrong request type: a vendor ID reply', 'Vendor ID: 12345678', 'NOT_FOUND', null),
  mp(70, 'Wrong request type: a client code reply', 'Client code: 12345678', 'NOT_FOUND', null),
  mp(71, 'EST number with 8 digits is not a project code', 'Project code: EST-12345678', 'NOT_FOUND', null),
  mp(72, 'Project code and a mixed estimate', 'Project 12345678 EST-12@34#5', OK, '12345678'),
  mp(73, 'Project code and two estimates', 'Project code: 12345678 EST-903282 EST-111222', OK, '12345678'),
  mp(74, 'Business example: UF and EST only', 'Job completed.\nUF987654320\nEST-903282', 'NOT_FOUND', null),
  mp(75, 'Business example: code with an estimate', 'Job completed.\n12345678\nEST-903282', OK, '12345678'),
  mp(76, 'Only the quoted mail has a code', 'Thanks\n> Project code: 87654321', 'NOT_FOUND', null),
  mp(77, 'New code above a quoted old one', 'Project code: 12345678\n> Project code: 87654321', OK, '12345678'),
  mp(78, 'HTML mail: symbols inside, quote ignored', '', OK, '12345678', { html: '<p>Project code: <b>12@34#56$78</b></p><blockquote>Project code: 87654321</blockquote>' }),
  mp(79, 'Lower minimum from the rules (6)', 'Project code: 123456', OK, '123456', { rules: { projectMinDigits: 6 } }),
  mp(80, 'Higher minimum from the rules (10): 9 digits invalid', 'Project code: 123456789', 'INVALID', null, { rules: { projectMinDigits: 10 } }),
  mp(81, 'Empty reply', '', 'NOT_FOUND', null),
  mp(82, 'Thanks only', 'Thanks, done.', 'NOT_FOUND', null),
];

/* ---------------------------------------------------------------- cross-workflow: request, sender, duplicates ---------------------------------------------------------------- */
const ctxIn = (workflow: Workflow, requestId: string, body: string, sender = ACC, extra: Omit<AnalyzeInput, 'workflow' | 'body' | 'sender' | 'request' | 'subject'> & { request?: Record<string, unknown>; subject?: string } = {}): Omit<AnalyzeInput, 'workflow'> => {
  const { request, subject, ...rest } = extra;
  return { subject: subject ?? `Re: ${requestId}`, body, sender, request: { requestId, recipients: [ACC], ...(request ?? {}) } as NonNullable<AnalyzeInput['request']>, ...rest };
};
const mc = (n: number, workflow: Workflow, title: string, input: Omit<AnalyzeInput, 'workflow'>, expectStatus: ReplyStatus, expectValue: string | null): ReplyCase => ({ id: `MC${String(n).padStart(2, '0')}`, group: 'CROSS', workflow, title, input, expectStatus, expectValue });

export const MIXED_CROSS_CASES: ReplyCase[] = [
  mc(1, 'VENDOR_ID', 'Mixed vendor ID, correct request and sender', ctxIn('VENDOR_ID', VND, 'Vendor ID: 78@95#4'), OK, '78954'),
  mc(2, 'VENDOR_ID', 'Mixed vendor ID from an unauthorised sender', ctxIn('VENDOR_ID', VND, 'Vendor ID: 78@95#4', 'stranger@evil.com'), 'REVIEW_REQUIRED', null),
  mc(3, 'VENDOR_ID', 'Mixed vendor ID for another request', ctxIn('VENDOR_ID', VND, 'Vendor ID: 78@95#4', ACC, { subject: 'Re: ADN-Signage-vnd-99999999' }), 'UNMATCHED', null),
  mc(4, 'VENDOR_ID', 'Same mixed mail read twice', ctxIn('VENDOR_ID', VND, 'Vendor ID: 78@95#4', ACC, { messageId: '<mx1>', request: { processedMessageIds: ['<mx1>'] } }), 'DUPLICATE', null),
  mc(5, 'VENDOR_ID', 'Mixed vendor ID already used by another vendor', ctxIn('VENDOR_ID', VND, 'Vendor ID: 78@95#4', ACC, { request: { existingValues: ['78954'] } }), 'REVIEW_REQUIRED', null),
  mc(6, 'VENDOR_ID', 'Quoted mixed ID in the history only', ctxIn('VENDOR_ID', VND, 'Thanks\n\nOn Wed, Nov 11, 2026 at 6:32 PM Accounts <a@x.com> wrote:\n> Vendor ID: 78@95#4'), 'NOT_FOUND', null),
  mc(7, 'PROJECT_CODE', 'Mixed project code, correct request and sender', ctxIn('PROJECT_CODE', CP, 'Project code: %3924&242*8fafdRW'), OK, '39242428'),
  mc(8, 'PROJECT_CODE', 'Mixed project code from an unauthorised sender', ctxIn('PROJECT_CODE', CP, 'Project code: 12@34#56$78', 'stranger@evil.com'), 'REVIEW_REQUIRED', null),
  mc(9, 'PROJECT_CODE', 'Mixed project code for another request', ctxIn('PROJECT_CODE', CP, 'Project code: 12@34#56$78', ACC, { subject: 'Re: ADN-Signage-cp-99999999' }), 'UNMATCHED', null),
  mc(10, 'PROJECT_CODE', 'Same mixed mail read twice', ctxIn('PROJECT_CODE', CP, 'Project code: 12@34#56$78', ACC, { messageId: '<mx2>', request: { processedMessageIds: ['<mx2>'] } }), 'DUPLICATE', null),
  mc(11, 'PROJECT_CODE', 'Mixed code already used by another project', ctxIn('PROJECT_CODE', CP, 'Project code: 12@34#56$78', ACC, { request: { existingValues: ['12345678'] } }), 'REVIEW_REQUIRED', null),
  mc(12, 'PROJECT_CODE', 'Cancelled project with context', ctxIn('PROJECT_CODE', CP, 'Project code: 12@34#56$78 is cancelled'), 'CANCELLED', null),
  mc(13, 'PROJECT_CODE', 'Pending project with context', ctxIn('PROJECT_CODE', CP, 'Project code pending, expected 12@34#56$78'), 'PENDING', null),
  mc(14, 'PROJECT_CODE', 'Only an EST number in a project code reply', ctxIn('PROJECT_CODE', CP, 'Job completed.\nUF987654320\nEST-903282'), 'NOT_FOUND', null),
  mc(15, 'VENDOR_ID', 'A project code reply sent to a vendor request', ctxIn('VENDOR_ID', VND, 'Project code: 12345678'), 'NOT_FOUND', null),
  mc(16, 'PROJECT_CODE', 'A vendor ID reply sent to a project code request', ctxIn('PROJECT_CODE', CP, 'Vendor ID: 12345678'), 'NOT_FOUND', null),
];

/** Mixed cases that run through the same analyzer as the rest of the suite (and in the Test Lab). */
export const MIXED_CASES: ReplyCase[] = [...MIXED_VENDOR_CASES, ...MIXED_PROJECT_CASES, ...MIXED_CROSS_CASES];

/* ---------------------------------------------------------------- estimate numbers ---------------------------------------------------------------- */
export interface EstimateCase {
  id: string;
  title: string;
  body: string;
  html?: string;
  rules?: Partial<ReplyRules>;
  expectStatus: 'EXTRACTED' | 'REVIEW_REQUIRED' | 'INVALID' | 'CANCELLED' | 'NOT_FOUND';
  /** The digits that would be saved (EST-<digits>); null when nothing is saved. */
  expectDigits: string | null;
}
const me = (n: number, title: string, body: string, expectStatus: EstimateCase['expectStatus'], expectDigits: string | null, more: { html?: string; rules?: Partial<ReplyRules> } = {}): EstimateCase => ({ id: `ME${String(n).padStart(2, '0')}`, title, body, expectStatus, expectDigits, ...more });

export const ESTIMATE_CASES: EstimateCase[] = [
  // ---- the business table E01-E15 ----
  me(1, 'E01 plain', 'EST-903282', 'EXTRACTED', '903282'),
  me(2, 'E02 mixed case, 7 digits', 'ESt-7443912', 'EXTRACTED', '7443912'),
  me(3, 'E03 symbols inside', 'est-45@43#949', 'EXTRACTED', '4543949'),
  me(4, 'E04 symbols after the prefix', 'EST-%12&34*5', 'EXTRACTED', '12345'),
  me(5, 'E05 letters inside', 'EST-12abc345', 'EXTRACTED', '12345'),
  me(6, 'E06 double dash, leading zeros', 'EST--000@45', 'EXTRACTED', '00045'),
  me(7, 'E07 spaces around the dash', 'EST - 90!32@82', 'EXTRACTED', '903282'),
  me(8, 'E08 underscore separator', 'EST_1a2b3c4d5', 'EXTRACTED', '12345'),
  me(9, 'E09 4 digits: invalid', 'EST-1@2#3$4', 'INVALID', null),
  me(10, 'E10 UF prefix: ignored', 'UF-903282', 'NOT_FOUND', null),
  me(11, 'E11 PREST is not EST', 'PREST-903282', 'NOT_FOUND', null),
  me(12, 'E12 two different estimates: person decides', 'EST-12345 and EST-67890', 'REVIEW_REQUIRED', null),
  me(13, 'E13 8 digits is still an estimate', 'EST-12345678', 'EXTRACTED', '12345678'),
  me(14, 'E14 estimate beside a project code', 'Project 12345678 EST-12@34#5', 'EXTRACTED', '12345'),
  me(15, 'E15 cancelled: not confirmed', 'EST-903282 cancelled', 'CANCELLED', null),
  // ---- extra boundary and negative cases ----
  me(16, 'Exactly the minimum (5)', 'EST-12345', 'EXTRACTED', '12345'),
  me(17, 'One below the minimum (4)', 'EST-1234', 'INVALID', null),
  me(18, 'Maximum (12 digits)', 'EST-123456789012', 'EXTRACTED', '123456789012'),
  me(19, 'One above the maximum (13 digits)', 'EST-1234567890123', 'INVALID', null),
  me(20, 'Lower case, space separator', 'est 12345', 'EXTRACTED', '12345'),
  me(21, 'Slash separator', 'EST/12345', 'EXTRACTED', '12345'),
  me(22, 'Colon separator', 'EST:12345', 'EXTRACTED', '12345'),
  me(23, 'No separator', 'EST12345', 'EXTRACTED', '12345'),
  me(24, 'Em dash separator', 'EST—12345', 'EXTRACTED', '12345'),
  me(25, 'Spaces around an en dash', 'EST – 12345', 'EXTRACTED', '12345'),
  me(26, 'Space after the dash', 'Est- 12345', 'EXTRACTED', '12345'),
  me(27, 'Digits in groups with spaces are not joined', 'EST - 12 345', 'INVALID', null),
  me(28, 'Dots between digits', 'EST-1.2.3.4.5', 'EXTRACTED', '12345'),
  me(29, 'Leading zeros only', 'Est - 000000', 'EXTRACTED', '000000'),
  me(30, 'Leading zeros split by symbols', 'EST-0@0#0$0%1', 'EXTRACTED', '00001'),
  me(31, 'Leading zero, 6 digits', 'EST-020456', 'EXTRACTED', '020456'),
  me(32, 'Prefix alone', 'EST-', 'NOT_FOUND', null),
  me(33, 'Prefix and a word', 'EST done', 'NOT_FOUND', null),
  me(34, 'ESTIMATE is not the prefix', 'ESTIMATE-12345', 'NOT_FOUND', null),
  me(35, 'TEST is not the prefix', 'TEST-12345', 'NOT_FOUND', null),
  me(36, 'REST is not the prefix', 'REST-12345', 'NOT_FOUND', null),
  me(37, 'BEST with underscore is not the prefix', 'BEST_12345', 'NOT_FOUND', null),
  me(38, 'The same estimate twice', 'EST-12345 EST-12345', 'EXTRACTED', '12345'),
  me(39, 'Two estimates with a comma', 'EST-12345, EST-67890', 'REVIEW_REQUIRED', null),
  me(40, 'Two estimates with a slash', 'EST-12345/EST-67890', 'REVIEW_REQUIRED', null),
  me(41, 'Two estimates on two lines', 'EST-12345\nEST-67890', 'REVIEW_REQUIRED', null),
  me(42, 'A mixed and a plain form of the same estimate', 'EST-12@34#5 and EST-12345', 'EXTRACTED', '12345'),
  me(43, 'Amount after the prefix is not an estimate', 'EST-12,345', 'NOT_FOUND', null),
  me(44, 'Date after the prefix is not an estimate', 'EST-12/11/2026', 'NOT_FOUND', null),
  me(45, 'Rupee amount after the prefix is not an estimate', 'EST-₹12345', 'NOT_FOUND', null),
  me(46, 'Cancelled estimate with the word first', 'cancelled EST-12345', 'CANCELLED', null),
  me(47, '"not cancelled" does not cancel', 'EST-12345 not cancelled', 'EXTRACTED', '12345'),
  me(48, 'Only the quoted mail has an estimate', 'Thanks\n> EST-12345', 'NOT_FOUND', null),
  me(49, 'New estimate above a quoted old one', 'EST-12345\n> EST-67890', 'EXTRACTED', '12345'),
  me(50, 'Estimate beside a vendor ID', 'Vendor ID: 78954 EST-903282', 'EXTRACTED', '903282'),
  me(51, 'Estimate beside a project code', 'Project code 12345678 est-903282', 'EXTRACTED', '903282'),
  me(52, 'UF number beside an estimate', 'UF987654320 EST-903282', 'EXTRACTED', '903282'),
  me(53, 'Phone beside an estimate', 'Mobile 9876543210 EST-12345', 'EXTRACTED', '12345'),
  me(54, 'GSTIN beside an estimate', 'GST 33ABCDE1234F1Z5 EST-12345', 'EXTRACTED', '12345'),
  me(55, 'Request ID beside an estimate', 'ADN-Signage-cp-12112601 EST-12345', 'EXTRACTED', '12345'),
  me(56, '"EST number is 12345": a word sits between', 'EST number is 12345', 'NOT_FOUND', null),
  me(57, 'Higher minimum from the rules (6)', 'EST-12345', 'INVALID', null, { rules: { estDigits: 6 } }),
  me(58, 'Lower maximum from the rules (8)', 'EST-123456789', 'INVALID', null, { rules: { estMaxDigits: 8 } }),
  me(59, 'HTML mail: symbols inside, quote ignored', '', 'EXTRACTED', '45439', { html: '<p>EST-45@43#9</p><blockquote>EST-67890</blockquote>' }),
  me(60, 'Empty reply', '', 'NOT_FOUND', null),
];
