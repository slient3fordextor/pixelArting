import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:8001',
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `PIXELART_DATA_DIR=/tmp/pixelarting-browser-tests-${process.pid} ../.venv/bin/python -m uvicorn backend.app:app --app-dir .. --host 127.0.0.1 --port 8001`,
    url: 'http://127.0.0.1:8001/api/health',
    reuseExistingServer: false,
  },
});
