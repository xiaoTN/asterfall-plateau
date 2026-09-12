import { defineConfig } from 'vite';
export default defineConfig(({ mode }) => ({
  base: './',
  server: mode === 'test' ? { hmr: false, watch: null } : {},
  build: { target: 'es2022', rollupOptions: { output: { manualChunks: { three: ['three'] } } } },
}));
