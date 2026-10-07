// Public-seam tests for custom webhook ("doorbell") automations:
// receive()'s outcome order, replay's signature gate, the Send-test identity
// fix, and the relay drain's per-hook acknowledgement.
//
// Only the network edge is faked: `fetchImpl` is the relay, and the wake
// WebSocket (a network boundary the drain opens) is replaced with a no-op so
// the test never dials the real relay. The database is a real temp sqlite via
// openKvDb, the same helper sibling automation tests use.

import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./relayWakeSocket", () => ({
  createRelayWakeSocket: () => ({ connected: () => false, stop: () => {} }),
}));

import type {
  AutomationRule,
  AutomationTrigger,
  AutomationWebhookDeliveryOutcome,
  AutomationWebhookDeliverySummary,
  AutomationWebhookFilter,
  AutomationWebhookPreset,
  AutomationWebhookSignatureConfig,
} from "../../../shared/types";
import { openKvDb, type AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import {
  createCustomWebhookService,
  type CustomWebhookService,
  type CustomWebhookServiceDeps,
  type WebhookIncomingRequest,
} from "./customWebhookService";

const PROJECT_ID = "proj-webhook-test";
const LOCAL_BASE = "http://127.0.0.1:52011";
const HOOK_ID = "wh-0000000000000001";
const HOOK_OK = "wh-0000000000000002";
const HOOK_BAD = "wh-0000000000000003";
const HOOK_TOKEN = "hook-token-value";
const SIGNATURE_HEADER = "x-hub-signature-256";
const GITHUB_SECRET = "github-signing-secret";
const STRIPE_SECRET = "whsec_test_stripe";
const STRIPE_RECEIVED_AT = "2026-06-02T00:00:00.000Z";

const githubBody = JSON.stringify({ action: "opened", issue: { number: 7, title: "Bug" } });
const stripeBody = JSON.stringify({ id: "evt_123", type: "invoice.payment_failed" });

function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}
const githubSignature = `sha256=${hmacHex(GITHUB_SECRET, githubBody)}`;

function stripeSignature(secret: string, body: string, timestampSec: number): string {
  const digest = createHmac("sha256", secret).update(`${timestampSec}.`).update(Buffer.from(body)).digest("hex");
  return `t=${timestampSec},v1=${digest}`;
}
const stripeTimestampSec = Math.floor(Date.parse(STRIPE_RECEIVED_AT) / 1000);

const githubSignatureConfig: AutomationWebhookSignatureConfig = {
  scheme: "hmac",
  header: SIGNATURE_HEADER,
  prefix: "sha256=",
  encoding: "hex",
  secretName: "GITHUB_WEBHOOK_SECRET",
};
const stripeSignatureConfig: AutomationWebhookSignatureConfig = {
  scheme: "stripe",
  header: "stripe-signature",
  secretName: "STRIPE_WEBHOOK_SECRET",
};

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function defaultReadSecret(name: string): string | null {
  if (name === "GITHUB_WEBHOOK_SECRET") return GITHUB_SECRET;
  if (name === "STRIPE_WEBHOOK_SECRET") return STRIPE_SECRET;
  return null;
}

function makeRule(args: {
  ruleId?: string;
  hookId: string;
  signature?: AutomationWebhookSignatureConfig | null;
  filters?: AutomationWebhookFilter[];
  preset?: AutomationWebhookPreset;
  enabled?: boolean;
  prompt?: string;
}): AutomationRule {
  const trigger: AutomationTrigger = {
    type: "webhook",
    webhook: {
      hookId: args.hookId,
      ...(args.preset ? { preset: args.preset } : {}),
      ...(args.signature ? { signature: args.signature } : {}),
      ...(args.filters ? { filters: args.filters } : {}),
    },
  };
  return {
    id: args.ruleId ?? "rule-1",
    name: "Webhook rule",
    origin: "user",
    mode: "review",
    triggers: [trigger],
    trigger,
    executor: { mode: "automation-bot" },
    reviewProfile: "quick",
    toolPalette: [],
    contextSources: [],
    guardrails: {},
    outputs: { disposition: "comment-only", createArtifact: false },
    verification: { verifyBeforePublish: false, mode: "intervention" },
    billingCode: "auto:test",
    actions: [],
    legacy: { actions: [] },
    enabled: args.enabled ?? true,
    prompt: args.prompt ?? "Handle {{trigger.body.action}}",
  };
}

type HeldEvent = {
  eventId: string;
  hookId: string;
  method: string;
  query: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: string;
  receivedAt: string;
};

