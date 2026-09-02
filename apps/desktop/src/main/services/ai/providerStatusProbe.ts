/**
 * What each CLI-backed provider actually is on this machine.
 *
 * Backs the `providers.status` machine RPC. Until this module existed, an
 * embedder asking "is Claude Code installed?" got an answer derived from the
 * model catalog: "this provider has models". That is also what an expired
 * login looks like, and what a runtime that has not finished its first catalog
 * poll looks like. Telling a user to reinstall a CLI they already have is a
 * support ticket, so this module reports what the runtime itself resolved —
 * the same executable path the chat adapters spawn — instead of inferring it.
 *
 * Three rules hold the design together:
 *
 * 1. **No new detection.** Every path comes from the resolver a provider's own
 *    runtime already uses (`resolveClaudeCodeExecutable`, `resolveCodexExecutable`,
 *    `resolveDroidExecutable`, `resolveOpenCodeBinaryPath`, `resolvePiInstallation`,
 *    the Cursor SDK loader). A second detection path would drift from the one
 *    that decides whether chat can start, and the status screen would then
 *    disagree with the product.
 *
 * 2. **This path never prompts and never blocks.** No macOS Keychain read
 *    (a Keychain read can put an unlock dialog in front of the user), no
 *    network. Spawns are bounded: `--version` at 5 s, and at most one
 *    last-resort `auth status` per provider per cache lifetime, also at 5 s.
 *    The whole report is capped at 8 s. A hung CLI yields nulls, never a hung
 *    RPC.
 *
 *    That last-resort spawn is a deliberate exception, added after a live
 *    machine reported `authenticated: false` for a Claude install that works
 *    every day: the token was in the Keychain, which this path will not read.
 *    Every cheaper rung runs first (see `providerAuthResolvers.ts`), and the spawn happens
 *    only when the CLI is installed and nothing else knows. Being silently
 *    wrong about a signed-in user is worse than one bounded process.
 *
 * 3. **A `fallback-command` resolution is not an install.** Those resolvers end
 *    with a bare command name (`"claude"`) so a spawn can still try PATH. That
 *    is a hope, not a finding, so this module downgrades it to
 *    `installed: false` unless a real PATH lookup (PATHEXT-aware on win32)
 *    confirms a file.
 *
 * Results are cached per provider for {@link PROVIDER_STATUS_CACHE_TTL_MS};
 * `refresh: true` bypasses the cache, which is what an embedder's "I just
 * installed it" button calls.
 *
 * The two per-provider tables live beside this file rather than in it:
 * `providerBinaryResolvers.ts` answers "where is it", `providerAuthResolvers.ts`
 * answers "is it signed in". Both are pure data plus per-provider closures, and
 * both reach the loop only through the resolver function types. The injection
 * seams and the bounded command runner they share are in
 * `providerProbeSeams.ts`, and the budgets and `detail` copy all four read are
 * in `providerStatusDetails.ts`.
 */

import fs from "node:fs";
import { resolveExecutableFromKnownLocations } from "./cliExecutableResolver";
import {
  REMEDIATION_PROVIDERS,
  resolveProviderRemediation,
} from "../../../shared/providerRemediation";
import type { ShippedProvider } from "../../../shared/providers";
import { DEFAULT_RESOLVERS } from "./providerBinaryResolvers";
import { DEFAULT_AUTH } from "./providerAuthResolvers";
import {
  PROVIDER_OUTPUT_CAP_BYTES,
  PROVIDER_STATUS_BUDGET_MS,
  PROVIDER_STATUS_CACHE_TTL_MS,
  PROVIDER_STATUS_DETAILS,
  PROVIDER_VERSION_TIMEOUT_MS,
} from "./providerStatusDetails";
import {
  defaultSpawn,
  defaultTerminateTree,
  isExecutableFile,
  probeVersion,
  defaultReadTextFile,
  type ChildProcessLike,
  type FsLike,
  type ProbeContext,
  type ProviderAuthMethod,
  type ProviderAuthResolver,
  type ProviderAuthResult,
  type ProviderBinaryResolver,
  type ResolvedProviderBinary,
  type SpawnLike,
  type TerminateTreeLike,
} from "./providerProbeSeams";
import { providerUnavailableReason } from "../../../shared/providerPlatformSupport";

/**
 * Re-exported because this module's own callers and tests read them.
 *
 * Not a general re-export shelf: a symbol nobody imports from here is a second
 * import path for one declaration, and a reader then cannot tell which module
 * owns it. Anything else comes from `providerStatusDetails` or
 * `providerProbeSeams` directly.
 */
export {
  PROVIDER_OUTPUT_CAP_BYTES,
  PROVIDER_STATUS_BUDGET_MS,
  PROVIDER_STATUS_CACHE_TTL_MS,
  PROVIDER_STATUS_DETAILS,
  PROVIDER_VERSION_TIMEOUT_MS,
};
export { cursorSdkPackageDir } from "./providerBinaryResolvers";
export type {
  ChildProcessLike,
  FsLike,
  ProviderAuthResolver,
  ProviderBinaryResolver,
  SpawnLike,
};

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

