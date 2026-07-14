#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  dashboardSpec,
  EVENTS,
  MANAGED_TAG,
  PROPERTIES,
  SPEC_VERSION_TAG,
} from "./dashboard-spec.mjs";

const API_KEY_ENV = "POSTHOG_PERSONAL_API_KEY";
const PROJECT_ID_ENV = "POSTHOG_PROJECT_ID";
const HOST_ENV = "POSTHOG_HOST";
const ALLOW_HTTP_ENV = "POSTHOG_ALLOW_INSECURE_HTTP";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

const DASHBOARD_TAG_PREFIX = "ade-dashboard:";
const INSIGHT_TAG_PREFIX = "ade-insight:";
const MANAGED_DESCRIPTION = "Managed by ADE's scripts/posthog/provision.mjs.";

function usage() {
  process.stdout.write(
    [
      "Usage: node scripts/posthog/provision.mjs [--validate | --dry-run]",
      "",
      "Upserts ADE's managed PostHog dashboards and insights.",
      "",
      "Environment:",
      `  ${API_KEY_ENV}   Personal API key with dashboard and insight read/write scopes.`,
      `  ${PROJECT_ID_ENV}             Numeric PostHog project ID.`,
      `  ${HOST_ENV}                   PostHog app/API origin (default: https://us.posthog.com).`,
      `  ${ALLOW_HTTP_ENV}=1    Permit HTTP for a local self-hosted instance only.`,
      "",
      "Options:",
      "  --validate   Validate the declarative spec without credentials or network access.",
      "  --dry-run    Read PostHog and print the planned changes without writing them.",
      "  --help       Show this help.",
      "",
    ].join("\n"),
  );
}

function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv) {
  const options = { validate: false, dryRun: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--validate") {
      options.validate = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    fail(`Unknown option: ${arg}`);
  }
  if (options.validate && options.dryRun) fail("Use either --validate or --dry-run, not both.");
  return options;
}

function unique(values) {
  return [...new Set(values)];
}

function managedDashboardTags(key) {
  return [MANAGED_TAG, SPEC_VERSION_TAG, `${DASHBOARD_TAG_PREFIX}${key}`];
}

function managedInsightTags(key) {
  return [MANAGED_TAG, SPEC_VERSION_TAG, `${INSIGHT_TAG_PREFIX}${key}`];
}

function normalizedTags(tags) {
  return unique((Array.isArray(tags) ? tags : []).filter((tag) => typeof tag === "string")).sort();
}

function assertUnique(items, field, label) {
  const values = new Set();
  for (const item of items) {
    const value = item?.[field];
    if (typeof value !== "string" || value.trim() === "") fail(`${label} has a missing ${field}.`);
    if (values.has(value)) fail(`${label} has duplicate ${field} ${JSON.stringify(value)}.`);
    values.add(value);
  }
}

function visit(value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  visitor(value);
  for (const child of Object.values(value)) visit(child, visitor);
}

