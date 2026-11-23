import { contextBridge, ipcRenderer } from 'electron';
// Type-only imports: a sandboxed preload cannot require local modules at runtime.
import type { InstallerApi } from '../shared/api';
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
