import type { PendingInputRequest } from "./types/chat";

/**
 * The connect card: an agent that needs an integration which is not set up
 * yet asks the person to connect it, in the chat, without leaving it.
 *
 * It rides the same pending-input machinery as the private secret card
 * (`requestChatInput` → `respondToInput`), so every client that can answer a
 * question can answer it. A key or token travels only as the answer to an
 * `isSecret` question, which the transcript writer drops outright. The host
 * saves it into the integration itself, on the machine that runs the chat,
 * and hands the agent only the outcome.
 *
 * A browser or device sign-in is the one method that is not a question: the
 * card runs it and then answers with the method alone, and the host checks the
 * integration really is connected before the card closes.
 *
 * One record per provider describes everything the card draws. A new provider
 * is one record here plus one status/save pair in the host.
 */

export type ConnectProviderId = "github" | "linear" | "jira" | "agent37";

export const CONNECT_PROVIDER_IDS: readonly ConnectProviderId[] = ["github", "linear", "jira", "agent37"];

export function isConnectProviderId(value: unknown): value is ConnectProviderId {
  return value === "github" || value === "linear" || value === "jira" || value === "agent37";
}

/** `providerMetadata` key on the card. Its presence makes the card user-only. */
export const INTEGRATION_CONNECT_METADATA_KEY = "integrationConnectRequest" as const;

/** Which way of connecting the person used. Always asked, so any client can answer. */
export const CONNECT_METHOD_QUESTION_ID = "connect_method" as const;

export type ConnectMethodId = "oauth" | "api_key" | "token" | "site_token" | "app";

export type ConnectFieldKind = "secret" | "text" | "url" | "email";

export type ConnectField = {
  /** The question id the value is answered under. */
  id: string;
  label: string;
  kind: ConnectFieldKind;
  placeholder: string;
};

export type ConnectMethod = {
  id: ConnectMethodId;
  /** The tab label and the fallback option label. */
  label: string;
  /** What this method is, for clients that draw the plain question. */
  hint: string;
  fields: readonly ConnectField[];
  /** Where to make the key, when the method needs one. */
  help?: { label: string; url: string };
  /**
   * A browser sign-in the card runs itself; no fields. It returns to a port on
   * the chat's machine, so the card offers it only when that is this computer.
   */
  browser?: boolean;
  /** A device-code sign-in the card runs itself; no fields. The code works from any computer. */
  device?: boolean;
};

/** Whether the card runs this method itself and answers with the method alone. */
export function isSelfRunConnectMethod(method: Pick<ConnectMethod, "browser" | "device">): boolean {
  return method.browser === true || method.device === true;
}

export type ConnectProviderSpec = {
  id: ConnectProviderId;
  label: string;
  /** Where the credential lands, in one plain sentence. */
  savedWhere: string;
  methods: readonly ConnectMethod[];
  /** `settingsRouteFor` id of the integration's own page. */
  settingsSection: string;
};

export const CONNECT_FIELD_IDS = {
  linearKey: "connect_linear_key",
  githubToken: "connect_github_token",
  jiraSite: "connect_jira_site",
  jiraEmail: "connect_jira_email",
  jiraToken: "connect_jira_token",
  agent37Key: "connect_agent37_key",
} as const;

const PROVIDERS: Record<ConnectProviderId, ConnectProviderSpec> = {
  linear: {
    id: "linear",
    label: "Linear",
    savedWhere: "Saved for this project, on all your machines.",
    settingsSection: "integrations.linear",
    methods: [
      {
        id: "oauth",
        label: "Sign in",
        hint: "Opens Linear in your browser. Approve ADE and you are done.",
        fields: [],
        browser: true,
      },
      {
        id: "api_key",
        label: "API key",
        hint: "A personal API key from your Linear settings.",
        fields: [{ id: CONNECT_FIELD_IDS.linearKey, label: "API key", kind: "secret", placeholder: "lin_api_…" }],
        help: { label: "Get a key", url: "https://linear.app/settings/account/security" },
      },
    ],
  },
  jira: {
    id: "jira",
    label: "Jira",
    savedWhere: "Saved for this project, on all your machines.",
    settingsSection: "integrations.jira",
    methods: [
      {
        id: "site_token",
        label: "API token",
        hint: "Your Jira Cloud site, your Atlassian email, and an API token.",
        fields: [
          { id: CONNECT_FIELD_IDS.jiraSite, label: "Site", kind: "url", placeholder: "team.atlassian.net" },
          { id: CONNECT_FIELD_IDS.jiraEmail, label: "Email", kind: "email", placeholder: "you@company.com" },
          { id: CONNECT_FIELD_IDS.jiraToken, label: "API token", kind: "secret", placeholder: "ATATT…" },
        ],
        help: { label: "Get a token", url: "https://id.atlassian.com/manage-profile/security/api-tokens" },
      },
    ],
  },
  github: {
    id: "github",
    label: "GitHub",
    savedWhere: "Saved to your account, on all your machines.",
    settingsSection: "integrations.github",
    methods: [
      {
        id: "token",
        label: "Token",
        hint: "A personal access token with repo access. It reads, pushes and opens PRs.",
        fields: [{ id: CONNECT_FIELD_IDS.githubToken, label: "Token", kind: "secret", placeholder: "github_pat_… or ghp_…" }],
        help: {
          label: "Get a token",
          url: "https://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=ADE",
        },
      },
      {
        // ADE's GitHub app reads and edits issues, but cannot push or open
        // PRs, so the token stays first. The host offers it only while reads
        // do not work yet.
        id: "app",
        label: "ADE app",
        hint: "Sign in with ADE's GitHub app. It reads and edits issues, but cannot push or open PRs.",
        fields: [],
        device: true,
      },
    ],
  },
  agent37: {
    id: "agent37",
    label: "Agent37",
    savedWhere: "Saved to your account, on all your machines.",
    settingsSection: "integrations.agent37",
    methods: [
      {
        id: "api_key",
        label: "API key",
        hint: "A workspace API key from your Agent37 dashboard.",
        fields: [{ id: CONNECT_FIELD_IDS.agent37Key, label: "API key", kind: "secret", placeholder: "sk_live_…" }],
        help: { label: "Create a key in Agent37", url: "https://www.agent37.com/dashboard/cloud/api-keys" },
      },
    ],
  },
};

