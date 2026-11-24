import { contextBridge, ipcRenderer } from 'electron';
// Type-only imports: a sandboxed preload cannot require local modules at runtime.
import type { DevToolsApi, InstallerApi } from '../shared/api';
import type { InstallEvent } from '../shared/types';

const api: InstallerApi = {
  probe: () => ipcRenderer.invoke('system:probe'),
  startInstall: (options) => ipcRenderer.invoke('install:start', options),
  cancelInstall: () => ipcRenderer.invoke('install:cancel'),
  showLog: () => ipcRenderer.invoke('install:show-log'),
  copyErrorReport: () => ipcRenderer.invoke('install:copy-report'),
  reportError: (error) => ipcRenderer.invoke('log:renderer-error', error),
  launchApp: () => ipcRenderer.invoke('app:launch'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: InstallEvent) => callback(payload);
    ipcRenderer.on('install:event', listener);
    return () => ipcRenderer.removeListener('install:event', listener);
  },
};

contextBridge.exposeInMainWorld('installerApi', api);

// Development only: the main process passes this flag to unpackaged builds alone (see createWindow).
if (process.argv.includes('--enable-design-overlay')) {
  const devToolsApi: DevToolsApi = {
    capturePage: () => ipcRenderer.invoke('dev:capture-page'),
  };
  contextBridge.exposeInMainWorld('devToolsApi', devToolsApi);
}