export type ProviderStatusRecord = {
  provider: ShippedProvider;
  displayName: string;
  /** A usable binary or package was found. Never inferred from the model catalog. */
  installed: boolean;
  /** Absolute path the runtime would spawn (or load). Null when nothing was found. */
  binaryPath: string | null;
  /** Verbatim first line of `--version`. Null when unknown, non-zero, or timed out. */
  version: string | null;
  /** Credentials this CLI can use were found on disk or in the environment. */
  authenticated: boolean;
  authMethod: ProviderAuthMethod | null;
  installCommand: string | null;
  loginCommand: string | null;
  docsUrl: string | null;
  source: "probed";
  /** True when this record came from the cache rather than from this call's probe. */
  stale: boolean;
  checkedAt: string;
  /** Human-readable note when the plain flags would mislead. */
  detail: string | null;
};

export type ProviderStatusReport = {
  checkedAt: string;
  providers: Record<string, ProviderStatusRecord>;
};

export type ProviderStatusProbeOptions = {
  /** Bypass the cache and re-probe every provider. */
  refresh?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Defaults to `process.arch`. Paired with `platform` by the availability gate. */
  arch?: NodeJS.Architecture;
  now?: () => number;
  spawn?: SpawnLike;
  fs?: FsLike;
  /** Per-provider overrides. Tests inject these; production uses the runtime's own resolvers. */
  resolvers?: Partial<Record<ShippedProvider, ProviderBinaryResolver>>;
  /** Per-provider credential overrides. */
  auth?: Partial<Record<ShippedProvider, ProviderAuthResolver>>;
  findOnPath?: (command: string, env: NodeJS.ProcessEnv) => string | null;
  readTextFile?: (target: string) => string | null;
  /** Overrides the process-tree kill a timeout runs. Tests assert on it. */
  terminateTree?: TerminateTreeLike;
  /** Use a caller-owned cache instead of the module's. Tests pass a fresh one. */
  cache?: ProviderStatusCache;
};

export type ProviderStatusCache = Map<ShippedProvider, { record: ProviderStatusRecord; checkedAtMs: number }>;



// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

const moduleCache: ProviderStatusCache = new Map();
let inflight: { refresh: boolean; promise: Promise<ProviderStatusReport> } | null = null;

/** Drop every cached record. Tests and an explicit "forget everything" call this. */
export function resetProviderStatusProbeForTests(): void {
  moduleCache.clear();
  inflight = null;
}

/** A record that claims nothing, for a provider whose probe never finished. */
/**
 * A record with nothing found yet: the remediation copy filled in, every
 * finding still false or null.
 *
 * Both the starting point for a real probe and the whole answer for one that
 * overran the budget. It used to be written out twice, as two complete
 * fourteen-field literals differing only in `detail`, so a field added to
 * `ProviderStatusRecord` had to be added to both and nothing caught a miss.
 */
function emptyRecord(
  provider: ShippedProvider,
  platform: NodeJS.Platform,
  checkedAt: string,
  detail: string | null,
): ProviderStatusRecord {
  const remediation = resolveProviderRemediation(provider, platform);
  return {
    provider,
    displayName: remediation.displayName,
    installed: false,
    binaryPath: null,
    version: null,
    authenticated: false,
    authMethod: null,
    installCommand: remediation.installCommand,
    loginCommand: remediation.loginCommand,
    docsUrl: remediation.docsUrl,
    source: "probed",
    stale: false,
    checkedAt,
    detail,
  };
}

function joinDetails(...parts: (string | null | undefined)[]): string | null {
  const kept = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(" ") : null;
}

