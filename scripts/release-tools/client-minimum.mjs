#!/usr/bin/env node
// The owner's switch for ADE's update gate: the oldest build each kind of
// install may run (`GET /client/minimum`, apps/account-directory/src/clientMinimum.ts).
// No release moves it; only this script does.
//
// Run it with the Cloudflare and Sentry secrets:
//
//   ade secrets exec --env CLOUDFLARE_API_TOKEN --env CLOUDFLARE_ACCOUNT_ID --env SENTRY_AUTH_TOKEN -- \
//     node scripts/release-tools/client-minimum.mjs <command> [flags]
//
// Commands
//   show                      What is set now, and the newest published build of each kind.
//   set [flags]               Set one or more minimums. Unnamed ones keep their value.
//     --desktop-stable 1.2.131        Stable desktop app, brain and CLI.
//     --desktop-beta 1.2.131-beta.2   Beta desktop app, brain and CLI.
//     --ios-app-store 1.1.11          ADE iPhone app from the App Store (marketing version).
//     --ios-testflight 10070          ADE iPhone app from TestFlight (build number).
//     --ios-beta-app 10071            ADE Beta iPhone app (build number).
//     --clear-<name>                  Remove that one minimum (e.g. --clear-ios-app-store).
//     --dry-run                       Check and print; change nothing.
//     --force                         Skip the "is it published yet" checks. Never needed normally.
//     --no-sentry                     Do not touch the Sentry release filters.
//   clear                     Remove every minimum (nobody is blocked). Sentry filters stay.
//
// What `set` checks first (so nobody is ever blocked behind an update that
// does not exist): each desktop minimum is at or below the newest published
// release on its track; the App Store minimum is at or below the version the
// App Store serves; each TestFlight build exists and finished processing.
// The apps check the same thing again before they block.
//
// What `set` also does: it rewrites the Sentry release filters of ade-desktop,
// ade-brain and ade-ios so events from builds below the minimum are dropped
// at Sentry's edge. Lines in those filters that are not ADE release patterns
// are kept.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIRECTORY_URL = "https://ade-account-directory-production.arulsharma1028.workers.dev";
const D1_NAME = "ade-account-directory-production";
const BETA_FEED_MANIFEST_URL = "https://github.com/arul28/ADE/releases/download/beta-feed/beta.json";
const APP_IDS = { ios: "6762759870", betaApp: "6829373114" };
const SENTRY_API = "https://us.sentry.io/api/0";
const SENTRY_ORG = "ade-app";

// ---------------------------------------------------------------- versions

// Same ordering as apps/desktop/src/shared/updateVersions.ts compareUpdateVersions.
function parseVersion(version) {
  const withoutBuild = String(version).trim().replace(/^v/i, "").split("+")[0] ?? "";
  const [coreText = "", prereleaseText = ""] = withoutBuild.split("-", 2);
  return {
    core: coreText.split(".").map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }),
    prerelease: prereleaseText ? prereleaseText.split(".") : [],
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < Math.max(a.core.length, b.core.length, 3); i += 1) {
    const delta = (a.core[i] ?? 0) - (b.core[i] ?? 0);
    if (delta !== 0) return delta;
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    const l = a.prerelease[i];
    const r = b.prerelease[i];
    if (l == null) return -1;
    if (r == null) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    const delta = ln && rn ? Number(l) - Number(r) : ln !== rn ? (ln ? -1 : 1) : l.localeCompare(r);
    if (delta !== 0) return delta;
  }
  return 0;
}

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const BETA_VERSION = /^\d+\.\d+\.\d+-beta\.\d+$/;

// ---------------------------------------------------------------- sentry globs

/**
 * Patterns that together match every non-negative integer below `limit` and
 * nothing at or above it, for release names where a number is followed by
 * `-…`, `+…` or nothing. Numbers with as many digits as `limit` are covered
 * by prefixes ("12*" stands for 120..129); a prefix of a shorter number would
 * also match longer ones at or above the limit, so shorter numbers are listed
 * exactly (`exact`). `minDigits` drops shorter numbers entirely.
 */
