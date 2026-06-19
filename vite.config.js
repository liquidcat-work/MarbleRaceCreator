import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    host: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      external: ['matter-js', 'lucide', 'poly-decomp']
    }
  },
  optimizeDeps: {
    exclude: ['matter-js', 'lucide', 'poly-decomp']
  }
});
