import { createJiraError } from "../../../shared/jiraErrors";
import type { JiraConnectArgs, JiraErrorReason } from "../../../shared/types/jira";

export type JiraCredentials = JiraConnectArgs;

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function normalizeJiraSiteUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw createJiraError("invalid", "Enter a valid Jira site URL, such as https://example.atlassian.net.");
  }
  const loopback = isLoopbackHostname(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
    || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw createJiraError("invalid", "Jira site URLs must use HTTPS. HTTP is allowed only for loopback test servers.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function readRetryAt(value: string | null, now = Date.now()): string {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return new Date(now + Math.max(0, seconds) * 1000).toISOString();
    const date = Date.parse(value);
    if (Number.isFinite(date)) return new Date(date).toISOString();
  }
  return new Date(now + 60_000).toISOString();
}

function readErrorText(body: unknown, statusText: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const messages = Array.isArray(record.errorMessages)
      ? record.errorMessages.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    const fieldErrors = record.errors && typeof record.errors === "object"
      ? Object.entries(record.errors as Record<string, unknown>)
        .map(([field, message]) => `${field}: ${String(message)}`)
      : [];
    if (messages.length || fieldErrors.length) return [...messages, ...fieldErrors].join(" ");
  }
  return statusText || "Jira returned an unexpected response.";
}

export function createJiraClient(args: {
  getCredentials: () => JiraCredentials | null;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = args.fetchImpl ?? fetch;

  async function request<T>(
    path: string,
    init: RequestInit = {},
    credentialsOverride?: JiraCredentials,
  ): Promise<T> {
    const credentials = credentialsOverride ?? args.getCredentials();
    if (!credentials) throw createJiraError("not-connected", "Connect Jira in Settings to use Jira issues.");
    const siteUrl = normalizeJiraSiteUrl(credentials.siteUrl);
    const url = new URL(path.replace(/^\//, ""), `${siteUrl}/`);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString("base64")}`);
    headers.set("Accept", "application/json");
    if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, headers });
    } catch (cause) {
      throw createJiraError("failed", "Could not reach the Jira site. Check the site URL and network connection.", { cause });
    }
    if (response.ok) {
      if (response.status === 204) return undefined as T;
      const body = await response.text();
      if (!body) return undefined as T;
      try {
        return JSON.parse(body) as T;
      } catch (cause) {
        throw createJiraError("failed", "Jira returned invalid JSON.", { cause });
      }
    }
    let body: unknown = null;
    try { body = await response.json(); } catch { /* error pages can be empty or non-JSON */ }
    const message = readErrorText(body, response.statusText);
    let reason: JiraErrorReason = "failed";
    if (response.status === 400) reason = "invalid";
    else if (response.status === 401) reason = "unauthenticated";
    else if (response.status === 403) reason = "forbidden";
    else if (response.status === 404) reason = "not-found";
    else if (response.status === 429) {
      const retryAt = readRetryAt(response.headers.get("Retry-After"));
      throw createJiraError("rate-limited", `${message} Retry after ${retryAt}.`, { retryAt });
    }
    throw createJiraError(reason, message);
  }

  const json = (value: unknown): string => JSON.stringify(value);
  return {
    request,
    get<T>(path: string, credentials?: JiraCredentials): Promise<T> {
      return request<T>(path, { method: "GET" }, credentials);
    },
    post<T>(path: string, body: unknown, credentials?: JiraCredentials): Promise<T> {
      return request<T>(path, { method: "POST", body: json(body) }, credentials);
    },
    put<T>(path: string, body: unknown): Promise<T> {
      return request<T>(path, { method: "PUT", body: json(body) });
    },
    delete(path: string): Promise<void> {
      return request<void>(path, { method: "DELETE" });
    },
  };
}

export type JiraClient = ReturnType<typeof createJiraClient>;
