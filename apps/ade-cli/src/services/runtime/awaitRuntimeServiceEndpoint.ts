/**
 * "Is the brain answering, and if not, install the service and wait for it."
 *
 * Setup's single hardest question, and the one place a wrong answer is most
 * expensive: reporting "not running" against a socket that was simply never
 * given time to open is what turned every slow machine into a broken one.
 *
 * The policy is here, free of the CLI's globals, so it can be tested against a
 * probe that answers on the Nth call rather than against a real brain.
 */

export type RuntimeServiceEndpointOutcome = {
  ready: boolean;
  /** Supervised and coming up: not ready, but explicitly not a failure. */
  starting: boolean;
  detail: string;
};

export type AwaitRuntimeServiceEndpointDeps = {
  /** Dials the endpoint once. Resolves false for any connect failure. */
  probe: () => Promise<boolean>;
  /** Runs the platform service installer. Only called when the probe fails. */
  installService: () => Promise<{ ok: boolean; starting?: boolean; message: string }>;
  /** Called once the service is registered and supervised. */
  onStarting: () => void;
  /** How long to keep dialing after a successful (or `starting`) install. */
  budgetMs: number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  now?: () => number;
};

const DEFAULT_POLL_MS = 500;

export async function awaitRuntimeServiceEndpoint(
  deps: AwaitRuntimeServiceEndpointDeps,
): Promise<RuntimeServiceEndpointOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = Math.max(1, deps.pollMs ?? DEFAULT_POLL_MS);
  const running: RuntimeServiceEndpointOutcome = {
    ready: true,
    starting: false,
    detail: "background service is running",
  };

  if (await deps.probe()) return running;

  const install = await deps.installService();
  // `starting` is a live supervised brain that had not answered inside the
  // installer's own budget — a slow start, not a failed install.
  if (!install.ok && !install.starting) {
    return { ready: false, starting: false, detail: install.message };
  }

  // Registered and supervised from here on, whether or not the install itself
  // waited long enough to see it answer.
  deps.onStarting();
  const deadline = now() + Math.max(0, deps.budgetMs);
  for (;;) {
    if (await deps.probe()) return running;
    if (now() >= deadline) {
      return { ready: false, starting: true, detail: "background service is still starting" };
    }
    await sleep(pollMs);
  }
}
