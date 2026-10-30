import path from "node:path";
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";

import { IPC } from "../../../shared/ipc";
import type { StartupRecoveryAction, StartupRecoveryWindowState } from "../../../shared/types/startupRecovery";
import type { Logger } from "../logging/logger";
import type { StartupRecoveryWindow } from "./startupRecovery";

const ACTIONS: ReadonlySet<StartupRecoveryAction> = new Set(["try_again", "go_back", "open_logs", "copy_details"]);

/**
 * The page is static: no value is ever written into it. State reaches it
 * through the preload, and the script puts it on screen with `textContent`
 * only. It is its own page, not a route of the app's renderer, so it opens
 * when that renderer is what broke.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>ADE could not start</title>
<style>
:root { color-scheme: dark light; --bg:#151319; --fg:#f2f0f5; --t2:rgba(242,240,245,.66); --t3:rgba(242,240,245,.45);
  --edge:rgba(242,240,245,.10); --btn:rgba(242,240,245,.07); --btn-h:rgba(242,240,245,.12); --warn:#e2a336; --crit:#ef6b6b; }
@media (prefers-color-scheme: light) { :root { --bg:#f7f6f9; --fg:#1d1b22; --t2:rgba(29,27,34,.66); --t3:rgba(29,27,34,.48);
  --edge:rgba(29,27,34,.12); --btn:rgba(29,27,34,.05); --btn-h:rgba(29,27,34,.09); --warn:#b7791f; --crit:#c53030; } }
* { box-sizing:border-box; }
html,body { margin:0; height:100%; background:var(--bg); color:var(--fg);
  font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; -webkit-user-select:none; user-select:none; }
main { padding:28px 28px 24px; display:flex; flex-direction:column; gap:14px; }
.head { display:flex; gap:12px; align-items:flex-start; }
.tile { flex:none; width:34px; height:34px; border-radius:9px; display:grid; place-items:center;
  background:color-mix(in srgb, var(--warn) 16%, transparent); color:var(--warn); }
h1 { margin:0; font-size:15px; font-weight:600; letter-spacing:-.01em; }
#line { margin:3px 0 0; color:var(--t2); -webkit-user-select:text; user-select:text; }
.back { border:1px solid var(--edge); border-radius:10px; padding:12px 14px; display:flex; flex-direction:column; gap:8px; }
.back p { margin:0; color:var(--t2); font-size:12px; }
.row { display:flex; flex-wrap:wrap; gap:8px; }
button { height:30px; padding:0 12px; border-radius:8px; border:1px solid var(--edge); background:var(--btn); color:var(--fg);
  font:inherit; font-weight:500; cursor:pointer; }
button:hover:not(:disabled) { background:var(--btn-h); }
button:disabled { opacity:.5; cursor:default; }
button.primary { background:var(--fg); color:var(--bg); border-color:transparent; }
button.primary:hover:not(:disabled) { background:var(--fg); opacity:.9; }
button.ghost { border-color:transparent; background:transparent; color:var(--t2); }
#status { margin:0; min-height:18px; font-size:12px; color:var(--t2); }
#status[data-tone="crit"] { color:var(--crit); }
[hidden] { display:none !important; }
</style></head>
<body><main>
  <div class="head">
    <div class="tile" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 256 256" fill="currentColor"><path d="M236.8 188.09 149.35 36.22a24.76 24.76 0 0 0-42.7 0L19.2 188.09a23.51 23.51 0 0 0 0 23.72A24.35 24.35 0 0 0 40.55 224h174.9a24.35 24.35 0 0 0 21.33-12.19 23.51 23.51 0 0 0 .02-23.72ZM120 104a8 8 0 0 1 16 0v40a8 8 0 0 1-16 0Zm8 88a12 12 0 1 1 12-12 12 12 0 0 1-12 12Z"/></svg></div>
    <div><h1>ADE could not start</h1><p id="line"></p></div>
  </div>
  <section class="back" id="back" hidden>
    <div class="row"><button class="primary" id="go-back"></button></div>
    <p id="back-hint"></p>
  </section>
  <div class="row">
    <button id="try-again">Try again</button>
    <button class="ghost" id="open-logs">Open logs folder</button>
    <button class="ghost" id="copy-details">Copy details</button>
  </div>
  <p id="status" role="status"></p>
</main>
<script>
(function () {
  var api = window.adeStartupRecovery;
  if (!api) return;
  var el = function (id) { return document.getElementById(id); };
  var copied = false;
  function when(ms) {
    try { return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch (e) { return ""; }
  }
  function render(state) {
    if (!state) return;
    el("line").textContent = state.line;
    var phase = state.phase || { state: "idle" };
    var busy = phase.state === "checking" || phase.state === "downloading" || phase.state === "installing";
    var back = state.goBack;
    el("back").hidden = !back;
    el("try-again").className = back ? "" : "primary";
    if (back) {
      el("go-back").textContent = "Go back to " + back.version;
      el("back-hint").textContent = "Installs ADE " + back.version + " and puts back your data"
        + (back.dataFrom ? " from " + when(back.dataFrom) : "") + ". Your current data is kept as a copy.";
      el("go-back").disabled = busy;
    }
    el("try-again").disabled = busy;
    var status = el("status");
    status.removeAttribute("data-tone");
    if (phase.state === "checking") status.textContent = "Checking ADE " + (back ? back.version : "") + "\\u2026";
    else if (phase.state === "downloading") status.textContent = "Downloading ADE " + (back ? back.version : "") + "\\u2026"
      + (typeof phase.percent === "number" ? " " + phase.percent + "%" : "");
    else if (phase.state === "installing") status.textContent = "Installing ADE " + (back ? back.version : "") + ". ADE will restart.";
    else if (phase.state === "failed") { status.textContent = phase.message; status.setAttribute("data-tone", "crit"); }
    else status.textContent = copied ? "Details copied." : "";
  }
  var last = null;
  function act(action) {
    api.act(action).catch(function () {});
  }
  el("go-back").addEventListener("click", function () { act("go_back"); });
  el("try-again").addEventListener("click", function () { act("try_again"); });
  el("open-logs").addEventListener("click", function () { act("open_logs"); });
  el("copy-details").addEventListener("click", function () {
    api.act("copy_details").then(function () { copied = true; render(last); });
  });
  api.onState(function (state) { last = state; render(state); });
  api.getState().then(function (state) { last = state; render(state); });
})();
</script>
</body></html>`;

const PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`;

const recoveryWindows = new WeakSet<BrowserWindow>();

/**
 * Whether `win` is the recovery window. Its page cannot show ADE's quit
 * prompt, so Try again asks in an app window instead of the focused one.
 */
