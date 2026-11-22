/**
 * The one-provider sign-in check (`ai.verifyProviderSignIn`): each provider's
 * own live check, within `PROVIDER_SIGN_IN_CHECK_LIMIT_MS`. Settings runs it
 * right after a sign-in and on Re-check, never on a timer. A timeout or an
 * error reads "unknown". The status caches drop afterwards, so the next
 * status read shows the verdict.
 *
 * `aiIntegrationService` builds one per project service and hands it the
 * parts of its own state the checks read (the Copilot probe, Pi's inventory,
 * OpenCode's provider list, its status caches).
 */
import type { Logger } from "../logging/logger";
import type { AiProviderSignInCheck, AiProviderSignInState, OpenCodeProviderSummary } from "../../../shared/types";
import { ACP_PROVIDER_IDS } from "../../../shared/acpProviderMetadata";
import { AcpProbeLimitError, probeAcpProviderAuth } from "./acpAuthProbe";
import { checkCliSignInLive, savedCliSignInPresent, verifyProviderApiKey, type DetectedAuth } from "./authDetector";
import { getCursorSdkAuthSnapshot } from "./cursorSdkAuth";
import { inspectMuseCredentials } from "./museAuth";
import { resolvePiInstallation, type PiInstallation, type PiProfileInventory } from "./piInstallation";
import type { CopilotSdkAuthProbe } from "./providerConnectionStatus";
import { isRuntimeHealthProvider, noteProviderLoginChanged, noteProviderModelsChanged } from "./providerLoginChanged";
import { getProviderRuntimeHealth, reportProviderRuntimeAuthFailure, reportProviderRuntimeReady } from "./providerRuntimeHealth";

/**
 * The longest a one-provider sign-in check may take. A check that has not
 * answered by then reads "unknown"; the person is watching the button.
 */
const PROVIDER_SIGN_IN_CHECK_LIMIT_MS = 20_000;

/**
 * The check running now for each provider, across every project's service:
 * the process it starts is per machine. A second Re-check (another window,
 * the CLI) waits for that answer instead of starting the agent again.
 */
const providerSignInChecksInFlight = new Map<string, Promise<AiProviderSignInCheck>>();

type SignInVerdict = { state: AiProviderSignInState; reason: string | null; account?: string | null };

export type ProviderSignInCheckDeps = {
  projectRoot: string;
  logger: Logger;
  detectAuth: () => Promise<DetectedAuth[]>;
  /** Copilot's live auth status through its SDK (the service's probe). */
  copilotAuthStatus: (auth: DetectedAuth[], options: { limitMs: number }) => Promise<CopilotSdkAuthProbe>;
  /** Why the last Copilot probe gave no answer, for an "unknown" verdict. */
  lastCopilotProbeFailure: () => string | null;
  /** Pi's inventory read now, past its failure backoff (the check is a person's press). */
  refreshPiInventoryNow: (installation: PiInstallation) => Promise<PiProfileInventory>;
  /** OpenCode's provider list, asked of its server. */
  readOpenCodeProviders: () => Promise<{ opencodeProviders?: OpenCodeProviderSummary[]; opencodeInventoryError?: string | null }>;
  /** Drop the service's status caches. */
  dropStatusCaches: () => void;
};