export function numbersBelow(limit, { minDigits = 1 } = {}) {
  const digits = String(limit).length;
  const exact = [];
  for (let n = minDigits <= 1 ? 0 : 10 ** (minDigits - 1); n < Math.min(limit, 10 ** (digits - 1)); n += 1) exact.push(String(n));
  const prefixes = [];
  const low = digits === 1 ? 0 : 10 ** (digits - 1);
  let n = low;
  while (n < limit) {
    // The shortest prefix of n whose whole block sits inside [low, limit).
    let chosen = null;
    for (let k = 1; k <= digits; k += 1) {
      const span = 10 ** (digits - k);
      const blockStart = Math.floor(n / span) * span;
      const blockEnd = blockStart + span - 1;
      if (blockStart === n && blockStart >= low && blockEnd < limit) {
        chosen = { prefix: String(n).slice(0, k), next: blockEnd + 1 };
        break;
      }
    }
    if (!chosen) chosen = { prefix: String(n), next: n + 1 };
    prefixes.push(chosen.prefix);
    n = chosen.next;
  }
  return { exact, prefixes };
}

/** Sentry release globs for desktop builds below the stable and beta minimums. */
export function desktopReleaseGlobs(stableMin, betaMin) {
  const globs = new Set(["ade@0.*"]);
  const floors = [stableMin, betaMin].filter(Boolean);
  if (floors.length === 0) return [];
  // The lower floor decides which older versions go entirely: a beta user
  // on 1.2.131-beta.2 is fine even when stable's floor is 1.2.131.
  const lowest = floors.reduce((low, value) => (compareVersions(value, low) < 0 ? value : low));
  const [major, minor, patch] = parseVersion(lowest).core;
  for (let m = 0; m < minor; m += 1) {
    if (major === 1 && m === 0) continue; // 1.0.* holds every Alpha build; Alpha has no minimum.
    globs.add(`ade@${major}.${m}.*`);
  }
  const add = (base, { exact, prefixes }) => {
    for (const value of exact) {
      globs.add(`${base}${value}`);
      globs.add(`${base}${value}-*`);
    }
    for (const value of prefixes) globs.add(`${base}${value}*`);
  };
  add(`ade@${major}.${minor}.`, numbersBelow(patch));
  if (betaMin) {
    const beta = parseVersion(betaMin);
    const number = Number(beta.prerelease[1] ?? 0);
    // Beta numbers outgrow their digits (beta.10 follows beta.9), so no
    // prefixes here: each earlier beta is listed exactly.
    const earlier = Array.from({ length: number }, (_, n) => String(n));
    add(`ade@${beta.core.join(".")}-beta.`, { exact: earlier, prefixes: [] });
  }
  return [...globs];
}

/** Sentry release globs for iPhone builds below a build number (`<bundle>@<version>+<build>`). */
export function iosReleaseGlobs(bundleId, minBuild) {
  if (!minBuild) return [];
  // Only builds as long as the minimum: older, shorter build numbers are long gone.
  return numbersBelow(minBuild, { minDigits: String(minBuild).length }).prefixes.map((value) => `${bundleId}@*+${value}*`);
}

// ---------------------------------------------------------------- io

