#!/usr/bin/env node
/**
 * Keeps ADE's analytics tracking plan honest.
 *
 * Reads the events every surface can send (desktop/brain policy list and its
 * call sites, the iOS event enum, the marketing site's event map, the account
 * directory's server-side captures, `$identify`), the plan in
 * `docs/analytics/tracking-plan.json`, and every event the PostHog dashboard
 * spec references. Fails when:
 *
 * - an event is sent but missing from the plan;
 * - the plan lists an event nothing sends;
 * - a desktop/brain event is declared but no source file ever captures it;
 * - a dashboard references an event nothing sends;
 * - a plan entry names an owner file that does not exist.
 *
 * Plain regex extraction over source text, node built-ins only, so it runs in
 * CI's dependency-free docs job. See docs/analytics/README.md.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (...parts) => path.join(repoRoot, ...parts);
const read = (...parts) => fs.readFileSync(rel(...parts), "utf8");

const SOURCES = {
  desktopEvents: ["apps", "desktop", "src", "shared", "types", "productAnalytics.ts"],
  desktopRoots: [["apps", "desktop", "src"], ["apps", "ade-cli", "src"]],
  ios: ["apps", "ios", "ADE", "Services", "ProductAnalytics.swift"],
  marketing: ["apps", "web", "src", "lib", "marketingAnalytics.ts"],
  server: ["apps", "account-directory", "src", "signupAnalytics.ts"],
  identify: [
    ["apps", "desktop", "src", "main", "services", "analytics", "productAnalyticsService.ts"],
    ["apps", "ios", "ADE", "Services", "ProductAnalytics.swift"],
  ],
  plan: ["docs", "analytics", "tracking-plan.json"],
  dashboards: ["scripts", "posthog", "dashboard-spec.mjs"],
};

const EVENT_NAME = /^(?:ade_[a-z0-9_]+|\$[a-z_]+|survey (?:shown|dismissed|sent))$/;

function quoted(text) {
  return [...text.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
}

function block(text, startPattern, endToken, label) {
  const start = text.search(startPattern);
  if (start < 0) throw new Error(`Could not find ${label}.`);
  const end = text.indexOf(endToken, start);
  if (end < 0) throw new Error(`Could not find the end of ${label}.`);
  return text.slice(start, end);
}

/** `PRODUCT_ANALYTICS_EVENTS = [ ... ] as const` in the shared desktop types. */
export function desktopDeclaredEvents(text) {
  const body = block(text, /export const PRODUCT_ANALYTICS_EVENTS\s*=\s*\[/, "] as const", "PRODUCT_ANALYTICS_EVENTS")
    .replace(/\/\/.*$/gm, "");
  return quoted(body).filter((name) => EVENT_NAME.test(name));
}

/** `case x = "ade_mobile_..."` inside `enum ADEAnalyticsEventName`. */
export function iosEvents(text) {
  const body = block(text, /enum ADEAnalyticsEventName\b/, "\n}", "ADEAnalyticsEventName");
  return [...body.matchAll(/case\s+\w+\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
}

/** The values of `MARKETING_ANALYTICS_EVENTS = { ... }`. */
export function marketingEvents(text) {
  const body = block(text, /export const MARKETING_ANALYTICS_EVENTS\s*=\s*\{/, "}", "MARKETING_ANALYTICS_EVENTS");
  return quoted(body).filter((name) => EVENT_NAME.test(name));
}

/** `event: "ade_..."` literals in a source file. */
export function capturedEventLiterals(text) {
  return [...text.matchAll(/\bevent:\s*"([^"\n]+)"/g)].map((match) => match[1]).filter((name) => EVENT_NAME.test(name));
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(?:ts|tsx|mts|mjs)$/.test(entry.name) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) out.push(full);
  }
}

function dashboardEventRefs(spec) {
  const refs = new Map();
  const visit = (value, where) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, where);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.event === "string") refs.set(value.event, where);
    if (value.kind === "EventsNode" && typeof value.id === "string") refs.set(value.id, where);
    for (const child of Object.values(value)) visit(child, where);
  };
  for (const dashboard of spec.dashboards) {
    for (const item of dashboard.insights) visit(item.query, `${dashboard.key}/${item.key}`);
  }
  return refs;
}

