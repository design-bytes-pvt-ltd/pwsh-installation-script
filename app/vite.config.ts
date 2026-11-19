import { readFileSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  // App version from package.json, available in the renderer as `__APP_VERSION__` (see lib/version.ts).
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    // Keep in sync with "paths" in tsconfig.renderer.json.
    alias: { '@': path.resolve(__dirname, 'src/renderer') },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
});
