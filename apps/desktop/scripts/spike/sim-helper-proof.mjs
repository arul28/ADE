#!/usr/bin/env node
/**
 * End-to-end proof for the vendored simulator helper (phase 1 spike).
 *
 * Deliberately a standalone script rather than a vitest file: it needs two real
 * booted simulators and takes tens of seconds, which is neither what
 * `apps/desktop`'s unit suite is for nor something CI can run. The pieces that
 * DO belong in a unit suite (protocol parsing, the wire format, the AVCC →
 * Annex-B bridge) are covered by the Swift tests in
 * `native/ADESimHelper/Tests`.
 *
 * What it proves:
 *   1. One helper process drives TWO booted simulators at once.
 *   2. Each device's stream is a separate loopback endpoint, token-gated, and
 *      framed exactly as `iosSimVideoRecords.ts` expects — that parser is
 *      re-implemented here so a drift shows up as a failure, not a black canvas.
 *   3. Touch, ax-describe and screenshot all work per device.
 *   4. Tap-to-visible-frame latency, measured from the frame bytes.
 *
 * Usage: node scripts/spike/sim-helper-proof.mjs [--keep-booted]
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..", "..");
const packageRoot = path.join(desktopRoot, "native", "ADESimHelper");

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sim-helper-proof-"));
const log = (...parts) => console.log("[proof]", ...parts);

// ---------------------------------------------------------------------------
// The record parser, mirrored from src/renderer/components/chat/iosSimVideoRecords.ts
// ---------------------------------------------------------------------------

const RECORD_MAGIC = 0xade1f00d;
const RECORD_HEADER_BYTES = 12;
const TYPE_CONFIG = 1;
const TYPE_ACCESS_UNIT = 2;
const FLAG_KEYFRAME = 1;

function createRecordParser() {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const records = [];
    let offset = 0;
    while (buffer.length - offset >= RECORD_HEADER_BYTES) {
      const magic = buffer.readUInt32BE(offset);
      if (magic !== RECORD_MAGIC) {
        throw new Error(`Bad record magic 0x${magic.toString(16)} — the wire format drifted.`);
      }
      const type = buffer.readUInt8(offset + 4);
      const flags = buffer.readUInt8(offset + 5);
      const length = buffer.readUInt32BE(offset + 8);
      const end = offset + RECORD_HEADER_BYTES + length;
      if (buffer.length < end) break;
      const payload = buffer.subarray(offset + RECORD_HEADER_BYTES, end);
      if (type === TYPE_CONFIG) {
        records.push({ kind: "config", config: JSON.parse(payload.toString("utf8")) });
      } else if (type === TYPE_ACCESS_UNIT) {
        records.push({
          kind: "access-unit",
          keyframe: (flags & FLAG_KEYFRAME) !== 0,
          bytes: Buffer.from(payload),
          at: performance.now(),
        });
      }
      offset = end;
    }
    buffer = offset === 0 ? buffer : buffer.subarray(offset);
    return records;
  };
}

// ---------------------------------------------------------------------------
// Helper process
// ---------------------------------------------------------------------------

class Helper {
  constructor(executablePath) {
    this.child = spawn(executablePath, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
    this.nextId = 1;
    let stdout = "";
    this.child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        this.onEvent(JSON.parse(line));
      }
    });
    // The helper points fd 1 at stderr so vendored `print`s cannot corrupt
    // NDJSON. Everything on stderr is therefore diagnostics, not protocol.
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
  }

  onEvent(event) {
    if (event.type === "ready") {
      this.resolveReady(event);
      return;
    }
    const pending = this.pending.get(event.id);
    if (!pending) return;
    this.pending.delete(event.id);
    if (event.type === "error") pending.reject(new Error(`${event.code}: ${event.message}`));
    else pending.resolve(event);
  }

  send(type, payload = {}) {
    const id = String(this.nextId++);
    const line = JSON.stringify({ type, id, ...payload });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(line + "\n");
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${type} timed out`));
      }, 20_000).unref();
    });
  }

  async quit() {
    try { await this.send("quit"); } catch { /* exiting anyway */ }
    this.child.kill();
  }
}

