import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
  // Same `__APP_VERSION__` as vite.config.ts, so renderer tests can render it.
  define: { __APP_VERSION__: JSON.stringify(version) },
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
