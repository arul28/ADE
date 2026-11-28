/**
 * A server launch's wait for its chat's provider sign-in (C8), on the cloud
 * computer: whether the provider can run here, and the wait that shows the
 * person what to do until it can. `cloudBootLaunch.ts` runs it before the
 * chat starts.
 */

import type {
  CloudLaunchRecord,
  CloudLaunchSignIn,
  CloudLaunchStage,
  CloudRemoteSignInStatus,
} from "../../../../account-directory/src/cloud/contract";
import {
  CLOUD_LAUNCH_SIGN_IN_TIMED_OUT,
  CLOUD_SIGN_IN_CODE_EXPIRED,
  CLOUD_SIGN_IN_CODE_REFUSED,
  CLOUD_SIGN_IN_LINK_CHANGED,
  CLOUD_SIGN_IN_WAIT_MS,
  cloudRemoteSignInOf,
  cloudRemoteSignInRefusal,
  cloudRemoteSignInRuns,
} from "../../../../account-directory/src/cloud/contract";
import type { DetectedAuth } from "../../../../desktop/src/main/services/ai/authDetector";
import { cloudSignInSpec } from "../../../../desktop/src/shared/cloudSignIns";
import { isFreeModelId } from "../../../../desktop/src/shared/freeModels";
import type { CloudBootLaunchDeps, ReportStages } from "./cloudBootLaunch";

/**
 * How long a wait lasts unless the launch's request says otherwise (a cloud
 * Mac: `cloudSignInWaitMsFor`). The server ends the launch at its `expiresAt`
 * plus a grace (`failUnjoinedLaunches`).
 */
export const SIGN_IN_WAIT_MS = CLOUD_SIGN_IN_WAIT_MS;
/** How often the wait reads the sign-in's progress (local: the runner and the provider's status). */
const SIGN_IN_POLL_MS = 5_000;
/** How often the wait pulls the account vault and reads the launch (a cancel ends the wait). */
const SIGN_IN_REFRESH_MS = 30_000;
/** A sign-in that failed (a code that expired) is started again this many times. */
const SIGN_IN_RESTARTS = 5;
/** The stage row the wait shows. */
export const SIGN_IN_STAGE = "sign_in";

export type ProviderReadiness = "ready" | "missing" | "unknown";
/**
 * `fresh` drops the cached sign-in reads first; the wait asks for it once, not on every poll.
 * `model` is the chat's model: a free one (OpenCode Zen's, or an ADE Free Model) needs no sign-in.
 */
export type ProviderReady = (provider: string, options?: { fresh?: boolean; model?: string | null }) => Promise<ProviderReadiness>;
type DetectAuth = (options: { force: boolean; skipCliAuthProbe: true }) => Promise<DetectedAuth[]>;
/**
 * Each agent CLI's sign-in as read from disk and the environment, whether
 * DAEX's copy of the CLI is here yet or still to be downloaded on first use
 * (`detectCliAuthStatuses`, and Muse's own read). `verified` only when the
 * read is sure (a key).
 */
export type ReadCliSignIns = (options: { force: boolean }) => Promise<Array<{ cli: string; authenticated: boolean; verified: boolean }>>;
/**
 * The agent CLIs whose sign-in a disk read sees with no CLI installed: a new
 * cloud computer downloads them at the first turn, so before that their
 * signed-out state reads `missing` here, not `unknown`.
 */
const CLI_SIGN_IN_PROVIDERS: ReadonlySet<string> = new Set(["copilot", "grok", "kimi", "muse", "droid", "devin", "qwen"]);

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Codex's default account's config home, where its sign-in (a remote one too) is saved; null when unreadable. */
async function defaultCodexHome(): Promise<string | null> {
  try {
    const { getMachineProviderInstanceStore } = await import("../providerInstances/providerInstanceStore");
    return getMachineProviderInstanceStore().getDefault("codex").configHome;
  } catch {
    // The base home (`CODEX_HOME` or ~/.codex) is read instead.
    return null;
  }
}

/**
 * Whether a chat's provider can run on this computer, read with no CLI
 * started: the key the account vault put in the environment, a Claude pass
 * of the account (added at each spawn, never in this env), Claude's and
 * Codex's saved sign-in on disk, the OpenRouter key for OpenCode and Pi,
 * Cursor's key. For the other CLIs, a status read only guesses "signed in"
 * (it never runs the CLI), so that reads as `unknown`, never `ready`.
 * OpenCode on a free model is ready with no key: Zen's free models need none,
 * and an ADE Free Model runs on the computer's ADE account.
 */
