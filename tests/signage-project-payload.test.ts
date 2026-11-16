import { describe, expect, it } from 'vitest';

// Only the payload builder is exercised: no database, no network.
const base = {
  to: ['a@x.in'], cc: [], subject: 'Project Code Request', requestId: 'ADN-Signage-prj-091126001',
  text: 'Kindly create the codes', html: '<p>Kindly create the codes</p>', source: 'Client Servicing Team',
  client: { clientName: 'Milestone', clientCode: '30196' }, attachments: [],
};
const details = { existing: true, clientId: '30196', sections: [{ title: 'Client Details', rows: [{ label: 'Company Name', value: 'Milestone' }], table: null }] };

describe('project code request payload (Recce Assign)', () => {
  it('with details: the template prints the structure and the default text is not sent as a note', async () => {
    const { signagePayload } = await import('../src/modules/sales/signageMail');
    const p = signagePayload({ ...base, details }) as Record<string, unknown>;
    expect(p.details).toEqual(details);
    expect(p).not.toHaveProperty('bodyHtml');
    expect(p).not.toHaveProperty('message');
    expect(p).not.toHaveProperty('messageHtml');
  });

  it('with details and a written note: the rich note goes as bodyHtml', async () => {
    const { signagePayload } = await import('../src/modules/sales/signageMail');
    const p = signagePayload({ ...base, details, noteHtml: '<p><strong>Urgent</strong>: start Monday</p><ul><li>Theni</li></ul>' }) as Record<string, unknown>;
    expect(p.bodyHtml).toBe('<p><strong>Urgent</strong>: start Monday</p><ul><li>Theni</li></ul>');
    expect(p.message).toBe('Kindly create the codes');
  });

  it('without details (older callers): the whole text still goes, now under the key the PHP reads (bodyHtml)', async () => {
    const { signagePayload } = await import('../src/modules/sales/signageMail');
    const p = signagePayload(base) as Record<string, unknown>;
    expect(p.bodyHtml).toBe('<p>Kindly create the codes</p>');
    expect(p).not.toHaveProperty('messageHtml');
  });
});
