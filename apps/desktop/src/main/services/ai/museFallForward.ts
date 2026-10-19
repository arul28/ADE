/**
 * Muse fall-forward, driven by Meta's published floor.
 *
 * Muse never refuses a client in words; Meta's channel document
 * (`GET https://api.meta.ai/muse-code/channels/muse-stable`) publishes
 * `min_version` (null today) and `urgency`. On Muse runtime start, at most
 * once every few hours per process, ADE reads it. A failed fetch, a non-200 or
 * a document it cannot parse means nothing happens. Only when `min_version` is
 * set and the Muse ADE runs is older:
 *
 *   - when the channel's current build pairs with ADE's bundled
 *     `@muse-code/sdk` (SDK `X.Y.Z` drives binary `X.Y.Z-R<build>` only, see
 *     `pin-muse-release.mjs`) and meets the floor, ADE takes that build from
 *     Meta's versioned release manifest (sha256 + size, lookaside host, the
 *     same source as the pin), installs it as its own version directory,
 *     checks `--version`, and records the override `resolveMuseExecutable`
 *     follows while the pin it replaces is still the manifest's;
 *   - otherwise it says "Meta requires Muse Code ≥ X; this ADE has Y. Update
 *     ADE." and keeps running its pin.
 *
 * `urgency` only changes the wording. Everything acts on the tools cache of
 * the process it runs in (the brain on the lane's machine).
 */
import fs from "node:fs";
import os from "node:os";
import { isToolError } from "../../../../../ade-cli/src/services/tools/errors";
import { ensureTools } from "../../../../../ade-cli/src/services/tools/install";
import { findToolTargetPin, loadToolsManifest } from "../../../../../ade-cli/src/services/tools/manifest";
import { MUSE_TOOL_NAME, resolveMuseExecutable } from "../../../../../ade-cli/src/services/tools/muse";
import { pinnedToolFetchAllowed } from "../../../../../ade-cli/src/services/tools/onDemand";
import { manifestWithOverride, writeToolVersionOverride } from "../../../../../ade-cli/src/services/tools/overrides";
import { detectToolTarget, type ToolTarget } from "../../../../../ade-cli/src/services/tools/paths";
import {
  fallForwardOnce,
  fallForwardStatusLine,
  fetchVendorJson,
  runProbeProcess,
  type FallForwardLogger,
} from "./providerFallForward";
import { getMachineMainLogger } from "../logging/machineLogger";
import { decideMuseFloor, parseMuseChannelDocument, type MuseFloorDecision } from "./providerVersionRejection";

const CHANNEL_URL = "https://api.meta.ai/muse-code/channels/muse-stable";
const CHANNEL_HOSTS = ["api.meta.ai"] as const;
const LOOKASIDE_HOSTS = ["lookaside.facebook.com"] as const;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const VERSION_TIMEOUT_MS = 20_000;
const MUSE_VERSION_OUTPUT = /^Muse Code (\S+) \((\S+)\)\s*$/m;

/** ADE tools target -> Meta artifact key (as in `pin-muse-release.mjs`). */
const TARGET_ARTIFACTS: Readonly<Partial<Record<ToolTarget, string>>> = {
  "darwin-arm64": "aarch64_macos",
  "darwin-x64": "x86_macos",
  "linux-arm64": "aarch64_linux",
  "linux-x64": "x86_linux",
  "win32-x64": "x86_windows",
};

export type MuseFallForwardFailure = "lookup-failed" | "download-failed" | "probe-failed" | "write-failed";

export type MuseFloorOutcome =
  | { action: "none" }
  | { action: "switched"; minVersion: string; pinnedVersion: string; museVersion: string; urgency: string | null }
  | { action: "update-ade"; minVersion: string; runningVersion: string; urgency: string | null }
  | {
    action: "not-switched";
    reason: MuseFallForwardFailure;
    detail: string | null;
    minVersion: string;
    runningVersion: string;
    channelVersion: string;
    urgency: string | null;
  };

let lastCheckAt = 0;
let running: Promise<MuseFloorOutcome> | null = null;
/** What the last check found, for the status row. */
let lastVerdict: MuseFloorOutcome = { action: "none" };

function versionedManifestUrl(version: string): string {
  return `https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=${encodeURIComponent(version)}&file=manifest.json`;
}