export async function checkTrackingPlan() {
  const problems = [];
  const fired = new Map(); // event -> source label

  for (const name of desktopDeclaredEvents(read(...SOURCES.desktopEvents))) fired.set(name, "desktop_policy");
  for (const name of iosEvents(read(...SOURCES.ios))) fired.set(name, "ios");
  for (const name of marketingEvents(read(...SOURCES.marketing))) fired.set(name, "marketing");
  for (const name of capturedEventLiterals(read(...SOURCES.server))) fired.set(name, "server");
  if (SOURCES.identify.some((parts) => read(...parts).includes('"$identify"'))) fired.set("$identify", "system");

  // A declared desktop/brain event must have a real capture site.
  const files = [];
  for (const root of SOURCES.desktopRoots) walk(rel(...root), files);
  const captured = new Set();
  for (const file of files) for (const name of capturedEventLiterals(fs.readFileSync(file, "utf8"))) captured.add(name);
  for (const [name, source] of fired) {
    if (source === "desktop_policy" && !captured.has(name)) {
      problems.push(`"${name}" is declared in PRODUCT_ANALYTICS_EVENTS but no desktop or brain source captures it (\`event: "${name}"\`). Remove it or emit it.`);
    }
  }

  const plan = JSON.parse(read(...SOURCES.plan));
  const planned = new Map();
  for (const entry of plan.events ?? []) {
    if (!entry || typeof entry.name !== "string") {
      problems.push(`tracking-plan.json has an entry without a name.`);
      continue;
    }
    if (planned.has(entry.name)) problems.push(`tracking-plan.json lists "${entry.name}" twice.`);
    planned.set(entry.name, entry);
    if (typeof entry.owner !== "string" || !fs.existsSync(rel(...entry.owner.split("/")))) {
      problems.push(`tracking-plan.json: "${entry.name}" names owner file ${JSON.stringify(entry.owner)}, which does not exist.`);
    }
    if (!Array.isArray(entry.platforms) || entry.platforms.length === 0 || typeof entry.purpose !== "string" || !entry.purpose.trim()) {
      problems.push(`tracking-plan.json: "${entry.name}" needs platforms and a purpose.`);
    }
  }

  for (const [name, source] of fired) {
    if (!planned.has(name)) problems.push(`"${name}" is sent (${source}) but missing from docs/analytics/tracking-plan.json.`);
  }
  for (const name of planned.keys()) {
    if (!fired.has(name)) problems.push(`docs/analytics/tracking-plan.json lists "${name}", but nothing sends it.`);
  }

  const spec = await import(pathToFileURL(rel(...SOURCES.dashboards)).href);
  for (const [name, where] of dashboardEventRefs(spec.dashboardSpec)) {
    if (!fired.has(name)) problems.push(`Dashboard insight ${where} references "${name}", but nothing sends it.`);
  }
  for (const name of [...Object.values(spec.EVENTS), ...spec.SYSTEM_EVENTS]) {
    if (!fired.has(name)) problems.push(`dashboard-spec.mjs EVENTS lists "${name}", but nothing sends it.`);
  }
  for (const name of fired.keys()) {
    if (![...Object.values(spec.EVENTS), ...spec.SYSTEM_EVENTS].includes(name)) {
      problems.push(`"${name}" is sent but missing from dashboard-spec.mjs EVENTS, so the 30-day volume cards undercount.`);
    }
  }

  return { problems, events: fired.size };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { problems, events } = await checkTrackingPlan();
  if (problems.length > 0) {
    process.stderr.write(`Analytics tracking plan is out of date (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    process.stderr.write("See docs/analytics/README.md (How to add an event).\n");
    process.exit(1);
  }
  process.stdout.write(`Analytics tracking plan matches the code and dashboards: ${events} events.\n`);
}
