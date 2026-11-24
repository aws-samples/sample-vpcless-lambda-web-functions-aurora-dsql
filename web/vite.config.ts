import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// server/src/middleware.ts caches assets/* as immutable, which is safe only because their file names carry a content hash.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: '../dist/server/public',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
});