/** The channel build's artifact for this target, from Meta's versioned release manifest. */
async function lookupArtifact(version: string, target: ToolTarget): Promise<{ url: string; sha256: string; size: number }> {
  const artifactKey = TARGET_ARTIFACTS[target];
  if (!artifactKey) throw new Error(`Meta publishes no Muse build for ${target}`);
  const manifest = await fetchVendorJson(versionedManifestUrl(version), LOOKASIDE_HOSTS);
  if (manifest.version !== version) throw new Error(`Meta's manifest describes ${String(manifest.version)}, not ${version}`);
  if (manifest.checksum_algorithm !== "sha256") throw new Error("Meta's manifest does not use sha256");
  const artifacts = manifest.artifacts && typeof manifest.artifacts === "object" ? manifest.artifacts as Record<string, unknown> : {};
  const artifact = artifacts[artifactKey] && typeof artifacts[artifactKey] === "object" ? artifacts[artifactKey] as Record<string, unknown> : null;
  const url = typeof artifact?.url === "string" ? artifact.url : "";
  const checksum = typeof artifact?.checksum === "string" ? artifact.checksum : "";
  const size = artifact?.size;
  let host = "";
  try {
    const parsed = new URL(url);
    host = parsed.protocol === "https:" ? parsed.hostname : "";
  } catch {
    host = "";
  }
  if (!(LOOKASIDE_HOSTS as readonly string[]).includes(host)) throw new Error(`${artifactKey} is not served from Meta's lookaside host`);
  if (!/^[0-9a-fA-F]{64}$/.test(checksum)) throw new Error(`${artifactKey} has no sha256`);
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) throw new Error(`${artifactKey} has no byte size`);
  return { url, sha256: checksum.toLowerCase(), size };
}

async function fallForward(args: {
  decision: Extract<MuseFloorDecision, { action: "fall-forward" }>;
  pin: { package: string; version: string };
  target: ToolTarget;
  sdkVersion: string;
}): Promise<MuseFloorOutcome> {
  const { decision, pin, target, sdkVersion } = args;
  const failed = (reason: MuseFallForwardFailure, detail: string | null): MuseFloorOutcome => ({
    action: "not-switched", reason, detail, minVersion: decision.minVersion, runningVersion: pin.version,
    channelVersion: decision.version, urgency: decision.urgency,
  });
  let artifact: { url: string; sha256: string; size: number };
  try {
    artifact = await lookupArtifact(decision.version, target);
  } catch (error) {
    return failed("lookup-failed", error instanceof Error ? error.message : String(error));
  }
  const draft = {
    tool: MUSE_TOOL_NAME,
    target,
    format: "file" as const,
    packageName: pin.package,
    overrideVersion: decision.version,
    tarball: "",
    integrity: "",
    ...artifact,
  };
  let entryPath: string;
  let installedDir: string;
  try {
    const installed = await ensureTools([MUSE_TOOL_NAME], { manifest: manifestWithOverride(draft) });
    entryPath = installed.get(MUSE_TOOL_NAME)!.entryPath;
    installedDir = installed.get(MUSE_TOOL_NAME)!.dir;
  } catch (error) {
    return failed("download-failed", isToolError(error) ? error.kind : String(error));
  }
  const probe = await runProbeProcess(entryPath, ["--version"], { env: process.env, timeoutMs: VERSION_TIMEOUT_MS });
  const reported = probe.exitCode === 0 ? MUSE_VERSION_OUTPUT.exec(probe.stdout) : null;
  if (!reported || reported[2] !== decision.version || reported[1] !== sdkVersion) {
    // A build that failed its check must never be run, not even as the
    // cache's "previous pin": remove it now.
    fs.rmSync(installedDir, { recursive: true, force: true });
    return failed("probe-failed", reported ? `it reported ${reported[2]}` : "it did not report its version");
  }
  try {
    await writeToolVersionOverride({
      ...draft,
      pinnedVersion: pin.version,
      reason: "vendor_min_version",
      scope: null,
      requiredVersion: decision.minVersion,
      rejectedToolVersion: pin.version,
      overrideToolVersion: decision.version,
      at: new Date().toISOString(),
      lastUsedAt: Date.now(),
    });
  } catch (error) {
    return failed("write-failed", error instanceof Error ? error.message : String(error));
  }
  if (resolveMuseExecutable().fallForward?.overrideVersion !== decision.version) {
    return failed("write-failed", "the override did not resolve");
  }
  return { action: "switched", minVersion: decision.minVersion, pinnedVersion: pin.version, museVersion: decision.version, urgency: decision.urgency };
}