function heldEvent(hookId: string, eventId: string, body = "{}"): HeldEvent {
  return {
    eventId,
    hookId,
    method: "POST",
    query: "",
    headers: { "content-type": "application/json" },
    body,
    bodyEncoding: "utf8",
    receivedAt: new Date().toISOString(),
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

describe("customWebhookService", () => {
  let tempRoot: string;
  let db: AdeDb;
  let activeService: CustomWebhookService | null;

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-custom-webhook-"));
    db = await openKvDb(path.join(tempRoot, "ade.db"), makeLogger());
    // The runtime creates this alongside the automation service; the webhook
    // service reads it to link a delivery to its still-running run.
    db.run(`
      create table if not exists automation_ingress_events (
        id text primary key,
        project_id text not null,
        source text not null,
        event_key text not null,
        automation_ids_json text,
        trigger_type text not null,
        event_name text,
        status text not null,
        summary text,
        error_message text,
        cursor text,
        raw_payload_json text,
        received_at text not null
      )
    `);
    activeService = null;
  });

  afterEach(() => {
    activeService?.stop();
    activeService = null;
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setupService(options: {
    rules?: AutomationRule[];
    readSecret?: (name: string) => string | null;
    dispatch?: CustomWebhookServiceDeps["dispatch"];
    fetchImpl?: typeof fetch;
    accountToken?: string | null;
  } = {}): { service: CustomWebhookService; dispatch: ReturnType<typeof vi.fn> } {
    const dispatch = options.dispatch ?? vi.fn(async () => null);
    const service = createCustomWebhookService({
      db,
      projectId: PROJECT_ID,
      logger: makeLogger(),
      listRules: () => options.rules ?? [],
      readSecret: options.readSecret ?? (() => null),
      getAccountAccessToken: async () => options.accountToken ?? null,
      getLocalBaseUrl: () => LOCAL_BASE,
      getGatewayPublicUrl: () => null,
      dispatch,
      fetchImpl: options.fetchImpl,
    });
    activeService = service;
    return { service, dispatch: dispatch as ReturnType<typeof vi.fn> };
  }

  function seedHook(hookId: string, token: string, relayRegisteredAt: string | null): void {
    db.run(
      `insert into automation_webhook_hooks(hook_id, project_id, token, created_at, rotated_at, relay_registered_at, relay_error)
       values (?, ?, ?, ?, null, ?, null)`,
      [hookId, PROJECT_ID, token, new Date().toISOString(), relayRegisteredAt],
    );
  }

  type ReceiveCase = {
    name: string;
    token?: string;
    headers: Record<string, string>;
    body?: string;
    tooLarge?: boolean;
    receivedAt?: string;
    signature?: AutomationWebhookSignatureConfig | null;
    filters?: AutomationWebhookFilter[];
    preset?: AutomationWebhookPreset;
    readSecret?: (name: string) => string | null;
    outcome: AutomationWebhookDeliveryOutcome | "not_found";
    status: number;
    dispatchCalls: number;
    logged: boolean;
    deliverySignature?: AutomationWebhookDeliverySummary["signature"];
    sendTwice?: boolean;
    expectDispatchBody?: unknown;
  };

  const receiveCases: ReceiveCase[] = [
    {
      name: "a wrong token is not_found and is not logged",
      token: "wrong-token",
      headers: { "content-type": "application/json" },
      signature: githubSignatureConfig,
      outcome: "not_found",
      status: 404,
      dispatchCalls: 0,
      logged: false,
    },
    {
      name: "a valid GitHub-style HMAC runs and dispatches the parsed body",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: githubSignature, "x-github-event": "issues" },
      signature: githubSignatureConfig,
      preset: "github",
      outcome: "ran",
      status: 202,
      dispatchCalls: 1,
      logged: true,
      deliverySignature: "verified",
      expectDispatchBody: { action: "opened", issue: { number: 7, title: "Bug" } },
    },
    {
      name: "a wrong HMAC is bad_signature",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: "sha256=deadbeef" },
      signature: githubSignatureConfig,
      outcome: "bad_signature",
      status: 401,
      dispatchCalls: 0,
      logged: true,
      deliverySignature: "failed",
    },
    {
      name: "a request with no signature header is missing_signature",
      headers: { "content-type": "application/json" },
      signature: githubSignatureConfig,
      outcome: "missing_signature",
      status: 401,
      dispatchCalls: 0,
      logged: true,
      deliverySignature: "missing",
    },
    {
      name: "an unsaved signing secret is bad_signature marked unchecked",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: githubSignature },
      signature: githubSignatureConfig,
      readSecret: () => null,
      outcome: "bad_signature",
      status: 401,
      dispatchCalls: 0,
      logged: true,
      deliverySignature: "unchecked",
    },
    {
      name: "a request a filter rejects is filtered",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "closed" }),
      filters: [{ path: "body.action", op: "equals", value: "opened" }],
      outcome: "filtered",
      status: 202,
      dispatchCalls: 0,
      logged: true,
      deliverySignature: "not_required",
    },
    {
      name: "the same sender delivery id twice runs once and then is duplicate",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: githubSignature, "x-github-delivery": "delivery-abc" },
      signature: githubSignatureConfig,
      outcome: "ran",
      status: 202,
      dispatchCalls: 1,
      logged: true,
      deliverySignature: "verified",
      sendTwice: true,
    },
    {
      name: "a fresh Stripe t=,v1= signature runs",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignature(STRIPE_SECRET, stripeBody, stripeTimestampSec) },
      body: stripeBody,
      signature: stripeSignatureConfig,
      receivedAt: STRIPE_RECEIVED_AT,
      outcome: "ran",
      status: 202,
      dispatchCalls: 1,
      logged: true,
      deliverySignature: "verified",
    },
    {
      name: "a Stripe signature older than five minutes is bad_signature",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignature(STRIPE_SECRET, stripeBody, stripeTimestampSec - 600) },
      body: stripeBody,
      signature: stripeSignatureConfig,
      receivedAt: STRIPE_RECEIVED_AT,
      outcome: "bad_signature",
      status: 401,
      dispatchCalls: 0,
      logged: true,
      deliverySignature: "failed",
    },
    {
      name: "a body past the size cap is too_large",
      headers: { "content-type": "application/json" },
      tooLarge: true,
      outcome: "too_large",
      status: 413,
      dispatchCalls: 0,
      logged: true,
      deliverySignature: "not_required",
    },
  ];

  it.each(receiveCases.map((row) => [row.name, row] as [string, ReceiveCase]))(
    "receive(): %s",
    async (_name, row) => {
      const { service, dispatch } = setupService({
        rules: [makeRule({ hookId: HOOK_ID, signature: row.signature ?? null, filters: row.filters, preset: row.preset })],
        readSecret: row.readSecret ?? defaultReadSecret,
      });
      seedHook(HOOK_ID, HOOK_TOKEN, null);

      const send = (): Promise<{ outcome: string; status: number; deliveryId: string | null }> =>
        service.receive({
          hookId: HOOK_ID,
          token: row.token ?? HOOK_TOKEN,
          method: "POST",
          headers: row.headers,
          query: {},
          rawBody: Buffer.from(row.body ?? githubBody, "utf8"),
          tooLarge: row.tooLarge,
          via: "local",
          receivedAt: row.receivedAt,
        } satisfies WebhookIncomingRequest);

      const result = await send();
      expect(result.outcome).toBe(row.outcome);
      expect(result.status).toBe(row.status);
      expect(dispatch).toHaveBeenCalledTimes(row.dispatchCalls);

      if (!row.logged) {
        expect(service.listDeliveries({ hookId: HOOK_ID })).toHaveLength(0);
      } else {
        const delivery = service.getDelivery({ id: result.deliveryId! });
        expect(delivery?.outcome).toBe(row.outcome);
        expect(delivery?.signature).toBe(row.deliverySignature);
      }

      if (row.expectDispatchBody) {
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
          automationId: "rule-1",
          webhook: expect.objectContaining({ body: row.expectDispatchBody }),
        }));
      }

      if (row.sendTwice) {
        const second = await send();
        expect(second.outcome).toBe("duplicate");
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(service.listDeliveries({ hookId: HOOK_ID })).toHaveLength(2);
      }
    },
  );

  it.each([
    {
      label: "failed",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: "sha256=deadbeef" },
      firstOutcome: "bad_signature",
      signatureState: "failed",
    },
    {
      label: "missing",
      headers: { "content-type": "application/json" },
      firstOutcome: "missing_signature",
      signatureState: "missing",
    },
  ])(
    "replayDelivery(): refuses a $label signature and never dispatches",
    async (row) => {
      const dispatch = vi.fn(async () => null);
      const { service } = setupService({
        rules: [makeRule({ hookId: HOOK_ID, signature: githubSignatureConfig })],
        readSecret: defaultReadSecret,
        dispatch,
      });
      seedHook(HOOK_ID, HOOK_TOKEN, null);

      const first = await service.receive({
        hookId: HOOK_ID,
        token: HOOK_TOKEN,
        method: "POST",
        headers: row.headers as Record<string, string>,
        query: {},
        rawBody: Buffer.from(githubBody, "utf8"),
        via: "local",
      });
      expect(first.outcome).toBe(row.firstOutcome);
      const delivery = service.getDelivery({ id: first.deliveryId! });
      expect(delivery?.signature).toBe(row.signatureState);

      await expect(service.replayDelivery({ id: first.deliveryId! })).rejects.toThrow();
      expect(dispatch).toHaveBeenCalledTimes(0);
      expect(service.listDeliveries({ hookId: HOOK_ID })).toHaveLength(1);
    },
  );

  it("replayDelivery(): replays an unchecked delivery once the secret is saved, keeping unchecked", async () => {
    let secret: string | null = null;
    const dispatch = vi.fn(async () => null);
    const { service } = setupService({
      rules: [makeRule({ hookId: HOOK_ID, signature: githubSignatureConfig })],
      readSecret: () => secret,
      dispatch,
    });
    seedHook(HOOK_ID, HOOK_TOKEN, null);

    const first = await service.receive({
      hookId: HOOK_ID,
      token: HOOK_TOKEN,
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: githubSignature },
      query: {},
      rawBody: Buffer.from(githubBody, "utf8"),
      via: "local",
    });
    expect(first.outcome).toBe("bad_signature");
    expect(service.getDelivery({ id: first.deliveryId! })?.signature).toBe("unchecked");
    expect(dispatch).toHaveBeenCalledTimes(0);

    secret = GITHUB_SECRET;
    const replayed = await service.replayDelivery({ id: first.deliveryId! });
    expect(replayed?.outcome).toBe("ran");
    expect(replayed?.signature).toBe("unchecked");
    expect(replayed?.via).toBe("replay");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("replayDelivery(): replays a verified delivery and keeps verified", async () => {
    const dispatch = vi.fn(async () => null);
    const { service } = setupService({
      rules: [makeRule({ hookId: HOOK_ID, signature: githubSignatureConfig })],
      readSecret: defaultReadSecret,
      dispatch,
    });
    seedHook(HOOK_ID, HOOK_TOKEN, null);

    const first = await service.receive({
      hookId: HOOK_ID,
      token: HOOK_TOKEN,
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: githubSignature },
      query: {},
      rawBody: Buffer.from(githubBody, "utf8"),
      via: "local",
    });
    expect(first.outcome).toBe("ran");
    expect(service.getDelivery({ id: first.deliveryId! })?.signature).toBe("verified");
    expect(dispatch).toHaveBeenCalledTimes(1);

    const replayed = await service.replayDelivery({ id: first.deliveryId! });
    expect(replayed?.outcome).toBe("ran");
    expect(replayed?.signature).toBe("verified");
    expect(replayed?.id).not.toBe(first.deliveryId);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("sendTest(): a self-issued test is logged via \"test\" with its signature header hidden", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      requests.push({ url: typeof input === "string" ? input : input.toString(), init: init ?? {} });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const dispatch = vi.fn(async () => null);
    const { service } = setupService({
      rules: [makeRule({ hookId: HOOK_ID, signature: githubSignatureConfig, preset: "github" })],
      readSecret: defaultReadSecret,
      dispatch,
      fetchImpl,
    });
    seedHook(HOOK_ID, HOOK_TOKEN, null);

    const result = await service.sendTest({ hookId: HOOK_ID, body: githubBody });
    expect(result.ok).toBe(true);
    expect(result.route).toBe("local");
    expect(result.status).toBe(200);

    const ring = requests.find((entry) => entry.url.includes(`/hooks/${HOOK_ID}/`));
    expect(ring).toBeDefined();
    const sentHeaders = ring!.init.headers as Record<string, string>;
    const token = decodeURIComponent(new URL(ring!.url).pathname.split("/").pop()!);

    const recv = await service.receive({
      hookId: HOOK_ID,
      token,
      method: "POST",
      headers: sentHeaders,
      query: {},
      rawBody: Buffer.from(ring!.init.body as Buffer),
      via: "local",
    });
    expect(recv.outcome).toBe("ran");
    const delivery = service.getDelivery({ id: recv.deliveryId! });
    expect(delivery?.via).toBe("test");
    expect(delivery?.headers[SIGNATURE_HEADER]).toBe("‹hidden›");
    expect(delivery?.headers["x-ade-test"]).toBe(sentHeaders["x-ade-test"]);
  });

  it("receive(): an x-ade-test header the service never issued keeps the normal via and visible signature", async () => {
    const dispatch = vi.fn(async () => null);
    const { service } = setupService({
      rules: [makeRule({ hookId: HOOK_ID, signature: githubSignatureConfig })],
      readSecret: defaultReadSecret,
      dispatch,
    });
    seedHook(HOOK_ID, HOOK_TOKEN, null);

    const recv = await service.receive({
      hookId: HOOK_ID,
      token: HOOK_TOKEN,
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: githubSignature,
        "x-ade-test": "never-issued-nonce",
      },
      query: {},
      rawBody: Buffer.from(githubBody, "utf8"),
      via: "local",
    });
    expect(recv.outcome).toBe("ran");
    const delivery = service.getDelivery({ id: recv.deliveryId! });
    expect(delivery?.via).toBe("local");
    expect(delivery?.headers["x-ade-test"]).toBe("never-issued-nonce");
    expect(delivery?.headers[SIGNATURE_HEADER]).toBe(githubSignature);
  });

  function makeRelayFetch(pages: Array<{ events: HeldEvent[]; hasMore: boolean }>): {
    fetchImpl: typeof fetch;
    ackBodies: Array<{ eventIds: string[] }>;
    eventHooksParams: string[];
  } {
    const ackBodies: Array<{ eventIds: string[] }> = [];
    const eventHooksParams: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toString().toUpperCase();
      if (url.includes("/hooks/register")) return jsonResponse({ ok: true });
      if (url.includes("/hooks/ack")) {
        ackBodies.push(JSON.parse(String(init?.body ?? "{}")) as { eventIds: string[] });
        return jsonResponse({ ok: true });
      }
      if (url.includes("/hooks/events")) {
        eventHooksParams.push(new URL(url).searchParams.get("hooks") ?? "");
        return jsonResponse(pages.shift() ?? { events: [], hasMore: false });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;
    return { fetchImpl, ackBodies, eventHooksParams };
  }

  function relayRules(): AutomationRule[] {
    return [
      makeRule({ ruleId: "rule-ok", hookId: HOOK_OK }),
      makeRule({
        ruleId: "rule-bad",
        hookId: HOOK_BAD,
        signature: { scheme: "hmac", header: "x-signature", secretName: "BOOM_SECRET" },
      }),
    ];
  }

  it("pollNow(): acknowledges only the relay events whose receive succeeded", async () => {
    const relay = makeRelayFetch([
      { events: [heldEvent(HOOK_OK, "evt-ok"), heldEvent(HOOK_BAD, "evt-bad")], hasMore: false },
    ]);
    const dispatch = vi.fn(async () => null);
    const { service } = setupService({
      rules: relayRules(),
      readSecret: (name) => {
        if (name === "BOOM_SECRET") throw new Error("signing secret read failed");
        return defaultReadSecret(name);
      },
      dispatch,
      fetchImpl: relay.fetchImpl,
      accountToken: "account-token",
    });
    seedHook(HOOK_OK, "token-ok", new Date().toISOString());
    seedHook(HOOK_BAD, "token-bad", new Date().toISOString());

    service.start();
    await service.pollNow();

    expect(relay.ackBodies).toHaveLength(1);
    expect(relay.ackBodies[0]?.eventIds).toEqual(["evt-ok"]);
    expect(relay.ackBodies[0]?.eventIds).not.toContain("evt-bad");
    expect(service.listDeliveries({ hookId: HOOK_BAD })).toHaveLength(0);
    const good = service.listDeliveries({ hookId: HOOK_OK });
    expect(good[0]?.outcome).toBe("ran");
  });

  it("pollNow(): drops a failing hook and still drains other hooks on the next page", async () => {
    const relay = makeRelayFetch([
      { events: [heldEvent(HOOK_BAD, "evt-bad-1")], hasMore: true },
      { events: [heldEvent(HOOK_OK, "evt-ok-1")], hasMore: false },
    ]);
    const dispatch = vi.fn(async () => null);
    const { service } = setupService({
      rules: relayRules(),
      readSecret: (name) => {
        if (name === "BOOM_SECRET") throw new Error("signing secret read failed");
        return defaultReadSecret(name);
      },
      dispatch,
      fetchImpl: relay.fetchImpl,
      accountToken: "account-token",
    });
    seedHook(HOOK_OK, "token-ok", new Date().toISOString());
    seedHook(HOOK_BAD, "token-bad", new Date().toISOString());

    service.start();
    await service.pollNow();

    expect(relay.eventHooksParams[0]?.split(",")).toEqual(expect.arrayContaining([HOOK_OK, HOOK_BAD]));
    expect(relay.eventHooksParams).toContain(HOOK_OK);
    expect(relay.ackBodies).toHaveLength(1);
    expect(relay.ackBodies[0]?.eventIds).toEqual(["evt-ok-1"]);
    expect(service.listDeliveries({ hookId: HOOK_BAD })).toHaveLength(0);
  });
});
