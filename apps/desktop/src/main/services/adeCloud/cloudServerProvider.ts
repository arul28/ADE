/**
 * ADE Cloud as a `CloudProvider`, through ADE's own server (the account
 * directory's `/cloud/*` routes, `apps/account-directory/src/cloud/contract.ts`).
 * The signed-in account token is the only credential: the provider's key lives
 * on the server and nothing on this computer ever sees it.
 *
 * The server answers errors as `{ error: { code, message } }` with `message`
 * already one plain sentence; that sentence is the error the person sees.
 */

import type { CloudAccountState } from "../../../shared/adeCloud";
import {
  CLOUD_ACCESS_REFUSED,
  CloudProviderError,
  type CloudCreateInstanceInput,
  type CloudExecResult,
  type CloudInstance,
  type CloudProvider,
  type CloudUsage,
} from "./cloudProvider";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Under the 30 s an IPC call may wait, so a slow answer reads as ADE Cloud's, not the app's. */
const REQUEST_TIMEOUT_MS = 20_000;
/** A create returns once the computer is running, which takes tens of seconds. */
const CREATE_TIMEOUT_MS = 5 * 60_000;
/** Lifecycle calls answer once the computer reached its new state. */
const LIFECYCLE_TIMEOUT_MS = 3 * 60_000;
const BACKUP_TIMEOUT_MS = 15 * 60_000;
/** The server applies an exec's own timeout; this leaves room for its answer. */
const EXEC_RESPONSE_GRACE_MS = 10_000;

const INSTANCES = "/cloud/instances";

export type CloudServerProviderDeps = {
  /** The signed-in account's token, or null when there is none now. */
  accessToken: () => Promise<string | null>;
  /** The account directory (`ADE_ACCOUNT_DIRECTORY_URL` points it at a local server in development). */
  baseUrl: () => string | null;
  /** Names this computer in the server's delete log. */
  deviceName?: () => string | null;
  fetch?: FetchLike;
};

export type CloudDeleteContext = { who?: string | null; reason?: string };

const BAD_RESPONSE = "ADE Cloud answered with something ADE could not read.";