async function check(logger: FallForwardLogger | null | undefined): Promise<MuseFloorOutcome> {
  let target: ToolTarget;
  let pin: { package: string; version: string };
  try {
    target = detectToolTarget(process.platform, os.arch());
    const targetPin = findToolTargetPin(loadToolsManifest(), MUSE_TOOL_NAME, target);
    if (targetPin.format !== "file") return { action: "none" };
    pin = { package: targetPin.package, version: targetPin.version };
  } catch {
    return { action: "none" };
  }
  const resolved = resolveMuseExecutable();
  // A developer's build is left alone, and until the pin itself is on disk
  // (not a previous build while it downloads) there is nothing to compare.
  if (resolved.source === "env-override" || !resolved.path || resolved.previous) return { action: "none" };
  let channel;
  try {
    channel = parseMuseChannelDocument(await fetchVendorJson(CHANNEL_URL, CHANNEL_HOSTS));
  } catch {
    return { action: "none" };
  }
  if (!channel) return { action: "none" };
  // The pin's own release is ADE's SDK release: the pin script only pins a pairing build.
  const sdkVersion = /^\d+\.\d+\.\d+/.exec(pin.version)?.[0];
  if (!sdkVersion) return { action: "none" };
  const runningVersion = resolved.fallForward?.overrideVersion ?? pin.version;
  const decision = decideMuseFloor({ channel, pinnedVersion: runningVersion, sdkVersion });
  if (decision.action === "none") return { action: "none" };
  if (decision.action === "update-ade") {
    return { action: "update-ade", minVersion: decision.minVersion, runningVersion, urgency: decision.urgency };
  }
  return fallForwardOnce(
    `${pin.package}@${pin.version}->${decision.version}`,
    () => fallForward({ decision, pin, target, sdkVersion }).catch((error: unknown): MuseFloorOutcome => ({
      action: "not-switched", reason: "download-failed", detail: error instanceof Error ? error.message : String(error),
      minVersion: decision.minVersion, runningVersion: pin.version, channelVersion: decision.version, urgency: decision.urgency,
    })),
    {
      event: "ai.muse_fall_forward",
      logger,
      fields: (outcome) => ({
        tool: MUSE_TOOL_NAME,
        signal: "vendor_min_version",
        pinnedVersion: pin.version,
        minVersion: decision.minVersion,
        urgency: decision.urgency,
        channelVersion: decision.version,
        outcome: outcome.action === "switched" ? "switched" : "not_switched",
        ...(outcome.action === "not-switched" ? { reason: outcome.reason, detail: outcome.detail } : {}),
      }),
    },
  );
}

/**
 * Read Meta's floor and act on it, at most once per {@link CHECK_INTERVAL_MS}
 * per process (callers: every Muse runtime start). Only where this process may
 * download tools (never in tests or with ADE_DISABLE_TOOLS_FETCH=1). Never
 * rejects; resolves to what it found, which the status row also shows.
 */
export function checkMuseVendorFloor(options: { logger?: FallForwardLogger | null } = {}): Promise<MuseFloorOutcome> {
  if (running) return running;
  if (!pinnedToolFetchAllowed(MUSE_TOOL_NAME)) return Promise.resolve(lastVerdict);
  if (Date.now() - lastCheckAt < CHECK_INTERVAL_MS) return Promise.resolve(lastVerdict);
  lastCheckAt = Date.now();
  running = check(options.logger)
    .catch((): MuseFloorOutcome => ({ action: "none" }))
    .then((outcome) => {
      lastVerdict = outcome;
      if (outcome.action === "update-ade") {
        (options.logger ?? getMachineMainLogger()).warn("ai.muse_vendor_floor", { minVersion: outcome.minVersion, runningVersion: outcome.runningVersion, urgency: outcome.urgency });
      }
      return outcome;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

function urgencyWords(urgency: string | null): string {
  return urgency && /^(high|critical|urgent|required)$/i.test(urgency) ? " Meta marks this update as urgent." : "";
}

/**
 * What ADE says about Meta's floor: the switch it made, or why it kept its
 * pin. Null when there is nothing to say.
 */
export function museFloorNotice(outcome: MuseFloorOutcome): string | null {
  switch (outcome.action) {
    case "none":
      return null;
    case "switched":
      return `Meta stopped supporting Muse Code ${outcome.pinnedVersion} (it requires ${outcome.minVersion} or newer); `
        + `ADE switched to the untested ${outcome.museVersion}. New Muse chats use it.${urgencyWords(outcome.urgency)}`;
    case "update-ade":
      return `Meta requires Muse Code ≥ ${outcome.minVersion}; this ADE has ${outcome.runningVersion}. Update ADE.${urgencyWords(outcome.urgency)}`;
    case "not-switched":
      return `Meta requires Muse Code ≥ ${outcome.minVersion}; this ADE has ${outcome.runningVersion}. `
        + `ADE could not switch to Meta's ${outcome.channelVersion} (${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ""}). Update ADE.`
        + urgencyWords(outcome.urgency);
  }
}

/**
 * The status row's line: "Running untested Muse Code X: Meta stopped
 * supporting Y." while an override runs, else the last check's "Update ADE"
 * sentence, else null. No spawn, no network.
 */
export function museFallForwardStatusLine(): string | null {
  const running = fallForwardStatusLine(MUSE_TOOL_NAME, "Muse Code", "Meta");
  if (running) return running;
  return lastVerdict.action === "update-ade" || lastVerdict.action === "not-switched" ? museFloorNotice(lastVerdict) : null;
}
