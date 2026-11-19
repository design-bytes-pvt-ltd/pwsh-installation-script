import type { InstallerApi } from '../../shared/api';

declare global {
  interface Window {
    /** Exposed by src/main/preload.ts. Use `@/services/installerApi` instead of touching this directly. */
    installerApi: InstallerApi;
  }
}

export {};
