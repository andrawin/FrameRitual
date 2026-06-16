import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 8889,
    open: true,
  },
  build: {
    target: 'esnext',
  },
});
