import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', env: { MAX_FILE_SIZE: '52428800', MAX_IMAGE_SIZE: '3145728', MAX_VIDEO_SIZE: '10485760' }, testTimeout: 60000, hookTimeout: 120000, include: ['tests/**/*.test.ts'] },
});
