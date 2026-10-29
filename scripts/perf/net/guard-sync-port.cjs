// Preload for a measurement brain with sync ON, on a machine whose installed brain must not be touched:
//   node --require scripts/perf/net/guard-sync-port.cjs apps/ade-cli/dist/cli.cjs --role cto serve --socket ...
// Pair it with its own HOME (ADE_HOME=$HOME/.ade, the only home where sync turns on), its own socket and
// ADE_SYNC_BIND_HOST=127.0.0.1 (no LAN advertising). See scripts/perf/net/README.md.
//
// A sync host is a machine-wide singleton, so a second one does three things a measurement brain must not:
//   1. It binds 8787 first, and its canonical-port migrate retries 8787 every few minutes. Every listen on
//      8787 (plus ADE_PERF_GUARD_PORTS, comma separated) fails here with the EADDRINUSE a held port gives,
//      so the listener moves to the next candidate even in the moment the installed brain restarts.
//   2. It scans every listener on 8787-8999 (lsof) and refuses to host while the installed brain listens,
//      and the stale-holder reaper reads the same scan before it stops a holder. Those lsof calls answer
//      "no listeners" here, so this brain neither refuses nor ever considers another process a holder.
//   3. It lists every process (ps -axo) to reap orphaned dns-sd advertisers and stale brains. That
//      listing answers empty here, so it never signals a process it did not start.
//   4. It publishes itself on the tailnet (`tailscale serve --tcp=<port>`) and turns off forwards it
//      thinks are stale, which is machine-wide state the installed brain relies on. Every tailscale
//      call answers empty here, so a measurement brain never reads or changes the tailnet config.
//   5. It talks to ADE's cloud (relay tunnel, push relay, analytics, crash reports). Name lookups for
//      ade-app.dev, posthog and sentry fail here (ENOTFOUND), so a scratch home never publishes itself.
// Each blocked call runs /usr/bin/true instead (on Windows `cmd.exe /d /c exit 0`), so callers see a normal
// empty result. Nothing else changes.
"use strict";
const net = require("node:net");
const childProcess = require("node:child_process");
const util = require("node:util");
const dns = require("node:dns");

const BLOCKED_HOSTS = /(^|\.)(ade-app\.dev|posthog\.com|sentry\.io)$/i;
const originalLookup = dns.lookup;
dns.lookup = function guardedLookup(host, ...rest) {
  if (BLOCKED_HOSTS.test(String(host ?? ""))) {
    const callback = rest[rest.length - 1];
    const error = Object.assign(new Error(`getaddrinfo ENOTFOUND ${host} (guard-sync-port.cjs)`), {
      code: "ENOTFOUND",
      hostname: host,
    });
    if (typeof callback === "function") process.nextTick(() => callback(error));
    return {};
  }
  return originalLookup.call(this, host, ...rest);
};
const originalPromisesLookup = dns.promises.lookup;
dns.promises.lookup = function guardedPromisesLookup(host, ...rest) {
  if (BLOCKED_HOSTS.test(String(host ?? ""))) {
    return Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host} (guard-sync-port.cjs)`), {
      code: "ENOTFOUND",
      hostname: host,
    }));
  }
  return originalPromisesLookup.call(this, host, ...rest);
};

const guardedPorts = new Set([8787]);
for (const part of String(process.env.ADE_PERF_GUARD_PORTS ?? "").split(",")) {
  const port = Number(part.trim());
  if (Number.isInteger(port) && port > 0) guardedPorts.add(port);
}

function requestedPort(args) {
  const first = args[0];
  if (typeof first === "number") return first;
  if (typeof first === "string" && /^\d+$/.test(first)) return Number(first);
  if (first && typeof first === "object" && first.port != null) return Number(first.port);
  return null;
}

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function guardedListen(...args) {
  const port = requestedPort(args);
  if (port != null && guardedPorts.has(port)) {
    const error = Object.assign(new Error(`listen EADDRINUSE: guarded port ${port} (guard-sync-port.cjs)`), {
      code: "EADDRINUSE",
      errno: -48,
      syscall: "listen",
      port,
    });
    process.nextTick(() => this.emit("error", error));
    return this;
  }
  return originalListen.apply(this, args);
};

const TRUE_CALL = process.platform === "win32"
  ? [process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe", ["/d", "/c", "exit 0"]]
  : ["/usr/bin/true", []];
let blockedCalls = 0;

function isBlocked(file, args) {
  // Windows callers pass full paths with backslashes (C:\Windows\System32\...\powershell.exe).
  const name = String(file ?? "").split(/[\\/]/).pop();
  const list = Array.isArray(args) ? args.map(String) : [];
  // Machine-wide listener scans of the sync port range.
  if (name === "lsof" && list.some((arg) => /^-iTCP:8[7-9]\d\d/.test(arg))) return true;
  // The tailnet config is machine-wide (tailscale serve / status / ip).
  if (/^tailscale(\.exe)?$/i.test(name) || /Tailscale\.app/.test(String(file ?? ""))) return true;
  // Windows: the singleton's listener scan and the process listings run through PowerShell.
  if (/^(powershell|pwsh)(\.exe)?$/i.test(name) && list.some((arg) => /Get-NetTCPConnection|Win32_Process|Get-Process/i.test(arg))) return true;
  // Windows: the orphan reapers try `wmic process` before PowerShell.
  if (/^wmic(\.exe)?$/i.test(name) && list.some((arg) => /^process$/i.test(arg))) return true;
  // Machine-wide process listings (reapers for orphaned dns-sd and stale brains).
  if (name === "ps" && list.some((arg) => /^-[a-z]*a[a-z]*x|^-ax|^-e$|^-A$/.test(arg))) return true;
  return false;
}

function rewrite(file, args) {
  if (!isBlocked(file, args)) return null;
  blockedCalls += 1;
  if (process.env.ADE_PERF_GUARD_LOG === "1") {
    process.stderr.write(`[guard-sync-port] blocked ${file} ${(args ?? []).join(" ")}\n`);
  }
  return TRUE_CALL;
}

function wrapFileArgs(original) {
  return function wrapped(file, ...rest) {
    const args = Array.isArray(rest[0]) ? rest[0] : null;
    const swap = rewrite(file, args);
    if (!swap) return original.call(this, file, ...rest);
    return original.call(this, swap[0], swap[1], ...(args ? rest.slice(1) : rest));
  };
}

const originalExecFile = childProcess.execFile;
const wrappedExecFile = wrapFileArgs(originalExecFile);
const promisifiedOriginal = util.promisify(originalExecFile);
wrappedExecFile[util.promisify.custom] = (file, ...rest) => {
  const args = Array.isArray(rest[0]) ? rest[0] : null;
  const swap = rewrite(file, args);
  if (!swap) return promisifiedOriginal(file, ...rest);
  return promisifiedOriginal(swap[0], swap[1], ...(args ? rest.slice(1) : rest));
};
childProcess.execFile = wrappedExecFile;
childProcess.execFileSync = wrapFileArgs(childProcess.execFileSync);
childProcess.spawnSync = wrapFileArgs(childProcess.spawnSync);
childProcess.spawn = wrapFileArgs(childProcess.spawn);

process.on("exit", () => {
  if (process.env.ADE_PERF_GUARD_LOG === "1") process.stderr.write(`[guard-sync-port] blocked ${blockedCalls} calls\n`);
});
