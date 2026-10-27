import type { GitHubPrSnapshot, OpenProjectBinding, PrListConditionalReply, PrSummary } from "../../shared/types";

type InFlightEntry<T> = {
  promise: Promise<T>;
};

const prListInFlight = new Map<string, InFlightEntry<PrSummary[]>>();
const githubSnapshotInFlight = new Map<string, InFlightEntry<GitHubPrSnapshot>>();
const prRefreshInFlight = new Map<string, InFlightEntry<PrSummary[]>>();
const prSurfaceWarmInFlight = new Map<string, InFlightEntry<void>>();
const linkedPrRefreshInFlight = new Map<string, InFlightEntry<PrSummary | null>>();
const linkedPrRecentRefresh = new Map<string, { refreshedAt: number; result: PrSummary | null }>();
const machineReconcileRequestedAt = new Map<string, number>();

export const LINKED_PR_LIVE_REFRESH_COOLDOWN_MS = 5_000;

/**
 * Cache scope for a PR read.
 *
 * A pinned read resolves against the lane's own machine, so two reads that
 * differ only by pin are reads of two different databases and must never share
 * an in-flight entry — the pin is part of the key, and takes precedence over
 * the project root (a pin already names a project on its machine).
 */
function projectKey(
  projectRoot: string | null | undefined,
  pin?: OpenProjectBinding | null,
): string {
  if (pin?.key) return `pin:${pin.key}`;
  return projectRoot?.trim() || "active";
}

/**
 * The scope of an unpinned GitHub snapshot read.
 *
 * `getGitHubSnapshot` takes no pin, so the read follows the machine this
 * window's project tab is bound to — the same path on two machines is two
 * different credential stores and two different databases. The root alone
 * cannot say which one a memoized refusal came from, so the caller also names
 * the window's binding: one machine's "no GitHub credential" must never answer
 * the other machine's reads. It is an argument, not a store read, so the key
 * is a function of what the caller asked for.
 */
function snapshotReadScopeKey(
  projectRoot: string | null | undefined,
  bindingKey: string | null | undefined,
): string {
  return JSON.stringify([projectKey(projectRoot), bindingKey ?? null]);
}

function summaryFreshness(summary: PrSummary): number {
  const updatedAt = Date.parse(summary.updatedAt || "");
  const lastSyncedAt = Date.parse(summary.lastSyncedAt || "");
  return Math.max(Number.isFinite(updatedAt) ? updatedAt : 0, Number.isFinite(lastSyncedAt) ? lastSyncedAt : 0);
}

function freshestLinkedPr(current: PrSummary, recent: PrSummary | null): PrSummary | null {
  if (!recent) return null;
  return summaryFreshness(current) > summaryFreshness(recent) ? current : recent;
}

function coalesceInFlight<T>(
  cache: Map<string, InFlightEntry<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing.promise;

  let promise: Promise<T>;
  promise = load().finally(() => {
    if (cache.get(key)?.promise === promise) {
      cache.delete(key);
    }
  });
  cache.set(key, { promise });
  return promise;
}

export function listPrsCoalesced(options?: {
  projectRoot?: string | null;
  pin?: OpenProjectBinding | null;
}): Promise<PrSummary[]> {
  return coalesceInFlight(
    prListInFlight,
    projectKey(options?.projectRoot, options?.pin),
    () => window.ade.prs.listAll(options?.pin ?? null),
  );
}

/**
 * The project's PR list, kept for a short while per machine. A chat's header
 * and the Work tools both read it to find one lane's PRs, on every chat switch;
 * on a large remote project that list is half a megabyte, re-downloaded each
 * time. A surface that hears a PR event drops the entry first
 * (`invalidatePrListCache`), so a change still shows at once while it is open.
 */
const PR_LIST_TTL_MS = 30_000;
const prListSettled = new Map<string, { value: PrSummary[]; at: number; signature: string | null; stale?: boolean }>();
/**
 * Bumped by `invalidatePrListCache`. A read started before a PR event neither
 * answers a read started after it nor writes its older list back.
 */
const prListGeneration = new Map<string, number>();

/**
 * The settled list's scope. A pin names its machine; an unpinned read goes to
 * the machine this window's tab is bound to, so the binding is part of the key
 * (the same root on two machines is two databases).
 */
function prListKey(options?: PrListCacheOptions): string {
  if (options?.pin?.key) return projectKey(null, options.pin);
  return JSON.stringify([projectKey(options?.projectRoot), options?.bindingKey ?? null]);
}

type PrListCacheOptions = {
  projectRoot?: string | null;
  pin?: OpenProjectBinding | null;
  /** The window's `projectBinding.key`, for an unpinned read. */
  bindingKey?: string | null;
};
const prListRevalidateInFlight = new Map<string, InFlightEntry<PrSummary[]>>();

function isConditionalPrListReply(value: unknown): value is PrListConditionalReply {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { signature?: unknown }).signature === "string";
}

