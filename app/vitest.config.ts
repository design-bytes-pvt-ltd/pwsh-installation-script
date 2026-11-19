import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Same `@/` alias as vite.config.ts (not merged from it: that config sets root to src/renderer).
    alias: { '@': path.resolve(__dirname, 'src/renderer') },
  },
  test: {
    // Main-process tests run in node (the default). Renderer tests opt in to a DOM with a
    // `// @vitest-environment jsdom` comment at the top of the file.
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
