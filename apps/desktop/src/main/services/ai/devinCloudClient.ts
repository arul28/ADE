/**
 * Devin Cloud REST client.
 *
 * Two credential generations exist, and ADE supports both so every Devin
 * account works:
 *
 * - **v3 / PAT** (`cog_...`): `https://api.devin.ai/v3/organizations/{org}/...`.
 *   PATs are user-identity, self-serve, and non-expiring on non-enterprise
 *   accounts. The org id can be configured (`ai.devinCloudOrgId`) or
 *   auto-discovered from `GET /v3/enterprise/organizations`.
 * - **v1 / personal key** (`apk_user_...`): `https://api.devin.ai/v1/...`.
 *   Deprecated upstream but still accepted — the fallback for enterprises
 *   whose admins disable PATs. v1 has no org scoping, no `repos` binding on
 *   create, and no archive endpoint; those gaps degrade rather than error.
 */

import type {
  DevinCloudAttachment,
  DevinCloudAuthMode,
  DevinCloudCreateSessionRequest,
  DevinCloudListMessagesResult,
  DevinCloudMessage,
  DevinCloudMode,
  DevinCloudSessionStatus,
  DevinCloudSessionSummary,
} from "../../../shared/types/config";
import type { Logger } from "../logging/logger";

const DEFAULT_TIMEOUT_MS = 20_000;
const API_BASE = "https://api.devin.ai";
const USER_AGENT = "ade-devin-cloud/1";

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(reason?: unknown): Promise<void>;
      releaseLock?(): void;
    };
  } | null;
}>;

