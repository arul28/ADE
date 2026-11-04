import { CONNECT_FIELD_IDS, normalizeConnectSiteInput, type ConnectProviderId } from "../../../shared/integrationConnect";
import type { JiraConnectArgs, JiraConnectionStatus } from "../../../shared/types/jira";
import type { GitHubStatus } from "../../../shared/types/git";
import type { LinearConnectionStatus } from "../../../shared/types/linearSync";
import type { IntegrationCredentialStorage } from "../../../shared/types/integrationCredentialStorage";
import { jiraErrorMessage, parseJiraError } from "../../../shared/jiraErrors";
import type { IntegrationConnectAdapter } from "./integrationConnectRequest";

/**
 * The status/save pair for each integration the connect card knows, over the
 * services this runtime already has. Each save checks the credential with the
 * provider before it stores it, so the card never says "connected" for a key
 * the provider refused. Settings stores as it is told; the card is stricter
 * because nobody is looking at a status line when an agent asked.
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type IntegrationConnectServices = {
  githubService?: {
    getStatus(): Promise<GitHubStatus>;
    setToken(token: string): void;
  } | null;
  linearCredentialService?: { setToken(token: string): void } | null;
  linearStatus?: (() => Promise<LinearConnectionStatus>) | null;
  jiraService?: {
    getConnectionStatus(): Promise<JiraConnectionStatus>;
    connect(input: JiraConnectArgs): Promise<JiraConnectionStatus>;
  } | null;
  /** Agent37's status/save pair lives with its credential (services/agent37). */
  agent37?: IntegrationConnectAdapter | null;
  fetch?: FetchLike;
};

const VALIDATE_TIMEOUT_MS = 15_000;

