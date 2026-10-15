import { connectDb, disconnectDb } from '../config/db';
import { env } from '../config/env';
import { hashMpin } from '../modules/auth/auth.service';
import { User } from '../modules/users/user.model';

async function seed() {
  const email = env.SEED_ADMIN_EMAIL?.toLowerCase();
  const mpin = env.SEED_ADMIN_MPIN;
  if (!email || !mpin) throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_MPIN (4 digits) in .env');
  await connectDb();
  await User.init();
  const existing = await User.findOne({ email });
  if (existing) console.log(`User ${email} already exists, skipping`);
  else {
    await User.create({ name: 'Super Admin', email, authMethod: 'MPIN', mpinHash: await hashMpin(mpin), role: 'SUPER_ADMIN' });
    console.log(`Created SUPER_ADMIN ${email}`);
  }
  await disconnectDb();
}
seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