/** The line an agent gets once the integration is connected: what to use now. */
export const CONNECT_NEXT_STEP: Record<ConnectProviderId, string> = {
  github: "Use `ade prs` and `ade github` (see the ade-pr-workflows skill).",
  linear: "Use `ade linear` (see the ade-linear skill).",
  jira: "Use `ade jira` (run `ade help jira`).",
  agent37: "The person can now make Agent37 machines from Add computer in ADE.",
};

export function connectProviderSpec(id: ConnectProviderId): ConnectProviderSpec {
  return PROVIDERS[id];
}

export function connectMethod(provider: ConnectProviderId, method: string | null | undefined): ConnectMethod | null {
  return PROVIDERS[provider].methods.find((candidate) => candidate.id === method) ?? null;
}

export const INTEGRATION_CONNECT_REASON_MAX_CHARS = 500;

export type IntegrationConnectRequestCard = {
  provider: ConnectProviderId;
  reason: string;
  /**
   * Set when the credential will stay on the chat's machine (no Git remote,
   * signed out, vault unreachable): the sentence the card shows instead of
   * the provider's `savedWhere`.
   */
  savedNote?: string;
  /** The methods the host offers, in order. Absent: all of the provider's methods. */
  methods?: ConnectMethodId[];
  /** What already works, in a few words (GitHub: "arul · reads only"). */
  current?: string;
};

/** What `integration_connect.request` returns. Never a credential. */
export type IntegrationConnectRequestResult =
  | {
    provider: ConnectProviderId;
    connected: true;
    method: ConnectMethodId | "already";
    account: string | null;
    /** What the agent can do with it now, in one line. */
    next: string;
  }
  | { provider: ConnectProviderId; connected: false; declined: true };

/** One integration's state, as `integration_connect.status` reports it. */
export type IntegrationConnectionSummary = {
  provider: ConnectProviderId;
  label: string;
  connected: boolean;
  /** Who or what it is connected as, when the integration says. */
  account: string | null;
  /** A short reason when it is not connected or needs attention. */
  detail: string | null;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The card's metadata, or null when this pending input is not a connect card. */
export function readIntegrationConnectRequestCard(
  request: Pick<PendingInputRequest, "providerMetadata"> | null | undefined,
): IntegrationConnectRequestCard | null {
  const record = readRecord(request?.providerMetadata?.[INTEGRATION_CONNECT_METADATA_KEY]);
  if (!record || !isConnectProviderId(record.provider)) return null;
  const provider = record.provider;
  const savedNote = typeof record.savedNote === "string" ? record.savedNote.trim() : "";
  const current = typeof record.current === "string" ? record.current.trim() : "";
  const methods = Array.isArray(record.methods)
    ? PROVIDERS[provider].methods.map((method) => method.id).filter((id) => (record.methods as unknown[]).includes(id))
    : [];
  return {
    provider,
    reason: typeof record.reason === "string" ? record.reason.trim() : "",
    ...(savedNote ? { savedNote } : {}),
    ...(methods.length ? { methods } : {}),
    ...(current ? { current } : {}),
  };
}

/** The answers the native card sends for a method and its field values. */
export function integrationConnectAnswers(
  method: ConnectMethodId,
  values: Record<string, string>,
): Record<string, string> {
  return { [CONNECT_METHOD_QUESTION_ID]: method, ...values };
}

/** `your-team.atlassian.net` and `https://your-team.atlassian.net/` both read as a site. */
export function normalizeConnectSiteInput(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