export function createProviderReady(detectAuth: DetectAuth, env: NodeJS.ProcessEnv = process.env, readCliSignIns?: ReadCliSignIns): ProviderReady {
  return async (provider, options) => {
    if (provider === "opencode" && isFreeModelId(options?.model)) return "ready";
    const row = cloudRemoteSignInOf(provider);
    const spec = row?.accountSignIn ? cloudSignInSpec(row.accountSignIn) : null;
    if (spec && env[spec.env]?.trim()) return "ready";
    if (provider === "claude") {
      const { claudePassSignedInHere } = await import("../../../../desktop/src/main/services/claudePass/claudePassLaunch");
      if (claudePassSignedInHere()) return "ready";
    }
    if (provider === "claude" || provider === "codex") {
      const codexHome = provider === "codex" ? await defaultCodexHome() : null;
      const { savedSignInPresent } = await import("../../../../desktop/src/main/services/ai/providerConnectionStatus");
      return (await savedSignInPresent(provider, codexHome ? { ...env, CODEX_HOME: codexHome } : env)) ? "ready" : "missing";
    }
    // An agent CLI not downloaded yet: its sign-in on disk (a shared one, a saved key) still reads.
    // Signed in, a guess is `unknown` (the chat goes on); nothing at all is `missing` (the step shows).
    if (readCliSignIns && CLI_SIGN_IN_PROVIDERS.has(provider)) {
      const status = (await readCliSignIns({ force: options?.fresh === true })).find((entry) => entry.cli === provider);
      if (status) return !status.authenticated ? "missing" : status.verified ? "ready" : "unknown";
    }
    const auth = await detectAuth({ force: options?.fresh === true, skipCliAuthProbe: true });
    // OpenCode and Pi read an OpenRouter key, and the other model keys too.
    if (row?.accountSignIn === "openrouter") {
      return auth.some((entry) => entry.type === "api-key" || entry.type === "openrouter") ? "ready" : "missing";
    }
    if (provider === "cursor") {
      return auth.some((entry) => entry.type === "api-key" && /cursor/i.test(entry.provider)) ? "ready" : "missing";
    }
    const cli = auth.find((entry) => entry.type === "cli-subscription" && entry.cli === provider);
    if (cli?.type !== "cli-subscription") return "unknown";
    if (!cli.authenticated) return "missing";
    return cli.verified ? "ready" : "unknown";
  };
}

export type SignInWait =
  | { kind: "ready"; waited: boolean }
  /** The person moved the chat to a DAEX Free Model from the step (`POST .../free-model`): it starts on that. */
  | { kind: "switched"; provider: string; model: string }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" };

/** What the launch shows while it waits: the provider's own sign-in, a key to save, or ADE desktop. */
function signInOf(provider: string, started: CloudRemoteSignInStatus | null, startError: string | null, expiresAt: number | null = null): CloudLaunchSignIn {
  const row = cloudRemoteSignInOf(provider);
  const kind = row?.remoteSignIn ?? "desktop";
  return {
    provider: row?.provider ?? provider,
    label: row?.label ?? provider,
    kind,
    jobId: started?.jobId ?? null,
    url: started?.url ?? null,
    userCode: started?.userCode ?? null,
    needsPastedCode: started?.needsPastedCode === true,
    signInId: row?.accountSignIn ?? null,
    reason: startError ?? started?.reason ?? (row && !cloudRemoteSignInRuns(row) ? cloudRemoteSignInRefusal(row) : null),
    ...(expiresAt != null ? { expiresAt } : {}),
  };
}

/**
 * Why a sign-in started again, for the step: a device code the provider let
 * expire, a code the provider refused, or a link that ended some other way.
 */
function restartReasonOf(kind: CloudLaunchSignIn["kind"], status: CloudRemoteSignInStatus): string {
  if (kind === "device") return CLOUD_SIGN_IN_CODE_EXPIRED;
  return status.codeSent || status.verdict === "refused" ? CLOUD_SIGN_IN_CODE_REFUSED : CLOUD_SIGN_IN_LINK_CHANGED;
}

/** What the wait needs from the brain: the readiness read, the provider's own sign-in, and the vault pull. */
export type SignInWaitDeps = Pick<CloudBootLaunchDeps, "logger" | "providerReady" | "remoteSignIn" | "refreshVault">;

/**
 * Where a wait shows itself. A launch reports stage rows; a queued chat
 * message reports `waiting_for_sign_in` on the message.
 */
