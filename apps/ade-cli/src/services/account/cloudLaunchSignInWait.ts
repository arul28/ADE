/**
 * A server launch's wait for its chat's provider sign-in (C8), on the cloud
 * computer: whether the provider can run here, and the wait that shows the
 * person what to do until it can. `cloudBootLaunch.ts` runs it before the
 * chat starts.
 */

import type {
  CloudLaunchSignIn,
  CloudLaunchStage,
  CloudRemoteSignInStatus,
} from "../../../../account-directory/src/cloud/contract";
import {
  CLOUD_LAUNCH_SIGN_IN_TIMED_OUT,
  cloudRemoteSignInOf,
  cloudRemoteSignInRefusal,
  cloudRemoteSignInRuns,
} from "../../../../account-directory/src/cloud/contract";
import type { DetectedAuth } from "../../../../desktop/src/main/services/ai/authDetector";
import { cloudSignInSpec } from "../../../../desktop/src/shared/cloudSignIns";
import type { CloudBootLaunchDeps, ReportStages } from "./cloudBootLaunch";

/** How long a launch waits for its provider's sign-in; the server ends it a little later (`SIGN_IN_WAIT_MS` in launches.ts). */
export const SIGN_IN_WAIT_MS = 30 * 60_000;
/** How often the wait reads the sign-in's progress (local: the runner and the provider's status). */
const SIGN_IN_POLL_MS = 5_000;
/** How often the wait pulls the account vault and reads the launch (a cancel ends the wait). */
const SIGN_IN_REFRESH_MS = 30_000;
/** A sign-in that failed (a code that expired) is started again this many times. */
const SIGN_IN_RESTARTS = 5;
/** The stage row the wait shows. */
export const SIGN_IN_STAGE = "sign_in";

export type ProviderReadiness = "ready" | "missing" | "unknown";
/** `fresh` drops the cached sign-in reads first; the wait asks for it once, not on every poll. */
export type ProviderReady = (provider: string, options?: { fresh?: boolean }) => Promise<ProviderReadiness>;
type DetectAuth = (options: { force: boolean; skipCliAuthProbe: true }) => Promise<DetectedAuth[]>;

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
 */
export function createProviderReady(detectAuth: DetectAuth, env: NodeJS.ProcessEnv = process.env): ProviderReady {
  return async (provider, options) => {
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

export type SignInWait = { kind: "ready"; waited: boolean } | { kind: "failed"; error: string } | { kind: "cancelled" };

/** What the launch shows while it waits: the provider's own sign-in, a key to save, or ADE desktop. */
function signInOf(provider: string, started: CloudRemoteSignInStatus | null, startError: string | null): CloudLaunchSignIn {
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
  };
}

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
): Promise<SignInWait> {
  const { launchId, logger } = deps;
  const providerReady = deps.providerReady;
  if (!providerReady) return { kind: "ready", waited: false };
  // A read that fails: the first one goes on (as `unknown`), a later one keeps waiting.
  const readiness = async (fresh: boolean): Promise<ProviderReadiness> => await providerReady(provider, { fresh }).catch((error: unknown) => {
    logger.warn("cloud_boot_launch.provider_ready_failed", { launchId, provider, error: errorText(error) });
    return fresh ? "unknown" : "missing";
  });
  if (await readiness(true) !== "missing") return { kind: "ready", waited: false };
  const row = cloudRemoteSignInOf(provider);
  const remoteSignIn = row && cloudRemoteSignInRuns(row) ? deps.remoteSignIn : undefined;
  const start = async (): Promise<CloudLaunchSignIn> => {
    if (!remoteSignIn) return signInOf(provider, null, null);
    try {
      return signInOf(provider, await remoteSignIn.start(provider), null);
    } catch (error) {
      logger.warn("cloud_boot_launch.sign_in_start_failed", { launchId, provider, error: errorText(error) });
      return signInOf(provider, null, errorText(error).slice(0, 300));
    }
  };
  let signIn = await start();
  let shown = "";
  // Counted as shown only once the report landed, so a lost one is sent again.
  const show = async () => {
    const shape = JSON.stringify(signIn);
    if (shape === shown) return;
    const landed = await report({
      state: "waiting_for_sign_in",
      stages: [...stages, { id: SIGN_IN_STAGE, status: "running", detail: signIn.label }],
      signIn,
    });
    if (landed) shown = shape;
  };
  logger.info("cloud_boot_launch.waiting_for_sign_in", { launchId, provider, kind: signIn.kind });
  await show();
  const deadline = Date.now() + SIGN_IN_WAIT_MS;
  let restarts = 0;
  let nextRefresh = Date.now() + SIGN_IN_REFRESH_MS;
  while (Date.now() < deadline) {
    await sleep(SIGN_IN_POLL_MS);
    if (signIn.jobId && remoteSignIn) {
      const status = await remoteSignIn.status(signIn.jobId).catch((error: unknown) => {
        logger.warn("cloud_boot_launch.sign_in_status_failed", { launchId, provider, error: errorText(error) });
        return null;
      });
      if (status?.state === "failed" && restarts < SIGN_IN_RESTARTS) {
        restarts += 1;
        signIn = await start();
      } else if (status) {
        signIn = { ...signIn, url: status.url ?? signIn.url, userCode: status.userCode ?? signIn.userCode, needsPastedCode: status.needsPastedCode, reason: status.reason };
      }
      await show();
    }
    if (Date.now() >= nextRefresh) {
      nextRefresh = Date.now() + SIGN_IN_REFRESH_MS;
      // A key or a desktop sign-in has no job to poll: a report that didn't land goes again here.
      if (!signIn.jobId) await show();
      await deps.refreshVault?.().catch((error: unknown) => logger.warn("cloud_boot_launch.vault_refresh_failed", { launchId, error: errorText(error) }));
      const record = await deps.api()?.launchStatus(launchId).catch((error: unknown) => {
        logger.warn("cloud_boot_launch.sign_in_launch_read_failed", { launchId, error: errorText(error) });
        return null;
      });
      if (record?.state === "cancelled") return { kind: "cancelled" };
    }
    if (await readiness(false) !== "missing") {
      logger.info("cloud_boot_launch.signed_in", { launchId, provider });
      await report({ state: "joined", stages: [...stages, { id: SIGN_IN_STAGE, status: "done", detail: signIn.label }] });
      return { kind: "ready", waited: true };
    }
  }
  // The server's own timeout error: its cleanup then deletes this unused computer.
  logger.info("cloud_boot_launch.sign_in_timed_out", { launchId, provider });
  return { kind: "failed", error: CLOUD_LAUNCH_SIGN_IN_TIMED_OUT };
}
