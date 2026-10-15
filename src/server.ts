import { createApp } from './app';
import { connectDb } from './config/db';
import { env } from './config/env';

async function main() {
  await connectDb();
  createApp().listen(env.PORT, () => console.log(`API listening on :${env.PORT}`));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
