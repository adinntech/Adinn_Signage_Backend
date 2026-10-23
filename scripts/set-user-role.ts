/**
 * Changes one user's role (e.g. an old "Accounts" login that is now Client Servicing). Name, employee ID, phone and
 * MPIN / password are not touched.
 *   Dry run:   npx tsx scripts/set-user-role.ts --email someone@adinn.co.in --role CLIENT_SERVICING
 *   Apply:     npx tsx scripts/set-user-role.ts --email someone@adinn.co.in --role CLIENT_SERVICING --apply
 * Add --from FINANCE to refuse the change unless the user currently has that role.
 */
import { connectDb, disconnectDb } from '../src/config/db';
import { recordAudit } from '../src/modules/audit/audit.service';
import { ROLES } from '../src/modules/roles/roles';
import { User } from '../src/modules/users/user.model';

async function main() {
  const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
  const email = arg('--email')?.trim().toLowerCase();
  const role = arg('--role');
  const from = arg('--from');
  const apply = process.argv.includes('--apply');
  if (!email || !role) throw new Error('Give --email <address> and --role <ROLE>');
  if (!(ROLES as readonly string[]).includes(role)) throw new Error(`Unknown role "${role}". Roles: ${ROLES.join(', ')}`);
  await connectDb();
  const users = await User.find({ email, deletedAt: null }).select('name email employeeId phone role isActive');
  if (users.length !== 1) throw new Error(`Expected exactly one user with email ${email}, found ${users.length}`);
  const u = users[0]!;
  console.log(`User: ${u.name} | ${u.email} | employee ${u.employeeId ?? '-'} | phone ${u.phone ?? '-'} | role ${u.role} | active ${u.isActive}`);
  if (from && u.role !== from) throw new Error(`Role is ${u.role}, not ${from}; nothing changed`);
  if (u.role === role) console.log(`Already ${role}; nothing to do.`);
  else if (!apply) console.log(`Would change role ${u.role} -> ${role}. Dry run only; add --apply to save.`);
  else {
    const old = u.role;
    u.role = role as never;
    await u.save();
    await recordAudit({ actor: { id: String(u._id), role }, action: 'ROLE_CHANGE', entity: 'User', entityId: u._id, changes: [{ field: 'role', oldValue: old, newValue: role }], reason: 'Changed with scripts/set-user-role.ts' });
    console.log(`Role changed ${old} -> ${role}.`);
  }
  await disconnectDb();
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
