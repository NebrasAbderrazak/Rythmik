import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: true },
  test: { environment: 'node', include: ['tests/**/*.test.js'] },
});
