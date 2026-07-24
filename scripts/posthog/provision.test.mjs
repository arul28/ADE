import assert from "node:assert/strict";
import { test } from "node:test";

import { dashboardSpec } from "./dashboard-spec.mjs";
import {
  PostHogApi,
  configFromEnv,
  provisionDashboards,
  validateDashboardSpec,
} from "./provision.mjs";

function response(status, body) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function findInsight(key) {
  for (const dashboard of dashboardSpec.dashboards) {
    const insight = dashboard.insights.find((candidate) => candidate.key === key);
    if (insight) return insight;
  }
  throw new Error(`Missing insight ${key}`);
}

test("dashboard spec is valid and excludes replay queries", () => {
  assert.deepEqual(validateDashboardSpec(), { dashboards: 5, insights: 31 });
  assert.doesNotMatch(JSON.stringify(dashboardSpec), /\$snapshot|session replay|recording_property/i);
});

test("dashboard queries match the bounded instrumentation semantics", () => {
  const surface = findInsight("active-installations-by-surface");
  assert.equal(surface.name, "Feature-active installations by surface");
  assert.equal(surface.query.source.series[0].event, "ade_feature_used");
  assert.equal(surface.query.source.breakdownFilter.breakdown, "surface");

  const errors = findInsight("unrecoverable-errors");
  assert.equal(errors.name, "Errors by action");
  assert.equal(errors.query.source.breakdownFilter.breakdown, "action");

  const outcomes = findInsight("work-session-outcomes");
  assert.equal(outcomes.name, "First agent-turn outcomes");
  assert.equal(outcomes.query.source.series[0].event, "ade_work_session_completed");
  assert.equal(outcomes.query.source.breakdownFilter.breakdown, "outcome");

  const provider = findInsight("provider-adoption");
  assert.deepEqual(provider.query.source.properties, [{ key: "summary_kind", value: "provider", operator: "exact", type: "event" }]);
  const model = findInsight("model-family-adoption");
  assert.deepEqual(model.query.source.properties, [{ key: "summary_kind", value: "model", operator: "exact", type: "event" }]);

  const budget = findInsight("analytics-sent-vs-dropped");
  assert.match(budget.description, /accepted means admitted.+not confirmed delivered/i);

  const firstValue = findInsight("first-value-funnel");
  assert.equal(firstValue.name, "Desktop/web first-value funnel");
  assert.deepEqual(firstValue.query.source.series[0].properties, [
    { key: "surface", value: ["desktop", "web"], operator: "exact", type: "event" },
  ]);

  const marketingFunnel = findInsight("homepage-get-started-funnel");
  assert.deepEqual(
    marketingFunnel.query.source.series.map((series) => series.event),
    ["ade_marketing_app_opened", "ade_marketing_screen_viewed", "ade_marketing_feature_used"],
  );
  assert.deepEqual(marketingFunnel.query.source.series[1].properties, [
    { key: "screen", value: "home", operator: "exact", type: "event" },
  ]);
  const productDashboardEvents = dashboardSpec.dashboards
    .filter((dashboard) => ["growth-retention", "surface-feature-adoption"].includes(dashboard.key))
    .flatMap((dashboard) => dashboard.insights)
    .flatMap((managedInsight) => managedInsight.query.source.series ?? [])
    .map((series) => series.event);
  assert.equal(productDashboardEvents.some((event) => event.startsWith("ade_marketing_")), false);
  assert.equal(productDashboardEvents.some((event) => event.startsWith("ade_mobile_")), false);

  const ingestedVolume = findInsight("monthly-analytics-volume");
  assert.equal(ingestedVolume.name, "30-day ingested analytics volume");
  assert.equal(ingestedVolume.query.source.series.length, 25);
  assert.equal(ingestedVolume.query.source.trendsFilter.formula, "A+B+C+D+E+F+G+H+I+J+K+L+M+N+O+P+Q+R+S+T+U+V+W+X+Y");
});

test("config requires HTTPS and a numeric project ID", () => {
  assert.throws(
    () => configFromEnv({ POSTHOG_PERSONAL_API_KEY: "phx_test", POSTHOG_PROJECT_ID: "abc" }),
    /numeric project ID/,
  );
  assert.throws(
    () =>
      configFromEnv({
        POSTHOG_PERSONAL_API_KEY: "phx_test",
        POSTHOG_PROJECT_ID: "42",
        POSTHOG_HOST: "http://example.com",
      }),
    /must use HTTPS/,
  );
  assert.throws(
    () => configFromEnv({ POSTHOG_PERSONAL_API_KEY: "phc_public", POSTHOG_PROJECT_ID: "42" }),
    /personal phx_ API key/,
  );
});

