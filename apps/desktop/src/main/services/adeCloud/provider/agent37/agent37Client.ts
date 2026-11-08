/**
 * The Agent 37 API (`api.agent37.com`) and exec (`sandbox.agent37.app`) as a
 * `CloudProvider`, for one workspace key. The only code in ADE that knows
 * Agent 37's URLs, field names or error codes.
 *
 * Every failure becomes a `CloudProviderError` whose message is a sentence a
 * person can act on, keyed on Agent 37's stable `error.code` and never on its
 * prose. The key is only ever a header value: it is not logged, not put in an
 * error, and not returned.
 */

import {
  CLOUD_ACCESS_REFUSED,
  CloudProviderError,
  type CloudCreateInstanceInput,
  type CloudExecResult,
  type CloudInstance,
  type CloudProvider,
  type CloudUsage,
} from "../../cloudProvider";

const API_BASE_URL = "https://api.agent37.com/v1";
const SANDBOX_BASE_URL = "https://sandbox.agent37.app/v1";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Under the 30 s an IPC call may wait, so a slow answer reads as the provider's, not the app's. */
const REQUEST_TIMEOUT_MS = 20_000;
/** A create returns once the box is running, which takes tens of seconds. */
const CREATE_TIMEOUT_MS = 5 * 60_000;
/**
 * Lifecycle calls answer once the box reached its new state: sleep and wake in
 * seconds, a resize that moves hosts in minutes (it answers 202 past its own
 * limit and finishes on its own). A backup returns when it is written, minutes
 * on a big disk; giving up does not cancel it.
 */
const LIFECYCLE_TIMEOUT_MS = 3 * 60_000;
const BACKUP_TIMEOUT_MS = 15 * 60_000;

/** The sentence for a provider error code. the provider's own message is the fallback. */
function cloudErrorMessage(code: string, status: number): string {
  switch (code) {
    case "invalid_api_key":
    case "ip_not_allowed":
    case CLOUD_ACCESS_REFUSED:
      return "ADE Cloud refused this computer's access. Try again in a moment.";
    case "insufficient_balance":
    case "instance_suspended":
    case "instance_limit_reached":
    case "tier_limit":
      return "ADE Cloud can't start this machine right now. Try again in a few minutes.";
    case "no_capacity":
    case "capacity_unavailable":
      return "ADE Cloud has no room for this size right now. Try again in a few minutes or pick another size.";
    case "not_found":
      return "ADE Cloud has no such machine.";
    case "rate_limited":
      return "ADE Cloud is limiting requests right now. Try again in a minute.";
    case "try_again":
    case "wake_failed":
    case "wake_timeout":
    case "container_unreachable":
    case "upstream_unreachable":
    case "host_mesh_not_ready":
      return "The machine is busy changing state. Try again in a moment.";
    case "provisioning_failed":
      return "ADE Cloud could not start the machine.";
    default:
      if (status >= 500) return "ADE Cloud is having trouble right now. Try again in a moment.";
      return `ADE Cloud answered with an error (${status}).`;
  }
}

