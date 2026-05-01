import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests-audit',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
  ],
});
