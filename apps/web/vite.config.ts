import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  // Component tests mount into jsdom rather than rendering on the server.
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  build: {
    manifest: true,
    sourcemap: true,
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
