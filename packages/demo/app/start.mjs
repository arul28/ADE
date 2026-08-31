/**
 * Start DataDesk: the toy MCP server, the SDK host, and Vite — one command.
 *
 * Every child is tracked by the pid captured at spawn and killed on exit,
 * including on Ctrl-C and on any child dying first. The ADE home is a temp
 * directory unless `DATADESK_HOME` names one; the developer's `~/.ade` is never
 * touched.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { makeIsolatedHome } from "../lib/isolatedHome.mjs";
import { startMcpServer } from "../lib/mcpServer.mjs";
import { demoRoot, runtimeBinary } from "../lib/paths.mjs";
import { own, stop } from "../lib/processes.mjs";

const webPort = Number(process.env.DATADESK_WEB_PORT ?? 4317);
const bridgePort = Number(process.env.DATADESK_PORT ?? 4318);
const home = process.env.DATADESK_HOME || makeIsolatedHome("datadesk");

const children = [];
let stopping = false;

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children.reverse()) await stop(child);
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void shutdown(0));

const mcp = await startMcpServer({ logPath: path.join(demoRoot, "artifacts", "mcp-calls.jsonl") });
children.push(mcp.child);
process.stdout.write(`[start] demodata MCP: ${mcp.url}\n[start] ADE home: ${home}\n`);

function run(label, command, args, env) {
  const child = own(
    spawn(command, args, {
      cwd: demoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => target.write(chunk));
  }
  child.once("exit", (code) => {
    if (stopping) return;
    process.stderr.write(`[start] ${label} exited (${code}); shutting the rest down\n`);
    void shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

run("host", process.execPath, [path.join(demoRoot, "app", "host.mjs")], {
  DATADESK_MCP_URL: mcp.url,
  DATADESK_HOME: home,
  DATADESK_PORT: String(bridgePort),
  ADE_BINARY_PATH: runtimeBinary,
});

run("vite", process.execPath, [
  path.join(demoRoot, "node_modules", "vite", "bin", "vite.js"),
  "--config",
  path.join(demoRoot, "app", "vite.config.mjs"),
], {
  DATADESK_WEB_PORT: String(webPort),
  VITE_BRIDGE_PORT: String(bridgePort),
});

process.stdout.write(`[start] DataDesk will be at http://127.0.0.1:${webPort}\n`);
