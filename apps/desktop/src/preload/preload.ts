import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ade", {
  ping: async (): Promise<string> => ipcRenderer.invoke("ade.ping")
});

