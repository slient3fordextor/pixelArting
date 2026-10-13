import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './desktop-tests',
  workers: 1,
  timeout: 45000,
});