test("API requests use a bounded AbortSignal", async () => {
  let requestSignal;
  const api = new PostHogApi({
    host: new URL("https://us.posthog.com"),
    projectId: "42",
    apiKey: "phx_secret-key",
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });

  await assert.rejects(api.request("dashboards/"), /timed out after 5ms/);
  assert.equal(requestSignal instanceof AbortSignal, true);
  assert.equal(requestSignal.aborted, true);
});

test("API refuses cross-origin pagination before forwarding credentials", async () => {
  const calls = [];
  const api = new PostHogApi({
    host: new URL("https://us.posthog.com"),
    projectId: "42",
    apiKey: "secret-key",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization });
      return response(200, { results: [], next: "https://attacker.invalid/next" });
    },
  });

  await assert.rejects(api.list("dashboards/"), /cross-origin/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, "Bearer secret-key");
});

test("API errors redact the personal key", async () => {
  const api = new PostHogApi({
    host: new URL("https://us.posthog.com"),
    projectId: "42",
    apiKey: "secret-key",
    fetchImpl: async () => new Response("request rejected for secret-key", { status: 400 }),
  });

  await assert.rejects(
    api.request("dashboards/"),
    (error) => error instanceof Error && !error.message.includes("secret-key") && error.message.includes("[REDACTED]"),
  );
});

test("dry run plans every object without issuing writes", async () => {
  const writes = [];
  const api = {
    async list() {
      return [];
    },
    async request(path, options = {}) {
      if (options.method && options.method !== "GET") writes.push({ path, options });
      return null;
    },
  };
  let output = "";
  const summary = await provisionDashboards({
    api,
    dryRun: true,
    output: { write(chunk) { output += chunk; } },
  });

  assert.deepEqual(summary, { created: 36, updated: 0, unchanged: 0 });
  assert.equal(writes.length, 0);
  assert.match(output, /would create dashboard: ADE · Growth and retention/);
  assert.match(output, /would create dashboard: ADE · Marketing acquisition/);
  assert.match(output, /would create dashboard: ADE · Native mobile engagement/);
  assert.match(output, /would create insight: 30-day ingested analytics volume/);
});

test("managed objects that already match are not rewritten", async () => {
  const writes = [];
  const dashboardsByTag = new Map();
  const insightsByTag = new Map();
  let nextDashboardId = 1;
  let nextInsightId = 100;

  const api = {
    async list(path, params) {
      if (path === "dashboards/") {
        const dashboard = dashboardsByTag.get(params.search);
        if (dashboard) return [dashboard];
        return [...dashboardsByTag.values()].filter((item) => item.name === params.search);
      }
      const requestedTags = params.tags ? JSON.parse(params.tags) : [];
      if (requestedTags.length > 0) {
        const insight = insightsByTag.get(requestedTags[0]);
        return insight ? [insight] : [];
      }
      return [...insightsByTag.values()].filter((item) => item.name === params.search);
    },
    async request(path, options = {}) {
      if (!options.method || options.method === "GET") {
        const id = Number(path.match(/insights\/(\d+)/)?.[1]);
        return [...insightsByTag.values()].find((item) => item.id === id);
      }
      writes.push({ path, options });
      if (path === "dashboards/") {
        const item = { id: nextDashboardId++, ...options.body };
        for (const tag of item.tags) if (tag.startsWith("ade-dashboard:")) dashboardsByTag.set(tag, item);
        return item;
      }
      if (path === "insights/") {
        const item = {
          id: nextInsightId++,
          ...options.body,
          dashboard_tiles: options.body.dashboards.map((dashboard_id) => ({ dashboard_id, deleted: false })),
        };
        for (const tag of item.tags) if (tag.startsWith("ade-insight:")) insightsByTag.set(tag, item);
        return item;
      }
      throw new Error(`Unexpected write ${path}`);
    },
  };

  const first = await provisionDashboards({ api, output: { write() {} } });
  assert.deepEqual(first, { created: 36, updated: 0, unchanged: 0 });
  assert.equal(writes.length, 36);

  writes.length = 0;
  const second = await provisionDashboards({ api, output: { write() {} } });
  assert.deepEqual(second, { created: 0, updated: 0, unchanged: 36 });
  assert.equal(writes.length, 0);
});
