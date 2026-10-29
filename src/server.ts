import { createApp } from './app';
import { connectDb } from './config/db';
import { env } from './config/env';
import { initConnectSocket } from './modules/connect/connect.hub';
import { startOrphanCleanup, watchProjectDeletes } from './modules/files/orphans';
import { startNotificationCleanup, startNotificationRetry } from './modules/notifications/notification.service';

async function main() {
  await connectDb();
  const server = createApp().listen(env.PORT, () => console.log(`API listening on :${env.PORT}`));
  initConnectSocket(server); // Adinn Connect live messages
  if (env.STORAGE_ORPHAN_WATCH === 'true') watchProjectDeletes(); // clears leftovers seconds after a project is deleted anywhere
  startOrphanCleanup(); // off unless STORAGE_ORPHAN_CLEANUP_HOURS is set
  startNotificationCleanup(); // deletes read notifications after NOTIFICATION_READ_RETENTION_DAYS
  startNotificationRetry(); // re-sends emails that failed or were interrupted by a restart
  console.log(`Email notifications: ${env.mailEnabled ? 'on' : 'off (in-app only; set SMTP_HOST and MAIL_FROM to enable)'}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
