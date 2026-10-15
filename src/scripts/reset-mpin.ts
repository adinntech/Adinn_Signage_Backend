// Usage: npm run reset-mpin -- <email> <new 4-digit MPIN>
// Also converts a legacy password account to MPIN sign-in and clears any lockout.
import { connectDb, disconnectDb } from '../config/db';
import { hashMpin } from '../modules/auth/auth.service';
import { User } from '../modules/users/user.model';

async function resetMpin() {
  const email = process.argv[2]?.toLowerCase();
  const mpin = process.argv[3];
  if (!email || !mpin || !/^\d{4}$/.test(mpin)) throw new Error('Usage: npm run reset-mpin -- <email> <4-digit MPIN>');

  await connectDb();
  const user = await User.findOne({ email, deletedAt: null });
  if (!user) throw new Error(`No user found with email ${email}`);

  user.set({ authMethod: 'MPIN', mpinHash: await hashMpin(mpin), passwordHash: undefined, failedLogins: 0, lockedUntil: null });
  await user.save();
  console.log(`MPIN reset for ${email}`);
  await disconnectDb();
}

resetMpin().catch((e) => {
  console.error(e);
  process.exit(1);
});
