import type { CloudExecResult, CloudInstance } from "./contract";

/**
 * Agent 37's API (`api.agent37.com`) and exec (`sandbox.agent37.app`), for the
 * one workspace key this Worker holds. The only code on the server that knows
 * its URLs, field names or error codes.
 *
 * The key is only ever a header value: never logged, never put in an error,
 * never returned.
 */

const API_BASE_URL = "https://api.agent37.com/v1";
const SANDBOX_BASE_URL = "https://sandbox.agent37.app/v1";

const REQUEST_TIMEOUT_MS = 20_000;
/** A create or fork returns once the computer is up, which takes tens of seconds. */
const CREATE_TIMEOUT_MS = 5 * 60_000;
/** Lifecycle calls answer at the new state: a move between hosts takes minutes. */
const LIFECYCLE_TIMEOUT_MS = 3 * 60_000;
const BACKUP_TIMEOUT_MS = 15 * 60_000;

export class CloudProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudProviderError";
  }
}

export const TRY_AGAIN_CODE = "try_again";

const BUSY_CHANGING_STATE = "The computer is busy changing state. Try again in a moment.";

/**
 * ADE's own sentence for each provider error code it words itself: these
 * say more than the provider would, so a refusal with one of them never shows
 * the provider's text (`cloudRefusalMessage`).
 */
const OWN_SENTENCES: Readonly<Record<string, string>> = {
  invalid_api_key: "ADE Cloud refused this request. Try again in a moment.",
  ip_not_allowed: "ADE Cloud refused this request. Try again in a moment.",
  instance_limit_reached: "ADE Cloud is at capacity right now. Try again in a few minutes.",
  insufficient_balance: "ADE Cloud can't start this computer right now. Try again in a few minutes.",
  instance_suspended: "ADE Cloud can't start this computer right now. Try again in a few minutes.",
  tier_limit: "ADE Cloud can't start this computer right now. Try again in a few minutes.",
  no_capacity: "ADE Cloud has no room for this size right now. Try again in a few minutes or pick another size.",
  capacity_unavailable: "ADE Cloud has no room for this size right now. Try again in a few minutes or pick another size.",
  not_found: "ADE Cloud has no such computer.",
  rate_limited: "ADE Cloud is limiting requests right now. Try again in a minute.",
  [TRY_AGAIN_CODE]: BUSY_CHANGING_STATE,
  wake_failed: BUSY_CHANGING_STATE,
  wake_timeout: BUSY_CHANGING_STATE,
  container_unreachable: BUSY_CHANGING_STATE,
  upstream_unreachable: BUSY_CHANGING_STATE,
  host_mesh_not_ready: BUSY_CHANGING_STATE,
  provisioning_failed: "ADE Cloud could not start the computer.",
  timeout: "ADE Cloud did not answer in time. Try again.",
  network: "Could not reach ADE Cloud. Try again.",
};

/** The sentence a person reads for a provider error code. */
export function cloudErrorMessage(code: string, status: number): string {
  if (Object.hasOwn(OWN_SENTENCES, code)) return OWN_SENTENCES[code]!;
  // The provider's catch-all: its own text says which cause (`cloudRefusalMessage`); this is the fallback.
  if (code === "invalid_request") return "ADE Cloud couldn't do that with this computer right now.";
  if (status >= 500) return "ADE Cloud is having trouble right now. Try again in a moment.";
  return `ADE Cloud answered with an error (${status}).`;
}

/**
 * The provider's own explanation (`{error: {code, message}}`), made safe to
 * show: one line, no links, no key- or token-like strings, no IP addresses or
 * internal host and node names, the provider named as ADE Cloud, at most 240
 * characters. Null when nothing readable is left.
 */
