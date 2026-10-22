export const ROLES = [
  'SUPER_ADMIN',
  'BD',
  'RECCE_COORDINATOR',
  'RECCE_EXECUTIVE',
  'VENDOR',
  'OPERATIONS',
  'FINANCE',
  'MANAGEMENT',
] as const;
export type Role = (typeof ROLES)[number];

// Permission keys are `module:action`. Modules are added per phase.
export const PERMISSIONS = [
  'dashboard:view',
  'users:manage',
  'projects:read',
  'projects:write',
  'clients:read',
  'clients:write',
  'communications:read',
  'communications:write',
  'sites:read',
  'sites:write',
  'assignments:manage',
  'field:execute',
  'verification:manage',
  'vendors:manage',
  'finance:manage',
  'reports:read',
  // BD CRM: sales pipeline (orders), Company Profile email template, master rate card
  'sales:read',
  'sales:write',
  'templates:manage',
  'ratecards:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  BD: ['dashboard:view', 'projects:read', 'projects:write', 'clients:read', 'clients:write', 'communications:read', 'communications:write', 'sites:read', 'sites:write', 'reports:read', 'sales:read', 'sales:write', 'templates:manage', 'ratecards:manage'],
  RECCE_COORDINATOR: [
    'dashboard:view', 'projects:read', 'clients:read', 'communications:read', 'communications:write', 'sites:read', 'sites:write',
    'assignments:manage', 'verification:manage', 'vendors:manage', 'reports:read',
  ],
  RECCE_EXECUTIVE: ['dashboard:view', 'sites:read', 'field:execute'],
  VENDOR: ['dashboard:view', 'sites:read', 'field:execute'],
  OPERATIONS: ['dashboard:view', 'projects:read', 'clients:read', 'communications:read', 'communications:write', 'sites:read', 'sites:write', 'verification:manage', 'vendors:manage', 'reports:read'],
  FINANCE: ['dashboard:view', 'projects:read', 'clients:read', 'communications:read', 'finance:manage', 'reports:read'],
  MANAGEMENT: ['dashboard:view', 'projects:read', 'clients:read', 'communications:read', 'sites:read', 'reports:read'],
};

export const permissionsFor = (role: Role): readonly Permission[] => ROLE_PERMISSIONS[role];

// Where each role lands after login (web).
export const ROLE_HOME: Record<Role, string> = {
  SUPER_ADMIN: '/admin/dashboard',
  BD: '/bd/dashboard',
  RECCE_COORDINATOR: '/operations/dashboard',
  RECCE_EXECUTIVE: '/dashboard', // mobile-only; the Flutter app routes it to /recce
  VENDOR: '/dashboard', // mobile-only; the Flutter app routes it to /vendor
  OPERATIONS: '/operations/dashboard',
  FINANCE: '/finance/dashboard',
  MANAGEMENT: '/admin/dashboard',
};


// Which client app each role signs in on. Recce field staff are mobile-only; everyone else uses the web CRM.
export type Platform = 'web' | 'mobile';
export const ROLE_PLATFORMS: Record<Role, readonly Platform[]> = {
  SUPER_ADMIN: ['web'],
  BD: ['web'],
  RECCE_COORDINATOR: ['web'],
  RECCE_EXECUTIVE: ['mobile'],
  VENDOR: ['mobile'],
  OPERATIONS: ['web'],
  FINANCE: ['web'],
  MANAGEMENT: ['web'],
};

// Roles a person may pick when self-registering, per app. Management/coordinator accounts are created by an admin.
// SUPER_ADMIN is only accepted while no active super admin exists (first-run bootstrap); see auth.service register().
export const SELF_REGISTER_ROLES: Record<Platform, readonly Role[]> = {
  web: ['BD', 'OPERATIONS', 'FINANCE', 'SUPER_ADMIN'],
  mobile: ['RECCE_EXECUTIVE', 'VENDOR'],
};

// The role cards on the sign-in screens. The card a person picks must match the role their account was registered with.
export const LOGIN_ROLE_KEYS = ['BD', 'RECCE', 'VENDOR', 'OPERATIONS', 'ACCOUNTS', 'ADMIN'] as const;
export type LoginRoleKey = (typeof LOGIN_ROLE_KEYS)[number];
export const LOGIN_ROLE_GROUPS: Record<LoginRoleKey, readonly Role[]> = {
  BD: ['BD'],
  RECCE: ['RECCE_EXECUTIVE'],
  VENDOR: ['VENDOR'],
  OPERATIONS: ['OPERATIONS', 'RECCE_COORDINATOR'],
  ACCOUNTS: ['FINANCE'],
  ADMIN: ['SUPER_ADMIN', 'MANAGEMENT'],
};
