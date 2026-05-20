#!/usr/bin/env node

/**
 * Browser mirror for `ade code`: one shared PTY. The page is a full-viewport xterm.js
 * instance fed the same byte stream as Terminal.app/iTerm — not a separate React UI.
 */

import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import {
  buildRuntimeCliForDevClient,
  canConnectToSocket,
  cliPath,
  devRuntimeEnv,
  ensureRuntime,
  repoRoot,
  resolveDevSocketPath,
  resolveProjectRoot,
  resolveWorkspaceRoot,
} from "./dev-shared.mjs";

const require = createRequire(import.meta.url);
const ptyPath = path.join(repoRoot, "apps", "ade-cli", "node_modules", "node-pty");
const wsPath = path.join(repoRoot, "apps", "ade-cli", "node_modules", "ws");
const xtermDir = path.join(repoRoot, "apps", "ade-cli", "node_modules", "@xterm", "xterm");

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const xtermFitPath = firstExistingPath([
  path.join(repoRoot, "apps", "ade-cli", "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.mjs"),
  path.join(repoRoot, "apps", "desktop", "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.mjs"),
]);

function usage() {
  return [
    "Usage: npm run dev:code:web -- [options] [-- ade-code-args...]",
    "",
    "Mirrors one `ade code` PTY to the browser (xterm.js). Same process, same ANSI bytes,",
    "same cols×rows as the primary browser tab (FitAddon). Not a React DOM clone.",
    "",
    "Options:",
    "  --auto                     Start dev runtime if missing. Default.",
    "  --attach                   Require an existing dev runtime.",
    "  --project-root <path>      ADE project data root.",
    "  --workspace-root <path>    Source checkout root (PTY cwd).",
    "  --socket <path>            Dev runtime socket.",
    "  --skip-runtime-build       Launch without rebuilding apps/ade-cli.",
    "  --http-port <n>            Bind HTTP to this port (default: pick a free port).",
    "  -h, --help                 Show this help.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    mode: "auto",
    projectRoot: null,
    workspaceRoot: null,
    socketPath: null,
    skipRuntimeBuild: false,
    httpPort: null,
    rest: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      options.rest = argv.slice(i + 1);
      break;
    }
    if (arg === "--auto") {
      options.mode = "auto";
      continue;
    }
    if (arg === "--attach") {
      options.mode = "attach";
      continue;
    }
    if (arg === "--skip-runtime-build") {
      options.skipRuntimeBuild = true;
      continue;
    }
    if (arg === "--http-port") {
      const value = argv[++i];
      options.httpPort = value ? Number(value) : NaN;
      if (!Number.isFinite(options.httpPort)) throw new Error("--http-port requires a number.");
      continue;
    }
    if (arg.startsWith("--http-port=")) {
      options.httpPort = Number(arg.slice("--http-port=".length));
      if (!Number.isFinite(options.httpPort)) throw new Error("--http-port requires a number.");
      continue;
    }
    if (arg === "--project-root") {
      options.projectRoot = argv[++i] ?? null;
      if (!options.projectRoot) throw new Error("--project-root requires a path.");
      continue;
    }
    if (arg.startsWith("--project-root=")) {
      const value = arg.slice("--project-root=".length).trim();
      if (!value) throw new Error("--project-root requires a path.");
      options.projectRoot = value;
      continue;
    }
    if (arg === "--workspace-root") {
      options.workspaceRoot = argv[++i] ?? null;
      if (!options.workspaceRoot) throw new Error("--workspace-root requires a path.");
      continue;
    }
    if (arg.startsWith("--workspace-root=")) {
      const value = arg.slice("--workspace-root=".length).trim();
      if (!value) throw new Error("--workspace-root requires a path.");
      options.workspaceRoot = value;
      continue;
    }
    if (arg === "--socket") {
      options.socketPath = argv[++i] ?? null;
      if (!options.socketPath) throw new Error("--socket requires a path.");
      continue;
    }
    if (arg.startsWith("--socket=")) {
      options.socketPath = arg.slice("--socket=".length);
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return {
    ...options,
    projectRoot: resolveProjectRoot(options.projectRoot),
    workspaceRoot: resolveWorkspaceRoot(options.workspaceRoot),
    socketPath: resolveDevSocketPath(options.socketPath),
  };
}

function pickFreePort(preferred = null) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(preferred ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : null;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error("Failed to allocate port."));
      });
    });
  });
}

