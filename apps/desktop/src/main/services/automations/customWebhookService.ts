// Custom webhook triggers ("doorbells").
//
// A webhook trigger owns a hook id. This service gives it a secret URL, takes
// every request that rings it (straight to this machine, or held and drained
// from ADE's relay), decides whether it may start the automation, and keeps a
// short log of every ring so the user can see what arrived and why it ran or
// did not. Order of checks, cheapest and least revealing first:
//
//   token (local only; the relay already checked it) → rule → size → rate
//   limit → age → signature → filters → duplicate → run
//
// The signing secret is a project secret; it is read here, on the machine that
// runs the automation, and never sent to the relay.

import { randomBytes } from "node:crypto";
import type {
  AutomationIngressEventRecord,
  AutomationRule,
  AutomationTrigger,
  AutomationWebhookDelivery,
  AutomationWebhookDeliveryOutcome,
  AutomationWebhookDeliverySummary,
  AutomationWebhookDeliveryVia,
  AutomationWebhookEndpoint,
  AutomationWebhookRoute,
  AutomationWebhookTestRequest,
  AutomationWebhookTestResult,
  AutomationWebhookTriggerConfig,
} from "../../../shared/types";
import {
  WEBHOOK_HOOK_ID_PATTERN,
  WEBHOOK_MAX_BODY_BYTES,
  describeWebhookFilter,
  firstFailingWebhookFilter,
  webhookEventLabel,
  webhookPresetDef,
  type WebhookRequestView,
} from "../../../shared/automationWebhooks";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { ACCOUNT_RELAY_TOKEN_HEADER, DEFAULT_GITHUB_RELAY_API_BASE_URL } from "../github/githubRelayConfig";
import { resolvePlaceholders, type TriggerContext } from "./automationService";
import { createWebhookRelayDrain } from "./webhookRelayDrain";
import {
  parseJsonRecord,
  parseWebhookBody,
  safeEqual,
  signWebhookBody,
  verifyWebhookSignature,
} from "./webhookRequest";

export const WEBHOOK_RELAY_API_BASE_ENV_KEY = "ADE_WEBHOOK_RELAY_API_BASE_URL";
const DELIVERIES_KEPT_PER_HOOK = 50;
const STORED_BODY_MAX_CHARS = 64 * 1024;
const RATE_LIMIT_PER_MINUTE = 60;
/** Header values never kept in the delivery log. */
const HIDDEN_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", ACCOUNT_RELAY_TOKEN_HEADER]);
/** Sender-supplied ids, in preference order, that make a redelivery recognisable. */
const SENDER_DELIVERY_ID_HEADERS = ["x-github-delivery", "svix-id", "webhook-id", "linear-delivery", "x-request-id", "request-id"];

export type WebhookIncomingRequest = {
  hookId: string;
  /** Present for direct requests; relay deliveries were token-checked by the relay. */
  token?: string | null;
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  rawBody: Buffer;
  /** The body went past the size cap and was not buffered (`rawBody` is empty). */
  tooLarge?: boolean;
  via: AutomationWebhookDeliveryVia;
  /** When the request first reached ADE (relay hold time counts toward max age). */
  receivedAt?: string;
  relayDeliveryId?: string | null;
};

export type WebhookReceiveResult = {
  /** HTTP status for a direct caller. */
  status: number;
  outcome: AutomationWebhookDeliveryOutcome | "not_found";
  deliveryId: string | null;
};

type HookRow = {
  hook_id: string;
  token: string;
  created_at: string;
  rotated_at: string | null;
  relay_registered_at: string | null;
  relay_error: string | null;
};

type DeliveryRow = {
  id: string;
  hook_id: string;
  rule_id: string | null;
  via: string;
  method: string;
  received_at: string;
  outcome: string;
  detail: string | null;
  signature: string;
  event_label: string | null;
  dedupe_key: string | null;
  /** The ingress event key the run was dispatched under; links a still-running run. */
  event_key: string | null;
  ingress_event_id: string | null;
  headers_json: string | null;
  query_json: string | null;
  content_type: string | null;
  body_text: string | null;
  body_truncated: number;
  prompt_text: string | null;
};

/** A row as written: `body_truncated` is a flag here and an integer once stored. */
type DeliveryInsert = Omit<DeliveryRow, "body_truncated"> & { body_truncated: boolean };

