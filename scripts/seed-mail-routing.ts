/**
 * Saves the mail recipients (the same thing as Admin > Mail settings) and adds the addresses to the address book.
 * No address lives in the code: pass them on the command line, one argument per mail kind,
 *   npx tsx scripts/seed-mail-routing.ts "PROJECT_CODE=to1,to2|cc1,cc2" "VENDOR_REGISTRATION=to1|cc1,cc2"
 * (left of "|" is To, right of it is Cc). Kinds: PROJECT_CODE, CLIENT_CODE, VENDOR_REGISTRATION.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { learn } from '../src/modules/mailContacts/mailContact.service';
import { MailRouting, ROUTING_KEYS, type RoutingKey } from '../src/modules/mailSettings/mailRouting.model';

const split = (s = '') => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

(async () => {
  const args = process.argv.slice(2);
  if (!args.length) throw new Error('Pass at least one KEY=to1,to2|cc1,cc2 argument');
  await mongoose.connect(env.MONGODB_URI);
  for (const a of args) {
    const [key, rest = ''] = a.split('=');
    if (!ROUTING_KEYS.includes(key as RoutingKey)) throw new Error(`Unknown kind ${key}`);
    const [to, cc] = rest.split('|');
    if (await MailRouting.exists({ _id: key })) { console.log(key, 'already saved, left as it is'); continue; }
    const row = { to: split(to), cc: split(cc) };
    if (!row.to.length) throw new Error(`${key}: To is empty`);
    await MailRouting.updateOne({ _id: key }, { $set: { ...row, bcc: [] } }, { upsert: true });
    await learn([...row.to, ...row.cc]);
    console.log(key, 'to', row.to.join(', '), '| cc', row.cc.join(', ') || '-');
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
