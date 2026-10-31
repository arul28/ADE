import { contextBridge, ipcRenderer } from "electron";

import { IPC } from "../shared/ipc";
import type { StartupRecoveryAction, StartupRecoveryWindowState } from "../shared/types/startupRecovery";

/**
 * The preload of the "ADE could not start" window, and nothing else. It is
 * its own small file on purpose: that window must open when the app's own
 * renderer or preload is what broke, so it shares no code with them.
 */
contextBridge.exposeInMainWorld("adeStartupRecovery", {
  getState: (): Promise<StartupRecoveryWindowState> => ipcRenderer.invoke(IPC.startupRecoveryGetState),
  act: (action: StartupRecoveryAction): Promise<void> => ipcRenderer.invoke(IPC.startupRecoveryAction, { action }),
  fit: (height: number): void => ipcRenderer.send(IPC.startupRecoveryFit, height),
  onState: (cb: (state: StartupRecoveryWindowState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: StartupRecoveryWindowState) => cb(state);
    ipcRenderer.on(IPC.startupRecoveryState, listener);
    return () => ipcRenderer.removeListener(IPC.startupRecoveryState, listener);
  },
});
