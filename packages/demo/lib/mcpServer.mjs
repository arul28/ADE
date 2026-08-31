/**
 * Starting the toy `demodata` MCP server, and reading the call log it keeps.
 *
 * Both the running app and the end-to-end scripts need the server, so the
 * starter is shared rather than owned by either.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { demoRoot } from "./paths.mjs";
import { own } from "./processes.mjs";

export async function startMcpServer({ logPath }) {
  const child = own(
    spawn(process.execPath, [path.join(demoRoot, "mcp-server.mjs"), "--port", "0", "--log", logPath], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => process.stderr.write(`[demodata] ${chunk}`));

  const ready = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("the toy MCP server never reported ready")), 10_000);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((entry) => entry.trim().startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the toy MCP server exited before it was ready (code ${code})`));
    });
  });

  return { child, url: ready.url, port: ready.port, logPath: ready.log };
}

export function readMcpLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}
