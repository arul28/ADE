/**
 * The local endpoint OpenCode's `ade-free` provider talks to.
 *
 * OpenCode keeps a provider's API key as fixed text, and the account token
 * expires every few minutes, so OpenCode never holds it. Each chat on an ADE
 * Free Model gets its own path on this server and a random key for that
 * path. The relay checks the key, then sends the request to the account
 * server with a fresh account token and the chat's id, and streams the
 * answer back unchanged.
 *
 * One server per process, on 127.0.0.1 and a random port: started at the
 * first registration, closed when the last one is released. No retries,
 * except one with a refreshed token when the account server refuses the
 * token (nothing reached Gravity then), and no answer under a status
 * OpenCode would retry on its own.
 */
import http from "node:http";
import https from "node:https";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  CLOUD_FREE_MODELS_CHAT_HEADER,
  CLOUD_PATHS,
} from "../../../../../account-directory/src/cloud/contract";
import type { AccountAuthService } from "../../../../../ade-cli/src/services/account/accountAuthService";
import { getSignedInAccountAccessToken } from "../../../../../ade-cli/src/services/account/accountAuthService";
import type { Logger } from "../logging/logger";
import { ADE_FREE_MODELS_SIGN_IN_MESSAGE } from "./adeFreeModelsLaunch";

/** Past Gravity's 8 MiB cap with room to spare: the account server refuses the rest. */
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
/** A reasoning model can stay silent for minutes; a socket quiet this long is dead. */
const UPSTREAM_IDLE_MS = 10 * 60_000;
/** Response headers that belong to one connection, never passed on. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
]);
/**
 * The statuses OpenCode retries on its own that must stay final (the AI SDK's
 * 408, 409 and 5xx; measured against the pinned 2.0.29: ten more attempts).
 * It retries other 4xx too when the body's `error.type` is
 * `rate_limit_error`, but never a 403. A 429 passes through: the account
 * server sends one only when waiting is right (Gravity's provider busy, or
 * the no-cards slow-down with `retry-after`), and refuses everything else
 * with a 403.
 */
const OPENCODE_RETRIED_STATUS = (status: number): boolean =>
  status === 408 || status === 409 || status >= 500;
/** The status OpenCode never retries, whatever the body says (measured on 2.0.29). */
const NO_RETRY_STATUS = 403;
const ROUTES: Record<string, { method: string; path: string }> = {
  "chat/completions": { method: "POST", path: CLOUD_PATHS.freeModelsChat },
  models: { method: "GET", path: CLOUD_PATHS.freeModelsModels },
};

export type FreeModelsRelayDeps = {
  /** The account server, or null when this process has none. */
  baseUrl: () => string | null;
  /** The signed-in account's token, or null when signed out. */
  accessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  /** Whether an ADE account is signed in here (a cloud computer's `ADE_ACCOUNT_TOKEN` counts). */
  signedIn: () => boolean;
  logger?: Pick<Logger, "info" | "warn"> | null;
};

export type FreeModelsRelayRegistration = {
  /** OpenCode's `baseURL` for this chat: `http://127.0.0.1:<port>/c/<chatId>/v1`. */
  baseURL: string;
  /** OpenCode's `apiKey` for this chat: valid on this chat's path only, until released. */
  apiKey: string;
  /** Ends the registration and any request it has in flight. */
  release: () => void;
};

export type FreeModelsRelay = {
  /** Whether a chat could use ADE Free Models here now: signed in, with an account server. */
  available: () => boolean;
  register: (chatId: string) => Promise<FreeModelsRelayRegistration>;
  /** Stops the server and every request (process shutdown). */
  close: () => void;
};

type Registration = {
  chatId: string;
  secretHash: Buffer;
  inflight: Set<() => void>;
  released: boolean;
};

/** The deps every process builds from its account service and its account server URL. */
export function freeModelsRelayDepsFor(args: {
  account: () => Pick<AccountAuthService, "getStatus" | "getAccessToken"> | null | undefined;
  baseUrl: () => string | null;
  logger?: FreeModelsRelayDeps["logger"];
}): FreeModelsRelayDeps {
  return {
    baseUrl: () => {
      try {
        return args.baseUrl()?.trim() || null;
      } catch {
        return null;
      }
    },
    accessToken: async (options) => {
      const account = args.account();
      return account ? await getSignedInAccountAccessToken(account, options) : null;
    },
    signedIn: () => {
      const status = args.account()?.getStatus();
      return Boolean(status && (status.signedIn || status.source === "env-token"));
    },
    logger: args.logger,
  };
}