/** Attach to a device's stream and collect records until `stop()`. */
function attachStream(url, token) {
  const parse = createRecordParser();
  const records = [];
  let config = null;
  const state = { records, get config() { return config; }, stop: () => {} };
  const request = http.get(url, { headers: { Authorization: `Bearer ${token}` } }, (response) => {
    if (response.statusCode !== 200) {
      throw new Error(`Stream answered ${response.statusCode}`);
    }
    response.on("data", (chunk) => {
      for (const record of parse(chunk)) {
        if (record.kind === "config") config = record.config;
        else records.push(record);
      }
    });
  });
  state.stop = () => { request.destroy(); };
  return state;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 15_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------

function bootedDevices() {
  const raw = execFileSync("xcrun", ["simctl", "list", "devices", "available", "--json"], {
    encoding: "utf8",
  });
  const parsed = JSON.parse(raw);
  const all = [];
  for (const [runtime, devices] of Object.entries(parsed.devices)) {
    for (const device of devices) all.push({ ...device, runtime });
  }
  return all;
}

async function main() {
  const keepBooted = process.argv.includes("--keep-booted");
  const binPath = execFileSync("swift", [
    "build", "--package-path", packageRoot,
    "--scratch-path", process.env.ADE_SIM_HELPER_SCRATCH
      || path.join(os.tmpdir(), "ade-sim-helper-spike", ".build"),
    "--show-bin-path",
  ], { encoding: "utf8" }).trim();
  const executablePath = path.join(binPath, "ade-sim-helper");
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Build the helper first: ${executablePath} is missing.`);
  }

  const all = bootedDevices();
  let booted = all.filter((device) => device.state === "Booted");
  const bootedByUs = [];
  // Boot, never clone: a clone costs gigabytes of disk and this proof does not
  // need a pristine device, only two distinct ones.
  for (const candidate of all) {
    if (booted.length >= 2) break;
    if (candidate.state === "Booted") continue;
    if (!/iPhone|iPad/.test(candidate.name)) continue;
    log(`Booting ${candidate.name} (${candidate.udid})`);
    execFileSync("xcrun", ["simctl", "boot", candidate.udid]);
    bootedByUs.push(candidate.udid);
    booted.push({ ...candidate, state: "Booted" });
  }
  if (booted.length < 2) throw new Error("Need two booted simulators.");
  const targets = booted.slice(0, 2);
  log(`Targets: ${targets.map((d) => `${d.name} ${d.udid}`).join(" | ")}`);

  const helper = new Helper(executablePath);
  const results = { devices: [], latencyMs: null };
  try {
    const ready = await helper.ready;
    log(`ready: protocol=${ready.protocol} pid=${ready.pid}`);

    const listed = await helper.send("list-devices");
    log(`list-devices: ${listed.devices.length} devices`);
    for (const target of targets) {
      const entry = listed.devices.find((d) => d.udid === target.udid);
      if (!entry) throw new Error(`list-devices omitted ${target.udid}`);
      if (!entry.pointWidth) throw new Error(`No point size for ${target.udid}`);
      log(`  ${entry.name}: ${entry.pointWidth}x${entry.pointHeight} @${entry.scale}x (${entry.state})`);
    }

    // --- capture on BOTH devices at once -----------------------------------
    const sessions = [];
    for (const target of targets) {
      const started = await helper.send("capture-start", { udid: target.udid, fps: 60, scale: 1 });
      log(`capture-started ${target.name}: ${started.url} ${started.pixelWidth}x${started.pixelHeight}`);
      sessions.push({ target, started, stream: attachStream(started.url, started.token) });
    }
    if (new Set(sessions.map((s) => s.started.url)).size !== sessions.length) {
      throw new Error("Both devices were handed the same stream endpoint.");
    }
    if (new Set(sessions.map((s) => s.started.token)).size !== sessions.length) {
      throw new Error("Both devices were handed the same token.");
    }

    for (const session of sessions) {
      await waitFor(() => session.stream.records.some((r) => r.keyframe), {
        label: `keyframe from ${session.target.name}`,
      });
      const config = session.stream.config;
      if (!config || config.annexB !== true || !/^avc1\./.test(config.codec)) {
        throw new Error(`Bad config from ${session.target.name}: ${JSON.stringify(config)}`);
      }
      // An Annex-B access unit must start with a start code; getting this wrong
      // is exactly the failure that renders as a permanently blank canvas.
      const keyframe = session.stream.records.find((r) => r.keyframe);
      const prefix = [...keyframe.bytes.subarray(0, 4)];
      if (prefix.join(",") !== "0,0,0,1") {
        throw new Error(`Keyframe is not Annex-B framed: ${prefix}`);
      }
      log(`keyframes OK ${session.target.name}: codec=${config.codec} ${config.width}x${config.height}`);
    }

    // --- token is actually enforced ----------------------------------------
    const refused = await new Promise((resolve) => {
      http.get(sessions[0].started.url, { headers: { Authorization: "Bearer wrong" } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      });
    });
    if (refused !== 403) throw new Error(`A wrong token got ${refused}, expected 403.`);
    log("token enforcement OK: wrong bearer -> 403");

    // --- input + ax + screenshot on each device ----------------------------
    for (const session of sessions) {
      const { udid, name } = session.target;
      const { pointWidth, pointHeight } = session.started;
      const x = pointWidth / 2;
      const y = pointHeight * 0.55;
      await helper.send("touch", { udid, phase: "begin", x, y });
      await helper.send("touch", { udid, phase: "end", x, y });

      const ax = await helper.send("ax-describe", { udid });
      const tree = JSON.parse(ax.tree);
      // Count the whole tree, not its roots: the dump is a single Application
      // root whose children are the elements, so a root count always says "1"
      // and would hide an empty tree.
      const countNodes = (node) => 1 + (node.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
      const nodes = (Array.isArray(tree) ? tree : [tree]).reduce((sum, root) => sum + countNodes(root), 0);
      if (nodes < 2) throw new Error(`ax-describe returned a stub tree (${nodes} nodes).`);
      // Frames come back in device points, the same unit the touch commands
      // take — so an element's centre can be tapped with no conversion.
      const first = (Array.isArray(tree) ? tree[0] : tree);
      if (first?.frame?.width !== session.started.pointWidth) {
        throw new Error(`ax frame width ${first?.frame?.width} != ${session.started.pointWidth} points`);
      }
      const frontmost = await helper.send("ax-frontmost", { udid });

      const shotPath = path.join(outDir, `${name.replace(/\W+/g, "-")}.png`);
      const shot = await helper.send("screenshot", { udid, path: shotPath });
      const bytes = fs.statSync(shotPath).size;
      const header = fs.readFileSync(shotPath).subarray(0, 8);
      if (header.toString("hex") !== "89504e470d0a1a0a") throw new Error("Not a PNG.");
      // Cross-check the unit arithmetic against ground truth. The PNG comes
      // from the real framebuffer, so if `capture-started` disagrees with it
      // the point/pixel conversion is wrong — and every touch coordinate is
      // wrong with it, silently, by exactly the scale factor.
      if (shot.width !== session.started.pixelWidth || shot.height !== session.started.pixelHeight) {
        throw new Error(
          `capture-started said ${session.started.pixelWidth}x${session.started.pixelHeight} `
          + `but the framebuffer is ${shot.width}x${shot.height}`,
        );
      }
      if (Math.round(pointWidth * session.started.scale) !== shot.width) {
        throw new Error(`points x scale (${pointWidth} x ${session.started.scale}) != ${shot.width}`);
      }

      fs.writeFileSync(path.join(outDir, `${name.replace(/\W+/g, "-")}-ax.json`), ax.tree);
      log(`${name}: touch OK, ax nodes=${nodes}, frontmost=${frontmost.app?.bundleId}, `
        + `png ${shot.width}x${shot.height} (${bytes} bytes) -> ${shotPath}`);
      results.devices.push({ name, udid, nodes, bundleId: frontmost.app?.bundleId, shotPath, bytes });
    }

    // --- latency: input to first visibly-changed frame --------------------
    //
    // Method, and why it is this and not something simpler:
    //
    // * The clock starts immediately before the command line is written to the
    //   helper's stdin and stops at the arrival timestamp of the first frame
    //   showing the change. It therefore covers NDJSON transit, HID injection,
    //   the simulator's own render, framebuffer capture, H.264 encode and
    //   loopback delivery — everything the user perceives except the decode.
    //
    // * Change is detected by ENCODED FRAME SIZE against a per-sample baseline,
    //   NOT by comparing bytes. Two things rule byte-comparison out: the
    //   encoder is not byte-deterministic, and — measured, not assumed — the
    //   iOS 26 home screen is never still. It renders continuously at ~60 fps,
    //   so the capture layer's 5 fps idle floor never engages and every frame
    //   differs from the last. A naive byte-difference check reports ~2 ms,
    //   which is not a latency, it is the next scheduled frame.
    //
    // * The stimulus is the lock button rather than a tap. Against a baseline
    //   that is already moving, a tap highlight is not separable from the
    //   wallpaper; a lock is a full-screen repaint that lands 6-20x over
    //   baseline and is unambiguous. It travels the same injection path as a
    //   touch (Indigo HID into the simulator's own port), so the pipeline cost
    //   it measures is the same one a tap pays.
    //
    // The number therefore includes iOS's own reaction time and is an UPPER
    // bound on what ADE's transport costs.
    const probe = sessions[0];
    const probeUdid = probe.target.udid;

    const measureOnce = async () => {
      // Return to a known state first. Locking twice in a row leaves the screen
      // off with nothing left to repaint, and the next sample then waits for a
      // change that never comes — so each sample starts from the home screen,
      // which `home` guarantees by relaunching SpringBoard.
      await helper.send("button", { udid: probeUdid, name: "lock" });
      await wait(600);
      await helper.send("button", { udid: probeUdid, name: "home" });
      await wait(2_500);
      const baseline = probe.stream.records.slice(-20).map((r) => r.bytes.length);
      if (baseline.length < 20) throw new Error("Not enough frames to establish a baseline.");
      const median = [...baseline].sort((a, b) => a - b)[Math.floor(baseline.length / 2)];
      const threshold = Math.max(20_000, median * 6);

      const before = probe.stream.records.length;
      const startedAt = performance.now();
      await helper.send("button", { udid: probeUdid, name: "lock" });
      const changed = await waitFor(() => probe.stream.records
        .slice(before)
        .find((r) => r.bytes.length > threshold), {
        label: "a full-screen repaint after the button",
        timeoutMs: 8_000,
      });
      return {
        latency: Math.round((changed.at - startedAt) * 10) / 10,
        bytes: changed.bytes.length,
        median,
      };
    };

    const samples = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const sample = await measureOnce();
      samples.push(sample.latency);
      log(`latency sample ${attempt + 1}: ${sample.latency} ms `
        + `(changed frame ${sample.bytes} B vs ${sample.median} B baseline)`);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    results.latencyMs = sorted[Math.floor(sorted.length / 2)];
    results.latencySamplesMs = samples;
    log(`latency: median ${results.latencyMs} ms over ${samples.length} samples `
      + `(min ${sorted[0]}, max ${sorted[sorted.length - 1]})`);

    // Delivery cadence, which is the part of the number ADE actually controls.
    const recent = probe.stream.records.slice(-60);
    const gaps = recent.slice(1).map((r, index) => r.at - recent[index].at);
    const medianGap = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    results.frameIntervalMs = Math.round(medianGap * 10) / 10;
    log(`frame cadence: median ${results.frameIntervalMs} ms between access units `
      + `(~${Math.round(1000 / medianGap)} fps)`);

    for (const session of sessions) {
      session.stream.stop();
      await helper.send("capture-stop", { udid: session.target.udid });
    }
    log("capture-stop OK on both devices");
  } finally {
    await helper.quit();
    if (helper.stderr.trim()) {
      log("--- helper stderr (vendored diagnostics) ---");
      console.log(helper.stderr.trim().split("\n").slice(0, 25).join("\n"));
    }
    if (!keepBooted) {
      for (const udid of bootedByUs) {
        log(`Shutting down ${udid} (booted by this run)`);
        try { execFileSync("xcrun", ["simctl", "shutdown", udid]); } catch { /* already gone */ }
      }
    }
  }

  log("RESULT " + JSON.stringify(results, null, 2));
  log("PASS");
}

main().catch((error) => {
  console.error("[proof] FAIL", error);
  process.exit(1);
});
