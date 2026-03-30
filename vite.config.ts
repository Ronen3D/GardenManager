import { defineConfig } from 'vite';
import { resolve } from 'path';

const isGitHubPages = process.env.GITHUB_PAGES === 'true';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  base: isGitHubPages ? '/GardenManager/' : './',
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