export type DevinCloudClientArgs = {
  apiKey: string;
  /** Configured org id; auto-discovered for v3 keys when null. */
  orgId: string | null;
  logger?: Logger;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

/** Proof sync buffers attachments in memory — refuse files past this cap. */
export const DEVIN_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

export class DevinCloudApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Devin API request failed (${status}): ${body.slice(0, 300)}`);
    this.name = "DevinCloudApiError";
    this.status = status;
    this.body = body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Epoch-millisecond timestamp parser for created_at/updated_at fields. ISO
 * strings parse to millis directly; bare numbers are treated as seconds when
 * they are implausibly small for a millisecond reading.
 */
function readTimestamp(value: unknown): number | null {
  if (typeof value === "string") {
    const millis = Date.parse(value);
    if (Number.isFinite(millis)) return millis;
  }
  const numeric = readNumber(value);
  if (numeric == null) return null;
  return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
}

export class DevinCloudResponseError extends Error {
  constructor(path: string) {
    super(`Devin API returned an unreadable response for ${path}.`);
    this.name = "DevinCloudResponseError";
  }
}

/**
 * v1 personal keys carry the `apk_user_` (or plain `apk_`) prefix. Everything
 * else is treated as a v3 credential — PATs are `cog_`, but prefix sniffing
 * should not reject a future token shape outright.
 */
export function detectDevinAuthMode(apiKey: string): DevinCloudAuthMode {
  return apiKey.trim().startsWith("apk_") ? "v1" : "v3";
}

/** Devin's public session id arrives bare or with the `devin-` prefix; store bare. */
export function normalizeDevinSessionId(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  return trimmed.startsWith("devin-") ? trimmed.slice("devin-".length) : trimmed;
}

const V3_STATUSES: ReadonlySet<string> = new Set([
  "new",
  "claimed",
  "running",
  "resuming",
  "suspended",
  "exit",
  "error",
]);

function normalizeV3Status(raw: unknown): DevinCloudSessionStatus | null {
  const value = readString(raw)?.toLowerCase();
  return value && V3_STATUSES.has(value) ? (value as DevinCloudSessionStatus) : null;
}

/**
 * v1's `status`/`status_enum` vocabulary folded into the v3-shaped summary.
 * `blocked` is the loud state and lands as running + waiting_for_user.
 */
function normalizeV1Session(record: Record<string, unknown>): {
  status: DevinCloudSessionStatus | null;
  statusDetail: string | null;
} {
  const statusEnum = readString(record.status_enum)?.toLowerCase() ?? "";
  const status = readString(record.status)?.toLowerCase() ?? "";
  if (statusEnum === "finished" || status === "finished") {
    return { status: "exit", statusDetail: "finished" };
  }
  if (statusEnum === "blocked") {
    return { status: "running", statusDetail: "waiting_for_user" };
  }
  if (statusEnum === "expired") {
    return { status: "exit", statusDetail: "expired" };
  }
  if (statusEnum.startsWith("suspend_requested")) {
    return { status: "suspended", statusDetail: "user_request" };
  }
  if (statusEnum.startsWith("resume_requested")) {
    return { status: "resuming", statusDetail: null };
  }
  if (statusEnum === "resumed" || statusEnum === "working") {
    return { status: "running", statusDetail: "working" };
  }
  if (status === "running") {
    return { status: "running", statusDetail: "working" };
  }
  return { status: statusEnum || status ? "running" : null, statusDetail: statusEnum || null };
}

function normalizeV3Session(record: Record<string, unknown>): DevinCloudSessionSummary {
  const prs = Array.isArray(record.pull_requests) ? record.pull_requests : [];
  const mode = readString(record.devin_mode);
  return {
    sessionId: normalizeDevinSessionId(
      readString(record.session_id) ?? readString(record.devin_id) ?? readString(record.id),
    ),
    title: readString(record.title),
    status: normalizeV3Status(record.status),
    statusDetail: readString(record.status_detail)?.toLowerCase() ?? null,
    isArchived: record.is_archived === true,
    url: readString(record.url),
    pullRequests: prs.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const prUrl = readString(entry.pr_url) ?? readString(entry.url);
      if (!prUrl) return [];
      return [{ prUrl, prState: readString(entry.pr_state) }];
    }),
    tags: Array.isArray(record.tags) ? record.tags.filter((t): t is string => typeof t === "string") : [],
    repos: Array.isArray(record.repos)
      ? record.repos.filter((t): t is string => typeof t === "string")
      : [],
    createdAt: readTimestamp(record.created_at),
    updatedAt: readTimestamp(record.updated_at),
    devinMode: (mode ?? null) as DevinCloudMode | null,
    acusConsumed: readNumber(record.acus_consumed),
    userId: readString(record.user_id),
    parentSessionId: readString(record.parent_session_id),
    origin: readString(record.origin),
  };
}

function normalizeV1SessionSummary(record: Record<string, unknown>): DevinCloudSessionSummary {
  const state = normalizeV1Session(record);
  const pr = isRecord(record.pull_request) ? readString(record.pull_request.url) : null;
  const sessionId = normalizeDevinSessionId(readString(record.session_id));
  return {
    sessionId,
    title: readString(record.title),
    status: state.status,
    statusDetail: state.statusDetail,
    isArchived: false,
    url: sessionId ? `https://app.devin.ai/sessions/${sessionId}` : null,
    pullRequests: pr ? [{ prUrl: pr, prState: null }] : [],
    tags: Array.isArray(record.tags) ? record.tags.filter((t): t is string => typeof t === "string") : [],
    repos: [],
    createdAt: readTimestamp(record.created_at),
    updatedAt: readTimestamp(record.updated_at),
    devinMode: null,
    acusConsumed: null,
    userId: readString(record.requesting_user_email),
    parentSessionId: null,
    origin: "api",
  };
}

function normalizeV3Message(record: Record<string, unknown>): DevinCloudMessage | null {
  const eventId = readString(record.event_id);
  const message = readString(record.message);
  const source = readString(record.source)?.toLowerCase();
  if (!eventId || message == null) return null;
  return {
    eventId,
    source: source === "user" ? "user" : "devin",
    message: record.message as string,
    createdAt: readTimestamp(record.created_at) ?? 0,
  };
}

function normalizeV1Message(record: Record<string, unknown>): DevinCloudMessage | null {
  const eventId = readString(record.event_id);
  const message = typeof record.message === "string" ? record.message : null;
  const type = readString(record.type)?.toLowerCase() ?? "";
  if (!eventId || message == null) return null;
  return {
    eventId,
    source: type.startsWith("user") || type === "initial_user_message" ? "user" : "devin",
    message,
    createdAt: readTimestamp(record.timestamp) ?? 0,
  };
}

