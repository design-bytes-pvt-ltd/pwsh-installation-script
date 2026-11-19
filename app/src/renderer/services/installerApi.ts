import type { InstallerApi } from '../../shared/api';

/**
 * The only module that talks to the preload bridge. Each call reads `window.installerApi` lazily,
 * so tests can install a fake on `window` before (or after) importing this module.
 */
export const installerApi: InstallerApi = {
  probe: () => window.installerApi.probe(),
  startInstall: (options) => window.installerApi.startInstall(options),
  cancelInstall: () => window.installerApi.cancelInstall(),
  showLog: () => window.installerApi.showLog(),
  copyErrorReport: () => window.installerApi.copyErrorReport(),
  reportError: (error) => window.installerApi.reportError(error),
  onEvent: (callback) => window.installerApi.onEvent(callback),
};
