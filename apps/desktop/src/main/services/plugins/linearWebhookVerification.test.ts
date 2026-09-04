// ---------------------------------------------------------------------------
// The ade-linear plugin's OWN webhook channel, end to end.
//
// `pluginWebhookIngressService.test.ts` proves the MACHINE: a channel that
// declares `verify` fails closed, a good signature passes, a bad one is
// abandoned. It proves all of that against a hand-written channel literal
// (`{ id: "default", verify: { secretRef: "SIGNING" } }`), which is exactly the
// right shape for testing the engine and exactly the wrong shape for testing
// the plugin — a literal cannot notice that what ships in `plugins/ade-linear`
// says something different.
//
// This file closes the other half. Every case below is driven by the REAL
// `plugins/ade-linear/plugin.json`, parsed through the real parser, and the
// failure it guards is one that is invisible in production:
//
//   * verification failure never produces a payload — the row is marked
//     abandoned and the plugin child hears nothing at all;
//   * the user's side of the setup ("paste the signing secret") reports
//     "Saved" whether or not the name it saved under is the name the host will
//     look for;
//   * Linear's own retry gives up long before anyone reads a log line.
//
// So a three-way disagreement between the manifest's `secretRef`, the key
// `saveWebhookSecret` writes, and the relay's stored-header allowlist is a
// silently dead integration: the URL is pasted, Linear reports 200, and no
// issue event ever wakes ADE. Nothing else in the suite spans all three.
// ---------------------------------------------------------------------------

import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";
import {
  createPluginWebhookIngressService,
  resetPluginIngressOwnersForTests,
  type PluginWebhookIngressDb,
  type PluginWebhookIngressPlugin,
} from "./pluginWebhookIngressService";
import {
  parsePluginManifestJson,
  type PluginManifestWebhookIngressChannel,
} from "../../../shared/plugins/manifest";
import type { PluginWebhookPayload } from "../../../shared/plugins/sdk";

const testRequire = createRequire(import.meta.url);
const { DatabaseSync } = testRequire("node:sqlite") as {
  DatabaseSync: new (dbPath: string) => DatabaseSyncType;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** apps/desktop/src/main/services/plugins -> repo root. */
const REPO_ROOT = path.resolve(HERE, "../../../../../..");
const LINEAR_PLUGIN_DIR = path.join(REPO_ROOT, "plugins", "ade-linear");
const LINEAR_MANIFEST_PATH = path.join(LINEAR_PLUGIN_DIR, "plugin.json");
const LINEAR_ENTRY_PATH = path.join(LINEAR_PLUGIN_DIR, "index.js");

/**
 * Every JavaScript file the plugin ships, as one string.
 *
 * The secret-name check below reads the plugin as TEXT, and it must read the
 * WHOLE plugin: the writer moved from `index.js` to `actions.js` when the
 * action table was split out, and a check pinned to one file would have gone
 * quietly green on a package that no longer wrote the secret at all. Reading
 * every file is also what makes "exactly one writer" a real claim rather than a
 * claim about one file.
 */
function pluginSource(): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "test") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(readFileSync(full, "utf8"));
    }
  };
  walk(LINEAR_PLUGIN_DIR);
  return files.join("\n");
}
const RELAY_SOURCE_PATH = path.join(REPO_ROOT, "apps", "webhook-relay", "src", "relay.ts");

const PLUGIN_ID = "ade-linear";
const CHANNEL_ID = "linear";

/**
 * The shipped manifest, parsed once by the parser the host actually uses.
 *
 * Parsed at module scope rather than per-test so every case below is bound to
 * the same declaration the loader would see — if one test's channel could
 * differ from another's, the suite would stop being a statement about what
 * ships.
 */
const parsed = parsePluginManifestJson(readFileSync(LINEAR_MANIFEST_PATH, "utf8"));

function linearChannel(): PluginManifestWebhookIngressChannel {
  const channel = parsed.manifest?.webhookIngress.find((entry) => entry.id === CHANNEL_ID);
  if (!channel) throw new Error(`ade-linear declares no "${CHANNEL_ID}" webhook channel`);
  return channel;
}