export function createProviderSignInCheck(deps: ProviderSignInCheckDeps) {
  const { logger } = deps;

  /** The live check for one provider. Runs inside `verifyProviderSignIn`'s limit. */
  const checkProviderSignIn = async (provider: string): Promise<SignInVerdict> => {
    switch (provider) {
      case "claude":
      case "codex": {
        const verdict = await checkCliSignInLive(provider);
        // What the CLI says now replaces what an older chat reported.
        if (verdict.state === "signed-in") reportProviderRuntimeReady(provider);
        if (verdict.state === "signed-out") reportProviderRuntimeAuthFailure(provider, verdict.reason ?? "Not signed in.");
        return verdict;
      }
      case "droid":
        return checkCliSignInLive("droid");
      case "cursor": {
        const auth = await deps.detectAuth();
        const keyEntry = auth.find(
          (entry): entry is Extract<DetectedAuth, { type: "api-key" }> => entry.type === "api-key" && entry.provider === "cursor",
        );
        if (!keyEntry) return { state: "signed-out", reason: null };
        const verification = await verifyProviderApiKey("cursor", keyEntry.key);
        if (verification.ok) {
          reportProviderRuntimeReady("cursor");
          const snapshot = await getCursorSdkAuthSnapshot().catch(() => null);
          return { state: "signed-in", reason: null, account: snapshot?.email ?? null };
        }
        if (verification.statusCode === 401 || verification.statusCode === 403) {
          reportProviderRuntimeAuthFailure("cursor", verification.message);
          return { state: "signed-out", reason: "Cursor turned down the saved key." };
        }
        return { state: "unknown", reason: verification.message || "Cursor did not answer." };
      }
      case "copilot": {
        const probe = await deps.copilotAuthStatus(await deps.detectAuth(), { limitMs: PROVIDER_SIGN_IN_CHECK_LIMIT_MS });
        if (probe.runtime.source === "fallback-command") {
          return { state: "unknown", reason: "ADE's copy of Copilot is not on this computer yet, so it could not check." };
        }
        if (!probe.auth) return { state: "unknown", reason: deps.lastCopilotProbeFailure() ?? "Copilot did not answer." };
        if (probe.auth.isAuthenticated) {
          reportProviderRuntimeReady("copilot");
          return { state: "signed-in", reason: null, account: probe.auth.login ?? null };
        }
        reportProviderRuntimeAuthFailure("copilot", probe.auth.statusMessage ?? "Not signed in.");
        return { state: "signed-out", reason: probe.auth.statusMessage ?? null };
      }
      case "muse": {
        // Muse has no sign-in check short of a chat, so this reads what it saved.
        if (inspectMuseCredentials().source != null) return { state: "signed-in", reason: null };
        if (process.platform === "darwin") {
          return { state: "unknown", reason: "Muse keeps its sign-in in the macOS Keychain. Your first chat confirms it." };
        }
        return { state: "signed-out", reason: null };
      }
      case "pi": {
        const installation = resolvePiInstallation();
        if (!installation.sdkAvailable) return { state: "unknown", reason: installation.blocker ?? "Pi is not ready on this computer." };
        const inventory = await deps.refreshPiInventoryNow(installation);
        const signedIn = inventory.providers.some((entry) => entry.configured && entry.authType !== "local");
        return signedIn
          ? { state: "signed-in", reason: null }
          : { state: "signed-out", reason: "Pi has no provider with a key or a sign-in." };
      }
      case "opencode": {
        const status = await deps.readOpenCodeProviders();
        // `connected` alone can be free models; a login or key is `signedIn`.
        const signedIn = (status.opencodeProviders ?? []).filter((entry) => entry.signedIn ?? entry.connected);
        if (signedIn.length > 0) return { state: "signed-in", reason: null };
        if (status.opencodeInventoryError) return { state: "unknown", reason: status.opencodeInventoryError };
        return { state: "signed-out", reason: "OpenCode has no provider signed in." };
      }
      default: {
        if (!(ACP_PROVIDER_IDS as readonly string[]).includes(provider)) {
          return { state: "unknown", reason: `ADE has no sign-in check for ${provider}.` };
        }
        const acpProvider = provider as (typeof ACP_PROVIDER_IDS)[number];
        try {
          const result = await probeAcpProviderAuth({
            provider: acpProvider,
            cwd: deps.projectRoot,
            logger,
            force: true,
            limitMs: PROVIDER_SIGN_IN_CHECK_LIMIT_MS,
          });
          if (result.state === "ready") return { state: "signed-in", reason: null };
          if (result.state === "auth-failed") return { state: "signed-out", reason: result.message ?? null };
          return { state: "unknown", reason: result.message ?? "The agent did not start." };
        } catch (error) {
          if (error instanceof AcpProbeLimitError) return { state: "unknown", reason: error.message };
          throw error;
        }
      }
    }
  };

  /**
   * Whether the status read showed `provider` signed in before a check: what
   * a chat or the last check proved, else the saved sign-in on disk. A
   * Re-check that finds the same answer then starts no model list read.
   */
  const signedInBeforeCheck = async (provider: string): Promise<boolean> => {
    if (isRuntimeHealthProvider(provider)) {
      const health = getProviderRuntimeHealth(provider)?.state;
      if (health === "ready") return true;
      if (health === "auth-failed") return false;
    }
    return savedCliSignInPresent(provider).catch(() => false);
  };

  const runProviderSignInCheck = async (provider: string): Promise<AiProviderSignInCheck> => {
    // Read before the caches drop: what the status showed as signed in.
    const signedInBefore = provider ? await signedInBeforeCheck(provider) : false;
    // A check runs after a sign-in or on Re-check, often after a sign-in ADE
    // did not see (a terminal). Either way the login may have changed: drop
    // every cached answer about it, an old chat's verdict included, before
    // asking again. The model lists stay until the answer says it changed.
    if (provider) noteProviderLoginChanged(provider, { refreshModels: false });
    let verdict: SignInVerdict;
    let limitTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      verdict = await Promise.race([
        checkProviderSignIn(provider),
        new Promise<SignInVerdict>((resolve) => {
          limitTimer = setTimeout(() => resolve({
            state: "unknown",
            reason: `The check did not finish in ${Math.round(PROVIDER_SIGN_IN_CHECK_LIMIT_MS / 1000)} seconds.`,
          }), PROVIDER_SIGN_IN_CHECK_LIMIT_MS);
        }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("ai.provider_sign_in_check_failed", { provider, error: message });
      verdict = { state: "unknown", reason: message || "The check failed." };
    } finally {
      if (limitTimer) clearTimeout(limitTimer);
    }
    logger.info("ai.provider_sign_in_check", { provider, state: verdict.state });
    // Newly signed in: possibly another account, so list its models again.
    // Pi's check is its inventory read, and OpenCode's is its provider list,
    // so both already hold the new answer.
    if (verdict.state === "signed-in" && !signedInBefore && provider !== "pi" && provider !== "opencode") {
      noteProviderModelsChanged(provider);
    }
    deps.dropStatusCaches();
    return {
      provider,
      state: verdict.state,
      reason: verdict.reason,
      account: verdict.account ?? null,
      checkedAt: new Date().toISOString(),
    };
  };

  /** One check per provider at a time, machine-wide; a second caller gets the same answer. */
  const verifyProviderSignIn = async (rawProvider: string): Promise<AiProviderSignInCheck> => {
    const provider = String(rawProvider ?? "").trim().toLowerCase();
    const running = provider ? providerSignInChecksInFlight.get(provider) : undefined;
    if (running) {
      const result = await running;
      // The check may have run under another project's service.
      deps.dropStatusCaches();
      return result;
    }
    const run = runProviderSignInCheck(provider);
    if (provider) providerSignInChecksInFlight.set(provider, run);
    try {
      return await run;
    } finally {
      if (providerSignInChecksInFlight.get(provider) === run) providerSignInChecksInFlight.delete(provider);
    }
  };

  return { verifyProviderSignIn };
}
