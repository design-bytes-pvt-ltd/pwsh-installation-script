// Vite's types for asset imports (`import url from './image.png'` gives the bundled URL as a string).
/// <reference types="vite/client" />

/** App version from package.json, injected at build time by `define` in vite.config.ts. */
declare const __APP_VERSION__: string;

/** True only in `npm run dev` builds (`vite build --mode development`); see vite.config.ts. */
declare const __DEV_TOOLS__: boolean;
