#!/usr/bin/env node
/**
 * Decides which runner `test-ios` uses.
 *
 * This is a security boundary, not a convenience: a self-hosted runner executes
 * whatever workflow the commit it checks out contains, so a fork pull request
 * must never be routed to one. Keeping the rule in a named function instead of
 * an inline `run:` makes that check something a test can hold on to, and makes
 * the workflow step one line.
 *
 * Inputs come from the environment (see the `Pick a runner` step):
 *   RUN_IOS    ios-gate's decision — "true" to build and test
 *   READY_AT   Unix time the Mac last proved it had spare capacity; unset or 0
 *              means "not ready"
 *   EVENT      github.event_name
 *   HEAD_REPO  github.event.pull_request.head.repo.full_name (empty off a PR)
 *   BASE_REPO  github.repository
 *   NOW        optional Unix time for tests; defaults to the real clock
 *
 * Output: writes `runner=<json>` to $GITHUB_OUTPUT and prints why.
 */

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * A readiness stamp older than this is not trusted. The agent ticks every five
 * minutes and republishes every four, so a healthy Mac always holds a stamp
 * inside this window and a sleeping one leaves it within ten.
 */
export const READINESS_WINDOW_SECONDS = 10 * 60;

/**
 * @returns {{ runner: string | string[], reason: string }}
 *   `runner` is a JSON-ready value for `runs-on` (via fromJSON in the workflow).
 */
export function pickRunner({
  runIos,
  readyAt,
  event,
  headRepo,
  baseRepo,
  now = Math.floor(Date.now() / 1000),
}) {
  // The gate already decided there is nothing to build. Keep the cheap Ubuntu
  // runner so the skip still reports success where ci-pass looks.
  if (runIos !== "true") {
    return { runner: "ubuntu-latest", reason: "no apps/ios or shared-fixture changes" };
  }

  // A push and a human pressing "Run workflow" both require write access; a
  // fork PR does not, so it is never trusted here.
  const trusted =
    event === "push" ||
    event === "workflow_dispatch" ||
    (event === "pull_request" && Boolean(headRepo) && headRepo === baseRepo);

  const stampedAt = Number(readyAt);
  const age = now - stampedAt;
  const fresh =
    Number.isFinite(stampedAt) && stampedAt > 0 && age >= 0 && age <= READINESS_WINDOW_SECONDS;

  if (trusted && fresh) {
    return {
      runner: ["self-hosted", "mac-studio", "ios"],
      reason: `mac-studio stamped ready ${age}s ago`,
    };
  }

  return {
    runner: "xcode-27",
    reason: `hosted xcode-27 (trusted=${trusted}, fresh=${fresh})`,
  };
}

function main() {
  const { runner, reason } = pickRunner({
    runIos: process.env.RUN_IOS,
    readyAt: process.env.READY_AT,
    event: process.env.EVENT,
    headRepo: process.env.HEAD_REPO,
    baseRepo: process.env.BASE_REPO,
    now: process.env.NOW ? Number(process.env.NOW) : undefined,
  });

  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is not set");
  appendFileSync(output, `runner=${JSON.stringify(runner)}\n`);

  console.log(`Runner: ${JSON.stringify(runner)} — ${reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
