/**
 * The Test button: one tiny request through a harness + source + model, and
 * the verdict it leaves behind.
 *
 * It resolves the source exactly as a launch does (`resolveRouteSource`), so a
 * Test and a launch can never disagree about which key, endpoint or sign-in is
 * in play. Two answers are recorded as a definite no so the next launch routes
 * around them: "does not support this protocol", and a request that never
 * answers at all (a hang is as unusable as a refusal, and the lamer failure to
 * leave standing). Every other failure (auth, balance, rate limit, plain
 * network error) leaves the protocol question unanswered, because a wrong key
 * or an empty balance says nothing about whether the protocol works.
 */

import { randomUUID } from "node:crypto";

import {
  HARNESS_ROUTE_PROTOCOLS,
  modelProtocols,
  resolveHarnessRoute,
  ROUTE_PROTOCOLS,
  stripTrailingV1,
  type HarnessRouteSource,
  type HarnessRouteTestResult,
  type RouteProtocol,
} from "../../../shared/harnessRoutes";
import { isHarnessPresetBody } from "../../../shared/harnessPresets";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { readRouteProbe, recordRouteProbe } from "./harnessRouteProbes";
import { OPENCODE_SESSION_HEADER, resolveRouteSource } from "./harnessRouteLaunch";

/** The one validator every entry point (IPC and the action bus) runs. */
export function requireHarnessRouteSource(value: unknown): HarnessRouteSource["source"] {
  if (!value || typeof value !== "object") throw new Error("source is required.");
  const raw = value as Record<string, unknown>;
  if (raw.kind === "opencode" && typeof raw.providerId === "string" && raw.providerId.trim()) {
    return { kind: "opencode", providerId: raw.providerId.trim() };
  }
  if (
    raw.kind === "key"
    && typeof raw.provider === "string" && raw.provider.trim()
    && typeof raw.credentialId === "string" && raw.credentialId.trim()
  ) {
    return {
      kind: "key",
      provider: raw.provider.trim(),
      credentialId: raw.credentialId.trim(),
      label: typeof raw.label === "string" ? raw.label : raw.provider.trim(),
    };
  }
  throw new Error("source must be an OpenCode sign-in or a stored key.");
}

const PROTOCOL_UNSUPPORTED = /does not support this protocol|unsupported (protocol|endpoint)|not supported on this endpoint/i;

type Fetch = typeof fetch;