/**
 * One read of the list that can come back "unchanged". A machine's brain that
 * knows `conditional` answers with a signature (and nothing else when it
 * matches the one held); an older one, the web client and the local IPC path
 * answer with the bare list, which is always taken whole.
 */
function readPrListConditional(
  key: string,
  held: { value: PrSummary[]; signature: string | null } | undefined,
  pin: OpenProjectBinding | null,
): Promise<PrSummary[]> {
  const prs = window.ade.prs;
  const listAllConditional = prs.listAllConditional;
  const generation = prListGeneration.get(key) ?? 0;
  const flightKey = `${generation}:${key}`;
  if (typeof listAllConditional !== "function") {
    return coalesceInFlight(prListInFlight, flightKey, () => prs.listAll(pin));
  }
  const settle = (value: PrSummary[], signature: string | null) => {
    if ((prListGeneration.get(key) ?? 0) !== generation) return;
    prListSettled.set(key, { value, at: Date.now(), signature });
  };
  return coalesceInFlight(prListRevalidateInFlight, flightKey, async () => {
    const reply = await listAllConditional(held?.signature ?? null, pin);
    if (Array.isArray(reply)) {
      settle(reply, null);
      return reply;
    }
    if (!isConditionalPrListReply(reply)) throw new Error("Unexpected PR list reply.");
    if (reply.notModified && held) {
      settle(held.value, reply.signature);
      return held.value;
    }
    const value = reply.prs ?? [];
    settle(value, reply.signature);
    return value;
  });
}

export function listPrsCached(options?: PrListCacheOptions): Promise<PrSummary[]> {
  const key = prListKey(options);
  const settled = prListSettled.get(key);
  if (settled && !settled.stale && Date.now() - settled.at < PR_LIST_TTL_MS) return Promise.resolve(settled.value);
  // Past its time (or dropped by a PR event): ask whether it changed. An
  // unchanged list costs a signature, not the whole list again.
  return readPrListConditional(key, settled, options?.pin ?? null);
}

export function invalidatePrListCache(options?: PrListCacheOptions): void {
  // Keep the list and its signature for the conditional re-read; only its
  // freshness goes, and any read already under way is superseded.
  const key = prListKey(options);
  prListGeneration.set(key, (prListGeneration.get(key) ?? 0) + 1);
  const entry = prListSettled.get(key);
  if (entry) entry.stale = true;
}

export function getGitHubSnapshotCoalesced(
  args: {
    force?: boolean;
    includeExternalClosed?: boolean;
    historyPageLimit?: number;
    /**
     * Set by timers, polling reactions, and visibility effects — anything that
     * is not a person asking. A forced snapshot from a person may retry GitHub
     * while it is rate-limiting us; an automatic one must not.
     */
    automaticRefresh?: boolean;
  } = {},
  options?: {
    projectRoot?: string | null;
    /** The window's `projectBinding.key`: the read follows it (see `snapshotReadScopeKey`). */
    bindingKey?: string | null;
  },
): Promise<GitHubPrSnapshot> {
  const scopeKey = snapshotReadScopeKey(options?.projectRoot, options?.bindingKey);
  // A machine with no GitHub sign-in (a fresh Linux box is the usual one)
  // answers every snapshot read with the same refusal, and every PR event
  // here used to ask it again over the relay. Remember that answer briefly;
  // a forced read (a person asking) always goes through.
  const remembered = githubSnapshotAuthRefusals.get(scopeKey);
  if (!args.force && remembered && Date.now() - remembered.at < GITHUB_SNAPSHOT_AUTH_REFUSAL_TTL_MS) {
    return Promise.reject(remembered.error);
  }
  return coalesceInFlight(
    githubSnapshotInFlight,
    JSON.stringify({
      scope: scopeKey,
      force: args.force === true,
      automaticRefresh: args.automaticRefresh === true,
      includeExternalClosed: args.includeExternalClosed === true,
      historyPageLimit: args.historyPageLimit ?? null,
    }),
    () => window.ade.prs.getGitHubSnapshot(args).then(
      (snapshot) => {
        githubSnapshotAuthRefusals.delete(scopeKey);
        return snapshot;
      },
      (error: unknown) => {
        if (GITHUB_SNAPSHOT_AUTH_REFUSAL.test(error instanceof Error ? error.message : String(error))) {
          githubSnapshotAuthRefusals.set(scopeKey, { at: Date.now(), error });
        }
        throw error;
      },
    ),
  );
}

const GITHUB_SNAPSHOT_AUTH_REFUSAL_TTL_MS = 60_000;
/** The prService sentences for "this machine has no usable GitHub credential". */
const GITHUB_SNAPSHOT_AUTH_REFUSAL = /GitHub auth missing|GitHub token could not be decrypted|GitHub auth is invalid/i;
const githubSnapshotAuthRefusals = new Map<string, { at: number; error: unknown }>();

