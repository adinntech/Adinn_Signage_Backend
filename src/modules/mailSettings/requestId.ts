import { nextSeq } from '../../common/counter.model';

import { REQUEST_ID_TAGS, type RequestIdType } from './requestIdTags';

export { REQUEST_ID_TAGS };
export type { RequestIdType };

const two = (n: number) => String(n).padStart(2, '0');

/**
 * Adn-Signage-VenReg-13112601 = tag + ddmmyy + serial. The serial is a running number per tag: it is never reset, so
 * ...2678 is followed by ...2779 when the year changes. It grows to 3+ digits after 99.
 */
export const formatRequestId = (type: RequestIdType, serial: number, d = new Date()) =>
  `Adn-Signage-${REQUEST_ID_TAGS[type]}-${two(d.getDate())}${two(d.getMonth() + 1)}${two(d.getFullYear() % 100)}${String(serial).padStart(2, '0')}`;

/** Takes the next serial atomically, so two requests can never get the same ID. */
export async function newRequestId(type: RequestIdType, d = new Date()) {
  return formatRequestId(type, await nextSeq(`mail-request-${REQUEST_ID_TAGS[type]}`), d);
}

/** Puts the request ID at the end of the subject (replies keep it), once. */
export const subjectWithId = (subject: string, requestId: string) => (subject.includes(requestId) ? subject : `${subject.trim()} - ${requestId}`).slice(0, 200);
