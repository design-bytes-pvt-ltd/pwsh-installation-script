import type { DevToolsApi, InstallerApi } from '../../shared/api';

declare global {
  interface Window {
    /** Exposed by src/main/preload.ts. Use `@/services/installerApi` instead of touching this directly. */
    installerApi: InstallerApi;
    /** Development builds only (see src/main/preload.ts). Use `@/services/devToolsApi`. */
    devToolsApi?: DevToolsApi;
  }
}

export {};
