import type { AiProviderConnectionStatus, AiSettingsStatus } from "../../../shared/types";
import { ACP_PROVIDER_METADATA } from "../../../shared/acpProviderMetadata";
import { PROVIDER_DISPLAY_NAME } from "../../../shared/providers";
import { cursorProviderAvailable } from "../../lib/platform";
import type { SettingsProviderId } from "../settings/providers/types";

/**
 * Every coding agent ADE runs, as the first-run cards show them: the welcome
 * card's row of marks and the tiles on "Connect your agents".
 *
 * Same ids as Settings › Agents & Models (`SettingsProviderId`).
 * The status rules below mirror the Settings descriptors (`descriptors.tsx`,
 * `acpProviders.tsx`) without importing them: those pull the whole Settings
 * page into the launch path, and this card only needs "connected or not".
 */

/** How a provider signs in from setup, before any project is open. */
export type FirstRunSignIn =
  /** The machine-level account sheet Settings uses (Claude Code, Codex). */
  | "account"
  /** Cursor's own browser login. */
  | "cursor"
  /** A terminal login or a key: needs Settings, which opens after setup. */
  | "settings";

export type FirstRunAgent = {
  id: SettingsProviderId;
  label: string;
  /** The `ProviderLogo` family for its mark. */
  logo: string;
  signIn: FirstRunSignIn;
};

// Keyed by id so a provider added to Settings and missing here fails to
// compile; the key order is the order the cards show them in.
const AGENTS: Record<SettingsProviderId, Omit<FirstRunAgent, "id">> = {
  claude: { label: "Claude Code", logo: "claude", signIn: "account" },
  codex: { label: "Codex", logo: "codex", signIn: "account" },
  cursor: { label: "Cursor", logo: "cursor", signIn: "cursor" },
  copilot: { label: "GitHub Copilot", logo: "github-copilot", signIn: "settings" },
  opencode: { label: "OpenCode", logo: "opencode", signIn: "settings" },
  droid: { label: "Droid", logo: "droid", signIn: "settings" },
  antigravity: { label: ACP_PROVIDER_METADATA.antigravity.label, logo: "antigravity", signIn: "settings" },
  devin: { label: ACP_PROVIDER_METADATA.devin.label, logo: "devin", signIn: "settings" },
  grok: { label: ACP_PROVIDER_METADATA.grok.label, logo: "grok", signIn: "settings" },
  kimi: { label: ACP_PROVIDER_METADATA.kimi.label, logo: "kimi", signIn: "settings" },
  qwen: { label: ACP_PROVIDER_METADATA.qwen.label, logo: "qwen", signIn: "settings" },
  muse: { label: PROVIDER_DISPLAY_NAME.muse, logo: "muse", signIn: "settings" },
  pi: { label: "Pi", logo: "pi", signIn: "settings" },
};

const ALL_AGENTS: readonly FirstRunAgent[] = (Object.keys(AGENTS) as SettingsProviderId[])
  .map((id) => ({ id, ...AGENTS[id] }));

/** The agents this computer can run, in the order the cards show them. */
export function firstRunAgents(): readonly FirstRunAgent[] {
  // Cursor's SDK has no build for some platforms (Windows on ARM); Settings hides it there too.
  return cursorProviderAvailable() ? ALL_AGENTS : ALL_AGENTS.filter((agent) => agent.id !== "cursor");
}

export type FirstRunAgentState = "checking" | "connected" | "sign-in" | "later";

export type FirstRunAgentStatus = {
  state: FirstRunAgentState;
  /** One short line: the account when connected, what is missing otherwise. */
  detail: string;
};

function accountLine(connection: AiProviderConnectionStatus | null | undefined): string | null {
  const parts = [connection?.accountPlan, connection?.accountEmail].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return parts.length ? parts.join(" · ") : null;
}

function notConnected(agent: FirstRunAgent, connection: AiProviderConnectionStatus | null): FirstRunAgentStatus {
  if (agent.signIn !== "settings") {
    // The tile's own "Sign in" button says what to do; the line only says where it stands.
    return { state: "sign-in", detail: "Not signed in" };
  }
  // Settings' "Sign in required" versus "Not downloaded", in plain words.
  const detected = connection?.runtimeDetected === true || connection?.authAvailable === true;
  return { state: "later", detail: detected ? "Not signed in yet" : "Not set up yet" };
}

/**
 * One agent's status, by the Settings tiles' rules: Claude by its SDK binary
 * and auth, Muse by runtime and sign-in, OpenCode by its own binary and
 * catalog, everyone else by their connection row's `runtimeAvailable` — plus
 * the model picker's `availableProviders` flag for any of them.
 */
export function firstRunAgentStatus(
  agent: FirstRunAgent,
  status: AiSettingsStatus | null,
  failed: boolean,
): FirstRunAgentStatus {
  if (!status) {
    // A failed read still offers sign-in; only a read in flight is "Checking".
    return failed ? notConnected(agent, null) : { state: "checking", detail: "Checking…" };
  }
  const connection = agent.id === "opencode" ? null : status.providerConnections?.[agent.id] ?? null;
  // The model picker's own "can run here" flag. Setup asks one question — can
  // this agent chat now? — so a provider ADE already offers models for counts
  // as connected even where Settings still wants more (Cursor signed in with
  // OAuth but no verified API key).
  //
  // Before any project is open the status comes from the machine-level
  // fallback, which never probes a runtime, so `runtimeAvailable` can read
  // false for an installed, signed-in agent. ADE's own copy present plus a
  // saved sign-in is the honest "ready" here.
  const runnable = (status.availableProviders as Partial<Record<string, unknown>> | undefined)?.[agent.id] === true
    || (connection?.runtimeDetected === true && connection.authAvailable === true);
  switch (agent.id) {
    case "claude": {
      const claude = status.availableProviders?.claude;
      if (claude?.binary.present && claude.auth.ready) {
        return { state: "connected", detail: accountLine(connection) ?? "Ready on this computer" };
      }
      return notConnected(agent, connection);
    }
    case "opencode": {
      if (status.opencodeBinaryInstalled === false || status.opencodeInventoryError) {
        return { state: "later", detail: "Not set up yet" };
      }
      // Settings calls an installed OpenCode connected: its free models work with no key.
      const signedIn = (status.opencodeProviders ?? []).filter((provider) => provider.signedIn).length;
      return {
        state: "connected",
        detail: signedIn ? `${signedIn} provider${signedIn === 1 ? "" : "s"} signed in` : "Free models",
      };
    }
    case "muse":
      if ((connection?.runtimeAvailable && connection.authAvailable) || runnable) {
        return { state: "connected", detail: accountLine(connection) ?? "Ready on this computer" };
      }
      return notConnected(agent, connection);
    default:
      if (connection?.runtimeAvailable || runnable) {
        return { state: "connected", detail: accountLine(connection) ?? "Ready on this computer" };
      }
      return notConnected(agent, connection);
  }
}
