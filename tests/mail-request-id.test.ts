import { describe, expect, it } from 'vitest';
import { formatRequestId, subjectWithId } from '../src/modules/mailSettings/requestId';
import { routingBody } from '../src/modules/mailSettings/mailRouting.validators';

describe('request id', () => {
  it('is tag + ddmmyy + serial', () => {
    expect(formatRequestId('VENDOR_REGISTRATION', 1, new Date(2026, 11, 6))).toBe('Adn-Signage-VenReg-06122601');
    expect(formatRequestId('PROJECT_CODE', 78, new Date(2026, 11, 6))).toBe('Adn-Signage-ProCode-06122678');
  });
  it('keeps counting across the year change and grows past 99', () => {
    expect(formatRequestId('VENDOR_REGISTRATION', 79, new Date(2027, 0, 5))).toBe('Adn-Signage-VenReg-05012779');
    expect(formatRequestId('CLIENT_CODE', 100, new Date(2026, 11, 6))).toBe('Adn-Signage-CliCode-061226100');
  });
  it('adds the id to the subject once', () => {
    const id = 'Adn-Signage-ProCode-06122601';
    expect(subjectWithId('Project Code Request - ACME', id)).toBe(`Project Code Request - ACME - ${id}`);
    expect(subjectWithId(`Project Code Request - ${id}`, id)).toBe(`Project Code Request - ${id}`);
  });
});

describe('routing validation', () => {
  it('lower-cases, de-duplicates and needs a recipient', () => {
    const r = routingBody.parse({ to: ['Project@Adinn.co.in', 'project@adinn.co.in'], cc: ['sm@adinn.co.in'] });
    expect(r.to).toEqual(['project@adinn.co.in']);
    expect(r.bcc).toEqual([]);
    expect(routingBody.safeParse({ to: [], cc: [] }).success).toBe(false);
    expect(routingBody.safeParse({ to: ['bad'], cc: [] }).success).toBe(false);
  });
});

describe('request id reading', () => {
  it('reads new and old spellings in any letter case and keeps the stored spelling', async () => {
    const { requestIdsIn } = await import('../src/modules/mailReplies/replyParser');
    const { requestKindOf } = await import('../src/modules/mailSettings/requestIdTags');
    expect(requestIdsIn('Re: x - adn-signage-venreg-13112601, ADN-SIGNAGE-VENRATE-13112602 and ADN-Signage-vnd-06122601')).toEqual(['Adn-Signage-VenReg-13112601', 'Adn-Signage-VenRate-13112602', 'ADN-Signage-vnd-06122601']);
    expect(requestKindOf('Adn-Signage-VenReg-13112601')).toBe('vendor');
    expect(requestKindOf('Adn-Signage-VenRate-13112601')).toBe('rate');
    expect(requestKindOf('Adn-Signage-ProCode-13112601')).toBe('code');
    expect(requestKindOf('ADN-Signage-vap-06122601')).toBe('rate');
  });
});
