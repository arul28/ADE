import path from "node:path";
import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

import { IPC } from "../../../shared/ipc";
import type { StartupRecoveryAction, StartupRecoveryWindowState } from "../../../shared/types/startupRecovery";
import type { Logger } from "../logging/logger";
import type { StartupRecoveryWindow } from "./startupRecovery";

const ACTIONS: ReadonlySet<StartupRecoveryAction> = new Set([
  "try_again",
  "go_back",
  "confirm_go_back",
  "cancel_go_back",
  "open_logs",
  "copy_details",
]);

const WINDOW_WIDTH = 540;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 680;

/**
 * The page is static: no value is ever written into it. State reaches it
 * through the preload, and the script puts it on screen with `textContent`
 * only. It is its own page, not a route of the app's renderer, so it opens
 * when that renderer is what broke. The words follow docs/design/notices.md:
 * what happened, what each choice does, what happens to the data, what next.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>ADE could not start</title>
<style>
:root { color-scheme: dark light; --bg:#151319; --fg:#f2f0f5; --t2:rgba(242,240,245,.68); --t3:rgba(242,240,245,.46);
  --edge:rgba(242,240,245,.10); --card:rgba(242,240,245,.035); --btn:rgba(242,240,245,.07); --btn-h:rgba(242,240,245,.12);
  --track:rgba(242,240,245,.10); --warn:#e2a336; --crit:#ef6b6b; }
@media (prefers-color-scheme: light) { :root { --bg:#f7f6f9; --fg:#1d1b22; --t2:rgba(29,27,34,.68); --t3:rgba(29,27,34,.48);
  --edge:rgba(29,27,34,.12); --card:rgba(29,27,34,.03); --btn:rgba(29,27,34,.05); --btn-h:rgba(29,27,34,.09);
  --track:rgba(29,27,34,.10); --warn:#b7791f; --crit:#c53030; } }
* { box-sizing:border-box; }
html,body { margin:0; background:var(--bg); color:var(--fg);
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; -webkit-user-select:none; user-select:none; }
main { padding:26px 28px 22px; display:flex; flex-direction:column; gap:16px; }
.head { display:flex; gap:12px; align-items:flex-start; }
.tile { flex:none; width:34px; height:34px; border-radius:9px; display:grid; place-items:center;
  background:color-mix(in srgb, var(--warn) 16%, transparent); color:var(--warn); }
h1 { margin:0; font-size:15px; font-weight:600; letter-spacing:-.01em; }
h2 { margin:0; font-size:13.5px; font-weight:600; }
#line { margin:3px 0 0; color:var(--t2); -webkit-user-select:text; user-select:text; }
.cards { display:flex; flex-direction:column; gap:8px; }
.card { border:1px solid var(--edge); background:var(--card); border-radius:10px; padding:12px 14px;
  display:flex; align-items:center; gap:14px; }
.card p { margin:0; flex:1; color:var(--t2); font-size:12.5px; }
.card button { flex:none; min-width:150px; }
.panel { border:1px solid var(--edge); background:var(--card); border-radius:10px; padding:14px 16px; display:flex; flex-direction:column; gap:10px; }
ul { margin:0; padding-left:18px; display:flex; flex-direction:column; gap:6px; color:var(--t2); font-size:12.5px; }
.row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
button { height:30px; padding:0 12px; border-radius:8px; border:1px solid var(--edge); background:var(--btn); color:var(--fg);
  font:inherit; font-weight:500; cursor:pointer; }
button:hover:not(:disabled) { background:var(--btn-h); }
button:disabled { opacity:.5; cursor:default; }
button.primary { background:var(--fg); color:var(--bg); border-color:transparent; }
button.primary:hover:not(:disabled) { background:var(--fg); opacity:.9; }
button.ghost { border-color:transparent; background:transparent; color:var(--t2); height:26px; padding:0 8px; }
.problem { border:1px solid color-mix(in srgb, var(--crit) 35%, transparent); background:color-mix(in srgb, var(--crit) 8%, transparent);
  border-radius:10px; padding:11px 14px; display:flex; flex-direction:column; gap:3px; }
.problem p { margin:0; font-size:12.5px; }
#f-msg { color:var(--fg); font-weight:500; }
#f-next { color:var(--t2); }
.bar { height:6px; border-radius:3px; background:var(--track); overflow:hidden; position:relative; }
.bar span { position:absolute; inset:0 auto 0 0; width:0; background:var(--fg); border-radius:3px; transition:width .3s; }
.bar[data-busy="true"] span { width:30%; animation:slide 1.4s ease-in-out infinite; }
@keyframes slide { 0% { left:-30%; } 100% { left:100%; } }
#p-title { margin:0; font-weight:500; }
#p-hint { margin:0; color:var(--t2); font-size:12.5px; }
footer { display:flex; align-items:center; gap:4px; margin-left:-8px; }
footer span { color:var(--t3); font-size:12px; margin-left:4px; }
[hidden] { display:none !important; }
</style></head>
<body><main id="main">
  <div class="head">
    <div class="tile" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 256 256" fill="currentColor"><path d="M236.8 188.09 149.35 36.22a24.76 24.76 0 0 0-42.7 0L19.2 188.09a23.51 23.51 0 0 0 0 23.72A24.35 24.35 0 0 0 40.55 224h174.9a24.35 24.35 0 0 0 21.33-12.19 23.51 23.51 0 0 0 .02-23.72ZM120 104a8 8 0 0 1 16 0v40a8 8 0 0 1-16 0Zm8 88a12 12 0 1 1 12-12 12 12 0 0 1-12 12Z"/></svg></div>
    <div><h1>ADE could not start</h1><p id="line"></p></div>
  </div>

  <div class="problem" id="problem" role="alert" hidden><p id="f-msg"></p><p id="f-next"></p></div>

  <div class="cards" id="choices">
    <div class="card" id="choice-back" hidden><button class="primary" id="go-back"></button><p id="back-text"></p></div>
    <div class="card"><button id="try-again">Try again</button><p id="try-text">Closes ADE and opens it again. Try this first if the problem might have been a one-off.</p></div>
  </div>

  <div class="panel" id="confirm" hidden>
    <h2 id="c-title"></h2>
    <ul>
      <li id="c-data"></li>
      <li id="c-others"></li>
      <li>ADE saves your current data as a copy first. Nothing is deleted.</li>
      <li id="c-next"></li>
      <li id="c-updates"></li>
    </ul>
    <div class="row"><button class="primary" id="confirm-yes">Go back</button><button id="confirm-no">Cancel</button></div>
  </div>

  <div class="panel" id="progress" role="status" hidden>
    <p id="p-title"></p>
    <div class="bar" id="bar"><span id="bar-fill"></span></div>
    <p id="p-hint"></p>
  </div>

  <footer><button class="ghost" id="open-logs">Open logs folder</button><button class="ghost" id="copy-details">Copy details</button><span id="footer-note">For ADE support</span></footer>
</main>
<script>
(function () {
  var api = window.adeStartupRecovery;
  if (!api) return;
  var el = function (id) { return document.getElementById(id); };
  var copied = false;
  var last = null;
  function day(ms) {
    try {
      var d = new Date(ms);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " at "
        + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch (e) { return ""; }
  }
  function list(items) {
    if (items.length <= 1) return items.join("");
    if (items.length === 2) return items[0] + " and " + items[1];
    return items.slice(0, -1).join(", ") + ", and " + items[items.length - 1];
  }
  function upper(text) { return text ? text.charAt(0).toUpperCase() + text.slice(1) : text; }
  function render(state) {
    if (!state) return;
    last = state;
    var phase = state.phase || { state: "idle" };
    var back = state.goBack;
    var busy = phase.state === "checking" || phase.state === "downloading" || phase.state === "installing";
    // A quoted project name never breaks at its hyphens.
    var keepWhole = function (text) {
      return text.replace(/\\u201c[^\\u201d]*\\u201d/g, function (name) { return name.replace(/-/g, "\\u2011"); });
    };
    el("line").textContent = keepWhole(state.line);

    el("problem").hidden = phase.state !== "failed";
    if (phase.state === "failed") { el("f-msg").textContent = keepWhole(phase.message); el("f-next").textContent = phase.next; }

    el("choices").hidden = busy || phase.state === "confirm";
    el("choice-back").hidden = !back;
    el("try-again").className = back ? "" : "primary";
    el("try-text").textContent = back
      ? "Closes ADE and opens it again. Try this first if the problem might have been a one-off."
      : "Closes ADE and opens it again. If it keeps happening, copy the details and send them to ADE support.";
    if (back) {
      el("go-back").textContent = "Go back to " + back.version;
      el("back-text").textContent = "Reinstalls the version you had before the update. ADE shows what it will do and asks before it changes anything.";
    }

    el("confirm").hidden = phase.state !== "confirm";
    if (back && phase.state === "confirm") {
      el("c-title").textContent = "Go back to ADE " + back.version + "?";
      el("c-data").textContent = keepWhole("Puts back " + list(back.putsBack)) + (back.dataFrom ? ", as they were on " + day(back.dataFrom) : "") + ".";
      el("c-others").hidden = back.projectsLeftAlone === 0;
      el("c-others").textContent = back.projectsLeftAlone === 1
        ? "Your other project stays as it is."
        : "Your other projects stay as they are.";
      el("c-next").textContent = "Downloads " + back.version + ", then closes ADE, installs it and opens it again. This takes about a minute.";
      el("c-updates").textContent = "Turns off automatic updates until a version newer than " + state.runningVersion
        + " is out. Until then, don't install " + state.runningVersion + " if ADE offers it.";
    }

    el("progress").hidden = !busy;
    var version = back ? back.version : "";
    var bar = el("bar");
    if (phase.state === "checking") {
      el("p-title").textContent = "Checking that ADE " + version + " can open your data\\u2026";
      el("p-hint").textContent = "Nothing has changed yet.";
      bar.setAttribute("data-busy", "true");
    } else if (phase.state === "downloading") {
      var pct = typeof phase.percent === "number" ? phase.percent : null;
      el("p-title").textContent = "Downloading ADE " + version + "\\u2026" + (pct === null ? "" : " " + pct + "%");
      el("p-hint").textContent = "Nothing has changed yet. When the download is done, ADE closes, installs it and opens again.";
      if (pct === null) bar.setAttribute("data-busy", "true");
      else { bar.removeAttribute("data-busy"); el("bar-fill").style.width = pct + "%"; }
    } else if (phase.state === "installing") {
      el("p-title").textContent = "Installing ADE " + version + "\\u2026";
      el("p-hint").textContent = "ADE puts your data back, closes, and opens again in about a minute. You don't need to do anything.";
      bar.setAttribute("data-busy", "true");
    }

    el("footer-note").textContent = copied ? "Details copied" : "For ADE support";
    var fit = function () { api.fit(Math.ceil(el("main").getBoundingClientRect().height)); };
    if (window.requestAnimationFrame) window.requestAnimationFrame(fit); else fit();
  }
  function act(action) { api.act(action).catch(function () {}); }
  el("go-back").addEventListener("click", function () { act("go_back"); });
  el("try-again").addEventListener("click", function () { act("try_again"); });
  el("confirm-yes").addEventListener("click", function () { act("confirm_go_back"); });
  el("confirm-no").addEventListener("click", function () { act("cancel_go_back"); });
  el("open-logs").addEventListener("click", function () { act("open_logs"); });
  el("copy-details").addEventListener("click", function () {
    api.act("copy_details").then(function () { copied = true; render(last); });
  });
  api.onState(render);
  api.getState().then(render);
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
 * only owns the Electron side: the window, its channels and the push.
 */
export function createStartupRecoveryWindow(args: {
  logger: Pick<Logger, "info" | "warn">;
  getState: () => StartupRecoveryWindowState;
  onAction: (action: StartupRecoveryAction) => Promise<void>;
}): StartupRecoveryWindow {
  let win: BrowserWindow | null = null;

  const fromThisWindow = (event: IpcMainInvokeEvent | IpcMainEvent, channel: string): boolean => {
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
  // The page asks for the height its content needs, so each state fits.
  ipcMain.on(IPC.startupRecoveryFit, (event, height: unknown) => {
    if (!fromThisWindow(event, IPC.startupRecoveryFit) || !win || typeof height !== "number" || !Number.isFinite(height)) return;
    const next = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)));
    const [, current] = win.getContentSize();
    if (current !== next) win.setContentSize(WINDOW_WIDTH, next);
  });

  const open = (): void => {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    const created = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: 330,
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
      created.center();
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
