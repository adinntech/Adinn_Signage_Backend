import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', env: { MONGODB_URI: 'mongodb://127.0.0.1:1/never-the-real-database?serverSelectionTimeoutMS=500', MAX_FILE_SIZE: '52428800', MAX_IMAGE_SIZE: '3145728', MAX_VIDEO_SIZE: '10485760' }, testTimeout: 60000, hookTimeout: 120000, include: ['tests/**/*.test.ts'] },
});