async function withDeadline<T>(work: Promise<T>, deadlineMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(0, deadlineMs));
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeOne(
  provider: ShippedProvider,
  context: ProbeContext,
  now: () => number,
  resolvers: Record<ShippedProvider, ProviderBinaryResolver>,
  auth: Record<ShippedProvider, ProviderAuthResolver>,
): Promise<ProviderStatusRecord> {
  const checkedAt = new Date(now()).toISOString();
  const base = emptyRecord(provider, context.platform, checkedAt, null);

  let resolved: ResolvedProviderBinary;
  try {
    resolved = await resolvers[provider](context);
  } catch (error) {
    return {
      ...base,
      detail: PROVIDER_STATUS_DETAILS.detectionFailed(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }

  let binaryPath = resolved.path;
  let detail = resolved.detail ?? null;

  // A bare command name is the resolvers' last resort, not a finding. Only a
  // real PATH lookup promotes it to an install.
  if (!binaryPath && resolved.requiresPathConfirmation && resolved.command) {
    const found = context.findOnPath(resolved.command, context.env);
    if (found) {
      binaryPath = found;
    } else {
      detail = joinDetails(detail, PROVIDER_STATUS_DETAILS.notOnPath(resolved.command));
    }
  }

  const installed = binaryPath != null
    && (resolved.installedWithoutBinary === true || isExecutableFile(binaryPath, context));

  if (binaryPath && !installed && resolved.installedWithoutBinary !== true) {
    detail = joinDetails(detail, PROVIDER_STATUS_DETAILS.notExecutable(binaryPath));
  }

  let version = resolved.version ?? null;
  if (installed && binaryPath && !resolved.skipVersionProbe) {
    version = await probeVersion(binaryPath, context, PROVIDER_VERSION_TIMEOUT_MS);
  }

  let authResult: ProviderAuthResult = { authenticated: false, authMethod: null };
  try {
    authResult = await auth[provider](context, { installed, binaryPath: installed ? binaryPath : null });
  } catch {
    // An unreadable credential store is "cannot tell", not "signed out with
    // confidence" — the detail below is the only honest thing to say.
    authResult = {
      authenticated: false,
      authMethod: null,
      detail: PROVIDER_STATUS_DETAILS.credentialsUnreadable,
    };
  }

  return {
    ...base,
    installed,
    binaryPath: installed ? binaryPath : null,
    version,
    authenticated: authResult.authenticated,
    authMethod: authResult.authMethod,
    detail: joinDetails(detail, authResult.detail),
  };
}

async function runProbe(options: ProviderStatusProbeOptions): Promise<ProviderStatusReport> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? moduleCache;
  const context: ProbeContext = {
    env,
    platform,
    arch,
    fs: options.fs ?? fs,
    findOnPath: options.findOnPath
      ?? ((command, commandEnv) => resolveExecutableFromKnownLocations(command, commandEnv)?.path ?? null),
    // `node:child_process` is already loaded in any Electron main or brain
    // process, so there was nothing for a dynamic import to defer — it just ran
    // on every probe, inside an object literal, behind a double cast.
    spawn: options.spawn ?? defaultSpawn,
    readTextFile: options.readTextFile ?? defaultReadTextFile,
    terminateTree: options.terminateTree ?? defaultTerminateTree,
  };
  const resolvers = { ...DEFAULT_RESOLVERS, ...options.resolvers };
  const auth = { ...DEFAULT_AUTH, ...options.auth };

  const startedMs = now();
  const checkedAt = new Date(startedMs).toISOString();

  const settled = await Promise.allSettled(
    REMEDIATION_PROVIDERS.map(async (provider) => {
      // The availability gate comes before the cache and before any probe.
      // ADE hides Cursor on win32/arm64 because `@cursor/sdk` has no build
      // there, so offering an install command would send the user to install a
      // CLI ADE then refuses to load, with no reason given. The reason comes
      // from the gate rather than being named here, so the second gated
      // provider does not report Cursor's sentence; `docsUrl` is the only
      // remediation left either way.
      const unavailable = providerUnavailableReason(provider, platform, arch);
      if (unavailable !== null) {
        return {
          provider,
          record: {
            ...emptyRecord(provider, platform, checkedAt, unavailable),
            installCommand: null,
          },
        };
      }
      const cached = cache.get(provider);
      if (!options.refresh && cached && startedMs - cached.checkedAtMs < PROVIDER_STATUS_CACHE_TTL_MS) {
        return { provider, record: { ...cached.record, stale: true } };
      }
      // A provider that overruns the budget falls back to its last known
      // record when there is one (marked stale, which is what it is) and to an
      // empty "did not finish" record otherwise. Reporting nothing at all
      // would let one hung CLI erase five healthy ones from the report.
      const fallback: ProviderStatusRecord = cached
        ? { ...cached.record, stale: true }
        : emptyRecord(provider, platform, checkedAt, PROVIDER_STATUS_DETAILS.budgetExceeded);
      // The deadline is measured from the RUN's start, not from this probe's.
      // The constant says "the whole report may not outlive this", and a
      // per-probe timer only honored that because the six probes happen to run
      // concurrently — make one sequential and the report's real cap silently
      // became six times the number written here.
      const record = await withDeadline(
        probeOne(provider, context, now, resolvers, auth),
        startedMs + PROVIDER_STATUS_BUDGET_MS - now(),
        fallback,
      );
      // Identity, not a flag: only a record this call actually produced may be
      // cached. Caching a "did not finish" placeholder would make one slow
      // probe the answer for the next minute.
      if (record !== fallback) {
        cache.set(provider, { record, checkedAtMs: now() });
      }
      return { provider, record };
    }),
  );

  const providers: Record<string, ProviderStatusRecord> = {};
  for (const entry of settled) {
    if (entry.status !== "fulfilled") continue;
    providers[entry.value.provider] = entry.value.record;
  }
  return { checkedAt, providers };
}

/**
 * Report every provider's install, version, and sign-in state.
 *
 * Concurrent callers share one probe: a setup screen that mounts three cards
 * must not spawn three `--version` processes per provider. `refresh: true`
 * never joins a non-refresh run, because the whole point of the refresh button
 * is to not be served the answer the user just disproved.
 */
export async function probeProviderStatuses(
  options: ProviderStatusProbeOptions = {},
): Promise<ProviderStatusReport> {
  const refresh = options.refresh === true;
  if (inflight && (inflight.refresh || !refresh)) {
    return await inflight.promise;
  }
  const promise = runProbe({ ...options, refresh }).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { refresh, promise };
  return await promise;
}
