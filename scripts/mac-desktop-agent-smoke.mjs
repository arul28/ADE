#!/usr/bin/env node
/**
 * The agent's own loop against a real display, end to end.
 *
 * Every Mac Desktop test in the repo runs against a fake seat provider, so
 * they prove the wiring and nothing about the thing an agent actually does:
 * create a display, put an app on it, read the screen, act on what it read,
 * and put the app back. That gap is why "can an agent reliably use this?" had
 * no answer but a shrug.
 *
 * This runs the real `ade mac-desktop` commands against a real brain and
 * checks the ANSWER of each one, not just its exit code. It needs a macOS host
 * with Screen Recording and Accessibility granted, so it is a local and proof
 * check rather than a CI one — CI has no display to drive.
 *
 * Every acting step asserts `mode: accessibility`. That is the property the
 * whole design rests on: an agent drives the lane's windows through the
 * Accessibility API and never through the one system cursor, so it cannot
 * fight the person using the Mac, and two lanes cannot fight each other.
 *
 *   node scripts/mac-desktop-agent-smoke.mjs --lane <laneId> [--socket <path>]
 *                                            [--app TextEdit] [--keep]
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "apps", "ade-cli", "dist", "cli.cjs");

function parseArgs(argv) {
  const options = { laneId: process.env.ADE_LANE_ID ?? "", socketPath: "", app: "TextEdit", keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      index += 1;
      return value;
    };
    if (arg === "--lane") options.laneId = next();
    else if (arg === "--socket") options.socketPath = next();
    else if (arg === "--app") options.app = next();
    else if (arg === "--keep") options.keep = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  return options;
}

/** One `ade` call, parsed. A non-zero exit is the step's failure, not a throw. */
function ade(options, args) {
  const full = [CLI];
  if (options.socketPath) full.push("--socket", options.socketPath);
  full.push("mac-desktop", ...args, "--lane", options.laneId, "--json");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, full, { cwd: repoRoot });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk) => { err += chunk.toString(); });
    child.on("close", (code) => {
      let json = null;
      try { json = JSON.parse(out); } catch { json = null; }
      resolve({ code, json, out, err });
    });
  });
}

