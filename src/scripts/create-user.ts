// Usage: USER_MPIN=2580 [EMPLOYEE_ID=EMP001] [PHONE=9876543210] npm run create-user -- <email> "<Full Name>" <ROLE>
import { connectDb, disconnectDb } from '../config/db';
import { hashMpin } from '../modules/auth/auth.service';
import { ROLES, type Role } from '../modules/roles/roles';
import { User } from '../modules/users/user.model';

async function main() {
  const [emailArg, name, role] = process.argv.slice(2);
  const mpin = process.env.USER_MPIN;
  if (!emailArg || !name || !role || !mpin) {
    throw new Error('Usage: USER_MPIN=2580 npm run create-user -- <email> "<Full Name>" <ROLE>');
  }
  if (!(ROLES as readonly string[]).includes(role)) throw new Error(`ROLE must be one of: ${ROLES.join(', ')}`);
  if (!/^d{4}$/.test(mpin)) throw new Error('MPIN must be exactly 4 digits');
  const email = emailArg.toLowerCase();
  await connectDb();
  await User.init();
  const mpinHash = await hashMpin(mpin);
  const existing = await User.exists({ email });
  await User.updateOne({ email }, { $set: { name, role: role as Role, authMethod: 'MPIN', mpinHash, isActive: true, deletedAt: null, ...(process.env.PHONE ? { phone: process.env.PHONE } : {}), ...(process.env.EMPLOYEE_ID ? { employeeId: process.env.EMPLOYEE_ID.toUpperCase() } : {}) } }, { upsert: true });
  console.log(`${existing ? 'Updated' : 'Created'} ${role} ${email}`);
  await disconnectDb();
}
main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