async function fetchJson(fetcher: FetchLike, url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("The provider did not answer in time. Try again.");
    throw new Error(`Could not reach the provider: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The card's line when a credential would stay on this machine, from the integration's own storage status. */
function storageNote(storage: IntegrationCredentialStorage | null | undefined): string | null {
  if (storage?.storage !== "device") return null;
  return storage.message?.trim() || "Saved on this computer only.";
}

/**
 * Whether ADE has a GitHub credential that can push and open PRs. ADE's
 * GitHub app only reads, so it never counts. Mirrors the renderer's
 * `githubStatusHasWriteCredential`, for runtimes that predate `writeAuthSource`.
 */
function githubCanWrite(status: GitHubStatus): boolean {
  if (status.writeAuthSource != null) return status.writeAuthSource !== "none";
  return status.connected && status.authSource !== "app" && status.authSource !== "none";
}

function githubAdapter(services: IntegrationConnectServices, fetcher: FetchLike): IntegrationConnectAdapter | null {
  const github = services.githubService;
  if (!github) return null;
  return {
    // Connected means reads AND writes: an agent asks because something it
    // needs failed, and with only ADE's app signed in that is a push or a PR.
    async status() {
      const status = await github.getStatus();
      const reads = Boolean(status.connected);
      const writes = githubCanWrite(status);
      return {
        connected: reads && writes,
        account: status.writeUserLogin ?? status.userLogin ?? null,
        detail: reads && writes
          ? null
          : reads
            ? "Reads work, but no token can push or open PRs."
            : status.authFailure?.message ?? status.repoAccessError ?? (status.tokenStored ? "The saved token does not work." : "No token saved."),
        // The app cannot add what is missing once reads work.
        offer: reads ? ["token"] : ["token", "app"],
        current: reads && !writes ? `${status.userLogin ? `${status.userLogin} · ` : ""}reads only` : null,
      };
    },
    async checkSignIn(method) {
      const status = await github.getStatus();
      const works = method === "app" ? Boolean(status.connected) : Boolean(status.connected) && githubCanWrite(status);
      return {
        connected: works,
        account: status.userLogin ?? null,
        detail: works ? null : status.repoAccessError ?? status.authFailure?.message ?? null,
      };
    },
    async save(_method, values) {
      const token = values[CONNECT_FIELD_IDS.githubToken] ?? "";
      const { status, body } = await fetchJson(fetcher, "https://api.github.com/user", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "ADE",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (status === 401) throw new Error("GitHub did not accept this token. Check that you copied all of it.");
      if (status === 403) throw new Error("GitHub refused this token. It may be expired or blocked by your organization.");
      if (status < 200 || status >= 300) throw new Error(`GitHub answered with an error (${status}). Try again.`);
      github.setToken(token);
      return { account: readString(readRecord(body)?.login) };
    },
  };
}

function linearAdapter(services: IntegrationConnectServices, fetcher: FetchLike): IntegrationConnectAdapter | null {
  const credentials = services.linearCredentialService;
  const readStatus = services.linearStatus;
  if (!credentials || !readStatus) return null;
  return {
    async status() {
      const status = await readStatus();
      return {
        connected: Boolean(status.connected),
        account: status.organizationName ?? status.viewerName ?? null,
        detail: status.connected ? null : status.message ?? null,
        storedOnThisMachine: storageNote(status.credentialStorage),
      };
    },
    async save(_method, values) {
      const key = values[CONNECT_FIELD_IDS.linearKey] ?? "";
      const { status, body } = await fetchJson(fetcher, "https://api.linear.app/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: key },
        body: JSON.stringify({ query: "query AdeConnect { viewer { name } organization { name } }" }),
      });
      const data = readRecord(readRecord(body)?.data);
      const errors = readRecord(body)?.errors;
      if (status === 400 || status === 401 || (Array.isArray(errors) && errors.length > 0 && !data)) {
        throw new Error("Linear did not accept this API key. Check that you copied all of it.");
      }
      if (status < 200 || status >= 300 || !data) throw new Error(`Linear answered with an error (${status}). Try again.`);
      credentials.setToken(key);
      return {
        account: readString(readRecord(data.organization)?.name) ?? readString(readRecord(data.viewer)?.name),
      };
    },
  };
}

/** The card's line for a failed Jira check: what to fix, without the runtime's error tag. */
function jiraConnectErrorText(error: unknown, siteUrl: string): string {
  const parsed = parseJiraError(error);
  const site = siteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "") || "that address";
  switch (parsed?.reason) {
    case "not-found":
      return `ADE could not find a Jira site at ${site}. Check the site address.`;
    case "unauthenticated":
      return "Jira did not accept this email and API token. Check both.";
    case "forbidden":
      return `Jira refused this token for ${site}. Check that your account can open the site.`;
    case "rate-limited":
      return "Jira is limiting requests right now. Try again in a minute.";
    default:
      return jiraErrorMessage(error, "Could not connect to Jira. Try again.");
  }
}

function jiraAdapter(services: IntegrationConnectServices): IntegrationConnectAdapter | null {
  const jira = services.jiraService;
  if (!jira) return null;
  const accountOf = (status: JiraConnectionStatus) => status.account?.displayName ?? status.email ?? null;
  return {
    async status() {
      const status = await jira.getConnectionStatus();
      return {
        connected: Boolean(status.connected),
        account: accountOf(status),
        detail: status.connected ? null : status.error?.message ?? null,
        storedOnThisMachine: storageNote(status.credentialStorage),
      };
    },
    async save(_method, values) {
      const siteUrl = normalizeConnectSiteInput(values[CONNECT_FIELD_IDS.jiraSite] ?? "");
      // `connect` checks the token against the site and throws before it
      // stores anything.
      let status: JiraConnectionStatus;
      try {
        status = await jira.connect({
          siteUrl,
          email: values[CONNECT_FIELD_IDS.jiraEmail] ?? "",
          apiToken: values[CONNECT_FIELD_IDS.jiraToken] ?? "",
        });
      } catch (error) {
        throw new Error(jiraConnectErrorText(error, siteUrl));
      }
      if (!status.connected) throw new Error(status.error?.message ?? "Jira did not accept these details.");
      return { account: accountOf(status) };
    },
  };
}

export function buildIntegrationConnectAdapters(
  services: IntegrationConnectServices,
): Partial<Record<ConnectProviderId, IntegrationConnectAdapter>> {
  const fetcher = services.fetch ?? ((input, init) => fetch(input, init));
  const adapters: Partial<Record<ConnectProviderId, IntegrationConnectAdapter>> = {};
  const github = githubAdapter(services, fetcher);
  if (github) adapters.github = github;
  const linear = linearAdapter(services, fetcher);
  if (linear) adapters.linear = linear;
  const jira = jiraAdapter(services);
  if (jira) adapters.jira = jira;
  if (services.agent37) adapters.agent37 = services.agent37;
  return adapters;
}
