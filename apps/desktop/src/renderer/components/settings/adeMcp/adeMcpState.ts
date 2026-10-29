/**
 * What the ADE MCP page says about each computer and about the account as a
 * whole, read from the true serving state each computer reports (never just
 * "online", which a computer that refuses every call also is).
 */
import {
  REMOTE_MCP_KNOWN_APP_LABELS,
  type RemoteMcpConnectionSummary,
  type RemoteMcpKnownApp,
  type RemoteMcpMachine,
  type RemoteMcpNotServingReason,
  type RemoteMcpStatus,
  type RemoteMcpVaultHealth,
} from "../../../../shared/types/remoteMcp";
import type { IntegrationFact, IntegrationTone } from "../integrations/IntegrationChrome";

export type MachineState = {
  tone: IntegrationTone;
  /** A short state: "Answering", "Left out". */
  label: string;
  /** One plain sentence: why, and what to do when there is something to do. */
  detail: string;
};

const REASON: Record<RemoteMcpNotServingReason, (machine: RemoteMcpMachine) => MachineState> = {
  off_for_account: () => ({ tone: "neutral", label: "Off", detail: "ADE MCP is off for your account." }),
  left_out: () => ({ tone: "neutral", label: "Left out", detail: "Apps can't reach it. Turn it on to include it." }),
  signed_out: (machine) => ({
    tone: "warn",
    label: "Signed out",
    detail: machine.isThisMachine
      ? "This computer is signed out of your ADE account. Sign in to include it."
      : "It's signed out of your ADE account. Sign in on it to include it.",
  }),
  relay_disconnected: (machine) => ({
    tone: "warn",
    label: "Not connected",
    detail: machine.isThisMachine
      ? "This computer isn't connected to ADE Relay, so apps can't reach it. It answers again once it reconnects."
      : "It isn't connected to ADE Relay, so apps can't reach it. It answers again once it reconnects.",
  }),
  account_vault_unreachable: (machine) => ({
    tone: "crit",
    label: "Account sync failing",
    detail: machine.isThisMachine
      ? "This computer's account sync is failing, so it hasn't received ADE MCP's settings."
      : "Its account sync is failing, so it hasn't received ADE MCP's settings. Open ADE on it to see why.",
  }),
  waiting_for_account_secret: () => ({
    tone: "warn",
    label: "Getting ready",
    detail: "Waiting for ADE MCP's settings to sync to it. This usually takes under a minute.",
  }),
  older_ade: () => ({ tone: "warn", label: "Needs an update", detail: "It runs an older ADE that can't answer. Update ADE on it." }),
  offline: () => ({ tone: "neutral", label: "Offline", detail: "Apps reach it again when it's back online." }),
};

/** The true state of one computer, from what it last reported. */
export function machineState(machine: RemoteMcpMachine): MachineState {
  if (machine.serving) {
    return {
      tone: "ok",
      label: "Answering",
      detail: machine.isThisMachine ? "Apps reach this computer through your account's address." : "Apps reach it through your account's address.",
    };
  }
  if (machine.notServingReason) return REASON[machine.notServingReason](machine);
  // A brain from before the reasons were reported: say only what is known.
  if (!machine.supported) return REASON.older_ade(machine);
  if (!machine.included) return REASON.left_out(machine);
  if (machine.online === false) return REASON.offline(machine);
  return { tone: "warn", label: "Not answering", detail: "It's on your account but isn't answering calls yet." };
}

export type OverallState = { tone: IntegrationTone; label: string };

/** One honest line for the whole account: how many included computers answer. */
export function overallState(status: RemoteMcpStatus | null, loading: boolean): OverallState {
  if (!status) return loading ? { tone: "checking", label: "Checking…" } : { tone: "neutral", label: "Couldn't check" };
  if (!status.signedIn) return { tone: "off", label: "Needs your ADE account" };
  if (!status.enabled) return { tone: "off", label: "Off" };
  if (!status.serverUrl) return { tone: "warn", label: "Setting up your address…" };
  const included = status.machines.filter((machine) => machine.included);
  const answering = included.filter((machine) => machine.serving).length;
  if (!included.length) return { tone: "warn", label: "No computers included" };
  if (answering === 0) return { tone: "crit", label: included.length === 1 ? "Your computer isn't answering" : `None of ${included.length} computers answering` };
  if (answering === included.length) {
    return { tone: "ok", label: included.length === 1 ? "1 computer answering" : `All ${included.length} computers answering` };
  }
  return { tone: "warn", label: `${answering} of ${included.length} computers answering` };
}

/** What the hero panel says while there is no server URL to show. */
export function heroPanelNote(status: RemoteMcpStatus | null): string {
  if (!status) return "Checking…";
  if (!status.signedIn) return "ADE MCP needs your ADE account. Apps sign in through it.";
  if (status.enabled) return "ADE is setting up your account's address.";
  return "Turn it on to get your account's address.";
}

const VAULT_STATE_LABEL: Record<Exclude<RemoteMcpVaultHealth["state"], "ok">, string> = {
  failing: "Failing",
  unavailable: "Unavailable",
};

/** The hero's account-sync fact: up to date and when, or what is wrong. */
export function vaultFact(vault: RemoteMcpVaultHealth): IntegrationFact {
  const ago = agoText(vault.lastSyncedAt);
  return {
    label: "Account sync",
    value: vault.state === "ok" ? (ago ? `Up to date · ${ago}` : "Up to date") : VAULT_STATE_LABEL[vault.state],
    title: vault.lastSyncedAt ? `Last synced ${new Date(vault.lastSyncedAt).toLocaleString()}` : undefined,
    tone: vault.state === "ok" ? undefined : "warn",
  };
}

/** "4 min ago", "3 h ago", or a date. */
export function agoText(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}

/** Where a known app signs in from, when that reads better than its name. */
const SIGN_IN_PLACE: Partial<Record<RemoteMcpKnownApp, string>> = { claude: "claude.ai", grok: "grok.com", chatgpt: "ChatGPT" };

/**
 * How a connection connected: the app it signed in from, or which token it
 * is. Only an app ADE recognised (`app`, from the redirect address it used)
 * is named by ADE's own label, since some sign in through another app's
 * client (Grok Bot uses Cursor's redirect host). Any other app shows its real
 * redirect host, never a name taken from the label it registered.
 */
export function connectionHow(connection: RemoteMcpConnectionSummary): string {
  if (connection.kind === "token") return `Token …${connection.tokenHint}`;
  if (connection.app) return `Signed in from ${SIGN_IN_PLACE[connection.app] ?? REMOTE_MCP_KNOWN_APP_LABELS[connection.app]}`;
  return connection.redirectHost ? `Signed in from ${connection.redirectHost}` : "Signed in";
}