export function validateDashboardSpec(spec = dashboardSpec) {
  if (!spec || typeof spec !== "object") fail("Dashboard spec must be an object.");
  if (!Number.isInteger(spec.version) || spec.version < 1) fail("Dashboard spec version must be a positive integer.");
  if (!Array.isArray(spec.dashboards) || spec.dashboards.length === 0) fail("Dashboard spec has no dashboards.");

  assertUnique(spec.dashboards, "key", "Dashboard spec");
  assertUnique(spec.dashboards, "name", "Dashboard spec");

  const allowedEvents = new Set(Object.values(EVENTS));
  const allowedProperties = new Set(Object.values(PROPERTIES));
  const insightKeys = [];

  for (const dashboard of spec.dashboards) {
    if (!Array.isArray(dashboard.insights) || dashboard.insights.length === 0) {
      fail(`Dashboard ${dashboard.key} has no insights.`);
    }
    assertUnique(dashboard.insights, "key", `Dashboard ${dashboard.key}`);
    assertUnique(dashboard.insights, "name", `Dashboard ${dashboard.key}`);

    for (const item of dashboard.insights) {
      insightKeys.push(item.key);
      if (typeof item.description !== "string" || item.description.trim() === "") {
        fail(`Insight ${item.key} has no description.`);
      }
      if (!item.query || typeof item.query !== "object") fail(`Insight ${item.key} has no query.`);

      visit(item.query, (node) => {
        if (typeof node.event === "string" && !allowedEvents.has(node.event)) {
          fail(`Insight ${item.key} references unknown event ${JSON.stringify(node.event)}.`);
        }
        if (node.kind === "EventsNode" && typeof node.id === "string" && !allowedEvents.has(node.id)) {
          fail(`Insight ${item.key} references unknown retention event ${JSON.stringify(node.id)}.`);
        }
        for (const field of ["breakdown", "key", "math_property"]) {
          if (typeof node[field] === "string" && !allowedProperties.has(node[field])) {
            fail(`Insight ${item.key} references unknown property ${JSON.stringify(node[field])}.`);
          }
        }
      });
    }
  }

  if (new Set(insightKeys).size !== insightKeys.length) fail("Insight keys must be unique across all dashboards.");

  const serialized = JSON.stringify(spec).toLowerCase();
  for (const forbidden of ["$snapshot", "session replay", "recording_property"]) {
    if (serialized.includes(forbidden)) fail(`Dashboard spec contains forbidden replay field ${JSON.stringify(forbidden)}.`);
  }

  return {
    dashboards: spec.dashboards.length,
    insights: insightKeys.length,
  };
}