function mimeFor(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function buildPage({ httpOrigin, ptyWsUrl, mirrorInstanceId, hasFitAddon }) {
  const fitImport = hasFitAddon
    ? `import { FitAddon } from "${httpOrigin}/vendor/addon-fit.mjs";`
    : "";
  const fitSetup = hasFitAddon
    ? `const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);`
    : "";
  const fitCall = hasFitAddon ? "fitAddon.fit();" : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ade code</title>
  <link rel="stylesheet" href="${httpOrigin}/vendor/xterm.css" />
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; background: #0d0d12; }
    #terminal { width: 100%; height: 100%; }
    #status {
      position: fixed; right: 8px; bottom: 6px; z-index: 9;
      font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: #6f6a86; pointer-events: none;
    }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <div id="status">connecting…</div>
  <script type="module">
    import { Terminal } from "${httpOrigin}/vendor/xterm.mjs";
    ${fitImport}

    const PTY_URL = ${JSON.stringify(ptyWsUrl)};
    const MIRROR_ID = ${JSON.stringify(mirrorInstanceId)};
    const status = document.getElementById("status");
    const PTY_COL_SAFETY_MARGIN = 1;
    const MAX_WEB_COLS = 240;
    const DEBUG_DATASET = new URLSearchParams(location.search).has("debug");
    let inputRole = "primary";
    let lastSentDims = { cols: 0, rows: 0 };
    let ptyWs;
    let resizeTimer = null;
    const mirrorDebug = {
      messages: 0,
      controlMessages: 0,
      stringWrites: 0,
      lastPtyLength: 0,
      lastPtySample: "",
      blobWrites: 0,
      arrayBufferWrites: 0,
      viewWrites: 0,
      fallbackWrites: 0,
      writeErrors: [],
    };
    if (DEBUG_DATASET) window.__adeTuiMirrorDebug = mirrorDebug;

    function setStatus(text) {
      status.textContent = text;
    }

    function updateDebugDataset() {
      if (!DEBUG_DATASET) return;
      status.dataset.messages = String(mirrorDebug.messages);
      status.dataset.controlMessages = String(mirrorDebug.controlMessages);
      status.dataset.stringWrites = String(mirrorDebug.stringWrites);
      status.dataset.lastPtyLength = String(mirrorDebug.lastPtyLength);
      status.dataset.lastPtySample = mirrorDebug.lastPtySample;
      status.dataset.writeErrors = mirrorDebug.writeErrors.slice(-3).join(" | ");
      try {
        status.dataset.cursor = String(term.buffer.active.cursorX) + "," + String(term.buffer.active.cursorY);
        status.dataset.viewport = String(term.buffer.active.viewportY) + "," + String(term.buffer.active.baseY) + "," + String(term.buffer.active.length);
        status.dataset.bufferLine0 = term.buffer.active.getLine(0)?.translateToString(true).slice(0, 120) ?? "";
        status.dataset.bufferLine1 = term.buffer.active.getLine(1)?.translateToString(true).slice(0, 120) ?? "";
        if (DEBUG_DATASET) {
          const screenLines = [];
          for (let index = 0; index < term.rows; index += 1) {
            screenLines.push(term.buffer.active.getLine(index)?.translateToString(true) ?? "");
          }
          status.dataset.screenText = screenLines.join("\\n").slice(0, 24000);
        }
      } catch (_) {}
    }

    function setRole(role) {
      inputRole = role;
      setStatus(role === "primary" ? "primary · " + lastSentDims.cols + "×" + lastSentDims.rows : "view-only · " + lastSentDims.cols + "×" + lastSentDims.rows);
    }

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 13,
      lineHeight: 1,
      fontFamily: "Menlo, Monaco, ui-monospace, SFMono-Regular, Consolas, monospace",
      theme: { background: "#0d0d12", cursor: "#c4b5fd" },
      allowTransparency: false,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
      scrollback: 5000,
    });
    ${fitSetup}
    term.open(document.getElementById("terminal"));
    term.focus();
    document.getElementById("terminal").addEventListener("pointerdown", () => term.focus());

    function writeTerminal(data) {
      term.write(data, () => {
        try {
          term.refresh(0, Math.max(0, term.rows - 1));
        } catch (_) {}
        updateDebugDataset();
      });
    }

    function measureGrid() {
      ${fitCall}
      return { cols: Math.max(2, Math.min(MAX_WEB_COLS, term.cols - PTY_COL_SAFETY_MARGIN)), rows: term.rows };
    }

    function pushPrimaryResize() {
      if (inputRole !== "primary" || !ptyWs || ptyWs.readyState !== WebSocket.OPEN) return;
      const { cols, rows } = measureGrid();
      if (cols === lastSentDims.cols && rows === lastSentDims.rows) return;
      lastSentDims = { cols, rows };
      ptyWs.send(JSON.stringify({ type: "resize", cols, rows }));
      setRole("primary");
    }

    function schedulePrimaryResize() {
      if (inputRole !== "primary") return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(pushPrimaryResize, 50);
    }

    ptyWs = new WebSocket(PTY_URL);
    ptyWs.binaryType = "arraybuffer";
    ptyWs.addEventListener("open", () => {
      setRole("primary");
      requestAnimationFrame(() => {
        pushPrimaryResize();
      });
    });
    ptyWs.addEventListener("message", (ev) => {
      mirrorDebug.messages += 1;
      updateDebugDataset();
      if (typeof ev.data === "string") {
        let handledControlMessage = false;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "session" && msg.mirrorInstanceId === MIRROR_ID) {
            setRole(msg.role === "primary" ? "primary" : "viewer");
            handledControlMessage = true;
          }
          if (msg.type === "sync_resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
            const c = Math.floor(msg.cols);
            const r = Math.floor(msg.rows);
            lastSentDims = { cols: c, rows: r };
            const displayCols = c + PTY_COL_SAFETY_MARGIN;
            if (term.cols !== displayCols || term.rows !== r) term.resize(displayCols, r);
            setRole(inputRole);
            handledControlMessage = true;
          }
          if (msg.type === "pty" && typeof msg.data === "string") {
            mirrorDebug.stringWrites += 1;
            mirrorDebug.lastPtyLength = msg.data.length;
            mirrorDebug.lastPtySample = msg.data.slice(0, 60);
            writeTerminal(msg.data);
            updateDebugDataset();
            handledControlMessage = true;
          }
        } catch (_) {}
        if (handledControlMessage) {
          mirrorDebug.controlMessages += 1;
        } else {
          mirrorDebug.stringWrites += 1;
          writeTerminal(ev.data);
          updateDebugDataset();
        }
        return;
      }
      if (ev.data && typeof ev.data.arrayBuffer === "function") {
        ev.data.arrayBuffer()
          .then((buffer) => {
            mirrorDebug.blobWrites += 1;
            if (typeof Uint8Array !== "undefined") writeTerminal(new Uint8Array(buffer));
            else writeTerminal(buffer);
            updateDebugDataset();
          })
          .catch((error) => {
            mirrorDebug.writeErrors.push(String(error && error.message ? error.message : error));
            updateDebugDataset();
          });
        return;
      }
      if (typeof ArrayBuffer !== "undefined" && ev.data instanceof ArrayBuffer) {
        mirrorDebug.arrayBufferWrites += 1;
        writeTerminal(new Uint8Array(ev.data));
        updateDebugDataset();
        return;
      }
      if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(ev.data)) {
        mirrorDebug.viewWrites += 1;
        writeTerminal(new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength));
        updateDebugDataset();
        return;
      }
      try {
        mirrorDebug.fallbackWrites += 1;
        writeTerminal(ev.data);
        updateDebugDataset();
      } catch (_) {
        mirrorDebug.writeErrors.push("unknown payload");
        updateDebugDataset();
        // Unknown browser WebSocket payload shape; keep the mirror alive.
      }
    });
    ptyWs.addEventListener("close", () => {
      setStatus("disconnected");
      writeTerminal("\\r\\n\\x1b[33m[pty disconnected]\\x1b[0m\\r\\n");
    });
    ptyWs.addEventListener("error", () => {
      setStatus("WebSocket error");
    });

    term.onData((data) => {
      if (inputRole !== "primary") return;
      if (ptyWs && ptyWs.readyState === WebSocket.OPEN) {
        ptyWs.send(JSON.stringify({ type: "stdin", data }));
      }
    });

    term.onBinary((data) => {
      if (inputRole !== "primary") return;
      if (ptyWs && ptyWs.readyState === WebSocket.OPEN) {
        ptyWs.send(JSON.stringify({ type: "stdin", data }));
      }
    });

    const ro = new ResizeObserver(() => schedulePrimaryResize());
    ro.observe(document.getElementById("terminal"));
    window.addEventListener("focus", () => {
      if (inputRole === "primary") term.focus();
      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch (_) {}
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch (_) {}
    });
  </script>