function instancePath(id: string, action?: string): string {
  const base = `${INSTANCES}/${encodeURIComponent(id)}`;
  return action ? `${base}/${action}` : base;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readError(body: unknown): { code: string | null; message: string | null } {
  const error = record(record(body)?.error);
  return {
    code: typeof error?.code === "string" ? error.code : null,
    message: typeof error?.message === "string" ? error.message : null,
  };
}

function readInstance(body: unknown): CloudInstance {
  const instance = record(body);
  if (typeof instance?.id !== "string" || !instance.id) throw new CloudProviderError(BAD_RESPONSE, "bad_response", 200);
  return {
    ...instance,
    metadata: record(instance.metadata) as Record<string, string> ?? {},
    publicPorts: Array.isArray(instance.publicPorts) ? instance.publicPorts : [],
  } as CloudInstance;
}

function statusOf(body: unknown, fallback: string): string {
  const status = record(body)?.status;
  return typeof status === "string" ? status : fallback;
}

export function createCloudServerProvider(deps: CloudServerProviderDeps): CloudProvider {
  const fetcher: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));

  async function request(
    method: string,
    path: string,
    init: { body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const base = deps.baseUrl()?.replace(/\/+$/, "");
    if (!base) throw new CloudProviderError("ADE's account service isn't set up on this computer.", "network", 0);
    const token = await deps.accessToken();
    if (!token) throw new CloudProviderError("Sign in to ADE to use ADE Cloud.", CLOUD_ACCESS_REFUSED, 401);
    const controller = new AbortController();
    const timedOut = () => init.signal?.aborted
      ? new CloudProviderError("Cancelled.", "cancelled", 0)
      : new CloudProviderError("ADE Cloud did not answer in time. Try again.", "timeout", 0);
    // The caller's signal (a cancelled create) stops the request too.
    const onCallerAbort = () => controller.abort();
    if (init.signal?.aborted) controller.abort();
    else init.signal?.addEventListener("abort", onCallerAbort, { once: true });
    // The timer covers the body too: a server that sends headers and then
    // stalls would otherwise hang the read with no timeout at all.
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
    let response: Response;
    let body: unknown;
    try {
      try {
        response = await fetcher(`${base}${path}`, {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        if (controller.signal.aborted) throw timedOut();
        throw new CloudProviderError(`Could not reach ADE Cloud: ${error instanceof Error ? error.message : String(error)}`, "network", 0);
      }
      body = response.status === 204
        ? null
        : await response.json().catch(() => {
          if (controller.signal.aborted) throw timedOut();
          return null;
        });
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onCallerAbort);
    }
    if (!response.ok) {
      const { code, message } = readError(body);
      // Off the access list, the server answers every route 404. On the list route
      // that means this account, not one computer.
      const refused = response.status === 401 || code === "unauthorized"
        || (response.status === 404 && method === "GET" && path === INSTANCES);
      throw new CloudProviderError(
        message ?? (response.status >= 500 ? "ADE Cloud is having trouble right now. Try again in a moment." : `ADE Cloud answered with an error (${response.status}).`),
        refused ? CLOUD_ACCESS_REFUSED : code ?? `http_${response.status}`,
        response.status,
      );
    }
    return body;
  }

  return {
    async accessEnabled(): Promise<boolean> {
      return record(await request("GET", "/cloud/access"))?.enabled === true;
    },

    async getAccount(): Promise<CloudAccountState> {
      return await request("GET", "/cloud/account") as CloudAccountState;
    },

    async listInstances(): Promise<CloudInstance[]> {
      const data = record(await request("GET", INSTANCES))?.data;
      return Array.isArray(data) ? data.map(readInstance) : [];
    },

    async getInstance(id: string): Promise<CloudInstance> {
      return readInstance(await request("GET", instancePath(id)));
    },

    async createInstance(input: CloudCreateInstanceInput, signal?: AbortSignal): Promise<CloudInstance> {
      return readInstance(await request("POST", INSTANCES, { body: input, timeoutMs: CREATE_TIMEOUT_MS, signal }));
    },

    async deleteInstance(id: string, context?: CloudDeleteContext): Promise<void> {
      await request("DELETE", instancePath(id), {
        body: { who: context?.who ?? deps.deviceName?.() ?? null, reason: context?.reason ?? "user" },
      });
    },

    async sleepInstance(id: string): Promise<string> {
      return statusOf(await request("POST", instancePath(id, "sleep"), { body: {}, timeoutMs: LIFECYCLE_TIMEOUT_MS }), "sleeping");
    },

    async requestIdleSleep(id: string): Promise<string> {
      return statusOf(await request("POST", instancePath(id, "idle"), { body: {}, timeoutMs: LIFECYCLE_TIMEOUT_MS }), "sleeping");
    },

    async startInstance(id: string, options?: { reason?: "push_work" }): Promise<string> {
      return statusOf(await request("POST", instancePath(id, "start"), {
        body: options?.reason ? { reason: options.reason } : {},
        timeoutMs: LIFECYCLE_TIMEOUT_MS,
      }), "running");
    },

    async stopInstance(id: string): Promise<string> {
      return statusOf(await request("POST", instancePath(id, "stop"), { body: {}, timeoutMs: LIFECYCLE_TIMEOUT_MS }), "stopped");
    },

    async updateInstance(id: string): Promise<string> {
      return statusOf(await request("POST", instancePath(id, "update"), { body: {}, timeoutMs: LIFECYCLE_TIMEOUT_MS }), "updating");
    },

    async resizeInstance(id, resources, options): Promise<string> {
      return statusOf(await request("POST", instancePath(id, "resize"), {
        body: { ...resources, ...(options?.computerIdle ? { computerIdle: true } : {}) },
        timeoutMs: LIFECYCLE_TIMEOUT_MS,
      }), "updating");
    },

    async createBackup(id: string): Promise<{ id: string | null; created: number | null; sizeBytes: number | null }> {
      const body = record(await request("POST", instancePath(id, "backups"), { body: {}, timeoutMs: BACKUP_TIMEOUT_MS }));
      return {
        id: typeof body?.id === "string" ? body.id : null,
        created: typeof body?.created === "number" ? body.created : null,
        sizeBytes: typeof body?.sizeBytes === "number" ? body.sizeBytes : null,
      };
    },

    async setAutoSleep(id, policy): Promise<void> {
      await request("PUT", instancePath(id, "auto-sleep"), { body: policy });
    },

    async addPublicPort(id, input): Promise<{ port: number; url: string }> {
      const body = record(await request("POST", instancePath(id, "public-ports"), { body: input }));
      if (typeof body?.url !== "string" || !body.url) throw new CloudProviderError(BAD_RESPONSE, "bad_response", 200);
      return { port: typeof body.port === "number" ? body.port : input.port, url: body.url };
    },

    async forkInstance(id, input, signal): Promise<CloudInstance> {
      return readInstance(await request("POST", instancePath(id, "fork"), { body: input, timeoutMs: CREATE_TIMEOUT_MS, signal }));
    },

    async signedUrl(id, input): Promise<{ url: string; expiresAt: number | null }> {
      const body = record(await request("POST", instancePath(id, "signed-url"), { body: input }));
      if (typeof body?.url !== "string" || !body.url) throw new CloudProviderError(BAD_RESPONSE, "bad_response", 200);
      return { url: body.url, expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null };
    },

    async setInstanceName(id, name): Promise<void> {
      await request("PUT", instancePath(id, "name"), { body: { name: name.slice(0, 60) } });
    },

    async setInstanceMetadata(id, metadata): Promise<void> {
      await request("PUT", instancePath(id, "metadata"), { body: { metadata } });
    },

    async usage(window): Promise<CloudUsage> {
      const query = new URLSearchParams({ from: window.from, ...(window.to ? { to: window.to } : {}) });
      const body = record(await request("GET", `/cloud/usage?${query.toString()}`));
      return {
        from: typeof body?.from === "string" ? body.from : null,
        to: typeof body?.to === "string" ? body.to : null,
        byInstance: record(body?.byInstance) as Record<string, number> ?? {},
        byDay: record(body?.byDay) as Record<string, number> ?? {},
      };
    },

    async hasTemplate(): Promise<boolean> {
      return record(await request("GET", "/cloud/templates/current"))?.exists === true;
    },

    async exec(id, command, options): Promise<CloudExecResult> {
      const body = record(await request("POST", instancePath(id, "exec"), {
        body: { command, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
        timeoutMs: (options?.timeoutMs ?? REQUEST_TIMEOUT_MS) + EXEC_RESPONSE_GRACE_MS,
        signal: options?.signal,
      }));
      return {
        exitCode: typeof body?.exitCode === "number" ? body.exitCode : -1,
        stdout: typeof body?.stdout === "string" ? body.stdout : "",
        stderr: typeof body?.stderr === "string" ? body.stderr : "",
      };
    },

    async billingCheckout(): Promise<{ url: string }> {
      const body = record(await request("POST", "/cloud/billing/checkout"));
      if (typeof body?.url !== "string" || !body.url) throw new CloudProviderError(BAD_RESPONSE, "bad_response", 200);
      return { url: body.url };
    },

    async billingPortal(): Promise<{ url: string }> {
      const body = record(await request("POST", "/cloud/billing/portal"));
      if (typeof body?.url !== "string" || !body.url) throw new CloudProviderError(BAD_RESPONSE, "bad_response", 200);
      return { url: body.url };
    },

    async setExtraHours(enabled: boolean): Promise<CloudAccountState> {
      return await request("POST", "/cloud/billing/extra-hours", { body: { enabled } }) as CloudAccountState;
    },
  };
}
