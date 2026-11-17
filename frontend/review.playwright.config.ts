import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'editor-review.spec.ts', workers: 1, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:5178', headless: true, launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }, trace: 'retain-on-failure' },
  webServer: { command: 'npx vite --host 127.0.0.1 --port 5178 --strictPort', url: 'http://127.0.0.1:5178', reuseExistingServer: false },
});
