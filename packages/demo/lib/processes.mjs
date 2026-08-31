/**
 * Process bookkeeping shared by the app launcher and the test rig.
 *
 * Every process either side starts is registered and killed by the pid captured
 * at spawn, including on failure and on Ctrl-C. Nothing is ever killed by name.
 */

const owned = new Set();
let cleanupInstalled = false;

function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const killAll = () => {
    for (const child of [...owned]) {
      // Only pids captured at spawn time are ever signalled.
      try {
        if (child.pid != null && !child.killed) process.kill(child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    owned.clear();
  };
  process.on("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      killAll();
      process.exit(1);
    });
  }
}

export function own(child) {
  installCleanup();
  owned.add(child);
  child.once("exit", () => owned.delete(child));
  return child;
}

/**
 * Stop a child by the pid captured at spawn.
 *
 * The grace period has to outlast the slowest orderly shutdown underneath us:
 * a host holding an `@ade-dev/sdk` client spends up to 5s waiting for its own
 * runtime child to exit. SIGKILLing the host before that finishes orphans the
 * runtime — it survives, still holding its ADE home, because a POSIX child does
 * not die with its parent.
 */
export async function stop(child, graceMs = 12_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const timer = new Promise((resolve) => setTimeout(resolve, graceMs).unref());
  const finished = await Promise.race([exited.then(() => true), timer.then(() => false)]);
  if (!finished) {
    try {
      if (child.pid != null) process.kill(child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
    await exited;
  }
  owned.delete(child);
}