export type CustomWebhookServiceDeps = {
  db: Pick<AdeDb, "get" | "all" | "run" | "getJson" | "setJson">;
  projectId: string;
  logger: Logger;
  listRules: () => AutomationRule[];
  /** Reads a project secret by name; null when it does not exist. */
  readSecret: (name: string) => string | null;
  getAccountAccessToken?: () => Promise<string | null>;
  /** Base URL of this machine's webhook listener, e.g. `http://127.0.0.1:52011`. */
  getLocalBaseUrl: () => string | null;
  /** The user's own public URL for this machine, when they set one up. */
  getGatewayPublicUrl: () => string | null;
  dispatch: (args: {
    hookId: string;
    via: AutomationWebhookDeliveryVia;
    eventKey: string;
    automationId: string;
    summary: string;
    eventName: string | null;
    webhook: { method: string; headers: Record<string, string>; query: Record<string, string>; body: unknown };
  }) => Promise<AutomationIngressEventRecord | null>;
  onDeliveriesChanged?: (hookId: string) => void;
  fetchImpl?: typeof fetch;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function resolveWebhookRelayBaseUrl(db: Pick<AdeDb, "getJson">): string {
  const stored = db.getJson<unknown>("automations.webhookRelay.apiBaseUrl");
  const configured = typeof stored === "string" && stored.trim() ? stored.trim() : null;
  return (configured || process.env[WEBHOOK_RELAY_API_BASE_ENV_KEY]?.trim() || DEFAULT_GITHUB_RELAY_API_BASE_URL).replace(/\/+$/, "");
}

const OUTCOME_DETAIL: Record<"no_rule" | "disabled" | "too_large" | "rate_limited", string> = {
  no_rule: "Arrived, but no saved automation uses this URL yet. Save the automation and it will run on the next one.",
  disabled: "Arrived while the automation was turned off.",
  too_large: "The body was over 1 MB, so ADE did not read it.",
  rate_limited: "More than 60 requests arrived in a minute. ADE skipped the extras.",
};

export function createCustomWebhookService(deps: CustomWebhookServiceDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const rateWindows = new Map<string, { windowStart: number; count: number; loggedThisWindow: boolean }>();

  const relayBaseUrl = () => resolveWebhookRelayBaseUrl(deps.db);

  // -------------------------------------------------------------------------
  // Hooks (URL tokens). Machine-local: the token never syncs, so only the
  // machine that made a URL can receive on it.
  // -------------------------------------------------------------------------

  const getHookRow = (hookId: string): HookRow | null =>
    deps.db.get<HookRow>(
      `select hook_id, token, created_at, rotated_at, relay_registered_at, relay_error
         from automation_webhook_hooks where project_id = ? and hook_id = ? limit 1`,
      [deps.projectId, hookId],
    );

  const listHookIds = (): string[] =>
    deps.db.all<{ hook_id: string }>(
      "select hook_id from automation_webhook_hooks where project_id = ? order by created_at",
      [deps.projectId],
    ).map((row) => row.hook_id);

  const readAccountToken = async (): Promise<string | null> =>
    deps.getAccountAccessToken ? await deps.getAccountAccessToken().catch(() => null) : null;

  const registerWithRelay = async (hookId: string, token: string, label?: string | null): Promise<void> => {
    const accountToken = await readAccountToken();
    if (!accountToken) {
      deps.db.run(
        "update automation_webhook_hooks set relay_registered_at = null, relay_error = ? where project_id = ? and hook_id = ?",
        ["signed_out", deps.projectId, hookId],
      );
      return;
    }
    try {
      const response = await fetchImpl(`${relayBaseUrl()}/hooks/register`, {
        method: "POST",
        headers: { "content-type": "application/json", [ACCOUNT_RELAY_TOKEN_HEADER]: accountToken },
        body: JSON.stringify({ hookId, token, ...(label ? { label } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? `ADE relay answered HTTP ${response.status}.`);
      deps.db.run(
        "update automation_webhook_hooks set relay_registered_at = ?, relay_error = null where project_id = ? and hook_id = ?",
        [nowIso(), deps.projectId, hookId],
      );
      relayDrain.ensureConnected();
    } catch (error) {
      deps.logger.warn("automations.webhook_relay_register_failed", { hookId, error: errorMessage(error) });
      deps.db.run(
        "update automation_webhook_hooks set relay_registered_at = null, relay_error = ? where project_id = ? and hook_id = ?",
        [errorMessage(error), deps.projectId, hookId],
      );
    }
  };

  const lastDeliveryAt = (hookId: string): string | null =>
    deps.db.get<{ received_at: string }>(
      "select received_at from automation_webhook_deliveries where project_id = ? and hook_id = ? order by received_at desc limit 1",
      [deps.projectId, hookId],
    )?.received_at ?? null;

  const buildEndpoint = (hookId: string): AutomationWebhookEndpoint => {
    const row = getHookRow(hookId);
    const localBase = deps.getLocalBaseUrl();
    const base: AutomationWebhookEndpoint = {
      hookId,
      url: null,
      route: null,
      localUrl: null,
      ownedHere: Boolean(row),
      setupError: null,
      createdAt: row?.created_at ?? null,
      rotatedAt: row?.rotated_at ?? null,
      lastDeliveryAt: lastDeliveryAt(hookId),
    };
    if (!row) {
      return {
        ...base,
        setupError: "This URL was created on another machine. Make a new one here to receive on this machine.",
      };
    }
    const path = `/hooks/${encodeURIComponent(hookId)}/${encodeURIComponent(row.token)}`;
    const localUrl = localBase ? `${localBase}${path}` : null;
    if (row.relay_registered_at) {
      return { ...base, url: `${relayBaseUrl()}${path}`, route: "relay", localUrl };
    }
    const gateway = deps.getGatewayPublicUrl();
    if (gateway) {
      return { ...base, url: `${gateway.replace(/\/+$/, "")}${path}`, route: "gateway", localUrl };
    }
    const setupError = row.relay_error === "signed_out" || !row.relay_error
      ? "Sign in to your ADE account to get a public URL. Until then, only apps on this computer can reach it."
      : `ADE's relay could not set up this URL: ${row.relay_error}`;
    return { ...base, url: localUrl, route: localUrl ? "local" : null, localUrl, setupError };
  };

  const createEndpoint = async (args: { label?: string | null } = {}): Promise<AutomationWebhookEndpoint> => {
    const hookId = `wh-${randomBytes(9).toString("hex")}`;
    const token = randomBytes(24).toString("base64url");
    deps.db.run(
      `insert into automation_webhook_hooks(hook_id, project_id, token, created_at, rotated_at, relay_registered_at, relay_error)
       values (?, ?, ?, ?, null, null, null)`,
      [hookId, deps.projectId, token, nowIso()],
    );
    await registerWithRelay(hookId, token, args.label ?? null);
    return buildEndpoint(hookId);
  };

  const getEndpoint = async (hookId: string): Promise<AutomationWebhookEndpoint> => {
    const row = getHookRow(hookId);
    // A URL made while signed out (or while the relay was down) upgrades itself
    // to a public one as soon as it can.
    if (row && !row.relay_registered_at) await registerWithRelay(hookId, row.token);
    return buildEndpoint(hookId);
  };

  const rotateEndpoint = async (hookId: string): Promise<AutomationWebhookEndpoint> => {
    const row = getHookRow(hookId);
    if (!row) throw new Error("This URL was created on another machine and can only be changed there.");
    const token = randomBytes(24).toString("base64url");
    deps.db.run(
      "update automation_webhook_hooks set token = ?, rotated_at = ?, relay_registered_at = null where project_id = ? and hook_id = ?",
      [token, nowIso(), deps.projectId, hookId],
    );
    await registerWithRelay(hookId, token);
    return buildEndpoint(hookId);
  };

  /**
   * Stop a URL for good: the relay forgets it (and drops anything it held),
   * and this machine forgets its token and its log. A retired URL answers 404.
   */
  const retireEndpoint = async (hookId: string): Promise<boolean> => {
    const row = getHookRow(hookId);
    if (!row) return false;
    if (row.relay_registered_at) {
      const accountToken = await readAccountToken();
      if (accountToken) {
        await fetchImpl(`${relayBaseUrl()}/hooks/register`, {
          method: "DELETE",
          headers: { "content-type": "application/json", [ACCOUNT_RELAY_TOKEN_HEADER]: accountToken },
          body: JSON.stringify({ hookId }),
          signal: AbortSignal.timeout(15_000),
        }).catch((error: unknown) => {
          // The local token is gone either way, so the URL can never run
          // anything again; the relay's copy expires with its held requests.
          deps.logger.warn("automations.webhook_relay_unregister_failed", { hookId, error: errorMessage(error) });
        });
      }
    }
    deps.db.run("delete from automation_webhook_deliveries where project_id = ? and hook_id = ?", [deps.projectId, hookId]);
    deps.db.run("delete from automation_webhook_hooks where project_id = ? and hook_id = ?", [deps.projectId, hookId]);
    deps.logger.info("automations.webhook_retired", { hookId });
    return true;
  };

  const reRegisterAll = async (): Promise<void> => {
    const rows = deps.db.all<{ hook_id: string; token: string }>(
      "select hook_id, token from automation_webhook_hooks where project_id = ?",
      [deps.projectId],
    );
    for (const row of rows) await registerWithRelay(row.hook_id, row.token);
  };

  const referencedHookIds = (): Set<string> => {
    const ids = new Set<string>();
    for (const rule of deps.listRules()) {
      for (const trigger of rule.triggers ?? []) {
        if (trigger.type === "webhook" && trigger.webhook?.hookId) ids.add(trigger.webhook.hookId);
      }
    }
    return ids;
  };

  /** A deleted rule takes its URLs with it, unless another rule still uses them. */
  const retireForDeletedRule = async (rule: AutomationRule): Promise<void> => {
    const stillUsed = referencedHookIds();
    for (const trigger of rule.triggers ?? []) {
      const hookId = trigger.type === "webhook" ? trigger.webhook?.hookId : null;
      if (hookId && !stillUsed.has(hookId)) await retireEndpoint(hookId);
    }
  };

  /**
   * URLs no saved rule has used for a week: made for a draft that was never
   * saved, or left behind when a trigger stopped being a webhook.
   */
  const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60_000;
  const retireOrphans = async (): Promise<void> => {
    const stillUsed = referencedHookIds();
    const cutoff = new Date(Date.now() - ORPHAN_GRACE_MS).toISOString();
    const candidates = deps.db.all<{ hook_id: string; created_at: string; rotated_at: string | null }>(
      "select hook_id, created_at, rotated_at from automation_webhook_hooks where project_id = ?",
      [deps.projectId],
    );
    for (const row of candidates) {
      if (stillUsed.has(row.hook_id)) continue;
      const lastTouched = row.rotated_at && row.rotated_at > row.created_at ? row.rotated_at : row.created_at;
      const lastDelivery = lastDeliveryAt(row.hook_id);
      const newest = lastDelivery && lastDelivery > lastTouched ? lastDelivery : lastTouched;
      if (newest < cutoff) await retireEndpoint(row.hook_id);
    }
  };

  // -------------------------------------------------------------------------
  // Delivery log
  // -------------------------------------------------------------------------

  const findRuleForHook = (hookId: string): { rule: AutomationRule; trigger: AutomationTrigger; config: AutomationWebhookTriggerConfig } | null => {
    for (const rule of deps.listRules()) {
      for (const trigger of rule.triggers ?? []) {
        if (trigger.type === "webhook" && trigger.webhook?.hookId === hookId) {
          return { rule, trigger, config: trigger.webhook };
        }
      }
    }
    return null;
  };

  const recordDelivery = (row: DeliveryInsert): void => {
    deps.db.run(
      `insert into automation_webhook_deliveries(
        id, project_id, hook_id, rule_id, via, method, received_at, outcome, detail, signature, event_label,
        dedupe_key, event_key, ingress_event_id, headers_json, query_json, content_type, body_text, body_truncated, prompt_text
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, deps.projectId, row.hook_id, row.rule_id, row.via, row.method, row.received_at, row.outcome, row.detail,
        row.signature, row.event_label, row.dedupe_key, row.event_key ?? null, row.ingress_event_id, row.headers_json, row.query_json,
        row.content_type, row.body_text, row.body_truncated ? 1 : 0, row.prompt_text,
      ],
    );
    deps.db.run(
      `delete from automation_webhook_deliveries
        where project_id = ? and hook_id = ?
          and id not in (
            select id from automation_webhook_deliveries
             where project_id = ? and hook_id = ?
             order by received_at desc, rowid desc
             limit ${DELIVERIES_KEPT_PER_HOOK}
          )`,
      [deps.projectId, row.hook_id, deps.projectId, row.hook_id],
    );
    deps.onDeliveriesChanged?.(row.hook_id);
  };

  const lookupRun = (row: Pick<DeliveryRow, "ingress_event_id" | "event_key">): { runId: string | null; chatSessionId: string | null; chatLaneId: string | null } => {
    // The ingress id is written when dispatch returns, which is after the run
    // ends; a run still in progress is found through its event key.
    const ingressEventId = row.ingress_event_id
      ?? (row.event_key
        ? deps.db.get<{ id: string }>(
            "select id from automation_ingress_events where project_id = ? and event_key = ? limit 1",
            [deps.projectId, row.event_key],
          )?.id ?? null
        : null);
    if (!ingressEventId) return { runId: null, chatSessionId: null, chatLaneId: null };
    const run = deps.db.get<{ id: string; chat_session_id: string | null; lane_id: string | null }>(
      `select r.id, r.chat_session_id, s.lane_id
         from automation_runs r
         left join terminal_sessions s on s.id = r.chat_session_id
        where r.project_id = ? and r.ingress_event_id = ?
        order by r.started_at desc limit 1`,
      [deps.projectId, ingressEventId],
    );
    return { runId: run?.id ?? null, chatSessionId: run?.chat_session_id ?? null, chatLaneId: run?.lane_id ?? null };
  };

  const toSummary = (row: DeliveryRow): AutomationWebhookDeliverySummary => ({
    id: row.id,
    hookId: row.hook_id,
    ruleId: row.rule_id,
    via: row.via as AutomationWebhookDeliveryVia,
    method: row.method,
    receivedAt: row.received_at,
    outcome: row.outcome as AutomationWebhookDeliveryOutcome,
    detail: row.detail,
    signature: row.signature as AutomationWebhookDeliverySummary["signature"],
    eventLabel: row.event_label,
    ...lookupRun(row),
  });

  const DELIVERY_COLUMNS = `id, hook_id, rule_id, via, method, received_at, outcome, detail, signature, event_label, dedupe_key,
    event_key, ingress_event_id, headers_json, query_json, content_type, body_text, body_truncated, prompt_text`;

  const listDeliveries = (args: { hookId: string; limit?: number }): AutomationWebhookDeliverySummary[] =>
    deps.db.all<DeliveryRow>(
      `select ${DELIVERY_COLUMNS} from automation_webhook_deliveries
        where project_id = ? and hook_id = ? order by received_at desc, rowid desc limit ?`,
      [deps.projectId, args.hookId, Math.max(1, Math.min(DELIVERIES_KEPT_PER_HOOK, Math.floor(args.limit ?? DELIVERIES_KEPT_PER_HOOK)))],
    ).map(toSummary);

  const loadDeliveryRow = (id: string): DeliveryRow | null =>
    deps.db.get<DeliveryRow>(
      `select ${DELIVERY_COLUMNS} from automation_webhook_deliveries where project_id = ? and id = ? limit 1`,
      [deps.projectId, id],
    );

  const getDelivery = (args: { id: string }): AutomationWebhookDelivery | null => {
    const row = loadDeliveryRow(args.id);
    if (!row) return null;
    return {
      ...toSummary(row),
      headers: parseJsonRecord(row.headers_json),
      query: parseJsonRecord(row.query_json),
      contentType: row.content_type,
      body: row.body_text ?? "",
      bodyTruncated: row.body_truncated === 1,
      prompt: row.prompt_text,
    };
  };

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  const takeRateSlot = (hookId: string): { allowed: boolean; logRejection: boolean } => {
    const now = Date.now();
    const window = rateWindows.get(hookId);
    if (!window || now - window.windowStart >= 60_000) {
      rateWindows.set(hookId, { windowStart: now, count: 1, loggedThisWindow: false });
      return { allowed: true, logRejection: false };
    }
    window.count += 1;
    if (window.count <= RATE_LIMIT_PER_MINUTE) return { allowed: true, logRejection: false };
    const logRejection = !window.loggedThisWindow;
    window.loggedThisWindow = true;
    return { allowed: false, logRejection };
  };

  const senderDeliveryId = (headers: Record<string, string>, body: unknown): string | null => {
    for (const name of SENDER_DELIVERY_ID_HEADERS) {
      const value = headers[name]?.trim();
      if (value) return `${name}:${value}`;
    }
    // Stripe puts the event id in the body.
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const id = (body as Record<string, unknown>).id;
      if (typeof id === "string" && /^evt_/.test(id)) return `stripe:${id}`;
    }
    return null;
  };

  const storedHeaders = (headers: Record<string, string>, alsoHide?: string | null): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) out[name] = HIDDEN_HEADERS.has(name) || name === alsoHide ? "‹hidden›" : value;
    return out;
  };

  const bodyForLog = (rawBody: Buffer, parsed: unknown): { text: string; truncated: boolean } => {
    let text: string;
    if (parsed && typeof parsed === "object") {
      try {
        text = JSON.stringify(parsed, null, 2);
      } catch {
        text = rawBody.toString("utf8");
      }
    } else {
      text = rawBody.toString("utf8");
    }
    return text.length > STORED_BODY_MAX_CHARS
      ? { text: text.slice(0, STORED_BODY_MAX_CHARS), truncated: true }
      : { text, truncated: false };
  };

  const buildPromptPreview = (rule: AutomationRule, view: WebhookRequestView & { hookId: string; method: string }): string | null => {
    const template = rule.prompt?.trim()
      || rule.actions?.find((action) => action.type === "agent-session" && action.prompt?.trim())?.prompt?.trim()
      || "";
    if (!template) return null;
    const context: TriggerContext = {
      triggerType: "webhook",
      webhook: { hookId: view.hookId, method: view.method, headers: view.headers, query: view.query, body: view.body },
    };
    const rendered = resolvePlaceholders(template, context);
    return typeof rendered === "string" ? rendered : template;
  };

  // Nonces of tests this computer sent, valid for 10 minutes (relay held
  // tests can arrive after `sendTest` returns, or twice after a lost ack).
  // Each remembers the signature header the test was signed into, which its
  // log row hides: a test signs a body chosen by whoever ran it.
  const testNonces = new Map<string, { expiresAt: number; signatureHeader: string | null }>();
  const TEST_NONCE_TTL_MS = 10 * 60_000;
  const issueTestNonce = (signatureHeader: string | null): string => {
    const now = Date.now();
    for (const [nonce, entry] of testNonces) if (entry.expiresAt <= now) testNonces.delete(nonce);
    const nonce = randomBytes(12).toString("hex");
    testNonces.set(nonce, { expiresAt: now + TEST_NONCE_TTL_MS, signatureHeader: signatureHeader?.toLowerCase() ?? null });
    return nonce;
  };
  // Not consumed on first sight: a relay request whose acknowledgement was
  // lost comes back, and must still read as the same test.
  const readTestNonce = (nonce: string): { signatureHeader: string | null } | null => {
    const entry = testNonces.get(nonce);
    return entry && entry.expiresAt > Date.now() ? entry : null;
  };

  const receive = async (
    request: WebhookIncomingRequest,
    options: {
      /** A replay: the signature was settled when the request first arrived, and this is its state then. */
      replayedSignature?: AutomationWebhookDeliverySummary["signature"];
      skipDedupe?: boolean;
    } = {},
  ): Promise<WebhookReceiveResult> => {
    const hookId = request.hookId.trim().toLowerCase();
    const notFound: WebhookReceiveResult = { status: 404, outcome: "not_found", deliveryId: null };
    if (!WEBHOOK_HOOK_ID_PATTERN.test(hookId)) return notFound;
    const hook = getHookRow(hookId);
    if (!hook) return notFound;
    // Direct requests prove the URL with its token. A wrong token and an
    // unknown hook look the same, and neither is logged: a flood of guesses
    // must not be able to rewrite the log.
    if (request.via === "local" && !safeEqual(request.token ?? "", hook.token)) return notFound;

    const receivedAt = request.receivedAt ?? nowIso();
    const deliveryId = `whd_${randomBytes(9).toString("hex")}`;
    // Only a nonce this computer just sent marks a test; the header alone is
    // the sender's to set.
    const testNonce = request.headers["x-ade-test"];
    const test = testNonce ? readTestNonce(testNonce) : null;
    const isTest = test !== null;
    const contentType = request.headers["content-type"] ?? null;
    const match = findRuleForHook(hookId);
    const base = {
      id: deliveryId,
      hook_id: hookId,
      rule_id: match?.rule.id ?? null,
      via: isTest ? "test" as const : request.via,
      method: request.method.toUpperCase(),
      received_at: receivedAt,
      headers_json: JSON.stringify(storedHeaders(request.headers, test?.signatureHeader)),
      query_json: JSON.stringify(request.query),
      content_type: contentType,
      event_key: null,
      ingress_event_id: null,
      prompt_text: null,
    };

    if (request.tooLarge || request.rawBody.length > WEBHOOK_MAX_BODY_BYTES) {
      recordDelivery({
        ...base, outcome: "too_large", detail: OUTCOME_DETAIL.too_large, signature: "not_required",
        event_label: null, dedupe_key: null, body_text: "", body_truncated: true,
      });
      return { status: 413, outcome: "too_large", deliveryId };
    }

    const parsedBody = parseWebhookBody(request.rawBody, contentType);
    const view: WebhookRequestView = { body: parsedBody, headers: request.headers, query: request.query };
    const eventLabel = webhookEventLabel(view, match?.config.preset);
    const logged = bodyForLog(request.rawBody, parsedBody);
    const record = (outcome: AutomationWebhookDeliveryOutcome, detail: string | null, extra: Partial<DeliveryInsert> = {}) =>
      recordDelivery({
        ...base,
        outcome,
        detail,
        signature: "not_required",
        event_label: eventLabel,
        dedupe_key: null,
        body_text: logged.text,
        body_truncated: logged.truncated,
        ...extra,
      });

    const rate = takeRateSlot(hookId);
    if (!rate.allowed) {
      // A relay request is still held on the relay: the drain leaves it there
      // and comes back after the window, so it is neither logged nor lost.
      if (request.via === "relay") return { status: 429, outcome: "rate_limited", deliveryId: null };
      if (rate.logRejection) record("rate_limited", OUTCOME_DETAIL.rate_limited);
      return { status: 429, outcome: "rate_limited", deliveryId: rate.logRejection ? deliveryId : null };
    }

    if (!match) {
      record("no_rule", OUTCOME_DETAIL.no_rule);
      return { status: 202, outcome: "no_rule", deliveryId };
    }
    const { rule, config } = match;

    if (config.maxAgeMinutes && request.via === "relay") {
      const ageMs = Date.now() - Date.parse(receivedAt);
      if (Number.isFinite(ageMs) && ageMs > config.maxAgeMinutes * 60_000) {
        record("expired", `ADE's relay held it for ${Math.round(ageMs / 60_000)} minutes while this computer was away, longer than the ${config.maxAgeMinutes}-minute limit.`);
        return { status: 202, outcome: "expired", deliveryId };
      }
    }

    let signatureState: AutomationWebhookDeliverySummary["signature"] = "not_required";
    if (options.replayedSignature) {
      signatureState = options.replayedSignature;
    } else if (config.signature) {
      const secret = deps.readSecret(config.signature.secretName);
      if (!secret) {
        record("bad_signature", `The signing secret ${config.signature.secretName} is not saved in this project, so ADE could not check the signature.`, { signature: "unchecked" });
        return { status: 401, outcome: "bad_signature", deliveryId };
      }
      const failure = verifyWebhookSignature({
        signature: config.signature,
        secret,
        headers: request.headers,
        rawBody: request.rawBody,
        receivedAtMs: Date.parse(receivedAt) || Date.now(),
      });
      if (failure) {
        record(failure.outcome, failure.detail, { signature: failure.outcome === "missing_signature" ? "missing" : "failed" });
        return { status: 401, outcome: failure.outcome, deliveryId };
      }
      signatureState = "verified";
    }

    if (!rule.enabled) {
      record("disabled", OUTCOME_DETAIL.disabled, { signature: signatureState });
      return { status: 202, outcome: "disabled", deliveryId };
    }

    const failingFilter = firstFailingWebhookFilter(config.filters, view);
    if (failingFilter) {
      record("filtered", `Skipped: needs ${describeWebhookFilter(failingFilter)}.`, { signature: signatureState });
      return { status: 202, outcome: "filtered", deliveryId };
    }

    const senderId = senderDeliveryId(request.headers, parsedBody);
    const dedupeKey = senderId ?? (request.relayDeliveryId ? `relay:${request.relayDeliveryId}` : null);
    if (dedupeKey && !options.skipDedupe) {
      const seen = deps.db.get<{ id: string }>(
        "select id from automation_webhook_deliveries where project_id = ? and hook_id = ? and dedupe_key = ? and outcome = 'ran' limit 1",
        [deps.projectId, hookId, dedupeKey],
      );
      if (seen) {
        record("duplicate", "The sender delivered this same event again. It already ran once.", { signature: signatureState });
        return { status: 202, outcome: "duplicate", deliveryId };
      }
    }

    const prompt = buildPromptPreview(rule, { ...view, hookId, method: base.method });
    const eventKey = `webhook:${hookId}:${dedupeKey && !options.skipDedupe ? dedupeKey : deliveryId}`;
    record("ran", null, {
      signature: signatureState,
      dedupe_key: options.skipDedupe ? null : dedupeKey,
      event_key: eventKey,
      prompt_text: prompt,
    });
    const preset = webhookPresetDef(config.preset);
    // Reply first: the run can take minutes and senders time out in seconds.
    void deps.dispatch({
      hookId,
      via: request.via,
      eventKey,
      automationId: rule.id,
      summary: `${config.preset && config.preset !== "generic" ? preset.label : "Webhook"}${eventLabel ? `: ${eventLabel}` : ""}`,
      eventName: eventLabel,
      webhook: { method: base.method, headers: request.headers, query: request.query, body: parsedBody },
    }).then((ingress) => {
      if (!ingress) return;
      // Only a dispatched run stays `ran` and keeps its duplicate key. An
      // ignored or failed one started nothing, so the sender's redelivery must
      // be allowed to try again rather than read as a duplicate.
      const outcome: AutomationWebhookDeliveryOutcome = ingress.status === "failed"
        ? "error"
        : ingress.status === "ignored" ? "filtered" : "ran";
      const detail = outcome === "error"
        ? `The run could not start: ${ingress.errorMessage ?? "unknown error"}`
        : outcome === "filtered"
          ? "No run started: the automation's other conditions (active hours, event or branch) did not match."
          : null;
      deps.db.run(
        `update automation_webhook_deliveries
            set ingress_event_id = ?, outcome = ?, detail = ?, dedupe_key = case when ? = 'ran' then dedupe_key else null end
          where project_id = ? and id = ?`,
        [ingress.id, outcome, detail, outcome, deps.projectId, deliveryId],
      );
      deps.onDeliveriesChanged?.(hookId);
    }).catch((error: unknown) => {
      deps.logger.warn("automations.webhook_dispatch_failed", { hookId, error: errorMessage(error) });
      deps.db.run(
        "update automation_webhook_deliveries set outcome = 'error', detail = ?, dedupe_key = null where project_id = ? and id = ?",
        [`The run could not start: ${errorMessage(error)}`, deps.projectId, deliveryId],
      );
      deps.onDeliveriesChanged?.(hookId);
    });
    return { status: 202, outcome: "ran", deliveryId };
  };

  /** Run a logged delivery again with the automation as it is now. */
  const replayDelivery = async (args: { id: string }): Promise<AutomationWebhookDeliverySummary | null> => {
    const row = loadDeliveryRow(args.id);
    if (!row) throw new Error("That delivery is no longer in the log.");
    if (row.body_truncated === 1) throw new Error("That delivery was too large to keep in full, so it cannot be replayed.");
    // A request whose signature did not match (or was absent) may be forged;
    // replaying it would run it without one. The sender has to send it again.
    // One that arrived before the secret was saved proved nothing either way,
    // and replaying it is how setup is finished.
    if (row.signature === "failed" || row.signature === "missing") {
      throw new Error("That request failed the signature check, so ADE will not run it. Fix the signing secret, then have the service send it again.");
    }
    const body = row.body_text ?? "";
    // The stored body is pretty-printed JSON or the original text; either
    // re-parses to the same value, so placeholders and filters read the same.
    const result = await receive({
      hookId: row.hook_id,
      method: row.method,
      headers: parseJsonRecord(row.headers_json),
      query: parseJsonRecord(row.query_json),
      rawBody: Buffer.from(body, "utf8"),
      via: "replay",
    }, {
      // Checked when it first arrived; the stored body is re-serialized, so
      // the original signature could not match it again anyway.
      replayedSignature: row.signature === "verified" || row.signature === "unchecked" ? row.signature : "not_required",
      skipDedupe: true,
    });
    if (!result.deliveryId) return null;
    const replayed = loadDeliveryRow(result.deliveryId);
    return replayed ? toSummary(replayed) : null;
  };

  /**
   * Ring the doorbell the way the real sender would: same URL, same signature
   * header. When the URL is public this goes out to the relay and comes back,
   * so a green result proves the whole path.
   */
  const sendTest = async (args: AutomationWebhookTestRequest & { config?: AutomationWebhookTriggerConfig | null }): Promise<AutomationWebhookTestResult> => {
    const endpoint = await getEndpoint(args.hookId);
    if (!endpoint.ownedHere || !endpoint.url || !endpoint.route) {
      throw new Error(endpoint.setupError ?? "This URL is not available on this computer.");
    }
    const config = args.config ?? findRuleForHook(args.hookId)?.config ?? null;
    const preset = webhookPresetDef(config?.preset);
    const bodyText = args.body?.trim() ? args.body : JSON.stringify(preset.sampleBody);
    const body = Buffer.from(bodyText, "utf8");
    const headers: Record<string, string> = {
      ...preset.sampleHeaders,
      ...(args.headers ?? {}),
      "content-type": "application/json",
      "user-agent": "ADE-Webhook-Test/1",
      "x-ade-test": issueTestNonce(config?.signature?.header ?? null),
    };
    if (config?.signature) {
      const secret = deps.readSecret(config.signature.secretName);
      if (!secret) throw new Error(`Save the signing secret ${config.signature.secretName} first. ADE signs the test with it, the same way the sender will.`);
      headers[config.signature.header] = signWebhookBody(config.signature, secret, body);
    }
    const route: AutomationWebhookRoute = endpoint.route;
    const ring = () => fetchImpl(endpoint.url!, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
    let response = await ring();
    if (response.status === 404 && route === "relay") {
      // The relay no longer knows this URL (an account unlink, a relay reset):
      // register it again and ring once more, so the user's URL keeps working.
      const row = getHookRow(args.hookId);
      if (row) await registerWithRelay(args.hookId, row.token);
      response = await ring();
    }
    const responseText = (await response.text().catch(() => "")).slice(0, 500);
    if (route === "relay") void drainRelay();
    return { status: response.status, route, ok: response.ok, response: responseText };
  };

  // -------------------------------------------------------------------------
  // Relay drain. D1 is the durable stream; the socket only says "drain now".
  // -------------------------------------------------------------------------

  const relayDrain = createWebhookRelayDrain({
    listRelayHookIds: () => deps.db.all<{ hook_id: string }>(
      "select hook_id from automation_webhook_hooks where project_id = ? and relay_registered_at is not null",
      [deps.projectId],
    ).map((row) => row.hook_id),
    readAccountToken,
    relayBaseUrl,
    fetchImpl,
    logger: deps.logger,
    receive,
  });
  const drainRelay = relayDrain.drain;

  return {
    createEndpoint,
    getEndpoint,
    rotateEndpoint,
    listDeliveries,
    getDelivery,
    replayDelivery,
    sendTest,
    receive,
    pollNow: drainRelay,
    listHookIds,
    retireEndpoint,
    retireForDeletedRule,
    start() {
      if (!relayDrain.start()) return;
      void retireOrphans()
        // Registration is idempotent; refreshing it on start heals a relay
        // that forgot a URL (an account unlink, a relay reset) before the
        // next real delivery finds out with a 404.
        .then(() => reRegisterAll())
        .catch((error: unknown) => {
          deps.logger.warn("automations.webhook_start_maintenance_failed", { error: errorMessage(error) });
        });
    },
    stop() {
      relayDrain.stop();
    },
  };
}

export type CustomWebhookService = ReturnType<typeof createCustomWebhookService>;