const steps = [];
function record(name, ok, detail) {
  steps.push({ name, ok, detail });
  process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}\n`);
  return ok;
}

/**
 * The property the design rests on. An acting command that answers anything
 * but `accessibility` moved the one system cursor, which is the failure this
 * whole path exists to avoid.
 */
function assertAccessibility(name, reply) {
  const mode = reply.json?.mode ?? reply.json?.action?.mode ?? null;
  if (mode === "accessibility") return record(name, true, "mode=accessibility");
  return record(name, false, `mode=${mode ?? "unknown"} (expected accessibility)`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.laneId) {
    process.stdout.write(
      "Usage: node scripts/mac-desktop-agent-smoke.mjs --lane <laneId> [--socket <path>] [--app TextEdit] [--keep]\n",
    );
    process.exit(options.help ? 0 : 2);
  }

  process.stdout.write(`\nMac Desktop agent smoke — lane ${options.laneId}\n\n`);

  const status = await ade(options, ["status"]);
  if (!record("status answers", status.code === 0 && !!status.json, status.err.trim().slice(0, 120))) {
    return finish();
  }
  const supported = status.json.supported === true;
  if (!record("host supports Mac Desktop", supported, supported ? "darwin" : "not a Mac host")) return finish();
  const permissions = status.json.permissions ?? {};
  record(
    "permissions granted",
    permissions.screenRecording === "granted" && permissions.accessibility === "granted",
    `screenRecording=${permissions.screenRecording} accessibility=${permissions.accessibility}`,
  );

  const hadDisplay = !!status.json.display;
  if (!hadDisplay) {
    const started = await ade(options, ["start"]);
    if (!record("start creates the display", started.code === 0 && !!started.json?.display)) return finish();
  } else {
    record("display already up", true, `id ${status.json.display.displayId}`);
  }

  /*
   * A DOCUMENT of our own, not just an app.
   *
   * Opening a bare app is not a reliable way to get a window: TextEdit with no
   * document opens no standard window at all, so the check hung waiting for
   * one. A file forces a document window, and it also keeps the check off any
   * window the person is using.
   */
  const scratch = path.join(os.tmpdir(), "ade-mac-desktop-smoke.txt");
  fs.writeFileSync(scratch, `ADE Mac Desktop smoke ${new Date().toISOString()}\n`);
  const opened = await ade(options, ["open", scratch]);
  if (!record(`open a document`, opened.code === 0, opened.err.trim().slice(0, 120))) return finish();

  /*
   * `open` returns as soon as the app is launched, and a launching app has no
   * window yet: the reply carries the pid and `watching: true`, with
   * `windows: []`. An agent that calls `observe` on the next line sees an
   * empty screen and concludes the app failed. Polling `windows` for the pid
   * is the pattern, and it is asserted here so it stays true.
   */
  const launchedPid = opened.json?.pid ?? null;
  const openedAppName = opened.json?.appName ?? options.app;
  let openedWindowId = opened.json?.windows?.[0]?.id ?? null;
  const deadline = Date.now() + 15_000;
  while (openedWindowId == null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const listed = await ade(options, ["windows"]);
    // By app name, not by the pid `open` returned. macOS hands a document to
    // an ALREADY-RUNNING instance, so a second `open` answers with a fresh pid
    // that owns no window and never will — an agent that waits on that pid
    // waits forever.
    const match = (listed.json?.windows ?? []).find(
      (entry) => entry.pid === launchedPid || entry.appName === openedAppName,
    );
    openedWindowId = match?.id ?? null;
  }
  if (!record(`its window appears`, openedWindowId != null, openedWindowId == null ? "no window within 15s" : `#${openedWindowId}`)) {
    return finish();
  }

  const observed = await ade(options, ["observe", "--limit", "60"]);
  const elements = observed.json?.elements ?? [];
  if (!record("observe returns elements", observed.code === 0 && elements.length > 0, `${elements.length} elements`)) {
    return finish();
  }
  const observationId = observed.json?.id ?? null;
  record("observation is addressable", !!observationId, observationId ?? "no id");

  // Act on something the observation itself named, which is exactly how an
  // agent works: it never invents a coordinate.
  const target = elements.find((element) => element.role === "AXWindow") ?? elements[0];
  const handle = target?.handle ?? (observationId != null ? `${observationId}:e:${target?.index ?? 0}` : null);
  if (handle) {
    const clicked = await ade(options, ["click", handle]);
    record("click by handle", clicked.code === 0, clicked.err.trim().slice(0, 120));
    if (clicked.code === 0) assertAccessibility("click stays off the cursor", clicked);
  } else {
    record("click by handle", false, "no handle on the observation");
  }

  // `type` needs a named target too. The help calls it "type into the focused
  // element", but the command refuses without a handle or a text match, so an
  // agent must observe first and name what it is typing into.
  const field = elements.find((element) => element.role === "AXTextField" || element.role === "AXTextArea");
  if (field?.handle) {
    const typed = await ade(options, ["type", "ade agent smoke", "--handle", field.handle]);
    record("type into a named field", typed.code === 0, typed.err.trim().slice(0, 120));
    if (typed.code === 0) assertAccessibility("type stays off the cursor", typed);
  } else {
    record("type into a named field", true, "skipped: no text field on this screen");
  }

  if (!options.keep && openedWindowId != null) {
    const released = await ade(options, ["release", "--window", String(openedWindowId)]);
    const count = released.json?.released ?? 0;
    // A release that released nothing used to answer `{released: 0}` and look
    // exactly like success, which is how the button stayed broken.
    record("release moves the window back", released.code === 0 && count > 0, `released=${count}`);
  }

  finish();
}

function finish() {
  const failed = steps.filter((step) => !step.ok);
  process.stdout.write(`\n${steps.length - failed.length}/${steps.length} steps passed\n`);
  if (failed.length) {
    process.stdout.write(`failed: ${failed.map((step) => step.name).join(", ")}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
