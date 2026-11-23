import type { InstallEvent, InstallOptions, ProbeResult } from './types';

/** The API the preload script exposes to the renderer as `window.installerApi`. */
export interface InstallerApi {
  probe: () => Promise<ProbeResult>;
  startInstall: (options: InstallOptions) => Promise<void>;
  cancelInstall: () => Promise<void>;
  showLog: () => Promise<void>;
  copyErrorReport: () => Promise<boolean>;
  reportError: (error: { message: string; stack?: string; source?: string }) => Promise<void>;
  /** Opens Enterprise Brain (the configured launch URL) in the default browser. */
  launchApp: () => Promise<void>;
  /** Closes the installer (stopping a running install first). */
  quit: () => Promise<void>;
  onEvent: (callback: (event: InstallEvent) => void) => () => void;
}
