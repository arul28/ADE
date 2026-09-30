import type { LinearAgentStatus } from "../../../shared/types";
import { ACCOUNT_RELAY_TOKEN_HEADER } from "../github/githubRelayConfig";

/**
 * The desktop side of the relay's Linear agent routes. The relay holds the
 * workspace's `actor=app` token, so every write that should appear as the ADE
 * agent in Linear goes through here; the brain never holds the app token.
 */
export type LinearAgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "elicitation"; body: string; signal?: "select" | "auth"; signalMetadata?: { options: Array<{ label: string; value: string }> } }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

export type LinearAgentPlanStep = {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
};

export type LinearAgentRelayClientDeps = {
  getRelayBaseUrl: () => string;
  /** The person's Linear user token (`Bearer …` for OAuth, raw for an API key). */
  getLinearAccessToken: () => Promise<string | null>;
  getAccountAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
};

/** A hung relay must not hold a claim, an activity post, or an install open forever. */
const RELAY_REQUEST_TIMEOUT_MS = 20_000;

export class LinearAgentRelayError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "LinearAgentRelayError";
  }
}

export function createLinearAgentRelayClient(deps: LinearAgentRelayClientDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const call = async <T>(args: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
    withLinear?: boolean;
  }): Promise<T> => {
    const accountToken = (await deps.getAccountAccessToken())?.trim() ?? "";
    if (!accountToken) {
      throw new LinearAgentRelayError("Sign in to ADE to use the Linear agent.", 401, "account_required");
    }
    const headers: Record<string, string> = { [ACCOUNT_RELAY_TOKEN_HEADER]: accountToken };
    if (args.withLinear) {
      const linearToken = (await deps.getLinearAccessToken())?.trim() ?? "";
      if (!linearToken) throw new LinearAgentRelayError("Connect Linear first.", 401, "linear_required");
      headers.authorization = linearToken;
    }
    if (args.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetchImpl(`${deps.getRelayBaseUrl().replace(/\/+$/, "")}${args.path}`, {
      method: args.method,
      headers,
      signal: AbortSignal.timeout(RELAY_REQUEST_TIMEOUT_MS),
      ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || payload.ok === false) {
      const code = typeof payload.error === "string" ? payload.error : null;
      const reason = typeof payload.reason === "string" ? ` (${payload.reason})` : "";
      throw new LinearAgentRelayError(
        code ? `Linear agent relay: ${code}${reason}` : `Linear agent relay request failed (HTTP ${response.status}).`,
        response.status,
        code,
      );
    }
    return payload as T;
  };

  const sessionPath = (sessionId: string, suffix: string) =>
    `/linear/agent/sessions/${encodeURIComponent(sessionId)}/${suffix}`;

  return {
    getStatus: () => call<LinearAgentStatus>({ method: "GET", path: "/linear/agent/status", withLinear: true }),

    install: (args: { accessToken: string; refreshToken?: string | null; expiresAt?: string | null }) =>
      call<LinearAgentStatus>({ method: "POST", path: "/linear/agent/install", body: args, withLinear: true }),

    uninstall: () => call<{ ok: true }>({ method: "DELETE", path: "/linear/agent/install", withLinear: true }),

    /** `replace` moves this Linear user's delegations from another ADE account to this one. */
    registerMember: (options?: { replace?: boolean }) =>
      call<{ ok: true }>({
        method: "POST",
        path: `/linear/agent/members/register${options?.replace ? "?replace=1" : ""}`,
        withLinear: true,
      }),

    unregisterMember: () => call<{ ok: true }>({ method: "DELETE", path: "/linear/agent/members/register", withLinear: true }),

    updateSettings: (args: { fallbackMode: "reply" | "runner"; runner: "self" | null }) =>
      call<{ ok: true }>({ method: "PUT", path: "/linear/agent/settings", body: args, withLinear: true }),

    claimSession: (sessionId: string, args: { machineId: string; machineName?: string | null }) =>
      call<{ ok: true; claimed: boolean; claimedByMachineId: string | null }>({
        method: "POST",
        path: sessionPath(sessionId, "claim"),
        body: args,
      }),

    postActivity: (sessionId: string, content: LinearAgentActivityContent, options?: { ephemeral?: boolean }) =>
      call<{ ok: true; activityId?: string }>({
        method: "POST",
        path: sessionPath(sessionId, "activities"),
        body: { content, ...(options?.ephemeral ? { ephemeral: true } : {}) },
      }),

    updateSession: (sessionId: string, args: {
      plan?: LinearAgentPlanStep[];
      addedExternalUrls?: Array<{ label: string; url: string }>;
    }) => call<{ ok: true }>({ method: "POST", path: sessionPath(sessionId, "update"), body: args }),

    startWork: (sessionId: string) => call<{ ok: true }>({ method: "POST", path: sessionPath(sessionId, "start"), body: {} }),

    /** WebSocket URL + headers for the account's wake-up stream. */
    subscribeTarget: async (): Promise<{ url: string; headers: Record<string, string> } | null> => {
      const accountToken = (await deps.getAccountAccessToken())?.trim() ?? "";
      if (!accountToken) return null;
      const url = `${deps.getRelayBaseUrl().replace(/\/+$/, "").replace(/^http/i, "ws")}/linear/agent/subscribe`;
      return { url, headers: { [ACCOUNT_RELAY_TOKEN_HEADER]: accountToken } };
    },
  };
}

export type LinearAgentRelayClient = ReturnType<typeof createLinearAgentRelayClient>;