/** Both envelopes: `{error: {code, message}}` on the API and `{error: "code"}` on transport errors. */
function readErrorBody(body: unknown): { code: string | null; message: string | null } {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const error = record?.error;
  if (typeof error === "string") {
    return { code: error, message: typeof record?.message === "string" ? record.message : null };
  }
  if (error && typeof error === "object") {
    const inner = error as Record<string, unknown>;
    return {
      code: typeof inner.code === "string" ? inner.code : null,
      message: typeof inner.message === "string" ? inner.message : null,
    };
  }
  return { code: null, message: null };
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readMetadata(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function toInstance(raw: unknown): CloudInstance | null {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const id = str(record?.id);
  if (!record || !id) return null;
  const resources = record.resources && typeof record.resources === "object"
    ? record.resources as Record<string, unknown>
    : null;
  return {
    id,
    name: str(record.name),
    status: str(record.status) ?? "unknown",
    template: str(record.template),
    type: str(record.type),
    region: str(record.region),
    resources: resources
      ? { cpu: num(resources.cpu) ?? 0, memory: num(resources.memory) ?? 0, disk: num(resources.disk) ?? 0 }
      : null,
    url: str(record.url),
    pastDue: record.past_due === true,
    created: num(record.created),
    statusReason: readStatusReason(record.status_reason),
    metadata: readMetadata(record.metadata),
    autoSleep: record.auto_sleep === true,
    idleTimeoutSeconds: num(record.idle_timeout_seconds),
    publicPorts: readPublicPorts(record.public_ports),
  };
}

function readPublicPorts(value: unknown): CloudInstance["publicPorts"] {
  if (!Array.isArray(value)) return [];
  const out: CloudInstance["publicPorts"] = [];
  for (const entry of value) {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    const port = num(record?.port);
    const url = str(record?.url);
    if (port != null && url && /^https:\/\//.test(url)) out.push({ port, url, label: str(record?.label) });
  }
  return out;
}

function readStatusReason(value: unknown): CloudInstance["statusReason"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const code = str(record.code);
  const message = str(record.message);
  return code || message ? { code, message } : null;
}

export function createAgent37Provider(args: { apiKey: string; fetch?: FetchLike }): CloudProvider {
  const fetcher: FetchLike = args.fetch ?? ((input, init) => fetch(input, init));
  const apiKey = args.apiKey.trim();

  async function request(
    url: string,
    init: { method: string; body?: unknown; headers: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
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
        response = await fetcher(url, {
          method: init.method,
          headers: {
            accept: "application/json",
            ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
            ...init.headers,
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        if (controller.signal.aborted) throw timedOut();
        throw new CloudProviderError(
          `Could not reach ADE Cloud: ${error instanceof Error ? error.message : String(error)}`,
          "network",
          0,
        );
      }
      body = response.status === 204
        ? null
        : await response.json().catch(() => {
          // A body cut off by the timer is a timeout; one that isn't JSON is no body.
          if (controller.signal.aborted) throw timedOut();
          return null;
        });
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onCallerAbort);
    }
    if (!response.ok) {
      const { code } = readErrorBody(body);
      const providerCode = code ?? (response.status === 401 ? "invalid_api_key" : `http_${response.status}`);
      const refused = providerCode === "invalid_api_key" || providerCode === "ip_not_allowed";
      throw new CloudProviderError(cloudErrorMessage(providerCode, response.status), refused ? CLOUD_ACCESS_REFUSED : providerCode, response.status);
    }
    return body;
  }

  const api = (method: string, path: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal) =>
    request(`${API_BASE_URL}${path}`, {
      method,
      body,
      timeoutMs,
      signal,
      headers: { authorization: `Bearer ${apiKey}` },
    });

  return {
    async listInstances(): Promise<CloudInstance[]> {
      const body = await api("GET", "/instances") as Record<string, unknown> | null;
      const data = Array.isArray(body?.data) ? body.data : [];
      return data.map(toInstance).filter((instance): instance is CloudInstance => instance != null);
    },

    async getInstance(id: string): Promise<CloudInstance> {
      const instance = toInstance(await api("GET", `/instances/${encodeURIComponent(id)}`));
      if (!instance) throw new CloudProviderError("ADE Cloud answered with a machine ADE could not read.", "bad_response", 200);
      return instance;
    },

    /** Resolves once the box is `running` (the provider holds the request until then). */
    /**
     * `signal` stops waiting on a cancel. the provider may still make the box; the
     * caller finds it by its `ade_request_id` tag and deletes it.
     */
    async createInstance(input: CloudCreateInstanceInput, signal?: AbortSignal): Promise<CloudInstance> {
      const instance = toInstance(await api("POST", "/instances", {
        template: input.template,
        name: input.name,
        type: input.type,
        resources: input.resources,
        // Off until the box's brain says it keeps the box awake while it works
        // (cloudSleep.ts): the provider's idle timer counts only URL traffic, and
        // would put a brain that never pings to sleep under its work.
        auto_sleep: false,
        ...(input.env ? { env: input.env } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.publicPorts?.length ? { public_ports: input.publicPorts } : {}),
      }, CREATE_TIMEOUT_MS, signal));
      if (!instance) throw new CloudProviderError("ADE Cloud answered with a machine ADE could not read.", "bad_response", 201);
      return instance;
    },

    async deleteInstance(id: string): Promise<void> {
      await api("DELETE", `/instances/${encodeURIComponent(id)}`);
    },

    /** Checkpoints a running box: memory and processes kept, only the disk bills. */
    async sleepInstance(id: string): Promise<string> {
      const body = await api("POST", `/instances/${encodeURIComponent(id)}/sleep`, undefined, LIFECYCLE_TIMEOUT_MS) as Record<string, unknown> | null;
      return str(body?.status) ?? "sleeping";
    },

    /** Wakes a sleeping box or starts a stopped one. Answers with the new status. */
    async startInstance(id: string): Promise<string> {
      const body = await api("POST", `/instances/${encodeURIComponent(id)}/start`, undefined, LIFECYCLE_TIMEOUT_MS) as Record<string, unknown> | null;
      return str(body?.status) ?? "running";
    },

    /**
     * Changes the shape in place: the box restarts (in-memory state is lost,
     * files stay). Omitted fields keep their value; disk only grows.
     */
    async resizeInstance(id: string, resources: { cpu: number; memory: number; disk?: number }): Promise<string> {
      const body = await api("POST", `/instances/${encodeURIComponent(id)}/resize`, resources, LIFECYCLE_TIMEOUT_MS) as Record<string, unknown> | null;
      return str(body?.status) ?? "updating";
    },

    /** An on-demand backup, taken live. Once per box every 15 minutes (429 otherwise). */
    async createBackup(id: string): Promise<{ id: string | null; created: number | null; sizeBytes: number | null }> {
      const body = await api("POST", `/instances/${encodeURIComponent(id)}/backups`, undefined, BACKUP_TIMEOUT_MS) as Record<string, unknown> | null;
      return { id: str(body?.id), created: num(body?.created), sizeBytes: num(body?.size_bytes) };
    },

    /** the provider's idle sleep: on or off, and the seconds of quiet (300 to 86400) before it sleeps. */
    async setAutoSleep(id: string, policy: { autoSleep: boolean; idleTimeoutSeconds?: number }): Promise<void> {
      await api("PATCH", `/instances/${encodeURIComponent(id)}`, {
        auto_sleep: policy.autoSleep,
        ...(policy.idleTimeoutSeconds != null ? { idle_timeout_seconds: policy.idleTimeoutSeconds } : {}),
      });
    },

    /** A permanent unauthenticated URL for one port of the box (a random hostname: the URL is the credential). */
    async addPublicPort(id: string, input: { port: number; label: string }): Promise<{ port: number; url: string }> {
      const body = await api("POST", `/instances/${encodeURIComponent(id)}/public-ports`, input) as Record<string, unknown> | null;
      const url = str(body?.url);
      if (!url || !/^https:\/\//.test(url)) throw new CloudProviderError("ADE Cloud answered with a public port ADE could not read.", "bad_response", 201);
      return { port: num(body?.port) ?? input.port, url };
    },

    /**
     * Copies the box's disk into a new box (same image and files, its own id
     * and URLs). The copy boots fresh: nothing that ran on the source runs on
     * it. Answers with the copy, possibly still `provisioning` (202).
     */
    async forkInstance(
      id: string,
      input: { name?: string; resources?: { cpu: number; memory: number; disk?: number }; metadata?: Record<string, string> },
      signal?: AbortSignal,
    ): Promise<CloudInstance> {
      const instance = toInstance(await api("POST", `/instances/${encodeURIComponent(id)}/fork`, {
        ...(input.name ? { name: input.name } : {}),
        ...(input.resources ? { resources: input.resources } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        // The copy's own brain turns sleep on once it is signed in.
        auto_sleep: false,
      }, CREATE_TIMEOUT_MS, signal));
      if (!instance) throw new CloudProviderError("ADE Cloud answered with a machine ADE could not read.", "bad_response", 201);
      return instance;
    },

    /**
     * A time-boxed link to one port of the box that needs no key (the token
     * rides in the query). A credential: never logged, and kept short.
     */
    async signedUrl(id: string, input: { port: number; ttlSeconds: number }): Promise<{ url: string; expiresAt: number | null }> {
      const body = await api("POST", `/instances/${encodeURIComponent(id)}/signed-url`, { port: input.port, ttl_seconds: input.ttlSeconds }) as Record<string, unknown> | null;
      const url = str(body?.url);
      if (!url || !/^https:\/\//.test(url)) throw new CloudProviderError("ADE Cloud answered with a link ADE could not read.", "bad_response", 200);
      return { url, expiresAt: num(body?.expires_at) };
    },

    /** The box's label on the provider (up to 60 characters). */
    async setInstanceName(id: string, name: string): Promise<void> {
      await api("PATCH", `/instances/${encodeURIComponent(id)}`, { name: name.slice(0, 60) });
    },

    /** Replaces the box's metadata (the provider does not merge it). */
    async setInstanceMetadata(id: string, metadata: Record<string, string>): Promise<void> {
      await api("PATCH", `/instances/${encodeURIComponent(id)}`, { metadata });
    },

    /** What each instance spent in the window (at most 90 days). Compute lands within the hour. */
    async usage(window: { from: string; to?: string }): Promise<CloudUsage> {
      const query = new URLSearchParams({ from: window.from, ...(window.to ? { to: window.to } : {}) });
      const body = await api("GET", `/usage?${query.toString()}`) as Record<string, unknown> | null;
      const byInstance: Record<string, number> = {};
      for (const entry of Array.isArray(body?.instances) ? body.instances : []) {
        const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
        const id = str(record?.id);
        const micros = num(record?.total_micros);
        if (id && micros != null) byInstance[id] = micros / 1_000_000;
      }
      const byDay: Record<string, number> = {};
      for (const entry of Array.isArray(body?.days) ? body.days : []) {
        const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
        const date = str(record?.date);
        const micros = num(record?.total_micros);
        if (date && micros != null) byDay[date] = micros / 1_000_000;
      }
      return { from: str(body?.from), to: str(body?.to), byInstance, byDay };
    },

    /** Whether the workspace has this template; false on 404, throws on anything else. */
    async hasTemplate(name: string): Promise<boolean> {
      try {
        await api("GET", `/templates/${encodeURIComponent(name)}`);
        return true;
      } catch (error) {
        if (error instanceof CloudProviderError && error.status === 404) return false;
        throw error;
      }
    },

    /** Runs `sh -c command` on the box as its default user. A non-zero exit is a result, not an error. Exec wakes a sleeping box. */
    async exec(id: string, command: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CloudExecResult> {
      const body = await request(`${SANDBOX_BASE_URL}/instances/${encodeURIComponent(id)}/exec`, {
        method: "POST",
        body: { command },
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        headers: { "x-agent37-key": apiKey },
      }) as Record<string, unknown> | null;
      return {
        exitCode: num(body?.exit_code) ?? -1,
        stdout: typeof body?.stdout === "string" ? body.stdout : "",
        stderr: typeof body?.stderr === "string" ? body.stderr : "",
      };
    },
  };
}

/** The account vault item that holds the workspace key until ADE's server does (Cloud 2). */
export const AGENT37_KEY_VAULT_ITEM = "agent37";
