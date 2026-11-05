#!/usr/bin/env node
// Checks that analytics still arrive in PostHog.
//
// 1. The marketing site's first-party proxy (`/_t/` on ade-app.dev, rewritten
//    by apps/web/vercel.json) answers as PostHog, not as the site. A rewrite
//    that missed paths ending in `/` sent every site event to `index.html`
//    from 2026-11-03 22:20 UTC to about 07:00 UTC on 2026-11-05, and nothing
//    noticed.
// 2. With a PostHog key, the site and the desktop app each sent events in the
//    last 24 hours. The limits sit far under a normal day (October-November
//    2026: at least 469 site events and 11 desktop app opens a day) and far
//    over a broken one (the outage day had 17 site events).
//
// Prints a Markdown report. Never prints a secret.
//
// Exit codes: 0 every check passed; 1 a check failed; 2 a request or
// configuration failed.
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_SITE = "https://ade-app.dev";
const DEFAULT_PROJECT_ID = "510983";
const DEFAULT_QUERY_HOST = "https://us.posthog.com";
const REQUEST_TIMEOUT_MS = 30_000;

/** Events in the last 24 hours below which a source counts as broken. */
export const VOLUME_CHECKS = Object.freeze([
  {
    label: "Marketing site events",
    where: "event LIKE 'ade_marketing_%' AND event != 'ade_marketing_analytics_budget'",
    minimum: 100,
  },
  { label: "Desktop app opens", where: "event = 'ade_app_opened'", minimum: 3 },
]);

/**
 * PostHog answers an empty capture or flags body with its own 4xx and a
 * non-HTML body. The site answers a missed rewrite with `index.html` (405 to
 * a POST), so HTML, a 405, or a 2xx with HTML means the proxy is broken.
 */
export function proxyAnswerIsPostHog({ status, contentType }) {
  if (status === 405 || status >= 500) return false;
  return !/text\/html/i.test(contentType ?? "");
}

async function probe(url, init) {
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await response.arrayBuffer();
    return { status: response.status, contentType: response.headers.get("content-type") ?? "" };
  } catch (error) {
    return { status: 0, contentType: "", error: error instanceof Error ? error.name : "request failed" };
  }
}

export async function checkProxy(site) {
  const post = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
  const checks = [
    { label: "Capture (`/_t/i/v0/e/`)", path: "/_t/i/v0/e/", init: post, ok: proxyAnswerIsPostHog },
    { label: "Flags (`/_t/flags/`)", path: "/_t/flags/?v=2", init: post, ok: proxyAnswerIsPostHog },
    { label: "Replay (`/_t/s/`)", path: "/_t/s/", init: post, ok: proxyAnswerIsPostHog },
    {
      label: "Script (`/_t/static/array.js`)",
      path: "/_t/static/array.js",
      init: { method: "GET" },
      ok: ({ status, contentType }) => status === 200 && /javascript/i.test(contentType),
    },
  ];
  const results = [];
  for (const check of checks) {
    const answer = await probe(`${site}${check.path}`, check.init);
    results.push({
      label: check.label,
      passed: answer.status !== 0 && check.ok(answer),
      detail: answer.status === 0 ? answer.error : `${answer.status} ${answer.contentType.split(";")[0] || "no content type"}`,
    });
  }
  return results;
}

async function checkVolume(env) {
  const select = VOLUME_CHECKS.map((check, index) => `countIf(${check.where}) AS c${index}`).join(", ");
  const query = `SELECT ${select} FROM events WHERE timestamp > now() - INTERVAL 24 HOUR`;
  const response = await fetch(`${env.queryHost}/api/projects/${env.projectId}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.personalKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query }, name: "ade-analytics-health" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4),
  });
  // The body may echo request details; report only the status.
  if (!response.ok) throw new Error(`PostHog query: HTTP ${response.status}`);
  const row = (await response.json())?.results?.[0];
  if (!Array.isArray(row)) throw new Error("PostHog query: unexpected response");
  return VOLUME_CHECKS.map((check, index) => {
    const count = Number(row[index]);
    return { label: check.label, passed: count >= check.minimum, detail: `${count} (at least ${check.minimum})` };
  });
}

export function formatReport({ proxy, volume }) {
  const row = (result) => `| ${result.label} | ${result.passed ? "ok" : "**failed**"} | ${result.detail} |`;
  const lines = ["## Analytics health", "", "| Check | Result | Detail |", "|---|---|---|", ...proxy.map(row)];
  if (volume) lines.push(...volume.map(row));
  else lines.push("| Events in the last 24 hours | skipped | no PostHog key |");
  lines.push("");
  return lines.join("\n");
}

export async function main() {
  const site = (process.env.ADE_SITE_ORIGIN?.trim() || DEFAULT_SITE).replace(/\/+$/, "");
  if (!/^https:\/\//.test(site)) throw new Error("ADE_SITE_ORIGIN must be https");
  const env = {
    personalKey: process.env.POSTHOG_PERSONAL_API_KEY?.trim() || null,
    projectId: process.env.POSTHOG_PROJECT_ID?.trim() || DEFAULT_PROJECT_ID,
    queryHost: (process.env.POSTHOG_HOST?.trim() || DEFAULT_QUERY_HOST).replace(/\/+$/, ""),
  };
  if (!/^\d+$/.test(env.projectId)) throw new Error("POSTHOG_PROJECT_ID must be numeric");

  const proxy = await checkProxy(site);
  const volume = env.personalKey ? await checkVolume(env) : null;
  process.stdout.write(formatReport({ proxy, volume }));
  const failed = [...proxy, ...(volume ?? [])].filter((result) => !result.passed);
  if (failed.length > 0) {
    process.stderr.write(`Failed: ${failed.map((result) => result.label).join(", ")}.\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`Failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
