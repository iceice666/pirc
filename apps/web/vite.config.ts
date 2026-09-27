import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  // Component tests mount into jsdom rather than rendering on the server.
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  build: {
    manifest: true,
    sourcemap: true,
    // Only lazily loaded renderers (mermaid diagrams, KaTeX) exceed the default
    // 500 kB; the entry chunk stays well below this.
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
