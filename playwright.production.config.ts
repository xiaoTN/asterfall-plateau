import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
  ...base,
  testMatch: '**/production.e2e.ts', testIgnore: [],
  outputDir: 'test-results-production',
  use: { ...base.use, baseURL: 'http://127.0.0.1:5187' },
  webServer: { command: 'npm run preview -- --port 5187 --strictPort', url: 'http://127.0.0.1:5187', reuseExistingServer: false, timeout: 60000 },
});