export type SignInWaitHooks = {
  /** Shows the sign-in; true once the report landed (a lost one is sent again). */
  show: (signIn: CloudLaunchSignIn) => Promise<boolean>;
  /** The provider can run now. */
  ready?: (signIn: CloudLaunchSignIn) => Promise<void>;
  /** How long this wait lasts (`cloudSignInWaitMsFor` of the launch's request); `SIGN_IN_WAIT_MS` when left out. */
  waitMs?: number;
  /** Read at each refresh: true ends the wait (a cancelled launch). */
  isCancelled?: () => Promise<boolean>;
  /** Read right after `isCancelled`: the person moved the chat to a DAEX Free Model, so the wait ends with it. */
  switchedTo?: () => { provider: string; model: string } | null;
  /** Names the wait in log lines (a launch id or a message id). Never chat text. */
  logMeta: Record<string, unknown>;
};

/**
 * Holds the launch until the chat's provider can run here: reports
 * `waiting_for_sign_in` with what the person does, follows the sign-in (a
 * failed one, like a code that expired, starts again), pulls the vault for
 * a key or a pass saved on another screen, and ends once the provider is no
 * longer `missing`, on a cancel, or at `SIGN_IN_WAIT_MS`. A provider that is
 * ready (or unknown) doesn't wait.
 */
export async function waitForProviderSignIn(
  deps: CloudBootLaunchDeps,
  provider: string,
  report: ReportStages,
  stages: CloudLaunchStage[],
  sleep: (ms: number) => Promise<void>,
  model?: string | null,
  waitMs: number = SIGN_IN_WAIT_MS,
): Promise<SignInWait> {
  const { launchId, logger } = deps;
  // The launch as last read for a cancel: it also says whether the chat moved to a free model.
  let latest: CloudLaunchRecord | null = null;
  return await waitForSignIn(deps, provider, {
    show: async (signIn) => await report({
      state: "waiting_for_sign_in",
      stages: [...stages, { id: SIGN_IN_STAGE, status: "running", detail: signIn.label }],
      signIn,
    }),
    ready: async (signIn) => {
      await report({ state: "joined", stages: [...stages, { id: SIGN_IN_STAGE, status: "done", detail: signIn.label }] });
    },
    isCancelled: async () => {
      const record = await deps.api()?.launchStatus(launchId).catch((error: unknown) => {
        logger.warn("cloud_boot_launch.sign_in_launch_read_failed", { launchId, error: errorText(error) });
        return null;
      });
      if (record) latest = record;
      return record?.state === "cancelled";
    },
    switchedTo: () => {
      const chat = latest?.request?.chat;
      // Only a move to a free model, and only away from what this wait started with.
      if (!chat || chat.provider !== "opencode" || !isFreeModelId(chat.modelId)) return null;
      if (provider === "opencode" && isFreeModelId(model)) return null;
      return { provider: chat.provider, model: chat.modelId };
    },
    logMeta: { launchId },
    waitMs,
  }, sleep, model);
}