function providerErrorDetail(body: unknown): string | null {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const error = record?.error;
  const raw = error && typeof error === "object" ? (error as Record<string, unknown>).message : record?.message;
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    // A link goes with the words that point at it ("See https://…").
    .replace(/\s*\b(?:see|visit|read)\s+(?:the\s+docs\s+(?:at\s+)?)?https?:\/\/\S+/gi, "")
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\bBearer\s+\S+/gi, "")
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, "…")
    // IPv4 (with an optional port or prefix), then IPv6 (at least three groups, `::` forms included).
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+|\/\d+)?\b/g, "…")
    .replace(/(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi, (match) => (/[0-9a-f]/i.test(match) ? "…" : match))
    // Host and node names: dotted names (`node-3.internal`, `ip-10-0-0-1.ec2.internal`) and node-style ids.
    .replace(/\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:internal|local|lan|cluster|svc|compute|ec2|corp|intra|net|io|com|cloud|app)\b(?::\d+)?/gi, "…")
    .replace(/\b(?:node|host|worker|ip)-[a-z0-9-]*\d[a-z0-9-]*\b/gi, "…")
    .replace(/\bagent\s?37\b/gi, "ADE Cloud")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[A-Za-z]{3}/.test(cleaned)) return null;
  const clipped = cleaned.length > 240 ? `${cleaned.slice(0, 239)}…` : cleaned;
  return /[.!?…]$/.test(clipped) ? clipped : `${clipped}.`;
}

/**
 * The sentence for a refused request: ADE's own for the codes it words
 * itself, else the provider's own explanation after ADE's "couldn't". The
 * provider's `invalid_request` covers many causes (a lifecycle action in the
 * wrong state, a shape it doesn't take), and one fixed sentence hid which.
 */
export function cloudRefusalMessage(code: string, status: number, body: unknown): string {
  // A refusal of ADE's own key, or the provider's own trouble, is ADE's to word: neither is the person's to act on.
  const refusal = status >= 400 && status < 500 && status !== 401 && status !== 403;
  if (Object.hasOwn(OWN_SENTENCES, code) || !refusal) return cloudErrorMessage(code, status);
  const detail = providerErrorDetail(body);
  return detail ? `ADE Cloud couldn't do that. ${detail}` : cloudErrorMessage(code, status);
}

/** Both envelopes: `{error: {code}}` on the API and `{error: "code"}` on transport errors. */
function readErrorCode(body: unknown): string | null {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const error = record?.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const code = (error as Record<string, unknown>).code;
    return typeof code === "string" ? code : null;
  }
  return null;
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

export type CloudCreateInput = {
  template: string;
  name: string;
  type: "default" | "vm";
  resources: { cpu: number; memory: number; disk: number };
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  publicPorts?: Array<{ port: number; label: string }>;
};

export type CloudUsageWindow = {
  /** Awake minutes per instance, for the whole workspace. */
  instances: Array<{ id: string; awakeMinutes: number }>;
};

export type CloudBilling = {
  balanceUsd: number | null;
  instanceLimit: number | null;
  autoTopUpEnabled: boolean;
};

export type CloudEvent = { type: string; at: number };

export type CloudProvider = ReturnType<typeof createCloudProvider>;

