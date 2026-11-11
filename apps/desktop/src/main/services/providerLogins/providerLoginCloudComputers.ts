/**
 * "Does this account have a cloud computer?" for the renewal planner on the
 * owner computer (P5 step 3a, B2). Without one, nothing renews ahead and no
 * timer exists ("no renewals for nobody").
 *
 * The answer comes from one `listInstances()` read, asked lazily: only when
 * the planner has a sign-in that is otherwise due to be planned. It has no
 * timer of its own; the next pass asks again once the answer is old.
 * - "At least one" is kept 6 h.
 * - "None" is kept 1 h, so a person who makes the first cloud computer does
 *   not wait long (a Grok copy lives about 6 h).
 * - A failed read pauses the reads for 30 min. It never changes a known
 *   answer to "none".
 * - Unknown (never read, or only failed reads) means no renewal.
 *
 * Free news: when this process already lists the account's cloud computers
 * or makes one (the brain's cloud actions, `adeActions/registry.ts`), the
 * answer is set at once, with no request of its own.
 */

/** How long "at least one cloud computer" holds. */
export const CLOUD_COMPUTER_EXISTS_TTL_MS = 6 * 60 * 60_000;
/** How long "no cloud computer" holds. */
export const CLOUD_COMPUTER_NONE_TTL_MS = 60 * 60_000;
/** After a failed read, no other read for this long. */
export const CLOUD_COMPUTER_FAILED_PAUSE_MS = 30 * 60_000;

type CountListener = (count: number) => void;

/** Live checks in this process that want the free news. */
const countListeners = new Set<CountListener>();

/**
 * This process just learned how many cloud computers the account has (not
 * deleted, not failed), with no extra request. Nothing happens when no check
 * listens (the desktop process, a cloud computer).
 */
function noteCloudComputerCount(count: number): void {
  if (!Number.isFinite(count) || count < 0) return;
  for (const listener of countListeners) {
    try {
      listener(count);
    } catch {
      // A listener never breaks the caller's cloud action.
    }
  }
}

type CloudMachinesLike = {
  list(): Promise<{ state: string; instanceCount?: number | null }>;
};

/** The brain's cloud computers object, with each good list sent to the checks. */
export function observeCloudComputerLists<T extends CloudMachinesLike>(machines: T): T {
  return {
    ...machines,
    list: async () => {
      const result = await machines.list();
      if (result.state === "ok" && typeof result.instanceCount === "number") noteCloudComputerCount(result.instanceCount);
      return result;
    },
  };
}

type CloudMakerLike = {
  make(input: never, onApproval: never): Promise<unknown>;
  status(requestId: string): { done: boolean; stage: string } | null;
};

/** A path other than the maker made a cloud computer here (a brain's lane launch): "at least one". */
export function noteCloudComputerMade(): void {
  noteCloudComputerCount(1);
}

/** The brain's maker, with each finished make sent to the checks as "at least one". */
export function observeCloudComputerMakes<T extends CloudMakerLike | null>(maker: T): T {
  if (!maker) return maker;
  const noted = new Set<string>();
  const wrapped: CloudMakerLike = {
    ...maker,
    make: async (input: never, onApproval: never) => {
      const result = await maker.make(input, onApproval);
      noteCloudComputerCount(1);
      return result;
    },
    status: (requestId: string) => {
      const job = maker.status(requestId);
      if (job?.done && job.stage === "done" && !noted.has(requestId)) {
        noted.add(requestId);
        noteCloudComputerCount(1);
      }
      return job;
    },
  };
  return wrapped as T;
}

export type CloudComputerCheck = {
  /** True, false, or null when unknown. Reads at most once at a time, and only when the answer is old. */
  exists(): Promise<boolean | null>;
  /** Requests this check sent (for the numbers). */
  requestCount(): number;
  /** Stop listening for free news. */
  close(): void;
};

export function createCloudComputerCheck(args: {
  /** The account's cloud computers (not deleted, not failed), or null when they can't be read. */
  count: () => Promise<number | null>;
  /** The signed-in account: an answer never outlives it. */
  accountId: () => string | null;
  now?: () => number;
  logger?: { info?(event: string, data?: Record<string, unknown>): void };
}): CloudComputerCheck {
  const now = args.now ?? (() => Date.now());
  let known: { account: string; exists: boolean; atMs: number } | null = null;
  let failed: { account: string; atMs: number } | null = null;
  let read: Promise<void> | null = null;
  let requests = 0;

  const knownFor = (account: string) => (known?.account === account ? known : null);
  const fresh = (answer: NonNullable<typeof known>) =>
    now() - answer.atMs < (answer.exists ? CLOUD_COMPUTER_EXISTS_TTL_MS : CLOUD_COMPUTER_NONE_TTL_MS);

  const set = (account: string, count: number, source: "read" | "news") => {
    const exists = count > 0;
    const before = knownFor(account)?.exists;
    known = { account, exists, atMs: now() };
    failed = null;
    if (before !== exists) args.logger?.info?.("provider_login.cloud_computer_answer", { exists, source });
  };

  const listener: CountListener = (count) => {
    const account = args.accountId();
    if (account) set(account, count, "news");
  };
  countListeners.add(listener);

  async function readOnce(account: string): Promise<void> {
    requests += 1;
    let count: number | null = null;
    try {
      count = await args.count();
    } catch {
      count = null;
    }
    // The account changed while the read ran: its answer is not this account's.
    if (args.accountId() !== account) return;
    if (count == null) failed = { account, atMs: now() };
    else set(account, count, "read");
  }

  return {
    async exists() {
      const account = args.accountId();
      if (!account) return null;
      const answer = knownFor(account);
      if (answer && fresh(answer)) return answer.exists;
      const paused = failed?.account === account && now() - failed.atMs < CLOUD_COMPUTER_FAILED_PAUSE_MS;
      if (!paused) {
        read ??= readOnce(account).finally(() => {
          read = null;
        });
        await read;
      }
      // A failed read keeps the last answer of this account, even an old one.
      return knownFor(account)?.exists ?? null;
    },
    requestCount: () => requests,
    close: () => {
      countListeners.delete(listener);
    },
  };
}