function need(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set. Run this under: ade secrets exec --env CLOUDFLARE_API_TOKEN --env CLOUDFLARE_ACCOUNT_ID --env SENTRY_AUTH_TOKEN -- node scripts/release-tools/client-minimum.mjs ...`);
    process.exit(2);
  }
  return value;
}

async function getJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return await response.json();
}

async function readCurrent() {
  return await getJson(`${DIRECTORY_URL}/client/minimum`, { headers: { "cache-control": "no-cache" } });
}

async function newestPublished() {
  const out = { stable: null, beta: null, appStore: null, testFlightBuilds: null, betaAppBuilds: null };
  try {
    const raw = execFileSync("gh", ["api", "repos/arul28/ADE/releases/latest", "--jq", ".tag_name"], { encoding: "utf8" }).trim();
    out.stable = raw.replace(/^v/, "") || null;
  } catch { /* unknown */ }
  try {
    const beta = await getJson(BETA_FEED_MANIFEST_URL);
    out.beta = typeof beta?.version === "string" ? beta.version.replace(/^v/, "") : null;
  } catch { /* unknown */ }
  try {
    const lookup = await getJson("https://itunes.apple.com/lookup?bundleId=com.ade.ios&country=us");
    out.appStore = lookup?.results?.[0]?.version ?? null;
  } catch { /* unknown */ }
  const builds = (appId) => {
    try {
      const raw = execFileSync("asc", ["builds", "list", "--app", appId, "--limit", "50"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const data = JSON.parse(raw).data ?? [];
      return data
        .filter((build) => build.attributes?.processingState === "VALID" && !build.attributes?.expired)
        .map((build) => Number(build.attributes?.version))
        .filter(Number.isFinite);
    } catch {
      return null;
    }
  };
  out.testFlightBuilds = builds(APP_IDS.ios);
  out.betaAppBuilds = builds(APP_IDS.betaApp);
  return out;
}

function writeMinimum(body) {
  need("CLOUDFLARE_API_TOKEN");
  need("CLOUDFLARE_ACCOUNT_ID");
  const json = JSON.stringify(body);
  if (json.includes("'")) throw new Error("refusing a body with a quote");
  const sql = `insert into client_minimums (id, body, updated_at) values (1, '${json}', '${new Date().toISOString()}') `
    + "on conflict(id) do update set body = excluded.body, updated_at = excluded.updated_at;";
  execFileSync("npx", ["wrangler", "d1", "execute", D1_NAME, "--env", "production", "--remote", "--command", sql], {
    cwd: path.join(repoRoot, "apps/account-directory"),
    stdio: ["ignore", "inherit", "inherit"],
  });
}

const OUR_GLOB = /^(ade|com\.ade\.ios|com\.ade\.ios\.beta)@/;

async function setSentryReleaseFilter(project, globs, dryRun) {
  const token = need("SENTRY_AUTH_TOKEN");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const current = await getJson(`${SENTRY_API}/projects/${SENTRY_ORG}/${project}/`, { headers });
  const kept = String(current?.options?.["filters:releases"] ?? "")
    .split("\n").map((line) => line.trim()).filter((line) => line && !OUR_GLOB.test(line));
  const next = [...kept, ...globs].join("\n");
  console.log(`  sentry ${project}: ${globs.length} release patterns${kept.length ? ` (+${kept.length} kept)` : ""}`);
  if (dryRun) return;
  const response = await fetch(`${SENTRY_API}/projects/${SENTRY_ORG}/${project}/`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ options: { "filters:releases": next } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`sentry ${project}: HTTP ${response.status} ${await response.text()}`);
  const after = await getJson(`${SENTRY_API}/projects/${SENTRY_ORG}/${project}/`, { headers });
  if (String(after?.options?.["filters:releases"] ?? "") !== next) throw new Error(`sentry ${project}: the filter did not save`);
}

// ---------------------------------------------------------------- commands

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (["dry-run", "force", "no-sentry"].includes(name) || name.startsWith("clear-")) flags[name] = true;
    else {
      const value = argv[i + 1];
      if (value == null || value.startsWith("--")) throw new Error(`--${name} needs a value`);
      flags[name] = value;
      i += 1;
    }
  }
  return flags;
}

function bodyOf(current) {
  return {
    desktop: { stable: current?.desktop?.stable ?? null, beta: current?.desktop?.beta ?? null },
    ios: {
      appStore: current?.ios?.appStore ?? null,
      testFlight: current?.ios?.testFlight ?? null,
      betaApp: current?.ios?.betaApp ?? null,
    },
  };
}

function printState(label, body, published) {
  console.log(label);
  console.log(`  desktop stable : ${body.desktop.stable ?? "none"}${published ? `   (newest published ${published.stable ?? "?"})` : ""}`);
  console.log(`  desktop beta   : ${body.desktop.beta ?? "none"}${published ? `   (newest published ${published.beta ?? "?"})` : ""}`);
  console.log(`  iOS App Store  : ${body.ios.appStore?.version ?? "none"}${published ? `   (App Store serves ${published.appStore ?? "nothing yet"})` : ""}`);
  console.log(`  iOS TestFlight : ${body.ios.testFlight?.build ?? "none"}${published ? `   (newest valid build ${published.testFlightBuilds?.length ? Math.max(...published.testFlightBuilds) : "?"})` : ""}`);
  console.log(`  iOS Beta app   : ${body.ios.betaApp?.build ?? "none"}${published ? `   (newest valid build ${published.betaAppBuilds?.length ? Math.max(...published.betaAppBuilds) : "?"})` : ""}`);
}

async function main() {
  const [command = "show", ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const current = await readCurrent();
  const body = bodyOf(current);

  if (command === "show") {
    printState(`Set now (updated ${current.updatedAt ?? "never"}):`, body, await newestPublished());
    return;
  }

  if (command === "clear") {
    const empty = { desktop: { stable: null, beta: null }, ios: { appStore: null, testFlight: null, betaApp: null } };
    printState("Clearing every minimum. Nobody is blocked after this:", empty, null);
    if (!flags["dry-run"]) writeMinimum(empty);
    return;
  }

  if (command !== "set") throw new Error(`Unknown command: ${command} (show, set, clear)`);

  const next = structuredClone(body);
  if (flags["desktop-stable"]) {
    if (!STABLE_VERSION.test(flags["desktop-stable"])) throw new Error("--desktop-stable looks like 1.2.131");
    next.desktop.stable = flags["desktop-stable"];
  }
  if (flags["desktop-beta"]) {
    if (!BETA_VERSION.test(flags["desktop-beta"])) throw new Error("--desktop-beta looks like 1.2.131-beta.2");
    next.desktop.beta = flags["desktop-beta"];
  }
  if (flags["ios-app-store"]) {
    if (!STABLE_VERSION.test(flags["ios-app-store"])) throw new Error("--ios-app-store looks like 1.1.11");
    next.ios.appStore = { version: flags["ios-app-store"] };
  }
  for (const [flag, key] of [["ios-testflight", "testFlight"], ["ios-beta-app", "betaApp"]]) {
    if (flags[flag]) {
      const build = Number(flags[flag]);
      if (!Number.isInteger(build) || build <= 0) throw new Error(`--${flag} is a build number such as 10070`);
      next.ios[key] = { build };
    }
  }
  if (flags["clear-desktop-stable"]) next.desktop.stable = null;
  if (flags["clear-desktop-beta"]) next.desktop.beta = null;
  if (flags["clear-ios-app-store"]) next.ios.appStore = null;
  if (flags["clear-ios-testflight"]) next.ios.testFlight = null;
  if (flags["clear-ios-beta-app"]) next.ios.betaApp = null;

  const published = await newestPublished();
  const problems = [];
  if (next.desktop.stable && (!published.stable || compareVersions(published.stable, next.desktop.stable) < 0)) {
    problems.push(`desktop stable ${next.desktop.stable} is not published yet (newest stable: ${published.stable ?? "unknown"})`);
  }
  if (next.desktop.beta && (!published.beta || compareVersions(published.beta, next.desktop.beta) < 0)) {
    problems.push(`desktop beta ${next.desktop.beta} is not published yet (newest beta: ${published.beta ?? "unknown"})`);
  }
  if (next.ios.appStore && (!published.appStore || compareVersions(published.appStore, next.ios.appStore.version) < 0)) {
    problems.push(`iOS ${next.ios.appStore.version} is not on the App Store yet (it serves ${published.appStore ?? "nothing"})`);
  }
  if (next.ios.testFlight && !(published.testFlightBuilds ?? []).some((build) => build >= next.ios.testFlight.build)) {
    problems.push(`no valid TestFlight build ${next.ios.testFlight.build} or newer for the ADE app`);
  }
  if (next.ios.betaApp && !(published.betaAppBuilds ?? []).some((build) => build >= next.ios.betaApp.build)) {
    problems.push(`no valid TestFlight build ${next.ios.betaApp.build} or newer for the ADE Beta app`);
  }
  if (problems.length && !flags.force) {
    console.error("Not set. People would be blocked behind an update they cannot get:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("Publish the build first, then run this again. (--force skips this check.)");
    process.exit(1);
  }

  printState(flags["dry-run"] ? "Would set:" : "Setting:", next, published);
  if (!flags["dry-run"]) writeMinimum(next);

  if (!flags["no-sentry"]) {
    const desktopGlobs = desktopReleaseGlobs(next.desktop.stable, next.desktop.beta);
    const iosGlobs = [
      ...iosReleaseGlobs("com.ade.ios", next.ios.testFlight?.build ?? null),
      ...iosReleaseGlobs("com.ade.ios.beta", next.ios.betaApp?.build ?? null),
    ];
    await setSentryReleaseFilter("ade-desktop", desktopGlobs, flags["dry-run"]);
    await setSentryReleaseFilter("ade-brain", desktopGlobs, flags["dry-run"]);
    await setSentryReleaseFilter("ade-ios", iosGlobs, flags["dry-run"]);
  }
  if (!flags["dry-run"]) {
    console.log("Done. Apps read it within a minute (server cache) and block on their next check (launch, focus, or within 3 hours).");
    console.log("Undo at once with: ... client-minimum.mjs clear");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
