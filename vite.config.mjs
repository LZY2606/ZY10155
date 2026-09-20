import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: '.',
  server: {
    host: '127.0.0.1',
    port: 5355,
    strictPort: true
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.mjs']
  }
});
