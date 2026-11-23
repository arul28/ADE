import os from "node:os";
import { Worker } from "node:worker_threads";

/**
 * `os.networkInterfaces()` off the brain's main thread, on Windows.
 *
 * On Windows the call is `GetAdaptersAddresses`, which waits on every adapter
 * (VPN, Hyper-V, WSL, a sleeping Wi-Fi card). On some PCs one call took 1 to
 * 13 seconds, and the brain asks often: the mDNS responder (`multicast-dns`,
 * under `bonjour-service`) polls it every 5 s and again for every answer it
 * sends, and the sync host reads the local device's addresses for each status
 * read. Profiles of frozen Windows brains spent up to a third of a minute in
 * it (ADE-BRAIN-94, ADE-BRAIN-8P).
 *
 * So on Windows every caller in the brain, ADE's own and the libraries', gets
 * the last snapshot, and a snapshot older than `REFRESH_AFTER_MS` is refreshed
 * by a short-lived worker thread, which can wait on the adapters for as long
 * as they take (up to `WORKER_CEILING_MS`). The read that finds the snapshot
 * old still gets that old snapshot and starts the refresh: while mDNS polls
 * every 5 s the answer is at most about half a minute old, and a caller that
 * reads seldom gets the addresses as of its last read once. Addresses change
 * when the network does, so that costs nothing anyone sees. A worker starts
 * only on a read, never on a timer. Only the very first read, before any
 * snapshot exists, is still made on the caller's thread. Elsewhere the call is
 * cheap (`getifaddrs`), so nothing changes there.
 */

const REFRESH_AFTER_MS = 30_000;
/** A worker still waiting on the adapters after this is stopped; the next read past the refresh age tries again. */
const WORKER_CEILING_MS = 60_000;

// A string, not a function's source: the bundle is minified, and a function
// stringified into a worker loses the names it reached outside itself.
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const os = require("node:os");
let interfaces = null;
try { interfaces = os.networkInterfaces(); } catch {}
parentPort.postMessage(interfaces);
`;

type Interfaces = ReturnType<typeof os.networkInterfaces>;

let installed = false;

function copyOf(value: Interfaces): Interfaces {
  const copy: Interfaces = {};
  for (const [name, entries] of Object.entries(value)) copy[name] = entries ? entries.map((entry) => ({ ...entry })) : entries;
  return copy;
}

export function installNetworkInterfacesSnapshot(
  warn?: (event: string, meta: Record<string, unknown>) => void,
): void {
  if (installed || process.platform !== "win32") return;
  installed = true;
  const read = os.networkInterfaces.bind(os);
  let snapshot: { value: Interfaces; atMs: number } | null = null;
  let refreshing = false;
  let warned = false;

  // A failed or stuck read keeps the old snapshot until the next refresh age.
  const settle = (value: Interfaces | null, failure?: string) => {
    refreshing = false;
    if (value && typeof value === "object") snapshot = { value, atMs: Date.now() };
    else if (snapshot) snapshot.atMs = Date.now();
    if (failure && !warned) {
      // Once per brain: the old addresses keep being served either way.
      warned = true;
      warn?.("brain.network_interfaces_refresh_failed", { reason: failure });
    }
  };

  const refresh = () => {
    if (refreshing) return;
    refreshing = true;
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true });
    } catch (error) {
      // No worker (out of threads).
      settle(null, error instanceof Error ? error.message : "worker_start_failed");
      return;
    }
    worker.unref();
    // This worker's own answer: a late exit from it must not end a later one.
    let settled = false;
    const done = (value: Interfaces | null, failure?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(ceiling);
      settle(value, failure);
      void worker.terminate().catch(() => undefined);
    };
    const ceiling = setTimeout(() => done(null, "timeout"), WORKER_CEILING_MS);
    ceiling.unref();
    worker.once("message", (value: Interfaces | null) => done(value, value ? undefined : "read_failed"));
    worker.once("error", (error) => done(null, error instanceof Error ? error.message : "worker_error"));
    worker.once("exit", () => done(null, "worker_exit"));
  };

  const snapshotRead = (): Interfaces => {
    if (!snapshot) {
      snapshot = { value: read(), atMs: Date.now() };
    } else if (Date.now() - snapshot.atMs >= REFRESH_AFTER_MS) {
      refresh();
    }
    // A copy: a caller that edits its answer must not edit the next caller's.
    return copyOf(snapshot.value);
  };
  (os as { networkInterfaces: typeof os.networkInterfaces }).networkInterfaces = snapshotRead;
  // The first snapshot too, so the brain's own first read seldom has to wait.
  refresh();
}