export function isStartupRecoveryWindow(win: BrowserWindow): boolean {
  return recoveryWindows.has(win);
}

/**
 * Opens and drives the one window. `onAction` is the controller's; this file
 * only owns the Electron side: the window, its two channels and the push.
 */
export function createStartupRecoveryWindow(args: {
  logger: Pick<Logger, "info" | "warn">;
  getState: () => StartupRecoveryWindowState;
  onAction: (action: StartupRecoveryAction) => Promise<void>;
}): StartupRecoveryWindow {
  let win: BrowserWindow | null = null;

  const fromThisWindow = (event: IpcMainInvokeEvent, channel: string): boolean => {
    if (win && !win.isDestroyed() && event.sender === win.webContents) return true;
    args.logger.warn("ipc.untrusted_sender", { channel, senderUrl: event.sender.getURL().slice(0, 80) });
    return false;
  };

  ipcMain.handle(IPC.startupRecoveryGetState, (event) => {
    if (!fromThisWindow(event, IPC.startupRecoveryGetState)) throw new Error("Only the recovery window may ask.");
    return args.getState();
  });
  ipcMain.handle(IPC.startupRecoveryAction, async (event, payload: { action?: unknown }) => {
    if (!fromThisWindow(event, IPC.startupRecoveryAction)) throw new Error("Only the recovery window may ask.");
    const action = payload?.action;
    if (typeof action !== "string" || !ACTIONS.has(action as StartupRecoveryAction)) {
      throw new Error("Unknown recovery action.");
    }
    await args.onAction(action as StartupRecoveryAction);
  });

  const open = (): void => {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    const created = new BrowserWindow({
      width: 520,
      height: 300,
      useContentSize: true,
      resizable: false,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: "ADE could not start",
      backgroundColor: "#151319",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "../preload/startupRecovery.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    win = created;
    recoveryWindows.add(created);
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.once("ready-to-show", () => {
      if (created.isDestroyed()) return;
      created.show();
      created.focus();
    });
    created.on("closed", () => {
      if (win === created) win = null;
    });
    created.loadURL(PAGE_URL).catch((error) => {
      args.logger.warn("startupRecovery.window_load_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  return {
    show(): void {
      open();
    },
    update(state: StartupRecoveryWindowState): void {
      if (!win || win.isDestroyed()) return;
      win.webContents.send(IPC.startupRecoveryState, state);
    },
  };
}
