/**
 * `ade providers status`: every provider ADE runs, and whether it can start on
 * this machine (or `--machine`): signed in, needs a sign-in, not installed, or
 * unknown, each with the deeplink that opens its Settings page to sign in.
 *
 * Read from `ai.getStatus`, the status Settings shows. That read never starts
 * an agent, a provider CLI, an SDK process or a login: it reads saved logins
 * from disk, and its cache serves repeat reads. A provider whose login ADE
 * cannot read without a process (an OS keychain that did not answer) is
 * "unknown", never guessed.
 */
import { CHAT_PROVIDER_IDS } from "../../desktop/src/shared/types/chat";
import { buildDeeplink } from "../../desktop/src/shared/deeplinks";
import { settingsEntryById } from "../../desktop/src/shared/settingsManifest";

export type ProviderSignInState = "signed_in" | "needs_sign_in" | "not_installed" | "unknown";

export type ProviderSignInRow = {
  provider: string;
  label: string;
  state: ProviderSignInState;
  /** One short sentence: why, when ADE knows. */
  detail: string | null;
  /** The signed-in account, when the provider records one locally. */
  account: string | null;
  /** Opens the provider's Settings page (sign in there). Null when ADE has no page for it. */
  signInLink: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function signInLinkFor(provider: string): string | null {
  const entryId = `agents.provider.${provider}`;
  return settingsEntryById(entryId) ? buildDeeplink({ kind: "settings", entryId }) : null;
}

/** One CLI-backed provider's row, from its `providerConnections` arm. */
function connectionState(connection: Record<string, unknown>): { state: ProviderSignInState; detail: string | null } {
  const signIn = connection.signInState;
  const installed = connection.runtimeDetected === true
    || connection.runtimeAvailable === true
    || connection.runtimeDownloadPending === true;
  const blocker = text(connection.blocker);
  // An older brain has no `signInState`: `authAvailable` is its answer.
  if (signIn === "signed-in" || (signIn === undefined && connection.authAvailable === true)) {
    return { state: "signed_in", detail: connection.runtimeDownloadPending === true ? blocker : null };
  }
  if (!installed) return { state: "not_installed", detail: blocker };
  if (signIn === "signed-out" || (signIn === undefined && connection.authAvailable === false)) {
    return { state: "needs_sign_in", detail: blocker };
  }
  return { state: "unknown", detail: blocker ?? "ADE can't tell from the saved login (a keychain that did not answer, say)." };
}

/** OpenCode keeps its own provider logins; `opencodeProviders` lists them. */
function openCodeState(status: Record<string, unknown>): { state: ProviderSignInState; detail: string | null } {
  if (status.opencodeBinaryInstalled === false || status.opencodeBinarySource === "missing") {
    return { state: "not_installed", detail: text(status.opencodeInventoryError) };
  }
  if (!Array.isArray(status.opencodeProviders)) {
    return { state: "unknown", detail: text(status.opencodeInventoryError) ?? "OpenCode's provider list was not read yet." };
  }
  const providers = status.opencodeProviders.filter(isRecord);
  const signedIn = providers.filter((provider) => provider.signedIn === true || provider.credentialSource != null);
  if (signedIn.length > 0) {
    return { state: "signed_in", detail: `Through ${signedIn.map((provider) => text(provider.name) ?? text(provider.id)).filter(Boolean).join(", ")}.` };
  }
  const free = providers.some((provider) => provider.connected === true);
  return {
    state: "needs_sign_in",
    detail: free ? "No OpenCode login or key: only its free models run." : "No OpenCode login or key.",
  };
}

/** Every provider of `CHAT_PROVIDER_IDS`, from an `ai.getStatus` answer. A provider the answer leaves out is unknown. */
export function providerSignInRows(status: unknown): ProviderSignInRow[] {
  const record = isRecord(status) ? status : {};
  const connections = isRecord(record.providerConnections) ? record.providerConnections : {};
  return CHAT_PROVIDER_IDS.map((provider) => {
    const connection = isRecord(connections[provider]) ? connections[provider] as Record<string, unknown> : null;
    const { state, detail } = provider === "opencode"
      ? openCodeState(record)
      : connection
        ? connectionState(connection)
        : { state: "unknown" as const, detail: "This machine's ADE does not report this provider (an older version)." };
    return {
      provider,
      label: settingsEntryById(`agents.provider.${provider}`)?.label ?? provider,
      state,
      detail,
      account: connection ? text(connection.accountEmail) : null,
      signInLink: signInLinkFor(provider),
    };
  });
}

const STATE_WORDS: Record<ProviderSignInState, string> = {
  signed_in: "signed in",
  needs_sign_in: "needs sign-in",
  not_installed: "not installed",
  unknown: "unknown",
};

/** `--text`: one line per provider, the link on the rows a person has to act on. */
export function formatProviderSignIns(value: unknown, machineName: string | null): string {
  const rows = isRecord(value) && Array.isArray(value.providers) ? value.providers.filter(isRecord) : [];
  const lines = rows.map((row) => {
    const state = STATE_WORDS[row.state as ProviderSignInState] ?? String(row.state);
    const account = text(row.account) ? ` (${text(row.account)})` : "";
    const detail = text(row.detail) ? `  ${text(row.detail)}` : "";
    const link = row.state !== "signed_in" && text(row.signInLink) ? `  ${text(row.signInLink)}` : "";
    return `${String(row.label).padEnd(16)} ${state}${account}${detail}${link}`;
  });
  const where = machineName ? `on ${machineName}` : "on this machine";
  const needs = rows.filter((row) => row.state === "needs_sign_in").length;
  return [
    `Providers ${where}:`,
    ...lines,
    needs > 0
      ? "A link opens that provider's page in ADE Settings (pick the machine there when it is not this one); the person signs in there."
      : "",
  ].filter(Boolean).join("\n");
}
