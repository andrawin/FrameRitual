import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 8890,
    open: true,
  },
  build: {
    target: 'esnext',
  },
});