</body>
</html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!xtermFitPath) {
    process.stderr.write("[ade] warning: @xterm/addon-fit not found; grid sizing uses xterm defaults until npm install in apps/ade-cli or apps/desktop\n");
  }
  process.stdout.write(`[ade] tui-web mode: ${options.mode}\n`);
  process.stdout.write(`[ade] project root: ${options.projectRoot}\n`);
  process.stdout.write(`[ade] workspace root: ${options.workspaceRoot}\n`);
  process.stdout.write(`[ade] runtime socket: ${options.socketPath}\n`);

  if (options.mode === "attach") {
    if (!(await canConnectToSocket(options.socketPath))) {
      throw new Error(`No dev runtime is listening at ${options.socketPath}. Start it with npm run dev:runtime.`);
    }
    await buildRuntimeCliForDevClient(options.skipRuntimeBuild, options.socketPath);
  } else {
    await buildRuntimeCliForDevClient(options.skipRuntimeBuild, options.socketPath);
    await ensureRuntime(options.socketPath);
  }

  let pty;
  try {
    pty = require(ptyPath);
  } catch (e) {
    throw new Error(`node-pty is required (apps/ade-cli). ${String(e)}`);
  }
  let WebSocketServer;
  try {
    const ws = require(wsPath);
    WebSocketServer = ws.WebSocketServer;
  } catch (e) {
    throw new Error(`ws is required (apps/ade-cli). ${String(e)}`);
  }

  const httpPort = await pickFreePort(options.httpPort);
  const mirrorInstanceId = crypto.randomUUID();

  const codeArgs = [
    cliPath(),
    "code",
    "--project-root",
    options.projectRoot,
    "--workspace-root",
    options.workspaceRoot,
    "--socket",
    options.socketPath,
    "--require-socket",
    ...options.rest,
  ];
  const codeEnv = {
    ...process.env,
    ...devRuntimeEnv(options.socketPath, options.projectRoot),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
  };
  delete codeEnv.NO_COLOR;
  delete codeEnv.CI;
  if (!codeEnv.ADE_TUI_MOUSE) codeEnv.ADE_TUI_MOUSE = "1";

  const shell = pty.spawn(process.execPath, codeArgs, {
    name: "xterm-256color",
    cols: 120,
    rows: 36,
    cwd: options.workspaceRoot,
    env: codeEnv,
  });

  const ptyClients = new Set();
  /** @type {import("ws").WebSocket | null} */
  let primaryClient = null;
  let ptyCols = 120;
  let ptyRows = 36;
  const ptyReplayLimitBytes = 2 * 1024 * 1024;
  /** @type {string[]} */
  const ptyReplayChunks = [];
  let ptyReplayBytes = 0;

  function rememberPtyOutput(text) {
    if (!text.length) return;
    ptyReplayChunks.push(text);
    ptyReplayBytes += Buffer.byteLength(text);
    while (ptyReplayBytes > ptyReplayLimitBytes && ptyReplayChunks.length > 1) {
      const removed = ptyReplayChunks.shift();
      ptyReplayBytes -= removed ? Buffer.byteLength(removed) : 0;
    }
  }

  function replayPtyOutput(ws) {
    for (const chunk of ptyReplayChunks) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "pty", data: chunk }));
    }
  }

  function broadcastSessionRoles() {
    const primaryJson = JSON.stringify({ type: "session", mirrorInstanceId, role: "primary" });
    const viewerJson = JSON.stringify({ type: "session", mirrorInstanceId, role: "viewer" });
    for (const client of ptyClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      client.send(client === primaryClient ? primaryJson : viewerJson);
    }
  }

  function broadcastPtySize(cols, rows) {
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    if (c === ptyCols && r === ptyRows) return;
    ptyCols = c;
    ptyRows = r;
    shell.resize(c, r);
    const msg = JSON.stringify({ type: "sync_resize", cols: c, rows: r });
    for (const client of ptyClients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${httpPort}`);
    if (req.method === "GET" && url.pathname === "/vendor/xterm.css") {
      const p = path.join(xtermDir, "css", "xterm.css");
      fs.readFile(p, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("missing xterm.css — run npm install in apps/ade-cli");
          return;
        }
        res.writeHead(200, { "content-type": mimeFor(p) });
        res.end(data);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/vendor/xterm.mjs") {
      const p = path.join(xtermDir, "lib", "xterm.mjs");
      fs.readFile(p, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("missing xterm.mjs");
          return;
        }
        res.writeHead(200, { "content-type": mimeFor(p) });
        res.end(data);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/vendor/addon-fit.mjs") {
      if (!xtermFitPath) {
        res.writeHead(404);
        res.end("missing addon-fit");
        return;
      }
      fs.readFile(xtermFitPath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("missing addon-fit");
          return;
        }
        res.writeHead(200, { "content-type": mimeFor(xtermFitPath) });
        res.end(data);
      });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const httpOrigin = `http://127.0.0.1:${httpPort}`;
      const ptyWsUrl = `ws://127.0.0.1:${httpPort}/pty`;
      const html = buildPage({
        httpOrigin,
        ptyWsUrl,
        mirrorInstanceId,
        hasFitAddon: Boolean(xtermFitPath),
      });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    ptyClients.add(ws);
    primaryClient = ws;
    broadcastSessionRoles();
    ws.send(JSON.stringify({ type: "sync_resize", cols: ptyCols, rows: ptyRows }));
    replayPtyOutput(ws);

    ws.on("message", (raw) => {
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        const msg = JSON.parse(text);
        if (msg.type === "stdin" && typeof msg.data === "string") {
          if (ws !== primaryClient) return;
          shell.write(msg.data);
        } else if (msg.type === "resize") {
          if (ws !== primaryClient) return;
          const cols = Number(msg.cols);
          const rows = Number(msg.rows);
          if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
            broadcastPtySize(cols, rows);
          }
        }
      } catch {
        // ignore
      }
    });

    ws.on("close", () => {
      ptyClients.delete(ws);
      if (ws === primaryClient) {
        primaryClient = null;
        for (const c of ptyClients) {
          if (c.readyState === WebSocket.OPEN) {
            primaryClient = c;
            break;
          }
        }
        broadcastSessionRoles();
      }
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${httpPort}`);
    if (url.pathname !== "/pty") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  shell.onData((data) => {
    const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    rememberPtyOutput(text);
    const payload = JSON.stringify({ type: "pty", data: text });
    for (const client of ptyClients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  });
  shell.onExit(({ exitCode, signal }) => {
    process.stdout.write(`[ade] ade code exited (code=${exitCode}, signal=${signal ?? "none"})\n`);
    for (const client of ptyClients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    httpServer.close();
    process.exit(exitCode ?? (signal ? 1 : 0));
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(httpPort, "127.0.0.1", resolve);
  });

  const url = `http://127.0.0.1:${httpPort}/`;
  process.stdout.write(`[ade] tui web UI: ${url}\n`);
  process.stdout.write(`[ade] PTY parity: same ade code process, binary stdout, FitAddon grid, cwd=${options.workspaceRoot}\n`);

  if (process.platform === "darwin") {
    const { spawn } = await import("node:child_process");
    spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true }).unref?.();
  }
}

main().catch((error) => {
  process.stderr.write(`[ade] tui-web failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
