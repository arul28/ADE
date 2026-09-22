#!/usr/bin/env node
/**
 * Run a dev command in its own SESSION, so a process-group signal cannot kill it.
 *
 * `nohup cmd & disown` survives the shell exiting. It does not survive a
 * SIGTERM sent to the process group, which is how an agent harness tears a turn
 * down — and that is exactly how a detached `npm run dev:desktop` died twice in
 * one night with `electron exited (code=143)`, taking the app under test with
 * it. macOS ships no `setsid`; Node's `detached: true` calls it for us.
 *
 * Usage:
 *   node scripts/dev-detached.mjs <logfile> <command> [args...]
 *
 * Prints the child's pid and returns immediately. Stop it with `kill <pid>`;
 * it is a normal process, just in a session of its own.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const [logPath, command, ...args] = process.argv.slice(2);
if (!logPath || !command) {
  process.stderr.write("usage: node scripts/dev-detached.mjs <logfile> <command> [args...]\n");
  process.exit(2);
}

// Truncate rather than append: the log is read by "wait for the isolation
// report", and a stale report from the previous run would satisfy that wait
// before this launch had done anything.
const fd = fs.openSync(logPath, "w");
const child = spawn(command, args, {
  detached: true,
  stdio: ["ignore", fd, fd],
  env: process.env,
});
child.unref();
fs.closeSync(fd);
process.stdout.write(`${child.pid}\n`);
