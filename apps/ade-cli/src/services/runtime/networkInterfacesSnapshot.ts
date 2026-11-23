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
 * as they take. Addresses change when the network does, not between two
 * reads, so a snapshot that is half a minute old costs nothing anyone sees.
 * Only the very first read, before any snapshot exists, is still made on the
 * caller's thread. Elsewhere the call is cheap (`getifaddrs`), so nothing
 * changes there.
 */

const REFRESH_AFTER_MS = 30_000;

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

export function installNetworkInterfacesSnapshot(): void {
  if (installed || process.platform !== "win32") return;
  installed = true;
  const read = os.networkInterfaces.bind(os);
  let snapshot: { value: Interfaces; atMs: number } | null = null;
  let refreshing = false;

  const refresh = () => {
    if (refreshing) return;
    refreshing = true;
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true });
    } catch {
      // No worker (out of threads): the snapshot stays, and the next read past
      // the refresh age tries again.
      refreshing = false;
      if (snapshot) snapshot.atMs = Date.now();
      return;
    }
    worker.unref();
    const done = (value: Interfaces | null) => {
      if (!refreshing) return;
      refreshing = false;
      // A failed read keeps the old snapshot until the next refresh age.
      if (value && typeof value === "object") snapshot = { value, atMs: Date.now() };
      else if (snapshot) snapshot.atMs = Date.now();
      void worker.terminate().catch(() => undefined);
    };
    worker.once("message", (value: Interfaces | null) => done(value));
    worker.once("error", () => done(null));
    worker.once("exit", () => done(null));
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
