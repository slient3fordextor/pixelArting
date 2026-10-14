import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './component-tests',
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:5176',
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `PIXELART_DATA_DIR=/tmp/pixelarting-component-tests-${process.pid} PIXELART_DESKTOP_PORT=5176 ../.venv/bin/python -m uvicorn backend.app:app --app-dir .. --host 127.0.0.1 --port 8093`,
      url: 'http://127.0.0.1:8093/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'npx vite --config component.vite.config.ts --host 127.0.0.1 --port 5176 --strictPort',
      url: 'http://127.0.0.1:5176/component-tests/fixture.html',
      reuseExistingServer: false,
    },
  ],
});
