import { app, ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import type { DockLayout, ProjectInfo, AppInfo } from "../../../shared/types";
import type { Logger } from "../logging/logger";

type KvDb = {
  getJson: <T>(key: string) => T | null;
  setJson: (key: string, value: unknown) => void;
};

function clampLayout(layout: DockLayout): DockLayout {
  const out: DockLayout = {};
  for (const [k, v] of Object.entries(layout)) {
    if (!Number.isFinite(v)) continue;
    out[k] = Math.max(0, Math.min(100, v));
  }
  return out;
}

export function registerIpc({ db, logger, project }: { db: KvDb; logger: Logger; project: ProjectInfo }) {
  ipcMain.handle(IPC.appPing, async () => "pong" as const);

  ipcMain.handle(IPC.appGetProject, async () => project);

  ipcMain.handle(IPC.appGetInfo, async (): Promise<AppInfo> => {
    return {
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      versions: {
        electron: process.versions.electron ?? "unknown",
        chrome: process.versions.chrome ?? "unknown",
        node: process.versions.node ?? "unknown",
        v8: process.versions.v8 ?? "unknown"
      },
      env: {
        nodeEnv: process.env.NODE_ENV,
        viteDevServerUrl: process.env.VITE_DEV_SERVER_URL
      }
    };
  });

  ipcMain.handle(IPC.layoutGet, async (_event, arg: { layoutId: string }): Promise<DockLayout | null> => {
    const key = `dock_layout:${arg.layoutId}`;
    const value = db.getJson<DockLayout>(key);
    logger.debug("layout.get", { key, hit: value != null });
    return value;
  });

  ipcMain.handle(IPC.layoutSet, async (_event, arg: { layoutId: string; layout: DockLayout }): Promise<void> => {
    const key = `dock_layout:${arg.layoutId}`;
    const safe = clampLayout(arg.layout);
    db.setJson(key, safe);
    logger.debug("layout.set", { key, panels: Object.keys(safe).length });
  });
}