let processRelay: FreeModelsRelay | null = null;

/**
 * This process's one relay. Every project scope of a brain shares it; the
 * account service is the machine's shared one, so the first caller's deps
 * serve the rest.
 */
export function processFreeModelsRelay(deps: () => FreeModelsRelayDeps): FreeModelsRelay {
  processRelay ??= createFreeModelsRelay(deps());
  return processRelay;
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: { message, type: status === 401 ? "authentication_error" : "invalid_request_error", code } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** The request body, or null when it passed the cap. */
async function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function createFreeModelsRelay(deps: FreeModelsRelayDeps): FreeModelsRelay {
  const registrations = new Map<string, Set<Registration>>();
  let server: http.Server | null = null;
  let listening: Promise<number> | null = null;
  let count = 0;

  const matchRegistration = (chatId: string, header: string | undefined): Registration | null => {
    const presented = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "")?.[1]?.trim();
    if (!presented) return null;
    const hash = sha256(presented);
    let found: Registration | null = null;
    // Every candidate is compared, so the time taken says nothing about which one matched.
    for (const registration of registrations.get(chatId) ?? []) {
      if (timingSafeEqual(hash, registration.secretHash) && !registration.released) found = registration;
    }
    return found;
  };

  /** One request to the account server; resolves with its response once the headers arrive. */
  const sendUpstream = (
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: Buffer | null,
    track: (abort: () => void) => () => void,
  ): Promise<http.IncomingMessage> => new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, { method, headers });
    const untrack = track(() => request.destroy(new Error("aborted")));
    request.setTimeout(UPSTREAM_IDLE_MS, () => request.destroy(new Error("The account server stopped answering.")));
    request.once("response", (response) => {
      response.once("close", untrack);
      resolve(response);
    });
    request.once("error", (error) => {
      untrack();
      reject(error);
    });
    request.end(body ?? undefined);
  });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // A web page can reach 127.0.0.1 too; OpenCode never sends an Origin.
    if (req.headers.origin) {
      req.resume();
      sendError(res, 403, "forbidden", "This endpoint is for ADE's own OpenCode.");
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const match = /^\/c\/([^/]+)\/v1\/(.+?)\/?$/.exec(pathname);
    let chatId = "";
    try {
      chatId = match ? decodeURIComponent(match[1]!) : "";
    } catch {
      chatId = "";
    }
    const registration = chatId ? matchRegistration(chatId, req.headers.authorization) : null;
    if (!registration) {
      req.resume();
      sendError(res, 401, "invalid_api_key", "This key is not valid for this chat.");
      return;
    }
    const route = ROUTES[match![2]!];
    if (!route || req.method !== route.method) {
      req.resume();
      sendError(res, 404, "not_found", "ADE Free Models serve only chat completions and the model list.");
      return;
    }
    let body: Buffer | null = null;
    if (route.method === "POST") {
      body = await readBody(req);
      if (!body) {
        sendError(res, 413, "free_models_too_large", "This request is too large for ADE Free Models.");
        return;
      }
    } else {
      req.resume();
    }
    const base = deps.baseUrl();
    if (!base) {
      sendError(res, NO_RETRY_STATUS, "free_models_unavailable", "This ADE has no account server to reach.");
      return;
    }
    let url: URL;
    try {
      url = new URL(`${base.replace(/\/+$/, "")}${route.path}`);
    } catch {
      sendError(res, NO_RETRY_STATUS, "free_models_unavailable", "This ADE has no account server to reach.");
      return;
    }

    // Everything this request started ends when OpenCode hangs up or the chat is released.
    const aborts = new Set<() => void>();
    const abortAll = () => {
      for (const abort of [...aborts]) abort();
    };
    registration.inflight.add(abortAll);
    const track = (abort: () => void) => {
      aborts.add(abort);
      return () => aborts.delete(abort);
    };
    res.once("close", () => {
      registration.inflight.delete(abortAll);
      if (!res.writableFinished) abortAll();
    });
    track(() => res.destroy());

    const headersFor = (token: string): Record<string, string> => ({
      authorization: `Bearer ${token}`,
      [CLOUD_FREE_MODELS_CHAT_HEADER.toLowerCase()]: registration.chatId,
      accept: typeof req.headers.accept === "string" ? req.headers.accept : "application/json",
      // Bytes pass through as they arrive; a compressed stream would be held for whole blocks.
      "accept-encoding": "identity",
      ...(body
        ? {
          "content-type": typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/json",
          "content-length": String(body.length),
        }
        : {}),
    });

    try {
      let token = await deps.accessToken().catch(() => null);
      if (!token) {
        sendError(res, 401, "ade_sign_in_required", ADE_FREE_MODELS_SIGN_IN_MESSAGE);
        return;
      }
      let upstream = await sendUpstream(url, route.method, headersFor(token), body, track);
      if (upstream.statusCode === 401) {
        // The account server refused the token before anything reached
        // Gravity: refresh it once and send again, never more.
        upstream.resume();
        token = await deps.accessToken({ forceRefresh: true }).catch(() => null);
        if (!token) {
          sendError(res, 401, "ade_sign_in_required", ADE_FREE_MODELS_SIGN_IN_MESSAGE);
          return;
        }
        if (res.destroyed) return;
        upstream = await sendUpstream(url, route.method, headersFor(token), body, track);
      }
      const responseHeaders: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) responseHeaders[name] = value;
      }
      const status = upstream.statusCode ?? 502;
      // OpenCode retries these up to ten times, and Gravity asks clients never
      // to retry: the same answer goes back under a status it takes as final.
      if (OPENCODE_RETRIED_STATUS(status)) responseHeaders["x-ade-upstream-status"] = String(status);
      res.writeHead(OPENCODE_RETRIED_STATUS(status) ? NO_RETRY_STATUS : status, responseHeaders);
      res.flushHeaders();
      upstream.on("error", () => res.destroy());
      upstream.pipe(res);
    } catch (error) {
      if (res.destroyed) return;
      deps.logger?.warn("free_models_relay.upstream_failed", {
        chatId: registration.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      sendError(res, NO_RETRY_STATUS, "free_models_unreachable", "ADE couldn't reach its account server. Check your connection and try again.");
    }
  };

  const closeServer = () => {
    const current = server;
    server = null;
    listening = null;
    if (!current) return;
    current.close();
    current.closeAllConnections?.();
  };

  const ensureListening = (): Promise<number> => {
    if (listening) return listening;
    const created = http.createServer((req, res) => {
      void handle(req, res).catch(() => res.destroy());
    });
    server = created;
    listening = new Promise<number>((resolve, reject) => {
      created.once("error", reject);
      created.listen(0, "127.0.0.1", () => {
        created.off("error", reject);
        resolve((created.address() as AddressInfo).port);
      });
    });
    created.unref();
    listening.catch(() => {
      if (server === created) closeServer();
    });
    return listening;
  };

  const release = (registration: Registration) => {
    if (registration.released) return;
    registration.released = true;
    const set = registrations.get(registration.chatId);
    set?.delete(registration);
    if (set && set.size === 0) registrations.delete(registration.chatId);
    for (const abort of [...registration.inflight]) abort();
    registration.inflight.clear();
    count -= 1;
    if (count === 0) closeServer();
  };

  return {
    available: () => deps.signedIn() && Boolean(deps.baseUrl()),
    register: async (chatId) => {
      const id = chatId.trim();
      if (!id) throw new Error("An ADE Free Models chat needs an id.");
      const apiKey = randomBytes(32).toString("base64url");
      const registration: Registration = { chatId: id, secretHash: sha256(apiKey), inflight: new Set(), released: false };
      const set = registrations.get(id) ?? new Set<Registration>();
      set.add(registration);
      registrations.set(id, set);
      count += 1;
      let port: number;
      try {
        port = await ensureListening();
      } catch (error) {
        release(registration);
        throw error;
      }
      deps.logger?.info("free_models_relay.registered", { chatId: id, port });
      return {
        baseURL: `http://127.0.0.1:${port}/c/${encodeURIComponent(id)}/v1`,
        apiKey,
        release: () => release(registration),
      };
    },
    close: () => {
      for (const set of [...registrations.values()]) {
        for (const registration of [...set]) release(registration);
      }
      closeServer();
    },
  };
}
