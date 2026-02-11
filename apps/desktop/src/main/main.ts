import { app, BrowserWindow } from "electron";
import path from "node:path";
import { registerIpc } from "./services/ipc/registerIpc";
import { createFileLogger } from "./services/logging/logger";
import { openKvDb } from "./services/state/kvDb";
import { ensureAdeDirs, getProjectInfo } from "./services/state/projectState";

function getRendererUrl(): string {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) return devUrl;
  return `file://${path.join(__dirname, "../renderer/index.html")}`;
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    // Match renderer theme to avoid a dark flash on load.
    backgroundColor: "#fbf8ee",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setMenuBarVisibility(false);

  // Block unexpected external navigation/window creation.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = getRendererUrl();
    if (process.env.VITE_DEV_SERVER_URL) {
      // In dev we allow vite's HMR websocket/etc.
      const devBase = process.env.VITE_DEV_SERVER_URL;
      if (devBase && url.startsWith(devBase)) return;
    }
    if (url === allowed) return;
    event.preventDefault();
  });

  await win.loadURL(getRendererUrl());

  if (process.env.VITE_DEV_SERVER_URL) {
    win.webContents.openDevTools({ mode: "detach" });
  }

  return win;
}

app.whenReady().then(async () => {
  const project = getProjectInfo();
  const adePaths = ensureAdeDirs(project.rootPath);
  const logger = createFileLogger(path.join(adePaths.logsDir, "main.jsonl"));

  logger.info("app.start", { projectRoot: project.rootPath });

  process.on("uncaughtException", (err) => {
    logger.error("process.uncaught_exception", { err: String(err), stack: err instanceof Error ? err.stack : undefined });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("process.unhandled_rejection", { reason: String(reason) });
  });

  const db = await openKvDb(path.join(adePaths.adeDir, "ade.db"), logger);

  registerIpc({ db, logger, project });

  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });

  app.on("before-quit", () => {
    logger.info("app.before_quit");
    db.flushNow();
    db.close();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
