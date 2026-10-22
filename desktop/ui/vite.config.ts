import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The desktop app's screens, built into dist/ and served by desktop/main.js on this computer only. base './' so the
// built files open from wherever the app is installed.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { port: 5199 },
});
