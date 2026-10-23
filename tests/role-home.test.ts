import { describe, expect, it } from 'vitest';
import { ROLES, ROLE_HOME, ROLE_PLATFORMS } from '../src/modules/roles/roles';

describe('role home', () => {
  it('every role has a home path', () => {
    for (const r of ROLES) expect(ROLE_HOME[r]).toMatch(/^\//);
  });

  it('routes web roles to their own dashboard', () => {
    expect(ROLE_HOME.BD).toBe('/bd/dashboard');
    expect(ROLE_HOME.CLIENT_SERVICING).toBe('/client-servicing/dashboard');
    expect(ROLE_HOME.OPERATIONS).toBe('/operations/dashboard');
    expect(ROLE_HOME.RECCE_COORDINATOR).toBe('/operations/dashboard');
    expect(ROLE_HOME.FINANCE).toBe('/finance/dashboard');
    expect(ROLE_HOME.SUPER_ADMIN).toBe('/admin/dashboard');
    expect(ROLE_HOME.MANAGEMENT).toBe('/admin/dashboard');
  });

  it('never sends a role to a web area it cannot open', () => {
    const area = (p: string) => p.split('/')[1];
    const owners: Record<string, string[]> = {
      bd: ['BD', 'SUPER_ADMIN'],
      'client-servicing': ['CLIENT_SERVICING', 'SUPER_ADMIN'],
      operations: ['OPERATIONS', 'RECCE_COORDINATOR', 'SUPER_ADMIN'],
      finance: ['FINANCE', 'SUPER_ADMIN'],
      admin: ['SUPER_ADMIN', 'MANAGEMENT'],
    };
    for (const r of ROLES) {
      if (!ROLE_PLATFORMS[r].includes('web')) continue;
      expect(owners[area(ROLE_HOME[r]) ?? '']).toContain(r);
    }
  });
});
