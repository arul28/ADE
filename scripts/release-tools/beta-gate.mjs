#!/usr/bin/env node
// The release gate for a beta: may it become stable?
//
//   node scripts/release-tools/beta-gate.mjs v1.2.127-beta.4 [--json]
//
// Read-only. Asks Sentry (org ade-app, projects ade-desktop and ade-brain)
// three questions about the build `ade@<version>` since it was published:
//
//   1. Was Sentry receiving errors the whole time? An organization over its
//      error quota drops every error ("rate_limited"); then "no errors" means
//      nothing, so the gate fails.
//   2. Did the build run? At least one Sentry Log from it. Builds from
//      1.2.128 on send `app.started` and `brain.started` once per launch;
//      older builds count by any log line.
//   3. Did it bring new errors? No issue first seen in this build, and no
//      error-level log line whose event name the current stable build does
//      not also log. (`window.console` is renderer console noise, never
//      counted.)
//
// Exit 0: PASS. Exit 1: FAIL (the reasons are printed). Exit 2: the gate
// could not run (no token, Sentry unreachable, unknown version): never read
// that as a pass.
//
// The token is SENTRY_AUTH_TOKEN from the environment, else the ADE secret
// SENTRY_AUTH_TOKEN (`ade secrets get`). It needs org:read, project:read and
// event:read.
import { execFileSync } from "node:child_process";

const ORG = "ade-app";
const API = "https://us.sentry.io/api/0";
const PROJECTS = ["ade-desktop", "ade-brain"];
const REPO = process.env.GH_REPO || "arul28/ADE";
const NOISE_EVENTS = new Set(["window.console"]);

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const tagArg = args.find((arg) => !arg.startsWith("--"));
if (!tagArg) {
  console.error("usage: beta-gate.mjs <vX.Y.Z-beta.N> [--json]");
  process.exit(2);
}
const version = tagArg.replace(/^v/, "");
const tag = `v${version}`;
const release = `ade@${version}`;

function cannotRun(message) {
  if (asJson) console.log(JSON.stringify({ tag, result: "unavailable", reason: message }));
  else console.error(`beta-gate: cannot check ${tag}: ${message}`);
  process.exit(2);
}

