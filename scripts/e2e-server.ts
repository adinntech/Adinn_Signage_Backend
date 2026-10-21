/**
 * Starts the real API for browser end-to-end tests: an in-memory MongoDB (never the Atlas database), files stored on
 * local disk under E2E_UPLOAD_DIR, and a few seeded users. Run with `npm run e2e:server`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';

const port = Number(process.env.E2E_API_PORT ?? 4010);
const webOrigin = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:3100';
const uploadDir = process.env.E2E_UPLOAD_DIR ?? path.join(os.tmpdir(), 'signage-e2e-uploads');

async function main() {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  const mongod = await MongoMemoryServer.create();

  // Set before the app config is imported: real environment variables always win over .env files.
  Object.assign(process.env, {
    NODE_ENV: 'development',
    MONGODB_URI: mongod.getUri(),
    JWT_ACCESS_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123456789',
    PORT: String(port),
    PUBLIC_BASE_URL: `http://localhost:${port}`,
    CORS_ORIGINS: webOrigin,
    COOKIE_SECURE: 'false',
    STORAGE_TYPE: 'local',
    LOCAL_UPLOAD_PATH: uploadDir,
  });

  const { connectDb } = await import('../src/config/db');
  await connectDb();
  const { User } = await import('../src/modules/users/user.model');
  const { hashPassword } = await import('../src/modules/auth/auth.service');
  const seed: [string, string, string, string][] = [
    ['BD User', 'bd@e2e.test', 'BD', '9000000010'],
    ['Devi Ops', 'ops@e2e.test', 'OPERATIONS', '9000000001'],
    ['Karthik Ops', 'ops2@e2e.test', 'OPERATIONS', '9000000002'],
    ['Finance User', 'fin@e2e.test', 'FINANCE', '9000000020'],
  ];
  for (const [name, email, role, phone] of seed) {
    await User.create({ name, email, phone, role: role as 'BD', authMethod: 'PASSWORD', passwordHash: await hashPassword('Passw0rd!x') });
  }

  const { createApp } = await import('../src/app');
  createApp().listen(port, () => console.log(`E2E API ready on http://localhost:${port} (uploads: ${uploadDir})`));
  const stop = async () => {
    await mongod.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
