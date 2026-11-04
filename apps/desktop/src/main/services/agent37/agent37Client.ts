/**
 * The Agent37 control plane (`api.agent37.com`) and exec (`sandbox.agent37.app`)
 * for one workspace key.
 *
 * Every failure becomes an `Agent37Error` whose message is a sentence a person
 * can act on (box limit, empty wallet, bad key), keyed on Agent37's stable
 * `error.code` and never on its prose. The key is only ever a header value: it
 * is not logged, not put in an error, and not returned.
 */

import { AGENT37_API_BASE_URL, AGENT37_SANDBOX_BASE_URL } from "../../../shared/agent37";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Agent37Instance = {
  id: string;
  name: string | null;
  status: string;
  template: string | null;
  type: string | null;
  region: string | null;
  resources: { cpu: number; memory: number; disk: number } | null;
  url: string | null;
  pastDue: boolean;
  created: number | null;
};

export type Agent37Billing = {
  balanceUsd: number | null;
  tier: number | null;
  instanceLimit: number | null;
  pastDue: boolean;
};

export type Agent37ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type Agent37CreateInstanceInput = {
  template: string;
  name: string;
  type: "default" | "vm";
  resources: { cpu: number; memory: number; disk: number };
  env?: Record<string, string>;
  metadata?: Record<string, string>;
};

export class Agent37Error extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "Agent37Error";
  }
}

/** Under the 30 s an IPC call may wait, so a slow answer reads as Agent37's, not the app's. */
const REQUEST_TIMEOUT_MS = 20_000;
/** A create returns once the box is running, which takes tens of seconds. */
const CREATE_TIMEOUT_MS = 5 * 60_000;

/** The sentence for an Agent37 error code. Agent37's own message is the fallback. */
export function agent37ErrorMessage(code: string, status: number, upstream: string | null): string {
  switch (code) {
    case "invalid_api_key":
      return "Agent37 did not accept this API key. Check that you copied all of it, or make a new one.";
    case "ip_not_allowed":
      return "This Agent37 key only works from certain addresses, and this computer's isn't one of them.";
    case "insufficient_balance":
      return "Your Agent37 wallet is too low to make this machine (it needs a day of its price). Top it up and try again.";
    case "instance_suspended":
      return "Your Agent37 wallet is past due, so its machines are suspended. Top it up to use them again.";
    case "instance_limit_reached":
      return "Your Agent37 workspace is at its machine limit, sleeping ones included. Delete one, or top up to raise the limit.";
    case "tier_limit":
      return "Agent37 unlocks VMs and bigger sizes after your first top-up.";
    case "no_capacity":
    case "capacity_unavailable":
      return "Agent37 has no room for this size right now. Try again in a few minutes or pick another size.";
    case "not_found":
      return "Agent37 has no such machine or template in this workspace.";
    case "rate_limited":
      return "Agent37 is limiting requests right now. Try again in a minute.";
    case "try_again":
    case "wake_failed":
    case "wake_timeout":
    case "container_unreachable":
    case "upstream_unreachable":
    case "host_mesh_not_ready":
      return "The Agent37 machine is busy changing state. Try again in a moment.";
    case "provisioning_failed":
      return `Agent37 could not start the machine${upstream ? `: ${upstream}` : "."}`;
    default:
      if (status >= 500) return "Agent37 is having trouble right now. Try again in a moment.";
      return upstream ? `Agent37: ${upstream}` : `Agent37 answered with an error (${status}).`;
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

function toInstance(raw: unknown): Agent37Instance | null {
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
  };
}

export function createAgent37Client(args: { apiKey: string; fetch?: FetchLike }) {
  const fetcher: FetchLike = args.fetch ?? ((input, init) => fetch(input, init));
  const apiKey = args.apiKey.trim();

  async function request(
    url: string,
    init: { method: string; body?: unknown; headers: Record<string, string>; timeoutMs?: number },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
    let response: Response;
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
      if (controller.signal.aborted) throw new Agent37Error("Agent37 did not answer in time. Try again.", "timeout", 0);
      throw new Agent37Error(
        `Could not reach Agent37: ${error instanceof Error ? error.message : String(error)}`,
        "network",
        0,
      );
    } finally {
      clearTimeout(timer);
    }
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const { code, message } = readErrorBody(body);
      const resolvedCode = code ?? (response.status === 401 ? "invalid_api_key" : `http_${response.status}`);
      throw new Agent37Error(agent37ErrorMessage(resolvedCode, response.status, message), resolvedCode, response.status);
    }
    return body;
  }

  const api = (method: string, path: string, body?: unknown, timeoutMs?: number) =>
    request(`${AGENT37_API_BASE_URL}${path}`, {
      method,
      body,
      timeoutMs,
      headers: { authorization: `Bearer ${apiKey}` },
    });

  return {
    async billing(): Promise<Agent37Billing> {
      const body = await api("GET", "/billing") as Record<string, unknown> | null;
      return {
        balanceUsd: num(body?.balance_usd),
        tier: num(body?.tier),
        instanceLimit: num(body?.instance_limit),
        pastDue: body?.past_due === true,
      };
    },

    async listInstances(): Promise<Agent37Instance[]> {
      const body = await api("GET", "/instances") as Record<string, unknown> | null;
      const data = Array.isArray(body?.data) ? body.data : [];
      return data.map(toInstance).filter((instance): instance is Agent37Instance => instance != null);
    },

    async getInstance(id: string): Promise<Agent37Instance> {
      const instance = toInstance(await api("GET", `/instances/${encodeURIComponent(id)}`));
      if (!instance) throw new Agent37Error("Agent37 answered with a machine ADE could not read.", "bad_response", 200);
      return instance;
    },

    /** Resolves once the box is `running` (Agent37 holds the request until then). */
    async createInstance(input: Agent37CreateInstanceInput): Promise<Agent37Instance> {
      const instance = toInstance(await api("POST", "/instances", {
        template: input.template,
        name: input.name,
        type: input.type,
        resources: input.resources,
        // ADE owns sleep and wake; Agent37's idle timer counts only URL traffic
        // and would put a working brain to sleep.
        auto_sleep: false,
        ...(input.env ? { env: input.env } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }, CREATE_TIMEOUT_MS));
      if (!instance) throw new Agent37Error("Agent37 answered with a machine ADE could not read.", "bad_response", 201);
      return instance;
    },

    async deleteInstance(id: string): Promise<void> {
      await api("DELETE", `/instances/${encodeURIComponent(id)}`);
    },

    /** Whether the workspace has this template; false on 404, throws on anything else. */
    async hasTemplate(name: string): Promise<boolean> {
      try {
        await api("GET", `/templates/${encodeURIComponent(name)}`);
        return true;
      } catch (error) {
        if (error instanceof Agent37Error && error.status === 404) return false;
        throw error;
      }
    },

    /** Runs `sh -c command` on the box as its default user. A non-zero exit is a result, not an error. */
    async exec(id: string, command: string, options?: { timeoutMs?: number }): Promise<Agent37ExecResult> {
      const body = await request(`${AGENT37_SANDBOX_BASE_URL}/instances/${encodeURIComponent(id)}/exec`, {
        method: "POST",
        body: { command },
        timeoutMs: options?.timeoutMs,
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

export type Agent37Client = ReturnType<typeof createAgent37Client>;
