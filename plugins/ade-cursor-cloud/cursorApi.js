// The Cursor Cloud REST client, in the plugin's own process.
//
// Plain `fetch` against `api.cursor.com` rather than `@cursor/sdk`. Three
// reasons, in order of weight:
//
//   1. The package is 26 MB with its own `node_modules`, and a bundled plugin
//      ships inside the app. The eleven endpoints below are the whole of what
//      Cursor Cloud ever asked of it.
//   2. `fetch` is the door the child's network guard watches
//      (`pluginChildNetworkGuard.ts`), so `"network": {"hosts":
//      ["api.cursor.com"]}` in the manifest is a declaration that is actually
//      enforced, and every refusal reaches `ade plugin doctor`.
//   3. The SDK refuses win32-arm64 outright (`ade-cli/src/cursorCloud.ts:50-75`).
//      A plain HTTP client has no platform opinion, so the plugin works
//      wherever ADE does.
//
// The key is read one call at a time through `ade.secrets.getProviderKey`,
// never cached in a collection, a panel or a log. It is the user's credential,
// given to ADE and lent to this plugin.

"use strict";

const DEFAULT_BASE_URL = "https://api.cursor.com";
/** One request's ceiling. Cursor answers a list in well under a second. */
const DEFAULT_TIMEOUT_MS = 30_000;

const { CURSOR_MAX_PAGE_LIMIT, clampPageLimit } = require("./repoMatch");

/**
 * One failure a caller can branch on.
 *
 * `code` rather than a parsed sentence, because the panel draws a different
 * state for each: `no_key` points at Settings, `unauthorized` says the key was
 * refused, and everything else is a message beside the rows the reader already
 * has.
 */
class CursorApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "CursorApiError";
    this.code = code;
    if (details && typeof details === "object") Object.assign(this, details);
  }
}

