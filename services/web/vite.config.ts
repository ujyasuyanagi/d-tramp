import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const GATEWAY = process.env.VITE_GATEWAY_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [vue()],
  // 5173, а не 8080: на 8080 стоит nginx-контейнер с прод-сборкой, оба должны запускаться вместе
  server: {
    port: 5173,
    host: true,
    proxy: { '/graphql': { target: GATEWAY, changeOrigin: true } },
  },
  preview: {
    port: 5174,
    host: true,
    proxy: { '/graphql': { target: GATEWAY, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
