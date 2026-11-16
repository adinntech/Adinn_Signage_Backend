import { describe, expect, it } from 'vitest';
import { recceCodesBody } from '../src/modules/sales/sales.validators';

describe('Recce codes: the project code alone is enough', () => {
  it('accepts a project code without an estimation code', () => {
    expect(recceCodesBody.safeParse({ projectCode: '22070277', clientId: 'C-1' }).success).toBe(true);
    expect(recceCodesBody.safeParse({ projectCode: '22070277', estimationCode: '', clientId: 'C-1' }).success).toBe(true);
  });
  it('still checks an estimation code when one is given', () => {
    expect(recceCodesBody.parse({ projectCode: '22070277', estimationCode: 'est-323343' }).estimationCode).toBe('EST-323343');
    expect(recceCodesBody.safeParse({ projectCode: '22070277', estimationCode: 'EST-12' }).success).toBe(false);
    expect(recceCodesBody.safeParse({ projectCode: '2207', estimationCode: 'EST-323343' }).success).toBe(false);
  });
});
