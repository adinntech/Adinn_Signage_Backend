import { nextSeq } from '../../common/counter.model';

/** Which kind of request an ID is for. The tag is the part after "ADN-Signage-". */
export const REQUEST_ID_TAGS = { CLIENT_CODE: 'cli', PROJECT_CODE: 'prj', COMBINED_CODE: 'cp', VENDOR_REGISTRATION: 'vnd', VENDOR_RATE_APPROVAL: 'vap' } as const;
export type RequestIdType = keyof typeof REQUEST_ID_TAGS;

const two = (n: number) => String(n).padStart(2, '0');

/**
 * ADN-Signage-vnd-06122601 = tag + ddmmyy + serial. The serial is a running number per tag: it is never reset, so
 * ...2678 is followed by ...2779 when the year changes. It grows to 3+ digits after 99.
 */
export const formatRequestId = (type: RequestIdType, serial: number, d = new Date()) =>
  `ADN-Signage-${REQUEST_ID_TAGS[type]}-${two(d.getDate())}${two(d.getMonth() + 1)}${two(d.getFullYear() % 100)}${String(serial).padStart(2, '0')}`;

/** Takes the next serial atomically, so two requests can never get the same ID. */
export async function newRequestId(type: RequestIdType, d = new Date()) {
  return formatRequestId(type, await nextSeq(`mail-request-${REQUEST_ID_TAGS[type]}`), d);
}

/** Puts the request ID at the end of the subject (replies keep it), once. */
export const subjectWithId = (subject: string, requestId: string) => (subject.includes(requestId) ? subject : `${subject.trim()} - ${requestId}`).slice(0, 200);
