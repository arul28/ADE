#!/usr/bin/env node
// Rebuilds a package's test durations file, which scripts/ci/test-shards.mjs
// reads to split the CI test jobs into shards of about equal duration.
//
//   node scripts/ci/update-test-durations.mjs <package dir> <report>...
//
// Each report is one of:
// - the output of Vitest's JSON reporter (a .json file), for example from
//   `npx vitest run --reporter=json --outputFile.json=shard-1.json`;
// - the log of a CI test job (any other file), which has one
//   "✓ |project| path (N tests) 123ms" line per test file.
//
// Pass the reports of every shard of one run, so every file has a duration.
// To refresh from the CI run of a recent push to main:
//
//   for id in $(gh api "repos/arul28/ADE/actions/runs/<run id>/jobs?per_page=100" \
//       --jq '.jobs[] | select(.name | startswith("test-desktop")) | .id'); do
//     gh api --allow-escape-sequences "repos/arul28/ADE/actions/jobs/$id/logs" > "test-desktop-$id.log"
//   done
//   node scripts/ci/update-test-durations.mjs apps/desktop test-desktop-*.log
//
// (Use "test-ade-cli" and apps/ade-cli for the CLI.) The script replaces the
// file: a test file that no report lists drops out of it, and a file that is
// not in it weighs the median until the next refresh. A stale file only makes
// the shards less even; it never changes which test files run.

import fs from "node:fs";
import path from "node:path";

const DURATIONS_FILE_NAME = "vitest.durations.json";

// "✓ |unit-main| src/a.test.ts  (3 tests | 1 skipped) 123ms", after the
// runner's timestamp and with colors removed. Failed (❯ ×) and skipped (↓)
// files count too.
const LOG_LINE = /\s[✓❯×↓]\s+(?:\|[^|]+\|\s+)?(\S+\.test\.[cm]?[jt]sx?)\s+\([^)]*\)(?:\s+(\d+)ms)?/;

/**
 * The path of `file` from the package directory, with forward slashes. A
 * report from another checkout (a CI runner) has another prefix, so the
 * package's path from the repository root (`apps/desktop`) marks where the
 * package path starts.
 */
function fromPackage(file, packageDir) {
  const toPosix = (p) => p.split(path.sep).join("/");
  const posix = toPosix(file);
  const local = `${toPosix(path.resolve(packageDir))}/`;
  if (posix.startsWith(local)) return posix.slice(local.length);
  const marker = `/${toPosix(path.relative(process.cwd(), path.resolve(packageDir)))}/`;
  const at = posix.lastIndexOf(marker);
  return at >= 0 ? posix.slice(at + marker.length) : posix;
}

/** Reads one report into `durations` (path from the package -> ms). */
function readReport(text, packageDir, durations) {
  const add = (file, ms) => {
    if (!Number.isFinite(ms) || ms < 0) return;
    durations.set(file, Math.max(durations.get(file) ?? 0, Math.round(ms)));
  };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (json && Array.isArray(json.testResults)) {
    for (const result of json.testResults) {
      add(fromPackage(result.name, packageDir), (result.endTime ?? 0) - (result.startTime ?? 0));
    }
    return;
  }
  for (const line of text.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
    const match = LOG_LINE.exec(line);
    if (match) add(match[1], match[2] ? Number(match[2]) : 0);
  }
}

function main(argv) {
  const [packageDir, ...reports] = argv;
  if (!packageDir || reports.length === 0) {
    process.stderr.write("usage: node scripts/ci/update-test-durations.mjs <package dir> <report>...\n");
    return 2;
  }
  const durations = new Map();
  for (const report of reports) readReport(fs.readFileSync(report, "utf8"), packageDir, durations);
  if (durations.size === 0) {
    process.stderr.write("no test file durations found in the reports; the durations file is unchanged\n");
    return 1;
  }
  const files = Object.fromEntries([...durations].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const out = path.join(packageDir, DURATIONS_FILE_NAME);
  fs.writeFileSync(out, `${JSON.stringify({ files }, null, 2)}\n`);
  process.stdout.write(`wrote ${durations.size} test file durations to ${out}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
