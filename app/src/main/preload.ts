import { contextBridge, ipcRenderer } from 'electron';
import { InstallEvent, InstallOptions, ProbeResult } from './core/types';

export interface InstallerApi {
  probe: () => Promise<ProbeResult>;
  startInstall: (options: InstallOptions) => Promise<void>;
  cancelInstall: () => Promise<void>;
  showLog: () => Promise<void>;
  onEvent: (callback: (event: InstallEvent) => void) => () => void;
}

const api: InstallerApi = {
  probe: () => ipcRenderer.invoke('system:probe'),
  startInstall: (options) => ipcRenderer.invoke('install:start', options),
  cancelInstall: () => ipcRenderer.invoke('install:cancel'),
  showLog: () => ipcRenderer.invoke('install:show-log'),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: InstallEvent) => callback(payload);
    ipcRenderer.on('install:event', listener);
    return () => ipcRenderer.removeListener('install:event', listener);
  },
};

contextBridge.exposeInMainWorld('installerApi', api);