/** The wait itself, for a launch or a queued chat message (`SignInWaitHooks`). */
export async function waitForSignIn(
  deps: SignInWaitDeps,
  provider: string,
  hooks: SignInWaitHooks,
  sleep: (ms: number) => Promise<void>,
  /** The chat's model: a free one needs no sign-in (`createProviderReady`). */
  model?: string | null,
): Promise<SignInWait> {
  const { logger } = deps;
  const meta = hooks.logMeta;
  const providerReady = deps.providerReady;
  if (!providerReady) return { kind: "ready", waited: false };
  // A read that fails: the first one goes on (as `unknown`), a later one keeps waiting.
  const readiness = async (fresh: boolean): Promise<ProviderReadiness> => await providerReady(provider, { fresh, model }).catch((error: unknown) => {
    logger.warn("cloud_boot_launch.provider_ready_failed", { ...meta, provider, error: errorText(error) });
    return fresh ? "unknown" : "missing";
  });
  if (await readiness(true) !== "missing") return { kind: "ready", waited: false };
  const row = cloudRemoteSignInOf(provider);
  const remoteSignIn = row && cloudRemoteSignInRuns(row) ? deps.remoteSignIn : undefined;
  // One deadline from the start, shown on the step, so the person knows how long they have.
  const deadline = Date.now() + (hooks.waitMs ?? SIGN_IN_WAIT_MS);
  // Why the last restart happened: kept on the step until a new code goes or the next restart.
  let carried: string | null = null;
  // A start that threw (the runner wasn't ready): tried again at each refresh, a few times.
  let startFailed = false;
  let startRetries = 0;
  const start = async (): Promise<CloudLaunchSignIn> => {
    startFailed = false;
    if (!remoteSignIn) return signInOf(provider, null, null, deadline);
    try {
      // One link for the whole wait: the runner lives until the wait's own end.
      const started = signInOf(provider, await remoteSignIn.start(provider, { timeoutMs: Math.max(60_000, deadline - Date.now()) }), null, deadline);
      return carried && !started.reason ? { ...started, reason: carried } : started;
    } catch (error) {
      startFailed = true;
      logger.warn("cloud_boot_launch.sign_in_start_failed", { ...meta, provider, error: errorText(error) });
      return signInOf(provider, null, errorText(error).slice(0, 300), deadline);
    }
  };
  let signIn = await start();
  let shown = "";
  // Counted as shown only once the report landed, so a lost one is sent again.
  const show = async () => {
    const shape = JSON.stringify(signIn);
    if (shape === shown) return;
    if (await hooks.show(signIn)) shown = shape;
  };
  logger.info("cloud_boot_launch.waiting_for_sign_in", { ...meta, provider, kind: signIn.kind });
  await show();
  // The provider's sign-in this wait started ends with it, whatever ended the wait.
  const stopSignIn = async () => {
    if (!signIn.jobId || !remoteSignIn?.cancel) return;
    await remoteSignIn.cancel(signIn.jobId).catch((error: unknown) => logger.warn("cloud_boot_launch.sign_in_cancel_failed", { ...meta, provider, error: errorText(error) }));
  };
  let restarts = 0;
  let nextRefresh = Date.now() + SIGN_IN_REFRESH_MS;
  while (Date.now() < deadline) {
    await sleep(SIGN_IN_POLL_MS);
    if (signIn.jobId && remoteSignIn) {
      const status = await remoteSignIn.status(signIn.jobId).catch((error: unknown) => {
        logger.warn("cloud_boot_launch.sign_in_status_failed", { ...meta, provider, error: errorText(error) });
        return null;
      });
      if (status?.state === "failed" && restarts < SIGN_IN_RESTARTS) {
        restarts += 1;
        // The new link comes with why: the person never pastes into a page that changed without a word.
        carried = restartReasonOf(signIn.kind, status);
        logger.info("cloud_boot_launch.sign_in_restarted", { ...meta, provider, why: carried === CLOUD_SIGN_IN_CODE_REFUSED ? "code_refused" : carried === CLOUD_SIGN_IN_CODE_EXPIRED ? "code_expired" : "link_changed" });
        signIn = await start();
      } else if (status) {
        // A code sent on the new link: the change sentence has done its work.
        if (status.codeSent) carried = null;
        signIn = { ...signIn, url: status.url ?? signIn.url, userCode: status.userCode ?? signIn.userCode, needsPastedCode: status.needsPastedCode, reason: status.reason ?? carried };
      }
      await show();
    }
    if (Date.now() >= nextRefresh) {
      nextRefresh = Date.now() + SIGN_IN_REFRESH_MS;
      if (startFailed && startRetries < SIGN_IN_RESTARTS) {
        startRetries += 1;
        signIn = await start();
      }
      // A key or a desktop sign-in has no job to poll: a report that didn't land goes again here.
      if (!signIn.jobId) await show();
      await deps.refreshVault?.().catch((error: unknown) => logger.warn("cloud_boot_launch.vault_refresh_failed", { ...meta, error: errorText(error) }));
      if (await hooks.isCancelled?.()) {
        await stopSignIn();
        return { kind: "cancelled" };
      }
      const switched = hooks.switchedTo?.() ?? null;
      if (switched) {
        logger.info("cloud_boot_launch.sign_in_switched_to_free_model", { ...meta, provider });
        await stopSignIn();
        await hooks.ready?.(signIn);
        return { kind: "switched", ...switched };
      }
    }
    if (await readiness(false) !== "missing") {
      logger.info("cloud_boot_launch.signed_in", { ...meta, provider });
      await stopSignIn();
      await hooks.ready?.(signIn);
      return { kind: "ready", waited: true };
    }
  }
  // The server's own timeout error: its cleanup then deletes this unused computer.
  logger.info("cloud_boot_launch.sign_in_timed_out", { ...meta, provider });
  await stopSignIn();
  return { kind: "failed", error: CLOUD_LAUNCH_SIGN_IN_TIMED_OUT };
}
