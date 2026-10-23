/**
 * Fills the `industries` master from the former static list plus every industry already saved on a client.
 * Idempotent: existing rows (matched case-insensitively) are left untouched. The API also runs this once per process
 * on the first industry read, so this script is only needed to populate the collection ahead of time.
 */
import { connectDb, disconnectDb } from '../config/db';
import { seedIndustries } from '../modules/masters/masters.service';

async function main() {
  await connectDb();
  console.log(`industries: ${await seedIndustries()} added`);
  await disconnectDb();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectDb();
  process.exit(1);
});