export function refreshPrsCoalesced(
  args: { prId?: string; prIds?: string[] } = {},
  options?: { projectRoot?: string | null; pin?: OpenProjectBinding | null },
): Promise<PrSummary[]> {
  const prIds = args.prIds?.filter(Boolean).sort() ?? [];
  return coalesceInFlight(
    prRefreshInFlight,
    JSON.stringify({
      projectRoot: projectKey(options?.projectRoot, options?.pin),
      prId: args.prId ?? null,
      prIds,
    }),
    () => window.ade.prs.refresh(args, options?.pin ?? null),
  );
}

export function refreshLinkedPrCoalesced(
  pr: PrSummary,
  options?: {
    projectRoot?: string | null;
    pin?: OpenProjectBinding | null;
    force?: boolean;
    cooldownMs?: number;
  },
): Promise<PrSummary | null> {
  const prId = String(pr.id ?? "").trim();
  if (!prId) return Promise.resolve(null);

  const key = JSON.stringify({
    projectRoot: projectKey(options?.projectRoot, options?.pin),
    prId,
  });
  const cooldownMs = Math.max(0, options?.cooldownMs ?? LINKED_PR_LIVE_REFRESH_COOLDOWN_MS);
  const recent = linkedPrRecentRefresh.get(key);
  if (!options?.force && recent && Date.now() - recent.refreshedAt < cooldownMs) {
    return Promise.resolve(freshestLinkedPr(pr, recent.result));
  }

  return coalesceInFlight(
    linkedPrRefreshInFlight,
    key,
    async () => {
      try {
        const refreshed = await refreshPrsCoalesced(
          { prIds: [prId] },
          { projectRoot: options?.projectRoot, pin: options?.pin },
        );
        const result = refreshed.find((next) => next.id === prId) ?? null;
        linkedPrRecentRefresh.set(key, { refreshedAt: Date.now(), result });
        return result;
      } catch (error) {
        linkedPrRecentRefresh.set(key, { refreshedAt: Date.now(), result: pr });
        throw error;
      }
    },
  );
}

export function warmPrSurfaceCoalesced(options?: {
  projectRoot?: string | null;
  /** The window's `projectBinding.key`, as for `getGitHubSnapshotCoalesced`. */
  bindingKey?: string | null;
  includeGithubSnapshot?: boolean;
  forceGithubSnapshot?: boolean;
}): Promise<void> {
  const rootKey = projectKey(options?.projectRoot);
  return coalesceInFlight(
    prSurfaceWarmInFlight,
    JSON.stringify({
      projectRoot: rootKey,
      bindingKey: options?.bindingKey ?? null,
      includeGithubSnapshot: options?.includeGithubSnapshot !== false,
      forceGithubSnapshot: options?.forceGithubSnapshot === true,
    }),
    async () => {
      const tasks: Array<Promise<unknown>> = [
        refreshPrsCoalesced({}, { projectRoot: options?.projectRoot }).catch(() => null),
      ];
      if (options?.includeGithubSnapshot !== false) {
        tasks.push(
          getGitHubSnapshotCoalesced(
            { force: options?.forceGithubSnapshot === true },
            { projectRoot: options?.projectRoot, bindingKey: options?.bindingKey },
          ).catch(() => null),
        );
      }
      await Promise.all(tasks);
    },
  );
}

export const MACHINE_PR_RECONCILE_COOLDOWN_MS = 60_000;

/**
 * Ask another machine's brain for its focus catch-up reconcile.
 *
 * That reconcile is what maps a PR an agent opened with `gh pr create` to its
 * lane. Main runs it on window focus only for a project open on this computer,
 * so a chat whose lane lives on another machine asks here. The brain throttles
 * it as well; this cooldown only keeps every header mount and refocus from
 * paying a round trip.
 */
export function requestMachinePrReconcile(
  projectRoot: string | null | undefined,
  pin?: OpenProjectBinding | null,
): void {
  const reconcile = window.ade?.prs?.reconcileOnFocus;
  if (typeof reconcile !== "function") return;
  const key = projectKey(projectRoot, pin);
  const now = Date.now();
  const last = machineReconcileRequestedAt.get(key);
  if (last != null && now - last < MACHINE_PR_RECONCILE_COOLDOWN_MS) return;
  machineReconcileRequestedAt.set(key, now);
  void reconcile(pin ?? null).catch(() => {
    // best-effort; the next focus asks again once the cooldown passes
  });
}

export function clearPrReadInFlightForTest(): void {
  prListInFlight.clear();
  prListSettled.clear();
  prListRevalidateInFlight.clear();
  prListGeneration.clear();
  githubSnapshotInFlight.clear();
  prRefreshInFlight.clear();
  prSurfaceWarmInFlight.clear();
  linkedPrRefreshInFlight.clear();
  linkedPrRecentRefresh.clear();
  machineReconcileRequestedAt.clear();
}
