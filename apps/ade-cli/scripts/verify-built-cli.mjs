import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "dist", "cli.cjs");
const packageJsonPath = path.join(packageRoot, "package.json");

async function runHelp(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: packageRoot,
    env: process.env,
  });
  if (!stdout.includes("Agent-focused command-line interface for ADE")) {
    throw new Error(`[ade-cli:build] CLI help output did not include the ADE banner text for ${command}`);
  }
}

async function assertVersion(command, args, expectedVersion) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: packageRoot,
    env: process.env,
  });
  const actual = stdout.trim().replace(/^ade\s+/i, "");
  if (actual !== expectedVersion) {
    throw new Error(`[ade-cli:build] CLI version mismatch: expected ${expectedVersion}, got ${actual || "<empty>"}`);
  }
}

const contents = await fs.readFile(cliPath, "utf8");
const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
const expectedVersion = process.env.ADE_CLI_VERSION?.trim() || packageJson.version;
if (!expectedVersion) {
  throw new Error("[ade-cli:build] Unable to resolve expected CLI version from ADE_CLI_VERSION or package.json");
}

if (!contents.startsWith("#!/usr/bin/env node")) {
  throw new Error("[ade-cli:build] dist/cli.cjs is missing the node shebang");
}

const normalized = contents.replace(/require\((["'])sqlite\1\)/g, 'require("node:sqlite")');
if (normalized !== contents) {
  await fs.writeFile(cliPath, normalized, "utf8");
}

const stat = await fs.stat(cliPath);
if (process.platform !== "win32" && (stat.mode & 0o111) === 0) {
  throw new Error("[ade-cli:build] dist/cli.cjs is not executable");
}

await runHelp(process.execPath, [cliPath, "--help"]);
await assertVersion(process.execPath, [cliPath, "--version"], expectedVersion);

if (process.platform !== "win32") {
  await runHelp(cliPath, ["--help"]);
  await assertVersion(cliPath, ["--version"], expectedVersion);
}

console.log("[ade-cli:build] verified dist/cli.cjs binary");
