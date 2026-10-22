import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  // Every @lucide/svelte icon module carries the full ISC/MIT notice; inline,
  // the entry repeated it once per icon. At the end of each chunk the notices
  // are kept, deduplicated.
  esbuild: { legalComments: 'eof' },
  // Component tests mount into jsdom rather than rendering on the server.
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  build: {
    manifest: true,
    // No source maps in the shipped bundle: the gateway would serve them to
    // anyone who can load the app (security audit L15).
    sourcemap: false,
    // Only lazily loaded renderers (mermaid diagrams, KaTeX) exceed the default
    // 500 kB; the entry and the two pages (App.svelte) stay well below this.
    chunkSizeWarningLimit: 750,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