// ---------------------------------------------------------------------------
// Harness. Copied from `pluginWebhookIngressService.test.ts`, whose helpers are
// file-local and not exported; trimmed to what these six cases use.
// ---------------------------------------------------------------------------

/**
 * A REAL sqlite database rather than a statement-matching fake.
 *
 * The claim under test is "the row ends up abandoned", which is a property of
 * an `update ... set abandoned_at` the drain issues against a row it inserted
 * on an earlier statement. A fake that matched on statement text would report
 * whatever the test wanted rather than what the SQL did.
 *
 * The DDL is copied verbatim from `kvDb.ts`'s migration; `kvDb.migrations.test`
 * owns proving that migration runs.
 */
function createDb(): PluginWebhookIngressDb & { raw: DatabaseSyncType } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    create table if not exists plugin_ingress_events (
      id text primary key,
      project_id text not null,
      plugin_id text not null,
      channel text not null,
      delivery_id text not null,
      event_type text not null,
      received_at text not null,
      stored_at text not null,
      headers_json text,
      body text,
      attempts integer not null default 0,
      acked_at text,
      abandoned_at text
    );
    create index if not exists idx_plugin_ingress_events_delivery on plugin_ingress_events(project_id, plugin_id, delivery_id);
    create index if not exists idx_plugin_ingress_events_pending on plugin_ingress_events(project_id, plugin_id, acked_at, abandoned_at);
    create index if not exists idx_plugin_ingress_events_stored on plugin_ingress_events(plugin_id, stored_at desc);
  `);
  const kv = new Map<string, unknown>();
  return {
    raw,
    getJson: <T>(key: string): T | null => (kv.has(key) ? (kv.get(key) as T) : null),
    setJson: (key: string, value: unknown): void => {
      if (value === null || value === undefined) kv.delete(key);
      else kv.set(key, value);
    },
    run: (sql: string, params: unknown[] = []): void => {
      raw.prepare(sql).run(...(params as never[]));
    },
    get: <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T | null => {
      return (raw.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
    },
    all: <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T[] => {
      return raw.prepare(sql).all(...(params as never[])) as T[];
    },
  } as PluginWebhookIngressDb & { raw: DatabaseSyncType };
}

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function relayEvent(input: {
  seq: number;
  eventId: string;
  channel: string;
  headers: Record<string, unknown>;
  body: string;
}): Record<string, unknown> {
  return {
    cursor: `seq:${input.seq}`,
    eventId: input.eventId,
    channel: input.channel,
    eventType: "Issue",
    createdAt: new Date(1_700_000_000_000 + input.seq * 1000).toISOString(),
    headers: input.headers,
    body: input.body,
  };
}

/**
 * The real drain, wired to the real ade-linear channel.
 *
 * `channels` is not a parameter: taking it from the parsed manifest is the
 * whole point of the file, so there is no way for a case here to accidentally
 * test a channel the plugin does not ship.
 */
function createHarness(options: { secrets?: Record<string, string>; pages: Record<string, unknown>[][] }) {
  const db = createDb();
  const delivered: PluginWebhookPayload[] = [];
  const secretValues = new Map<string, string>(Object.entries(options.secrets ?? {}));
  let pageIndex = 0;

  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/register")) return jsonResponse({ ok: true, secretId: "secret-1" });
    const page = options.pages[Math.min(pageIndex, options.pages.length - 1)] ?? [];
    pageIndex += 1;
    const nextCursor = page.length ? (page[page.length - 1] as { cursor: string }).cursor : null;
    return jsonResponse({ events: page, nextCursor, cursorExpired: false });
  }) as unknown as typeof fetch;

  const plugins: PluginWebhookIngressPlugin[] = [{ pluginId: PLUGIN_ID, channels: [linearChannel()] }];

  const service = createPluginWebhookIngressService({
    db,
    projectId: "project-1",
    logger: createLogger(),
    listPlugins: () => plugins,
    secrets: {
      get: async (id, name) => secretValues.get(`${id}:${name}`) ?? null,
      set: async (id, name, value) => {
        secretValues.set(`${id}:${name}`, value);
      },
    },
    deliver: (_id, payload) => {
      delivered.push(payload);
      return true;
    },
    fetchImpl,
  });

  const rows = (): Record<string, unknown>[] =>
    db.all("select * from plugin_ingress_events order by rowid asc", []);

  return { db, service, delivered, rows, secretValues };
}

/**
 * One delivery shaped like Linear's.
 *
 * Signed as Linear signs — a bare lowercase hex digest with no `sha256=`
 * prefix — under the header name the MANIFEST declares rather than a literal,
 * so a manifest that renamed the header would break this case instead of
 * quietly diverging from it.
 */
function linearDelivery(secret: string, body: string): Record<string, unknown> {
  const channel = linearChannel();
  const headerName = channel.verify?.header ?? "x-webhook-signature";
  return relayEvent({
    seq: 1,
    eventId: "linear-delivery-1",
    channel: channel.id,
    headers: {
      "content-type": "application/json",
      "x-linear-event": "Issue",
      [headerName]: createHmac("sha256", secret).update(body, "utf8").digest("hex"),
    },
    body,
  });
}

afterEach(() => {
  resetPluginIngressOwnersForTests();
  vi.useRealTimers();
});

beforeEach(() => {
  resetPluginIngressOwnersForTests();
});

describe("ade-linear webhook channel declaration", () => {
  // The manifest is the contract for everything below. If it does not parse,
  // or parses with the channel dropped, ADE loads the plugin anyway (only
  // `errors` block a load — a dropped declaration is a warning) and the whole
  // webhook feature is simply absent with no visible failure. Warnings are
  // dumped into the failure message because "which declaration got dropped" is
  // the only useful thing to know when this breaks.
  it("parses cleanly and declares one hmac-verified channel", () => {
    expect(parsed.errors, `manifest errors: ${JSON.stringify(parsed.errors)}`).toEqual([]);
    expect(parsed.warnings, `manifest warnings: ${JSON.stringify(parsed.warnings)}`).toEqual([]);
    expect(parsed.manifest).not.toBeNull();

    const channel = linearChannel();
    expect(channel.verify).toEqual({
      kind: "hmac-sha256",
      secretRef: "LINEAR_WEBHOOK_SECRET",
      header: "linear-signature",
    });
  });

  // THE FAILURE NOTHING ELSE CATCHES.
  //
  // `saveWebhookSecret` is the only way a user stores this secret, and the host
  // only ever looks under the manifest's `secretRef`. If the two names drift —
  // a rename on one side, a typo on the other — the user pastes the secret,
  // sees "Saved the Linear webhook signing secret.", and every delivery is
  // refused forever, because a failed verify is an abandoned row and not an
  // error anyone sees. No unit test of the plugin and no unit test of the
  // service can see across that seam; only reading both sides can.
  //
  // Read as TEXT rather than by importing the plugin: `index.js` is a plugin
  // child module built against the plugin SDK's globals, not a desktop module,
  // and importing it here would test an import shim instead of the shipped
  // source.
  it("stores the secret under exactly the name the manifest declares", () => {
    const secretRef = linearChannel().verify?.secretRef;
    expect(secretRef).toBe("LINEAR_WEBHOOK_SECRET");

    const source = pluginSource();
    // The writer names the secret through a module constant rather than a
    // literal, so the text read has to resolve one hop. Anything further —
    // a computed name, a name assembled at runtime — stays unresolved and
    // fails this test, which is the answer we want: a secret name a reader
    // cannot find by reading is a name that can drift unseen.
    const constants = new Map(
      [...source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]+)"/g)]
        .map((match) => [match[1]!, match[2]!] as const),
    );
    const setArgs = [...source.matchAll(/secrets\.set\(\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))/g)];
    const setNames = setArgs.map((match) => match[1] ?? constants.get(match[2]!) ?? match[2]!);
    const webhookSetNames = setNames.filter((name) => name.includes("WEBHOOK"));

    // Exactly one writer, and it writes the declared name. A second writer
    // under another name would be the same silent breakage wearing a disguise.
    expect(webhookSetNames).toEqual([secretRef]);
  });

  // The relay drops every header outside `PLUGIN_WEBHOOK_STORED_HEADERS` before
  // the delivery is written, and `passesVerification` reads the signature off
  // the STORED row. So a channel whose `verify.header` is missing from that
  // list can never verify anything: the correct secret, the correct signature
  // and a correctly configured Linear webhook would still yield an empty
  // signature string and a refusal on every single delivery.
  //
  // Linear is the specific hazard here — it signs with an UNPREFIXED header
  // name (`linear-signature`), so it does not fall under any `x-*` convention
  // the list was originally built around.
  //
  // Asserted against the relay SOURCE TEXT rather than by importing the symbol.
  // `apps/webhook-relay` is a Cloudflare Worker: `relay.ts` references
  // `D1Database`, `DurableObjectNamespace` and `DurableObjectStub`, which come
  // from `@cloudflare/workers-types`. The desktop tsconfig sets
  // `types: ["node"]`, so importing across that package boundary makes
  // `tsc --noEmit -p tsconfig.json` fail with TS2304/TS2552 inside relay.ts —
  // errors in another package's file that this test has no business creating.
  it("declares a signature header the relay actually stores", () => {
    const headerName = linearChannel().verify?.header;
    expect(headerName).toBeTruthy();

    const relaySource = readFileSync(RELAY_SOURCE_PATH, "utf8");
    const match = /export const PLUGIN_WEBHOOK_STORED_HEADERS = \[([\s\S]*?)\];/.exec(relaySource);
    expect(match, "PLUGIN_WEBHOOK_STORED_HEADERS is no longer an exported array literal in relay.ts")
      .not.toBeNull();

    const storedHeaders = [...match![1]!.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!);
    // Sanity that the regex read a real list and not an empty capture.
    expect(storedHeaders).toContain("content-type");
    expect(storedHeaders).toContain(headerName);
  });
});

describe("ade-linear webhook channel verification", () => {
  const body = JSON.stringify({ action: "update", type: "Issue", data: { identifier: "ADE-1" } });
  const secret = "lin_wh_".concat("s".repeat(40));
  const secretKey = `${PLUGIN_ID}:LINEAR_WEBHOOK_SECRET`;

  // FAILS CLOSED. Until the user pastes the signing secret there is nothing to
  // check a signature against, and "the manifest says verify this and I cannot"
  // has exactly one safe reading. The dangerous alternative is not a crash —
  // it is delivering an unverified body to a plugin that will start lanes and
  // move issues from it, from a URL anyone who has seen it can POST to.
  it("abandons a delivery when the signing secret has not been stored", async () => {
    const harness = createHarness({ pages: [[linearDelivery(secret, body)], []] });
    await harness.service.pollNow();

    expect(harness.delivered).toHaveLength(0);
    expect(harness.rows()).toHaveLength(1);
    expect(harness.rows()[0]?.abandoned_at).toBeTruthy();
  });

  // The other half, and the reason the case above is not enough on its own: a
  // fail-closed channel that can never pass is just as broken as one that never
  // fails, and looks identical from the outside. This is the only assertion in
  // the repo that the shipped secretRef + header + prefix defaults compose into
  // a delivery that actually reaches the plugin.
  it("delivers a delivery signed with the stored secret", async () => {
    const harness = createHarness({
      secrets: { [secretKey]: secret },
      pages: [[linearDelivery(secret, body)], []],
    });
    await harness.service.pollNow();

    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0]).toMatchObject({
      event: "webhook.received",
      id: "linear-delivery-1",
      channel: CHANNEL_ID,
      attempt: 1,
    });
    // The signature is stored so a restart can still verify a pending row, but
    // it is re-filtered out of what the child sees.
    expect(harness.delivered[0]?.headers).not.toHaveProperty("linear-signature");
    expect(harness.rows()[0]?.abandoned_at).toBeNull();
  });

  // A stale secret — Linear's webhook was deleted and recreated, or the user
  // pasted the wrong one of two — is the realistic wrong-secret case, and it
  // must land on the refusal side rather than the "close enough" side.
  it("abandons a delivery signed with a different secret", async () => {
    const harness = createHarness({
      secrets: { [secretKey]: secret },
      pages: [[linearDelivery("some-other-signing-secret", body)], []],
    });
    await harness.service.pollNow();

    expect(harness.delivered).toHaveLength(0);
    expect(harness.rows()[0]?.abandoned_at).toBeTruthy();
  });
});