function normalizeHost(rawHost, allowInsecureHttp) {
  let url;
  try {
    url = new URL(rawHost);
  } catch {
    fail(`${HOST_ENV} must be a valid absolute URL.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    fail(`${HOST_ENV} must contain only an origin and optional path prefix.`);
  }
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    fail(`${HOST_ENV} must use HTTPS. Set ${ALLOW_HTTP_ENV}=1 only for a trusted local instance.`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

export function configFromEnv(env = process.env) {
  const apiKey = env[API_KEY_ENV]?.trim();
  const projectId = env[PROJECT_ID_ENV]?.trim();
  if (!apiKey) fail(`Missing ${API_KEY_ENV}.`);
  if (!apiKey.startsWith("phx_")) {
    fail(`${API_KEY_ENV} must be a personal phx_ API key, not a public phc_ project token.`);
  }
  if (!projectId || !/^\d+$/.test(projectId)) fail(`${PROJECT_ID_ENV} must be a numeric project ID.`);
  const allowInsecureHttp = env[ALLOW_HTTP_ENV] === "1";
  const host = normalizeHost(env[HOST_ENV]?.trim() || "https://us.posthog.com", allowInsecureHttp);
  return { apiKey, projectId, host };
}

function redact(value, secrets) {
  let result = String(value);
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export class PostHogApi {
  constructor({
    host,
    projectId,
    apiKey,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  }) {
    if (typeof fetchImpl !== "function") fail("This script requires a Node.js runtime with fetch support.");
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      fail(`PostHog request timeout must be between 1 and ${MAX_REQUEST_TIMEOUT_MS} milliseconds.`);
    }
    this.host = host;
    this.projectId = projectId;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.projectBase = new URL(`api/projects/${encodeURIComponent(projectId)}/`, `${host.href.replace(/\/?$/, "/")}`);
  }

  projectPath(pathname) {
    return new URL(pathname.replace(/^\/+/, ""), this.projectBase);
  }

  async request(urlOrPath, { method = "GET", body } = {}) {
    const url = urlOrPath instanceof URL ? urlOrPath : this.projectPath(urlOrPath);
    if (url.origin !== this.host.origin) fail("Refusing to send a PostHog credential to a different origin.");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      if (!response.ok) {
        const responseText = redact((await response.text()).slice(0, 2_000), [this.apiKey]);
        const suffix = responseText ? `: ${responseText}` : "";
        fail(`PostHog ${method} ${url.pathname} failed with ${response.status}${suffix}`);
      }
      if (response.status === 204) return null;
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } catch (error) {
      if (controller.signal.aborted) {
        fail(`PostHog ${method} ${url.pathname} timed out after ${this.requestTimeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async list(pathname, searchParams = {}) {
    const firstUrl = this.projectPath(pathname);
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== null) firstUrl.searchParams.set(key, String(value));
    }

    const results = [];
    let nextUrl = firstUrl;
    while (nextUrl) {
      const page = await this.request(nextUrl);
      if (Array.isArray(page)) return [...results, ...page];
      if (!page || !Array.isArray(page.results)) fail(`PostHog ${firstUrl.pathname} returned an unexpected list response.`);
      results.push(...page.results);
      if (!page.next) break;
      nextUrl = new URL(page.next, nextUrl);
      if (nextUrl.origin !== this.host.origin) fail("Refusing a cross-origin PostHog pagination URL.");
    }
    return results;
  }
}

function hasTag(item, tag) {
  return Array.isArray(item?.tags) && item.tags.includes(tag);
}

function matchesDesired(actual, desired) {
  if (Array.isArray(desired)) {
    return Array.isArray(actual) && actual.length === desired.length && desired.every((value, index) => matchesDesired(actual[index], value));
  }
  if (desired && typeof desired === "object") {
    return Boolean(actual) && typeof actual === "object" && Object.entries(desired).every(([key, value]) => matchesDesired(actual[key], value));
  }
  return Object.is(actual, desired);
}

function dashboardNeedsUpdate(existing, desired) {
  return (
    existing.name !== desired.name ||
    existing.description !== desired.description ||
    Boolean(existing.pinned) !== desired.pinned ||
    !desired.tags.every((tag) => hasTag(existing, tag))
  );
}

function insightNeedsUpdate(existing, desired, dashboardId) {
  const dashboardIds = new Set([
    ...(Array.isArray(existing.dashboards) ? existing.dashboards : []),
    ...(Array.isArray(existing.dashboard_tiles)
      ? existing.dashboard_tiles.filter((tile) => tile?.deleted !== true).map((tile) => tile.dashboard_id)
      : []),
  ]);
  return (
    existing.name !== desired.name ||
    existing.description !== desired.description ||
    !desired.tags.every((tag) => hasTag(existing, tag)) ||
    !dashboardIds.has(dashboardId) ||
    !matchesDesired(existing.query, desired.query)
  );
}

function singleManagedMatch(items, tag, kind) {
  const matches = items.filter((item) => item?.deleted !== true && hasTag(item, tag));
  if (matches.length > 1) fail(`Found multiple ${kind} objects with managed tag ${tag}. Resolve the duplicates before rerunning.`);
  return matches[0] ?? null;
}

async function findDashboard(api, dashboard) {
  const keyTag = `${DASHBOARD_TAG_PREFIX}${dashboard.key}`;
  const candidates = await api.list("dashboards/", { search: keyTag, limit: 100 });
  const managed = singleManagedMatch(candidates, keyTag, "dashboard");
  if (managed) return managed;

  const nameMatches = await api.list("dashboards/", { search: dashboard.name, limit: 100 });
  const collision = nameMatches.find((item) => item?.deleted !== true && item.name === dashboard.name);
  if (collision) {
    fail(`Dashboard ${JSON.stringify(dashboard.name)} already exists without managed tag ${keyTag}. Rename it or add the tag explicitly.`);
  }
  return null;
}

async function findInsight(api, item) {
  const keyTag = `${INSIGHT_TAG_PREFIX}${item.key}`;
  const candidates = await api.list("insights/", {
    basic: true,
    saved: true,
    tags: JSON.stringify([keyTag]),
    limit: 100,
  });
  const managed = singleManagedMatch(candidates, keyTag, "insight");
  if (managed) return api.request(`insights/${managed.id}/?refresh=force_cache`);

  const nameMatches = await api.list("insights/", { basic: true, saved: true, search: item.name, limit: 100 });
  const collision = nameMatches.find((candidate) => candidate?.deleted !== true && candidate.name === item.name);
  if (collision) {
    fail(`Insight ${JSON.stringify(item.name)} already exists without managed tag ${keyTag}. Rename it or add the tag explicitly.`);
  }
  return null;
}

function loggerFor(output) {
  return (message) => output.write(`${message}\n`);
}

export async function provisionDashboards({ api, spec = dashboardSpec, dryRun = false, output = process.stdout }) {
  validateDashboardSpec(spec);
  const log = loggerFor(output);
  const summary = { created: 0, updated: 0, unchanged: 0 };

  for (const dashboard of spec.dashboards) {
    const dashboardTags = managedDashboardTags(dashboard.key);
    const desiredDashboard = {
      name: dashboard.name,
      description: `${dashboard.description}\n\n${MANAGED_DESCRIPTION}`,
      pinned: dashboard.pinned === true,
      tags: dashboardTags,
    };
    let existingDashboard = await findDashboard(api, dashboard);

    if (!existingDashboard) {
      log(`${dryRun ? "would create" : "create"} dashboard: ${dashboard.name}`);
      if (dryRun) {
        existingDashboard = { id: `dry-run:${dashboard.key}`, ...desiredDashboard };
      } else {
        existingDashboard = await api.request("dashboards/", { method: "POST", body: desiredDashboard });
        if (!existingDashboard?.id) fail(`PostHog did not return an ID for dashboard ${dashboard.name}.`);
      }
      summary.created += 1;
    } else if (dashboardNeedsUpdate(existingDashboard, desiredDashboard)) {
      log(`${dryRun ? "would update" : "update"} dashboard: ${dashboard.name}`);
      if (!dryRun) {
        existingDashboard = await api.request(`dashboards/${existingDashboard.id}/`, {
          method: "PATCH",
          body: {
            ...desiredDashboard,
            tags: normalizedTags([...(existingDashboard.tags ?? []), ...dashboardTags]),
          },
        });
      }
      summary.updated += 1;
    } else {
      log(`unchanged dashboard: ${dashboard.name}`);
      summary.unchanged += 1;
    }

    for (const item of dashboard.insights) {
      const insightTags = managedInsightTags(item.key);
      const existingInsight = await findInsight(api, item);
      const desiredInsight = {
        name: item.name,
        description: item.description,
        query: item.query,
        tags: insightTags,
        dashboards: [existingDashboard.id],
      };

      if (!existingInsight) {
        log(`${dryRun ? "would create" : "create"} insight: ${item.name}`);
        if (!dryRun) await api.request("insights/", { method: "POST", body: desiredInsight });
        summary.created += 1;
        continue;
      }

      if (insightNeedsUpdate(existingInsight, desiredInsight, existingDashboard.id)) {
        const attachedDashboardIds = unique([
          ...(Array.isArray(existingInsight.dashboards) ? existingInsight.dashboards : []),
          ...(Array.isArray(existingInsight.dashboard_tiles)
            ? existingInsight.dashboard_tiles
                .filter((tile) => tile?.deleted !== true)
                .map((tile) => tile.dashboard_id)
            : []),
          existingDashboard.id,
        ]);
        log(`${dryRun ? "would update" : "update"} insight: ${item.name}`);
        if (!dryRun) {
          await api.request(`insights/${existingInsight.id}/`, {
            method: "PATCH",
            body: {
              ...desiredInsight,
              tags: normalizedTags([...(existingInsight.tags ?? []), ...insightTags]),
              dashboards: attachedDashboardIds,
            },
          });
        }
        summary.updated += 1;
      } else {
        log(`unchanged insight: ${item.name}`);
        summary.unchanged += 1;
      }
    }
  }

  return summary;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return;
  }

  const counts = validateDashboardSpec();
  if (options.validate) {
    process.stdout.write(`Valid PostHog dashboard spec: ${counts.dashboards} dashboards, ${counts.insights} insights.\n`);
    return;
  }

  const config = configFromEnv(env);
  const api = new PostHogApi(config);
  const summary = await provisionDashboards({ api, dryRun: options.dryRun });
  process.stdout.write(
    `${options.dryRun ? "Plan" : "Provisioning"} complete: ${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged.\n`,
  );
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`[ade-posthog] ${redact(error instanceof Error ? error.message : error, [process.env[API_KEY_ENV]?.trim()])}\n`);
    process.exitCode = 1;
  });
}
