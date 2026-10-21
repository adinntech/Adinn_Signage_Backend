import { createApp } from './app';
import { connectDb } from './config/db';
import { env } from './config/env';
import { startNotificationRetry } from './modules/notifications/notification.service';

async function main() {
  await connectDb();
  createApp().listen(env.PORT, () => console.log(`API listening on :${env.PORT}`));
  startNotificationRetry(); // re-sends emails that failed or were interrupted by a restart
  console.log(`Email notifications: ${env.mailEnabled ? 'on' : 'off (in-app only; set SMTP_HOST and MAIL_FROM to enable)'}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
