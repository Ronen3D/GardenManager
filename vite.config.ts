import { resolve } from 'path';
import { defineConfig } from 'vite';

const isGitHubPages = process.env.GITHUB_PAGES === 'true';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  base: isGitHubPages ? '/GardenManager/' : './',
  server: {
    // Use a dedicated port so dev-mode localStorage doesn't collide with
    // other Vite projects that default to 5173 on the same origin.
    port: 5174,
    strictPort: true,
    watch: {
      // Exclude Playwright MCP snapshot/log files from HMR so audit runs
      // do not accidentally trigger page reloads mid-test.
      ignored: ['**/.playwright-mcp/**'],
    },
  },
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