/** True for the one error the panel answers with "connect your key". */
function isMissingKeyError(error) {
  return Boolean(error) && error.code === "no_key";
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, "")}${path}`;
}

function buildQuery(params) {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    search.set(key, typeof value === "boolean" ? String(value) : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/**
 * Turn one non-2xx answer into a `CursorApiError` with a code the panel can
 * branch on. Cursor's own `{error: {message}}` body wins over the status line
 * whenever it says something a reader can act on.
 */
function errorForResponse(status, bodyText) {
  let detail = "";
  try {
    const parsed = JSON.parse(bodyText);
    const raw = parsed && typeof parsed === "object"
      ? (typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message)
      : null;
    if (typeof raw === "string") detail = raw.trim();
  } catch {
    detail = typeof bodyText === "string" ? bodyText.trim().slice(0, 200) : "";
  }
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403) {
    return new CursorApiError("unauthorized", `Cursor refused this API key${suffix}`, { status });
  }
  if (status === 404) {
    return new CursorApiError("not_found", `That cloud agent could not be found${suffix}`, { status });
  }
  if (status === 429) {
    return new CursorApiError("rate_limited", `Cursor is rate limiting this key${suffix}`, { status });
  }
  if (status === 400 || status === 422) {
    return new CursorApiError("validation", `Cursor refused the request${suffix}`, { status });
  }
  return new CursorApiError("http", `Cursor returned ${status}${suffix}`, { status });
}

/**
 * Build the client.
 *
 * Every dependency is injected so the whole surface is testable with no
 * network: `getApiKey` and `fetchImpl` are what the tests replace.
 */
function createCursorApi(options = {}) {
  const {
    getApiKey,
    fetch: fetchImpl = globalThis.fetch,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  if (typeof getApiKey !== "function") {
    throw new TypeError("createCursorApi needs a getApiKey function");
  }

  async function requireKey() {
    const key = await getApiKey();
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (!trimmed) {
      throw new CursorApiError(
        "no_key",
        "Connect your Cursor API key in Settings to use Cursor Cloud.",
      );
    }
    return trimmed;
  }

  async function request(method, path, init = {}) {
    const key = await requireKey();
    const headers = {
      Authorization: `Bearer ${key}`,
      Accept: init.accept ?? "application/json",
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
    // A caller's own headers last, so a resume can set `Last-Event-ID` without
    // this function growing a special case for every endpoint that has one.
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      if (typeof value === "string" && value) headers[name] = value;
    }

    const url = joinUrl(baseUrl, path) + buildQuery(init.query);
    // A caller's own signal wins; otherwise the request carries this client's
    // deadline, so a hung socket fails the action instead of the child.
    const signal = init.signal ?? AbortSignal.timeout(timeoutMs);

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        signal,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new CursorApiError("timeout", "Cursor did not answer in time.");
      }
      throw new CursorApiError("network", `Could not reach Cursor: ${error?.message ?? error}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw errorForResponse(response.status, text);
    }
    if (init.raw) return response;
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new CursorApiError("http", "Cursor answered with something that is not JSON.");
    }
  }

  return {
    CursorApiError,

    /** Is a key connected at all? Cheap enough to gate a panel state on. */
    async hasKey() {
      try {
        await requireKey();
        return true;
      } catch {
        return false;
      }
    },

    listAgents(params = {}) {
      return request("GET", "/v1/agents", {
        query: {
          limit: clampPageLimit(params.limit),
          cursor: params.cursor,
          includeArchived: params.includeArchived,
          prUrl: params.prUrl,
        },
      });
    },

    /**
     * Walk as many pages as the row budget takes.
     *
     * Three stop conditions, all of them load-bearing: the budget is reached,
     * a page came back empty or without a next cursor, or the cursor REPEATS —
     * which is a server that would otherwise page forever.
     */
    async listAgentsPaged(params = {}) {
      const wanted = Math.max(1, Math.floor(params.budget ?? 100));
      const items = [];
      const seenCursors = new Set();
      let cursor = null;
      while (items.length < wanted) {
        const page = await this.listAgents({
          // Always list everything and filter after: an archived agent still
          // has to be countable for "Show archived (3)".
          includeArchived: true,
          limit: Math.min(wanted - items.length, CURSOR_MAX_PAGE_LIMIT),
          ...(cursor ? { cursor } : {}),
        });
        const pageItems = Array.isArray(page?.items) ? page.items : [];
        items.push(...pageItems);
        const next = typeof page?.nextCursor === "string" ? page.nextCursor.trim() : "";
        if (!next || pageItems.length === 0 || seenCursors.has(next)) break;
        seenCursors.add(next);
        cursor = next;
      }
      return items.length > wanted ? items.slice(0, wanted) : items;
    },

    getAgent(agentId) {
      return request("GET", `/v1/agents/${encodeURIComponent(agentId)}`);
    },

    createAgent(body, init = {}) {
      return request("POST", "/v1/agents", { body, idempotencyKey: init.idempotencyKey });
    },

    archiveAgent(agentId) {
      return request("POST", `/v1/agents/${encodeURIComponent(agentId)}/archive`);
    },

    unarchiveAgent(agentId) {
      return request("POST", `/v1/agents/${encodeURIComponent(agentId)}/unarchive`);
    },

    deleteAgent(agentId) {
      return request("DELETE", `/v1/agents/${encodeURIComponent(agentId)}`);
    },

    listRuns(agentId, params = {}) {
      return request("GET", `/v1/agents/${encodeURIComponent(agentId)}/runs`, {
        query: { limit: clampPageLimit(params.limit), cursor: params.cursor },
      });
    },

    getRun(agentId, runId) {
      return request(
        "GET",
        `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      );
    },

    /** A follow-up turn: a new run on an agent that already exists. */
    createRun(agentId, body, init = {}) {
      return request("POST", `/v1/agents/${encodeURIComponent(agentId)}/runs`, {
        body,
        idempotencyKey: init.idempotencyKey,
      });
    },

    cancelRun(agentId, runId) {
      return request(
        "POST",
        `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
      );
    },

    /**
     * The run's event stream, as a `Response` the caller reads.
     *
     * Left raw on purpose: `conversation.js` owns the SSE framing and the fold
     * into turns, and this module stays the thing that knows about HTTP.
     */
    streamRun(agentId, runId, init = {}) {
      const headers = init.lastEventId ? { "Last-Event-ID": init.lastEventId } : undefined;
      return request(
        "GET",
        `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`,
        { raw: true, accept: "text/event-stream", signal: init.signal, headers },
      );
    },

    listArtifacts(agentId) {
      return request("GET", `/v1/agents/${encodeURIComponent(agentId)}/artifacts`);
    },

    getArtifactDownloadUrl(agentId, path) {
      return request("GET", `/v1/agents/${encodeURIComponent(agentId)}/artifacts/download`, {
        query: { path },
      });
    },

    getAgentUsage(agentId, params = {}) {
      return request("GET", `/v1/agents/${encodeURIComponent(agentId)}/usage`, {
        query: { runId: params.runId },
      });
    },

    getMe() {
      return request("GET", "/v1/me");
    },

    listModels() {
      return request("GET", "/v1/models");
    },

    listRepositories() {
      return request("GET", "/v1/repositories");
    },
  };
}

module.exports = {
  CursorApiError,
  DEFAULT_BASE_URL,
  createCursorApi,
  errorForResponse,
  isMissingKeyError,
};