async function pingProtocol(args: {
  protocol: RouteProtocol;
  baseUrl: string;
  token: string;
  model: string;
  sessionHeader: string | null;
  fetchImpl: Fetch;
  timeoutMs: number;
}): Promise<{ ok: boolean; error?: string; timedOut: boolean; latencyMs: number }> {
  const { protocol, baseUrl, token, model } = args;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "user-agent": "ade-harness-test/1.0",
  };
  if (args.sessionHeader) headers[OPENCODE_SESSION_HEADER] = args.sessionHeader;
  let url: string;
  let body: Record<string, unknown>;
  if (protocol === "anthropic") {
    // Anthropic's first-party API requires x-api-key; Anthropic-compatible
    // gateways use Bearer auth and must keep it (for example OpenRouter).
    let hostname: string | null = null;
    try {
      hostname = new URL(baseUrl).hostname;
    } catch {
      // Leave endpoint validation and fetch failure handling to the request path.
    }
    if (hostname === "api.anthropic.com") {
      delete headers.authorization;
      headers["x-api-key"] = token;
    }
    url = `${stripTrailingV1(baseUrl)}/v1/messages`;
    headers["anthropic-version"] = "2023-06-01";
    body = { model, max_tokens: 8, messages: [{ role: "user", content: "Reply with OK." }] };
  } else if (protocol === "openai-chat") {
    url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    body = { model, max_tokens: 8, messages: [{ role: "user", content: "Reply with OK." }] };
  } else {
    url = `${baseUrl.replace(/\/+$/, "")}/responses`;
    body = { model, max_output_tokens: 16, input: "Reply with OK." };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const started = Date.now();
  try {
    const response = await args.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const text = await response.text().catch(() => "");
    if (response.ok) return { ok: true, timedOut: false, latencyMs };
    return { ok: false, timedOut: false, error: summarizeError(text, response.status), latencyMs };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      ok: false,
      timedOut,
      error: timedOut ? "The endpoint did not answer in time." : (error instanceof Error ? error.message : String(error)),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeError(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON.
  }
  const trimmed = body.trim().slice(0, 200);
  return trimmed ? `HTTP ${status}: ${trimmed}` : `HTTP ${status}`;
}

/**
 * Send one tiny request for a (harness, source, model) and remember what the
 * endpoint said. Tries the protocols the harness can speak first (a direct
 * route), then the rest (a proxy route), then any the seed ruled out.
 */
export async function testHarnessRoute(
  args: { harness: unknown; source: unknown; model: unknown },
  deps: { adeHome?: string; fetchImpl?: Fetch; timeoutMs?: number } = {},
): Promise<HarnessRouteTestResult> {
  const adeHome = deps.adeHome ?? resolveMachineAdeDir();
  if (!isHarnessPresetBody(args.harness)) {
    return { ok: false, protocol: null, latencyMs: null, route: null, error: "Unknown harness." };
  }
  const harness = args.harness;
  const model = typeof args.model === "string" ? args.model.trim() : "";
  if (!model) return { ok: false, protocol: null, latencyMs: null, route: null, error: "Choose a model." };
  let source: HarnessRouteSource["source"];
  try {
    source = requireHarnessRouteSource(args.source);
  } catch (error) {
    return { ok: false, protocol: null, latencyMs: null, route: null, error: error instanceof Error ? error.message : String(error) };
  }

  const resolved = resolveRouteSource(source, { adeHome });
  if ("unsupported" in resolved) {
    return { ok: false, protocol: null, latencyMs: null, route: null, error: resolved.unsupported };
  }
  const { endpoints, token, sourceKey } = resolved;
  const served = modelProtocols({ sourceProvider: resolved.sourceProvider, modelId: model, endpoints, probe: null });
  const harnessProtocols = HARNESS_ROUTE_PROTOCOLS[harness];
  const order = [
    ...harnessProtocols.filter((protocol) => served.includes(protocol)),
    ...ROUTE_PROTOCOLS.filter((protocol) => served.includes(protocol) && !harnessProtocols.includes(protocol)),
    // A protocol the seed ruled out is still worth one try when nothing else
    // answered — the seed can be out of date.
    ...ROUTE_PROTOCOLS.filter((protocol) => Boolean(endpoints[protocol]) && !served.includes(protocol)),
  ];
  const sessionHeader = resolved.needsSessionHeader ? `ade-test-${randomUUID()}` : null;
  let lastError = "This provider has no endpoint ADE can test.";
  for (const protocol of order) {
    const result = await pingProtocol({
      protocol,
      baseUrl: endpoints[protocol]!,
      token,
      model,
      sessionHeader,
      fetchImpl: deps.fetchImpl ?? fetch,
      timeoutMs: deps.timeoutMs ?? 30_000,
    });
    if (result.ok) {
      recordRouteProbe(adeHome, sourceKey, model, protocol, true);
      const route = resolveHarnessRoute({
        harness,
        source,
        modelId: model,
        endpoints,
        probe: readRouteProbe(adeHome, sourceKey, model),
      });
      return {
        ok: route.kind !== "impossible",
        protocol,
        latencyMs: result.latencyMs,
        route: route.kind,
        ...(route.kind === "impossible" ? { error: route.reason } : {}),
      };
    }
    lastError = result.error ?? lastError;
    // A protocol that accepts the request and then never answers is as unusable
    // as one that refuses it, and it is the worse failure to leave standing: a
    // launch routed onto it hangs with no error at all. Record it as a definite
    // no and keep trying the rest, so a Test routes around a wedged protocol —
    // for example OpenCode Go's Anthropic route hanging on a model its OpenAI
    // route still serves. A later Test re-confirms a recovered protocol.
    if (result.timedOut || (result.error && PROTOCOL_UNSUPPORTED.test(result.error))) {
      recordRouteProbe(adeHome, sourceKey, model, protocol, false);
      continue;
    }
    return { ok: false, protocol, latencyMs: result.latencyMs, route: null, error: lastError };
  }
  return { ok: false, protocol: null, latencyMs: null, route: null, error: lastError };
}