/**
 * Proof attachments render in-app, so bytes that smell like markup/script
 * (HTML, SVG, XML) are refused regardless of the remote's declared name or
 * content-type — a hostile or confused response must not enter the artifact
 * store as something renderable.
 */
function sniffIsActiveMarkup(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 512))
    .trimStart()
    .toLowerCase();
  return (
    head.startsWith("<!doctype html")
    || head.startsWith("<html")
    || head.startsWith("<?xml")
    || head.startsWith("<svg")
    || head.startsWith("<script")
  );
}

export type DevinCloudListSessionsArgs = {
  first?: number;
  after?: string | null;
  repoNames?: string[];
  tags?: string[];
  sessionIds?: string[];
  isArchived?: boolean;
  createdAfter?: number;
  updatedAfter?: number;
};

export type DevinCloudListSessionsResult = {
  items: DevinCloudSessionSummary[];
  endCursor: string | null;
  /** v1 has no cursor — page math continues via offset. */
  offset?: number;
};

export type DevinCloudClient = ReturnType<typeof createDevinCloudClient>;

export function createDevinCloudClient(args: DevinCloudClientArgs) {
  const apiKey = args.apiKey.trim();
  const authMode = detectDevinAuthMode(apiKey);
  const fetchImpl: FetchLike = args.fetchImpl ?? (fetch as unknown as FetchLike);
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The org a v3 key can see, resolved lazily: configured id first, then the
  // single org `GET /v3/enterprise/organizations` reports.
  let cachedOrgId = args.orgId?.trim() || null;
  let orgLookupPromise: Promise<string | null> | null = null;

  const request = async <T>(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? timeoutMs);
    try {
      const response = await fetchImpl(`${API_BASE}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new DevinCloudApiError(response.status, text);
      }
      const text = await response.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        // A 2xx body that is not JSON means a proxy or upstream answered in
        // Devin's place — reporting it as an empty page would silently turn
        // malformed responses into empty fleets and accepted credentials.
        throw new DevinCloudResponseError(path);
      }
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Every organization the token can see — the endpoint paginates. Returns
   * null when the account is not enterprise: `/v3/enterprise/*` 403s on
   * personal/team accounts, which can still use every org-scoped endpoint.
   */
  const listAllOrganizations = async (): Promise<Record<string, unknown>[] | null> => {
    const items: Record<string, unknown>[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    try {
      for (;;) {
        const qs = { first: 50, ...(cursor ? { after: cursor } : {}) };
        const page = await request<unknown>(
          "/v3/enterprise/organizations?qs=" + encodeURIComponent(JSON.stringify(qs)),
        );
        if (!isRecord(page) || !Array.isArray(page.items)) {
          throw new Error("Devin rejected this token — the organizations endpoint did not answer as expected.");
        }
        items.push(...page.items.filter(isRecord));
        const next = readString(page.end_cursor);
        if (!next || seenCursors.has(next)) break;
        seenCursors.add(next);
        cursor = next;
      }
    } catch (error) {
      if (error instanceof DevinCloudApiError && error.status === 403) return null;
      throw error;
    }
    return items;
  };

  const orgIdOf = (entry: Record<string, unknown>): string | null =>
    readString(entry.org_id) ?? readString(entry.id);

  /**
   * `GET /v3/self` — who the credential authenticates as. Works for PATs and
   * service-user keys on every account tier (the enterprise org list is
   * enterprise-only); null on v1 keys, which have no equivalent.
   */
  const getSelf = async (): Promise<{
    userId: string | null;
    orgId: string | null;
    userName: string | null;
  } | null> => {
    if (authMode === "v1") return null;
    try {
      const record = await request<unknown>("/v3/self");
      if (!isRecord(record)) return null;
      return {
        userId: readString(record.user_id) ?? readString(record.service_user_id),
        orgId: readString(record.org_id),
        userName: readString(record.user_name) ?? readString(record.service_user_name),
      };
    } catch {
      return null;
    }
  };

  const noOrgIdError = () =>
    new Error(
      "Could not determine your Devin org. Add your org id (org-...) in Settings > Devin — it is shown in your Devin settings and session URLs.",
    );

  /**
   * Probes an org-scoped endpoint: true when the token can read the org. Used
   * when enterprise org listing is unavailable (non-enterprise accounts).
   */
  const probeOrg = async (orgId: string): Promise<boolean> => {
    try {
      await request<unknown>(
        `/v3/organizations/${encodeURIComponent(orgId)}/sessions?qs=` +
          encodeURIComponent(JSON.stringify({ first: 1 })),
      );
      return true;
    } catch {
      return false;
    }
  };

  const resolveOrgId = async (): Promise<string> => {
    if (authMode === "v1") {
      throw new Error("Devin v1 personal keys are not org-scoped; this call needs a v3 PAT.");
    }
    if (cachedOrgId) return cachedOrgId;
    if (!orgLookupPromise) {
      orgLookupPromise = (async (): Promise<string | null> => {
        // `/v3/self` is the cheapest, tier-agnostic discovery: PATs and service
        // users get `org_id` even on non-enterprise accounts where the
        // enterprise org list is gated.
        const self = await getSelf();
        if (self?.orgId) return self.orgId;
        const items = await listAllOrganizations();
        if (!items) throw noOrgIdError();
        const first = items.find(isRecord);
        const id = first ? orgIdOf(first) : null;
        if (!id) throw noOrgIdError();
        if (items.length > 1) {
          throw new Error(
            "Your Devin account belongs to multiple orgs. Add the org id (org-...) for the one you want in Settings > Devin.",
          );
        }
        return id;
      })().catch((error) => {
        orgLookupPromise = null;
        throw error;
      });
    }
    const resolved = await orgLookupPromise;
    cachedOrgId = resolved;
    return resolved!;
  };

  const orgPath = async (suffix: string): Promise<string> => {
    const orgId = await resolveOrgId();
    return `/v3/organizations/${encodeURIComponent(orgId)}${suffix}`;
  };

  const listSessions = async (
    listArgs: DevinCloudListSessionsArgs = {},
  ): Promise<DevinCloudListSessionsResult> => {
    const first = Math.min(Math.max(listArgs.first ?? 100, 1), 200);
    if (authMode === "v1") {
      const offset = listArgs.after ? Number(listArgs.after) || 0 : 0;
      const params = new URLSearchParams({ limit: String(Math.min(first, 100)), offset: String(offset) });
      if (listArgs.tags?.length) params.set("tags", listArgs.tags.join(","));
      const page = await request<unknown>(`/v1/sessions?${params.toString()}`);
      const sessions = isRecord(page) && Array.isArray(page.sessions) ? page.sessions : [];
      const items = sessions.filter(isRecord).map(normalizeV1SessionSummary);
      const next = items.length >= Math.min(first, 100) ? String(offset + items.length) : null;
      return { items, endCursor: next, offset: offset + items.length };
    }
    const qs = {
      first,
      ...(listArgs.after ? { after: listArgs.after } : {}),
      ...(listArgs.repoNames?.length ? { repo_names: listArgs.repoNames } : {}),
      ...(listArgs.tags?.length ? { tags: listArgs.tags } : {}),
      ...(listArgs.sessionIds?.length ? { session_ids: listArgs.sessionIds } : {}),
      ...(listArgs.isArchived !== undefined ? { is_archived: listArgs.isArchived } : {}),
      ...(listArgs.createdAfter ? { created_after: listArgs.createdAfter } : {}),
      ...(listArgs.updatedAfter ? { updated_after: listArgs.updatedAfter } : {}),
    };
    const page = await request<unknown>(
      `${await orgPath("/sessions")}?qs=${encodeURIComponent(JSON.stringify(qs))}`,
    );
    const items = isRecord(page) && Array.isArray(page.items) ? page.items : [];
    const endCursor = isRecord(page) ? readString(page.end_cursor) : null;
    return {
      items: items.filter(isRecord).map(normalizeV3Session),
      endCursor,
    };
  };

  const getSession = async (devinSessionId: string): Promise<DevinCloudSessionSummary | null> => {
    const id = normalizeDevinSessionId(devinSessionId);
    if (!id) throw new Error("Devin session id is required.");
    if (authMode === "v1") {
      const record = await request<unknown>(`/v1/sessions/${encodeURIComponent(id)}`);
      return isRecord(record) ? normalizeV1SessionSummary(record) : null;
    }
    const record = await request<unknown>(await orgPath(`/sessions/${encodeURIComponent(id)}`));
    return isRecord(record) ? normalizeV3Session(record) : null;
  };

  const createSession = async (
    input: DevinCloudCreateSessionRequest,
  ): Promise<DevinCloudSessionSummary> => {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Prompt is required.");
    if (authMode === "v1") {
      const body: Record<string, unknown> = {
        prompt,
        ...(input.tags?.length ? { tags: input.tags } : {}),
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      };
      const record = await request<unknown>("/v1/sessions", { method: "POST", body });
      const sessionId = isRecord(record) ? normalizeDevinSessionId(readString(record.session_id)) : "";
      if (!sessionId) throw new Error("Devin did not return a session id.");
      const fresh = await getSession(sessionId).catch(() => null);
      return fresh ?? {
        sessionId,
        title: input.title ?? null,
        status: "new",
        statusDetail: null,
        isArchived: false,
        url: isRecord(record) ? readString(record.url) : `https://app.devin.ai/sessions/${sessionId}`,
        pullRequests: [],
        tags: input.tags ?? [],
        repos: [],
        createdAt: null,
        updatedAt: null,
        devinMode: null,
        acusConsumed: null,
        userId: null,
        parentSessionId: null,
        origin: "api",
      };
    }
    const body: Record<string, unknown> = {
      prompt,
      ...(input.repoUrls?.length ? { repos: input.repoUrls } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.devinMode ? { devin_mode: input.devinMode } : {}),
      ...(input.resumable !== undefined ? { resumable: input.resumable } : {}),
      ...(input.bypassApproval !== undefined ? { bypass_approval: input.bypassApproval } : {}),
      ...(input.platform?.trim() ? { platform: input.platform.trim() } : {}),
    };
    const record = await request<unknown>(await orgPath("/sessions"), { method: "POST", body });
    if (!isRecord(record)) throw new Error("Devin did not return a session.");
    const summary = normalizeV3Session(record);
    if (!summary.sessionId) {
      const id = normalizeDevinSessionId(readString(record.session_id) ?? readString(record.devin_id));
      if (!id) throw new Error("Devin did not return a session id.");
      summary.sessionId = id;
    }
    return summary;
  };

  const listMessages = async (
    devinSessionId: string,
    listArgs: { first?: number; after?: string | null } = {},
  ): Promise<DevinCloudListMessagesResult> => {
    const id = normalizeDevinSessionId(devinSessionId);
    if (!id) throw new Error("Devin session id is required.");
    const first = Math.min(Math.max(listArgs.first ?? 200, 1), 200);
    if (authMode === "v1") {
      // v1 has no messages endpoint; the session record carries them inline.
      const record = await request<unknown>(`/v1/sessions/${encodeURIComponent(id)}`);
      const raw = isRecord(record) && Array.isArray(record.messages) ? record.messages : [];
      const items = raw
        .filter(isRecord)
        .map(normalizeV1Message)
        .filter((m): m is DevinCloudMessage => m !== null);
      // v1 embeds the whole transcript in the session record — return all of
      // it. The mirror dedupes on event_id, so replaying history is invisible
      // and nothing before the tail is ever lost.
      return { items, endCursor: null };
    }
    const qs = {
      first,
      ...(listArgs.after ? { after: listArgs.after } : {}),
    };
    const page = await request<unknown>(
      `${await orgPath(`/sessions/${encodeURIComponent(id)}/messages`)}?qs=${encodeURIComponent(JSON.stringify(qs))}`,
    );
    const items = isRecord(page) && Array.isArray(page.items) ? page.items : [];
    const endCursor = isRecord(page) ? readString(page.end_cursor) : null;
    return {
      items: items
        .filter(isRecord)
        .map(normalizeV3Message)
        .filter((m): m is DevinCloudMessage => m !== null),
      endCursor,
    };
  };

  /**
   * List the files a session uploaded or produced (recordings, screenshots,
   * exports). v3-only surface: v1 has no attachments endpoint, so a legacy key
   * simply reports none.
   */
  const listAttachments = async (
    devinSessionId: string,
  ): Promise<DevinCloudAttachment[]> => {
    const id = normalizeDevinSessionId(devinSessionId);
    if (!id) throw new Error("Devin session id is required.");
    if (authMode === "v1") return [];
    const rows = await request<unknown>(
      await orgPath(`/sessions/${encodeURIComponent(id)}/attachments`),
    );
    const items = Array.isArray(rows) ? rows : [];
    return items
      .filter(isRecord)
      .map((row) => ({
        attachmentId: readString(row.attachment_id) ?? readString(row.id) ?? "",
        name: readString(row.name) ?? "attachment",
        url: readString(row.url) ?? "",
        source: readString(row.source) === "user" ? "user" as const : "devin" as const,
        contentType: readString(row.content_type),
      }))
      .filter((item) => item.attachmentId.length > 0 && item.url.length > 0);
  };

  /**
   * Fetch attachment bytes. The URLs Devin hands out are short-lived signed
   * links, so the file is fetched by attachment id through the same Bearer
   * auth every other call uses — the caller saves it where it wants.
   */
  const downloadAttachment = async (
    attachment: DevinCloudAttachment,
  ): Promise<Uint8Array | null> => {
    if (authMode === "v1") return null;
    const path = await orgPath(
      `/attachments/${encodeURIComponent(attachment.attachmentId)}/${encodeURIComponent(attachment.name)}`,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${API_BASE}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": USER_AGENT,
        },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const declared = Number(response.headers?.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > DEVIN_ATTACHMENT_MAX_BYTES) {
        args.logger?.warn?.("devin_cloud.attachment_too_large", {
          attachmentId: attachment.attachmentId,
          bytes: declared,
        });
        return null;
      }
      // Stream the body and abort at the cap — Content-Length can be absent
      // or wrong, so buffering first would let an oversized payload through.
      const reader = response.body?.getReader?.();
      if (reader) {
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.length) continue;
            total += value.length;
            if (total > DEVIN_ATTACHMENT_MAX_BYTES) {
              await reader.cancel().catch(() => undefined);
              args.logger?.warn?.("devin_cloud.attachment_too_large", {
                attachmentId: attachment.attachmentId,
                bytes: total,
              });
              return null;
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock?.();
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        if (sniffIsActiveMarkup(bytes)) {
          args.logger?.warn?.("devin_cloud.attachment_active_markup", {
            attachmentId: attachment.attachmentId,
            name: attachment.name,
          });
          return null;
        }
        return bytes;
      }
      if (!response.arrayBuffer) return null;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > DEVIN_ATTACHMENT_MAX_BYTES) {
        args.logger?.warn?.("devin_cloud.attachment_too_large", {
          attachmentId: attachment.attachmentId,
          bytes: buffer.byteLength,
        });
        return null;
      }
      const bytes = new Uint8Array(buffer);
      if (sniffIsActiveMarkup(bytes)) {
        args.logger?.warn?.("devin_cloud.attachment_active_markup", {
          attachmentId: attachment.attachmentId,
          name: attachment.name,
        });
        return null;
      }
      return bytes;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const sendMessage = async (
    devinSessionId: string,
    input: { message: string; attachmentUrls?: string[] },
  ): Promise<void> => {
    const id = normalizeDevinSessionId(devinSessionId);
    const message = input.message.trim();
    if (!id) throw new Error("Devin session id is required.");
    if (!message) throw new Error("Message is required.");
    if (authMode === "v1") {
      await request<unknown>(`/v1/sessions/${encodeURIComponent(id)}/message`, {
        method: "POST",
        body: { message },
      });
      return;
    }
    await request<unknown>(await orgPath(`/sessions/${encodeURIComponent(id)}/messages`), {
      method: "POST",
      body: {
        message,
        ...(input.attachmentUrls?.length ? { attachment_urls: input.attachmentUrls } : {}),
      },
    });
  };

  const terminateSession = async (
    devinSessionId: string,
    options: { archive?: boolean } = {},
  ): Promise<void> => {
    const id = normalizeDevinSessionId(devinSessionId);
    if (!id) throw new Error("Devin session id is required.");
    if (authMode === "v1") {
      await request<unknown>(`/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      return;
    }
    const params = options.archive !== undefined ? `?archive=${options.archive ? "true" : "false"}` : "";
    await request<unknown>(await orgPath(`/sessions/${encodeURIComponent(id)}`) + params, {
      method: "DELETE",
    });
  };

  const archiveSession = async (devinSessionId: string): Promise<void> => {
    const id = normalizeDevinSessionId(devinSessionId);
    if (!id) throw new Error("Devin session id is required.");
    if (authMode === "v1") {
      throw new Error("Devin v1 keys cannot archive sessions; use a v3 PAT for archive.");
    }
    await request<unknown>(await orgPath(`/sessions/${encodeURIComponent(id)}/archive`), {
      method: "POST",
    });
  };

  const unarchiveSession = async (devinSessionId: string): Promise<void> => {
    const id = normalizeDevinSessionId(devinSessionId);
    if (!id) throw new Error("Devin session id is required.");
    if (authMode === "v1") {
      throw new Error("Devin v1 keys cannot unarchive sessions; use a v3 PAT for unarchive.");
    }
    await request<unknown>(await orgPath(`/sessions/${encodeURIComponent(id)}/unarchive`), {
      method: "POST",
    });
  };

  /** Verify the credential: v3 lists orgs, v1 lists one session page. */
  const verify = async (): Promise<{ orgName: string | null }> => {
    if (authMode === "v1") {
      const page = await request<unknown>("/v1/sessions?limit=1");
      if (!isRecord(page) || !Array.isArray(page.sessions)) {
        throw new Error("Devin rejected this token — the sessions endpoint did not answer as expected.");
      }
      return { orgName: null };
    }
    const items = await listAllOrganizations();
    if (!items) {
      // Non-enterprise account: org listing is enterprise-gated. `/v3/self`
      // still reports the org for PATs; otherwise verify the configured org by
      // probing an org-scoped endpoint.
      const orgId = cachedOrgId ?? (await getSelf())?.orgId ?? null;
      if (!orgId) throw noOrgIdError();
      if (!(await probeOrg(orgId))) {
        throw new Error(
          `Org '${orgId}' is not visible to this Devin token. Check the org id in Settings > Devin.`,
        );
      }
      cachedOrgId = orgId;
      return { orgName: null };
    }
    const first = items.find(isRecord);
    if (!first) {
      throw new Error("This Devin token works but no organizations are visible to it.");
    }
    if (cachedOrgId) {
      const match = items.find((entry) => orgIdOf(entry) === cachedOrgId);
      if (!match) {
        throw new Error(
          `Org '${cachedOrgId}' is not visible to this Devin token. Check the org id in Settings > Devin.`,
        );
      }
      return { orgName: readString(match.org_name) ?? readString(match.name) };
    }
    if (items.length > 1) {
      throw new Error(
        "Your Devin account belongs to multiple orgs. Add the org id (org-...) for the one you want in Settings > Devin.",
      );
    }
    const id = orgIdOf(first);
    if (!id) {
      throw new Error("Could not determine your Devin org. Add your org id (org-...) in Settings > Devin.");
    }
    cachedOrgId = id;
    return { orgName: readString(first.org_name) ?? readString(first.name) };
  };

  return {
    authMode,
    listSessions,
    getSession,
    createSession,
    listMessages,
    listAttachments,
    downloadAttachment,
    sendMessage,
    terminateSession,
    archiveSession,
    unarchiveSession,
    verify,
    /** `GET /v3/self` — caller identity (userId/orgId) for PATs and service users. */
    getSelf,
    /** Resolved org id when known (configured or discovered). */
    getOrgId: () => cachedOrgId,
  };
}
