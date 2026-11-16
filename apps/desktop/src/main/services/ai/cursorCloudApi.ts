/**
 * Cursor's public REST API for the reads that need only a GET.
 *
 * `@cursor/sdk` answers `Cursor.me`, `Cursor.models.list`,
 * `Cursor.repositories.list`, `Agent.list` and `Agent.get` (cloud) with one GET
 * each against this API. Loading the SDK for that costs the process about
 * 5 MB of module source and tens of MB of heap that it never gives back, and
 * the brain did it at rest: the Work prompt box asks for the repository list
 * as soon as a Cursor key is saved. These functions make the same requests
 * and return what the SDK returns, so the SDK loads only for a Cursor chat or
 * a Cloud action (create, send, runs, usage).
 *
 * Errors keep the SDK's text: `[code] message` from Cursor's error body, or
 * the message alone for 401 and 429, so callers that match on it (plan
 * refusals, rate limits, "unauthorized") read the same words.
 */

import { assertCursorSdkSupportedOnThisPlatform } from "./cursorSdkLoader";

const cursorApiBaseUrl = (): string =>
  process.env.CURSOR_BACKEND_URL?.trim() || "https://api.cursor.com";

/**
 * Past this, a request fails as a network error. Without a deadline a stalled
 * socket never settles, and the in-flight promise a caller keeps (the Work
 * prompt box's repository list) would be handed to every later read.
 */
const CURSOR_API_TIMEOUT_MS = 15_000;

export class CursorCloudApiError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(message: string, status: number | null, code: string) {
    super(message);
    this.name = "CursorCloudApiError";
    this.status = status;
    this.code = code;
  }
}

function readErrorBody(body: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(body) as unknown;
    const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const inner = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : record;
    return {
      ...(typeof inner.code === "string" ? { code: inner.code } : {}),
      ...(typeof inner.message === "string" ? { message: inner.message } : {}),
    };
  } catch {
    return {};
  }
}

/** One GET, with the SDK's query encoding and error text. */
async function cursorApiGet<T>(path: string, apiKey: string, query?: Record<string, unknown>): Promise<T> {
  // The SDK's platform gate, kept so a host where Cursor cannot run
  // (Windows on Arm) still reads "not supported" here, not "connected".
  assertCursorSdkSupportedOnThisPlatform();
  const token = apiKey.trim();
  if (!token) {
    throw new CursorCloudApiError("API key is required for cloud operations.", null, "unauthenticated");
  }
  const search = query
    ? Object.entries(query)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join("&")
    : "";
  let response: Response;
  try {
    response = await fetch(`${cursorApiBaseUrl()}${path}${search ? `?${search}` : ""}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(CURSOR_API_TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    const error = new CursorCloudApiError(
      timedOut ? `Request timed out after ${CURSOR_API_TIMEOUT_MS} ms` : "Network request failed",
      null,
      "network",
    );
    (error as { cause?: unknown }).cause = cause;
    throw error;
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const body = readErrorBody(text);
    const code = body.code ?? "unknown";
    const message = body.message ?? (text || `Request failed with status ${response.status}`);
    const plain = response.status === 401 || response.status === 429;
    throw new CursorCloudApiError(plain ? message : `[${code}] ${message}`, response.status, code);
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CursorCloudApiError("Failed to parse Cursor API response", response.status, "unknown");
  }
}

function itemsOf(payload: unknown): unknown[] {
  const items = payload && typeof payload === "object" ? (payload as { items?: unknown }).items : undefined;
  return Array.isArray(items) ? items : [];
}

/** `Cursor.me`: the account the key belongs to. */
export function getCursorAccount(apiKey: string): Promise<{ userEmail?: string } & Record<string, unknown>> {
  return cursorApiGet("/v1/me", apiKey);
}

/** `Cursor.models.list`: the models this key can run, as Cursor lists them. */
export async function listCursorApiModels(apiKey: string): Promise<unknown[]> {
  return itemsOf(await cursorApiGet("/v1/models", apiKey));
}

/** `Cursor.repositories.list`: the repositories Cursor Cloud can work in. */
export async function listCursorApiRepositories(apiKey: string): Promise<Array<{ url?: unknown } & Record<string, unknown>>> {
  return itemsOf(await cursorApiGet("/v1/repositories", apiKey)) as Array<{ url?: unknown } & Record<string, unknown>>;
}

/** The SDK's cloud agent summary, mapped from the API's agent the way the SDK maps it. */
function cloudAgentFromApi(raw: unknown): Record<string, unknown> {
  const agent = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const repos = Array.isArray(agent.repos)
    ? agent.repos.map((repo) => (repo && typeof repo === "object" ? (repo as { url?: unknown }).url : undefined))
    : undefined;
  return {
    agentId: agent.id,
    name: agent.name ?? "",
    summary: agent.name ?? "",
    lastModified: new Date(agent.updatedAt as string).getTime(),
    createdAt: new Date(agent.createdAt as string).getTime(),
    archived: agent.status === "ARCHIVED",
    runtime: "cloud",
    env: agent.env,
    repos,
    ...(agent.metadata !== undefined ? { metadata: agent.metadata } : {}),
  };
}

/** `Agent.list({ runtime: "cloud" })`. */
export async function listCursorApiCloudAgents(
  apiKey: string,
  args: { limit?: number; cursor?: string; includeArchived?: boolean },
): Promise<{ items: Record<string, unknown>[]; nextCursor?: string }> {
  const page = await cursorApiGet<{ items?: unknown; nextCursor?: string }>("/v1/agents", apiKey, {
    limit: args.limit,
    cursor: args.cursor,
    includeArchived: args.includeArchived,
  });
  return { items: itemsOf(page).map(cloudAgentFromApi), nextCursor: page.nextCursor };
}

/** Whether `Agent.get` answers this id from Cursor Cloud (the SDK's own test). */
export function isCursorCloudAgentId(agentId: string): boolean {
  return agentId.startsWith("bc-");
}

/** `Agent.get` for a cloud agent id. */
export async function getCursorApiCloudAgent(apiKey: string, agentId: string): Promise<Record<string, unknown>> {
  return cloudAgentFromApi(await cursorApiGet(`/v1/agents/${encodeURIComponent(agentId)}`, apiKey));
}
