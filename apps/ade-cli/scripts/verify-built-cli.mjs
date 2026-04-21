import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "dist", "cli.cjs");

async function runHelp(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: packageRoot,
    env: process.env,
  });
  if (!stdout.includes("Agent-focused command-line interface for ADE")) {
    throw new Error(`[ade-cli:build] CLI help output did not include the ADE banner text for ${command}`);
  }
}

const contents = await fs.readFile(cliPath, "utf8");
if (!contents.startsWith("#!/usr/bin/env node")) {
  throw new Error("[ade-cli:build] dist/cli.cjs is missing the node shebang");
}

const stat = await fs.stat(cliPath);
if (process.platform !== "win32" && (stat.mode & 0o111) === 0) {
  throw new Error("[ade-cli:build] dist/cli.cjs is not executable");
}

await runHelp(process.execPath, [cliPath, "--help"]);

if (process.platform !== "win32") {
  await runHelp(cliPath, ["--help"]);
}

console.log("[ade-cli:build] verified dist/cli.cjs binary");
