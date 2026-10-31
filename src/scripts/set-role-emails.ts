// Usage: npm run set-role-emails            (dry run: shows what would change)
//        npm run set-role-emails -- --apply (writes the changes)
// Gives each login type its own mailbox, so forgot MPIN / password codes reach the right person.
import { connectDb, disconnectDb } from '../config/db';
import { User } from '../modules/users/user.model';
import type { Role } from '../modules/roles/roles';

// User type -> role -> email. Edit here if a type should map to a different role.
const MAILBOXES: { type: number; label: string; role: Role; email: string }[] = [
  { type: 0, label: 'Admin', role: 'SUPER_ADMIN', email: 'reactdeveloper@adinn.co.in' },
  { type: 1, label: 'BD', role: 'BD', email: 'adinndigitalservices@gmail.com' },
  { type: 2, label: 'Client Servicing', role: 'CLIENT_SERVICING', email: 'fullstackdev@adinn.co.in' },
  { type: 3, label: 'Recce Operations', role: 'RECCE_COORDINATOR', email: 'adinntechnology@gmail.com' },
  { type: 4, label: 'Recce Mobile', role: 'RECCE_EXECUTIVE', email: 'smm@adinn.co.in' },
  { type: 5, label: 'Vendor Mobile', role: 'VENDOR', email: '2002karthikatg@gmail.com' },
];

async function run() {
  const apply = process.argv.includes('--apply');
  await connectDb();
  for (const m of MAILBOXES) {
    const users = await User.find({ role: m.role, deletedAt: null }).sort({ createdAt: 1 });
    if (users.length !== 1) {
      console.log(`[${m.type}] ${m.label}: ${users.length} users with role ${m.role}; skipped (needs exactly 1)${users.map((u) => `\n      - ${u.email}`).join('')}`);
      continue;
    }
    const user = users[0]!;
    if (user.email === m.email) {
      console.log(`[${m.type}] ${m.label}: already ${m.email}`);
      continue;
    }
    const clash = await User.findOne({ email: m.email, _id: { $ne: user._id } }).lean();
    if (clash) {
      console.log(`[${m.type}] ${m.label}: ${m.email} already belongs to another user (${clash.role}); skipped`);
      continue;
    }
    console.log(`[${m.type}] ${m.label}: ${user.email} -> ${m.email}${apply ? '' : '   (dry run)'}`);
    if (apply) {
      user.email = m.email;
      await user.save();
    }
  }
  await disconnectDb();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