function readToken() {
  const fromEnv = process.env.SENTRY_AUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("ade", ["secrets", "get", "SENTRY_AUTH_TOKEN", "--text"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function publishedAt() {
  try {
    return execFileSync("gh", ["release", "view", tag, "--repo", REPO, "--json", "publishedAt", "--jq", ".publishedAt"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const token = readToken();
if (!token) cannotRun("no Sentry token (set SENTRY_AUTH_TOKEN or the ADE secret SENTRY_AUTH_TOKEN)");
const since = publishedAt();
if (!since) cannotRun(`no published release ${tag} on ${REPO}`);
const window = { start: since, end: new Date().toISOString() };

async function get(path, params) {
  const url = new URL(`${API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    for (const item of [value].flat()) url.searchParams.append(key, String(item));
  }
  let response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (error) {
    cannotRun(`Sentry is unreachable (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!response.ok) cannotRun(`Sentry answered ${response.status} for ${path}`);
  return await response.json();
}

async function projectIds() {
  const projects = await get(`/organizations/${ORG}/projects/`, {});
  const ids = {};
  for (const project of projects) if (PROJECTS.includes(project.slug)) ids[project.slug] = project.id;
  if (PROJECTS.some((slug) => !ids[slug])) cannotRun(`Sentry has no project ${PROJECTS.filter((slug) => !ids[slug]).join(", ")}`);
  return ids;
}

/** Errors Sentry dropped for quota since the beta was published. */
async function droppedErrors() {
  const stats = await get(`/organizations/${ORG}/stats_v2/`, {
    field: "sum(quantity)",
    groupBy: ["outcome", "reason"],
    category: "error",
    outcome: "rate_limited",
    interval: "1h",
    ...window,
  });
  let dropped = 0;
  const reasons = new Set();
  for (const group of stats.groups ?? []) {
    const total = group.totals?.["sum(quantity)"] ?? 0;
    if (total > 0) {
      dropped += total;
      reasons.add(group.by?.reason ?? "unknown");
    }
  }
  return { dropped, reasons: [...reasons] };
}

async function logs(query, fields, extra = {}) {
  const result = await get(`/organizations/${ORG}/events/`, {
    dataset: "ourlogs",
    field: fields,
    query,
    per_page: 100,
    ...window,
    ...extra,
  });
  return result.data ?? [];
}

async function latestStableRelease() {
  try {
    return execFileSync("gh", ["release", "view", "--repo", REPO, "--json", "tagName", "--jq", ".tagName"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().replace(/^v/, "");
  } catch {
    return "";
  }
}

async function main() {
  const ids = await projectIds();
  const failures = [];
  const notes = [];

  const { dropped, reasons } = await droppedErrors();
  if (dropped > 0) {
    failures.push(`Sentry dropped ${dropped} errors since ${tag} was published (${reasons.join(", ")}), so its error count can't be trusted`);
  }

  const ran = await logs(`release:${release}`, ["project", "os.name", "count()"]);
  const launches = await logs(`release:${release} message:[app.started,brain.started]`, ["message", "os.name", "count()"]);
  const logLines = ran.reduce((sum, row) => sum + Number(row["count()"] ?? 0), 0);
  const launchCount = launches.reduce((sum, row) => sum + Number(row["count()"] ?? 0), 0);
  const systems = [...new Set([...ran, ...launches].map((row) => row["os.name"]).filter(Boolean))];
  if (logLines === 0) failures.push(`no machine has run ${tag} yet (no Sentry logs from it)`);
  else notes.push(`ran: ${launchCount} launch${launchCount === 1 ? "" : "es"} logged, ${logLines} log lines, on ${systems.join(", ") || "unknown systems"}`);

  const newIssues = [];
  for (const slug of PROJECTS) {
    const issues = await get(`/organizations/${ORG}/issues/`, {
      project: ids[slug],
      query: `firstRelease:${release} is:unresolved`,
      ...window,
      limit: 25,
    });
    for (const issue of issues) newIssues.push(`${issue.shortId} ${issue.title} (${issue.count} events)`);
  }
  if (newIssues.length > 0) failures.push(`${newIssues.length} new Sentry issue(s) first seen in ${tag}:\n    ${newIssues.join("\n    ")}`);

  const errorLines = (await logs(`release:${release} severity:[error,fatal]`, ["message", "count()"]))
    .filter((row) => !NOISE_EVENTS.has(row.message));
  const stable = await latestStableRelease();
  const stableErrorEvents = new Set();
  if (stable && errorLines.length > 0) {
    const fortnight = { start: new Date(Date.now() - 14 * 24 * 3_600_000).toISOString(), end: window.end };
    for (const row of await logs(`release:ade@${stable} severity:[error,fatal]`, ["message", "count()"], fortnight)) {
      stableErrorEvents.add(row.message);
    }
  }
  const newErrorLines = errorLines.filter((row) => !stableErrorEvents.has(row.message));
  const knownErrorLines = errorLines.filter((row) => stableErrorEvents.has(row.message));
  if (newErrorLines.length > 0) {
    failures.push(`error log lines that ${stable ? `v${stable}` : "stable"} does not have:\n    ${newErrorLines.map((row) => `${row.message} ×${row["count()"]}`).join("\n    ")}`);
  }
  if (knownErrorLines.length > 0) {
    notes.push(`errors stable also has (not counted): ${knownErrorLines.map((row) => `${row.message} ×${row["count()"]}`).join(", ")}`);
  }

  const result = failures.length === 0 ? "pass" : "fail";
  if (asJson) {
    console.log(JSON.stringify({ tag, result, since, failures, notes }, null, 2));
  } else {
    console.log(`${tag}: ${result.toUpperCase()} (published ${since})`);
    for (const note of notes) console.log(`  ${note}`);
    for (const failure of failures) console.log(`  FAIL: ${failure}`);
  }
  process.exit(result === "pass" ? 0 : 1);
}

await main();
