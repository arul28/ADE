#!/usr/bin/env node
/**
 * Capture a PNG of the first Electron devtools target (main ADE window) via CDP.
 * Requires `npm run dev` (or equivalent) with `--remote-debugging-port` set.
 *
 * Usage:
 *   node scripts/capture-dev-screenshot.mjs [port] [outPath]
 * Defaults: port 9222, out /tmp/ade-electron-dev.png
 */
import fs from "node:fs";
import http from "node:http";
import process from "node:process";
import { WebSocket } from "ws";

const port = Number.parseInt(process.argv[2] || process.env.ADE_ELECTRON_REMOTE_DEBUGGING_PORT || "9222", 10);
const outPath = process.argv[3] || "/tmp/ade-electron-dev.png";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function cdpCommand(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CDP timeout: ${method}`));
    }, 60_000);
    const onMessage = (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      if (msg.error) {
        reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        return;
      }
      resolve(msg.result);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRendererPainted(ws, timeoutMs = 60_000) {
  const started = Date.now();
  await cdpCommand(ws, "Runtime.enable");
  while (Date.now() - started < timeoutMs) {
    const result = await cdpCommand(ws, "Runtime.evaluate", {
      expression:
        "(() => { const href = String(location.href || ''); const root = document.getElementById('root'); const hasShell = root && root.children && root.children.length > 0; return href.includes('5173') && document.readyState === 'complete' && hasShell; })()",
      returnByValue: true,
    });
    if (result?.result?.value === true) {
      return;
    }
    await sleep(400);
  }
}

async function main() {
  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`No devtools targets on port ${port}. Is Electron running with --remote-debugging-port?`);
  }
  const pageTargets = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const devRenderer = pageTargets.find((t) => /localhost|127\.0\.0\.1/.test(String(t.url ?? "")));
  const pageTarget = devRenderer ?? pageTargets[0];
  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error(`No page target with webSocketDebuggerUrl in list (port ${port})`);
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  await cdpCommand(ws, "Page.enable");
  await waitForRendererPainted(ws);
  await sleep(2000);
  const shot = await cdpCommand(ws, "Page.captureScreenshot", { format: "png", fromSurface: true });
  ws.close();

  const buf = Buffer.from(shot.data, "base64");
  fs.writeFileSync(outPath, buf);
  process.stdout.write(`[ade] screenshot written to ${outPath} (${buf.length} bytes)\n`);
}

main().catch((err) => {
  process.stderr.write(`[ade] capture-dev-screenshot failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
