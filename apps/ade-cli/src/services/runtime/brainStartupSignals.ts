/**
 * Signal handling for a brain that is still starting up.
 *
 * Installing a SIGINT or SIGTERM listener turns off Node's default exit. A
 * listener that only does bookkeeping therefore makes the first signal a
 * no-op: the brain keeps running, and only a second signal ends it, with no
 * exit hooks. Before the graceful handler in `runServe` is installed there is
 * nothing safe to unwind, so the signal ends the brain at once with the
 * conventional code for it.
 */

const STARTUP_SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
} as const;

type StartupSignal = keyof typeof STARTUP_SIGNAL_EXIT_CODES;

/**
 * Runs `onSignal`, then exits with the signal's conventional code. Returns a
 * function that removes both listeners; call it before installing the graceful
 * handler, so exactly one listener owns each signal.
 */
export function installStartupSignalExit(onSignal: () => void): () => void {
  const listeners = (Object.keys(STARTUP_SIGNAL_EXIT_CODES) as StartupSignal[]).map((signal) => {
    const listener = () => {
      onSignal();
      process.exit(STARTUP_SIGNAL_EXIT_CODES[signal]);
    };
    process.once(signal, listener);
    return { signal, listener };
  });
  return () => {
    for (const { signal, listener } of listeners) {
      process.removeListener(signal, listener);
    }
  };
}
