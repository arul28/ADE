#!/usr/bin/env node
/**
 * Windows only: run a dev command in a console of its own that no one can see.
 *
 * A detached process on Windows has no console at all (DETACHED_PROCESS), so
 * every console program it starts without CREATE_NO_WINDOW gets a brand-new
 * console. On Windows 11 that is a Windows Terminal window that takes the
 * foreground: a detached `npm run dev:desktop` flashed one for npm's `cmd.exe`,
 * and the detached dev brain flashed one for every probe a service ran.
 *
 * This host is what gets detached instead. It has no console, so the command it
 * starts here (non-detached, `windowsHide`) gets a fresh console that Windows
 * creates hidden, and every process under the command inherits that hidden
 * console instead of opening its own. The host waits for the command and exits
 * with its exit code, so the host's pid is the root of the whole tree: stop it
 * with `taskkill /T /F /PID <pid>`.
 *
 * Usage (started by `spawnWithHiddenConsole` in dev-shared.mjs, not by hand):
 *   node scripts/dev-console-host.mjs <logfile|-> <command> [args...]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

import { resolveDetachedDevInvocation } from "./dev-shared.mjs";

const [logPath, command, ...args] = process.argv.slice(2);
if (!logPath || !command) {
  process.stderr.write("usage: node scripts/dev-console-host.mjs <logfile|-> <command> [args...]\n");
  process.exit(2);
}

const out = logPath === "-" ? "ignore" : fs.openSync(logPath, "a");
const invocation = resolveDetachedDevInvocation(command, args);
const child = spawn(invocation.command, invocation.args, {
  stdio: ["ignore", out, out],
  env: process.env,
  windowsHide: true,
  windowsVerbatimArguments: invocation.windowsVerbatimArguments,
});
child.once("error", (error) => {
  if (out !== "ignore") fs.writeSync(out, `dev-console-host: could not start ${command}: ${error.message}\n`);
  process.exit(1);
});
child.once("exit", (code) => process.exit(code ?? 1));