export function createCloudProvider(apiKey: string, fetcher: typeof fetch = fetch) {
  const key = apiKey.trim();

  async function request(
    url: string,
    init: { method: string; body?: unknown; headers: Record<string, string>; timeoutMs?: number },
  ): Promise<unknown> {
    const controller = new AbortController();
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
          // Workers has no `redirect: "error"`; a 3xx falls through as not ok below.
          redirect: "manual",
        });
      } catch (error) {
        if (controller.signal.aborted) throw new CloudProviderError(cloudErrorMessage("timeout", 0), "timeout", 0);
        console.warn(JSON.stringify({ kind: "cloud.provider_fetch_failed", message: error instanceof Error ? error.message : "unknown" }));
        throw new CloudProviderError(cloudErrorMessage("network", 0), "network", 0);
      }
      body = response.status === 204 ? null : await response.json().catch(() => {
        if (controller.signal.aborted) throw new CloudProviderError(cloudErrorMessage("timeout", 0), "timeout", 0);
        return null;
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const code = readErrorCode(body) ?? (response.status === 401 ? "invalid_api_key" : `http_${response.status}`);
      throw new CloudProviderError(cloudRefusalMessage(code, response.status, body), code, response.status);
    }
    return body;
  }

  const api = (method: string, path: string, body?: unknown, timeoutMs?: number) =>
    request(`${API_BASE_URL}${path}`, { method, body, timeoutMs, headers: { authorization: `Bearer ${key}` } });

  const instancePath = (id: string, action?: string) =>
    `/instances/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

  const statusOf = (body: unknown, fallback: string): string =>
    str((body as Record<string, unknown> | null)?.status) ?? fallback;

  return {
    async listInstances(): Promise<CloudInstance[]> {
      const body = await api("GET", "/instances") as Record<string, unknown> | null;
      const data = Array.isArray(body?.data) ? body.data : [];
      return data.map(toInstance).filter((instance): instance is CloudInstance => instance != null);
    },

    async getInstance(id: string): Promise<CloudInstance> {
      const instance = toInstance(await api("GET", instancePath(id)));
      if (!instance) throw new CloudProviderError("ADE Cloud answered with a computer ADE could not read.", "bad_response", 200);
      return instance;
    },

    /** Resolves once the computer is running (the provider holds the request until then). */
    async createInstance(input: CloudCreateInput): Promise<CloudInstance> {
      const instance = toInstance(await api("POST", "/instances", {
        template: input.template,
        name: input.name,
        type: input.type,
        resources: input.resources,
        auto_sleep: false,
        ...(input.env ? { env: input.env } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.publicPorts?.length ? { public_ports: input.publicPorts } : {}),
      }, CREATE_TIMEOUT_MS));
      if (!instance) throw new CloudProviderError("ADE Cloud answered with a computer ADE could not read.", "bad_response", 201);
      return instance;
    },

    async deleteInstance(id: string): Promise<void> {
      await api("DELETE", instancePath(id));
    },

    async sleepInstance(id: string): Promise<string> {
      return statusOf(await api("POST", instancePath(id, "sleep"), undefined, LIFECYCLE_TIMEOUT_MS), "sleeping");
    },

    async startInstance(id: string): Promise<string> {
      return statusOf(await api("POST", instancePath(id, "start"), undefined, LIFECYCLE_TIMEOUT_MS), "running");
    },

    async stopInstance(id: string): Promise<string> {
      return statusOf(await api("POST", instancePath(id, "stop"), undefined, LIFECYCLE_TIMEOUT_MS), "stopped");
    },

    /** Pulls the pinned template onto the computer, keeping its disk. The system layer resets. */
    async updateInstance(id: string, template: string): Promise<string> {
      return statusOf(await api("POST", instancePath(id, "update"), { template }, LIFECYCLE_TIMEOUT_MS), "updating");
    },

    async resizeInstance(id: string, resources: { cpu?: number; memory?: number; disk?: number }): Promise<string> {
      return statusOf(await api("POST", instancePath(id, "resize"), resources, LIFECYCLE_TIMEOUT_MS), "updating");
    },

    async createBackup(id: string): Promise<{ id: string | null; created: number | null; sizeBytes: number | null }> {
      const body = await api("POST", instancePath(id, "backups"), undefined, BACKUP_TIMEOUT_MS) as Record<string, unknown> | null;
      return { id: str(body?.id), created: num(body?.created), sizeBytes: num(body?.size_bytes) };
    },

    async setAutoSleep(id: string, policy: { autoSleep: boolean; idleTimeoutSeconds?: number }): Promise<void> {
      await api("PATCH", instancePath(id), {
        auto_sleep: policy.autoSleep,
        ...(policy.idleTimeoutSeconds != null ? { idle_timeout_seconds: policy.idleTimeoutSeconds } : {}),
      });
    },

    async addPublicPort(id: string, input: { port: number; label: string }): Promise<{ port: number; url: string }> {
      const body = await api("POST", instancePath(id, "public-ports"), input) as Record<string, unknown> | null;
      const url = str(body?.url);
      if (!url || !/^https:\/\//.test(url)) throw new CloudProviderError("ADE Cloud answered with a public port ADE could not read.", "bad_response", 201);
      return { port: num(body?.port) ?? input.port, url };
    },

    async forkInstance(
      id: string,
      input: { name?: string; resources?: { cpu: number; memory: number; disk?: number }; metadata?: Record<string, string> },
    ): Promise<CloudInstance> {
      const instance = toInstance(await api("POST", instancePath(id, "fork"), {
        ...(input.name ? { name: input.name } : {}),
        ...(input.resources ? { resources: input.resources } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        auto_sleep: false,
      }, CREATE_TIMEOUT_MS));
      if (!instance) throw new CloudProviderError("ADE Cloud answered with a computer ADE could not read.", "bad_response", 201);
      return instance;
    },

    /** A time-boxed link to one port. A secret: never logged. */
    async signedUrl(id: string, input: { port: number; ttlSeconds: number }): Promise<{ url: string; expiresAt: number | null }> {
      const body = await api("POST", instancePath(id, "signed-url"), { port: input.port, ttl_seconds: input.ttlSeconds }) as Record<string, unknown> | null;
      const url = str(body?.url);
      if (!url || !/^https:\/\//.test(url)) throw new CloudProviderError("ADE Cloud answered with a link ADE could not read.", "bad_response", 200);
      return { url, expiresAt: num(body?.expires_at) };
    },

    async setInstanceName(id: string, name: string): Promise<void> {
      await api("PATCH", instancePath(id), { name: name.slice(0, 60) });
    },

    async setInstanceMetadata(id: string, metadata: Record<string, string>): Promise<void> {
      await api("PATCH", instancePath(id), { metadata });
    },

    /** How long each instance was awake over a window; deleted instances stay in it. */
    async usage(window: { from: string; to?: string }): Promise<CloudUsageWindow> {
      const query = new URLSearchParams({ from: window.from, ...(window.to ? { to: window.to } : {}) });
      const body = await api("GET", `/usage?${query.toString()}`) as Record<string, unknown> | null;
      const instances: CloudUsageWindow["instances"] = [];
      for (const entry of Array.isArray(body?.instances) ? body.instances : []) {
        const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
        const id = str(record?.id);
        if (!id) continue;
        instances.push({ id, awakeMinutes: num(record?.awake_minutes) ?? 0 });
      }
      return { instances };
    },

    /** Oldest first. Read this before a delete: the history goes with the instance. */
    async instanceEvents(id: string): Promise<CloudEvent[]> {
      const body = await api("GET", instancePath(id, "events")) as Record<string, unknown> | null;
      const out: CloudEvent[] = [];
      for (const entry of Array.isArray(body?.events) ? body.events : []) {
        const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
        const type = str(record?.type);
        const at = num(record?.at);
        if (type && at != null) out.push({ type, at });
      }
      return out;
    },

    async billing(): Promise<CloudBilling> {
      const body = await api("GET", "/billing") as Record<string, unknown> | null;
      const topUp = body?.auto_top_up && typeof body.auto_top_up === "object" ? body.auto_top_up as Record<string, unknown> : null;
      return {
        balanceUsd: num(body?.balance_usd),
        instanceLimit: num(body?.instance_limit),
        autoTopUpEnabled: topUp?.enabled === true,
      };
    },

    /** Whether the workspace has this template; false on 404. */
    async hasTemplate(name: string): Promise<boolean> {
      try {
        await api("GET", `/templates/${encodeURIComponent(name)}`);
        return true;
      } catch (error) {
        if (error instanceof CloudProviderError && error.status === 404) return false;
        throw error;
      }
    },

    /** Runs `sh -c command`. A non-zero exit is a result, not an error. Exec wakes a sleeping computer. */
    async exec(id: string, command: string, timeoutMs?: number): Promise<CloudExecResult> {
      const body = await request(`${SANDBOX_BASE_URL}/instances/${encodeURIComponent(id)}/exec`, {
        method: "POST",
        body: { command },
        timeoutMs,
        headers: { "x-agent37-key": key },
      }) as Record<string, unknown> | null;
      return {
        exitCode: num(body?.exit_code) ?? -1,
        stdout: typeof body?.stdout === "string" ? body.stdout : "",
        stderr: typeof body?.stderr === "string" ? body.stderr : "",
      };
    },
  };
}
