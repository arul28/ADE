/**
 * Devin fall-forward, when Devin deleted the pinned build.
 *
 * Devin's CDN (`static.devin.ai`) keeps only its current release: an older
 * build's archive and its `manifest.json` start answering HTTP 403, so a
 * machine that never downloaded the pin can never run Devin, while a machine
 * that did keeps its copy. When the pinned archive answers 403 or 404 (never a
 * network error, a 5xx or anything else; `isDeletedPinFailure`), ADE:
 *
 *   - reads `static.devin.ai/cli/current/manifest.json`, the same host and the
 *     same manifest the pin came from (`pin-tool.mjs`), and takes this
 *     target's archive URL and sha256 from it (its byte size from a HEAD of
 *     that URL, as the pin script does);
 *   - installs it as its own version directory through the tools cache, which
 *     refuses a host other than Devin's and checks the sha256 and size before
 *     it unpacks a single file;
 *   - checks `devin --version` names that build, and records the override
 *     (reason `vendor_pin_deleted`) that stands in for the pin until an ADE
 *     update moves it (`tools/overrides.ts`).
 *
 * The switch is one warning in the machine log and one Sentry warning (tool
 * and versions only), so the pin gets moved. The person sees nothing new: the
 * chat or CLI that asked for Devin just starts. A failed attempt keeps the
 * download failure and may be tried again by the next start.
 */
import fs from "node:fs";
import os from "node:os";
import type { ToolError } from "../../../../../ade-cli/src/services/tools/errors";
import { isToolError } from "../../../../../ade-cli/src/services/tools/errors";
import { type ToolsContext, ensureTools } from "../../../../../ade-cli/src/services/tools/install";
import { findToolTargetPin, loadToolsManifest } from "../../../../../ade-cli/src/services/tools/manifest";
import {
  VENDOR_PIN_DELETED,
  manifestWithOverride,
  resolveDeletedPinReplacement,
  writeToolVersionOverride,
} from "../../../../../ade-cli/src/services/tools/overrides";
import { detectToolTarget, type ToolTarget } from "../../../../../ade-cli/src/services/tools/paths";
import { captureProblem } from "../../../shared/sentry/capture";
import { getMachineMainLogger } from "../logging/machineLogger";
import { fetchVendorJson, runProbeProcess, type FallForwardLogger } from "./providerFallForward";

const DEVIN_TOOL = "devin";
const CURRENT_MANIFEST_URL = "https://static.devin.ai/cli/current/manifest.json";
const DEVIN_HOSTS = ["static.devin.ai"] as const;
const HEAD_TIMEOUT_MS = 15_000;
/** Devin's archives are 60-90 MB; a size past this is not one of them. */
const MAX_ARCHIVE_BYTES = 1_000_000_000;
const VERSION_TIMEOUT_MS = 20_000;
const DEVIN_VERSION_OUTPUT = /^devin (\S+)/m;

/** ADE tools target -> Devin's platform key (as in `pin-tool.mjs`). */
const TARGET_TRIPLES: Readonly<Partial<Record<ToolTarget, string>>> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux",
  "linux-x64": "x86_64-unknown-linux",
  "win32-x64": "x86_64-pc-windows",
};

export type DevinFallForwardOutcome =
  | { action: "switched"; pinnedVersion: string; devinVersion: string }
  | {
    action: "not-switched";
    reason: "lookup-failed" | "same-version" | "download-failed" | "probe-failed" | "write-failed";
    detail: string | null;
    pinnedVersion: string;
  };

type CurrentBuild = { version: string; url: string; sha256: string; size: number; archive: "tar.gz" | "zip" };

function onDevinHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (DEVIN_HOSTS as readonly string[]).includes(parsed.hostname);
  } catch {
    return false;
  }
}

/** The archive's byte size from a HEAD on Devin's host, following no redirect. */
async function archiveSize(url: string): Promise<number> {
  const response = await fetch(url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
  if (response.status !== 200) throw new Error(`HEAD answered HTTP ${response.status}`);
  const size = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ARCHIVE_BYTES) throw new Error("HEAD sent no usable Content-Length");
  return size;
}

/** This target's archive of Devin's current release, from Devin's own manifest. */
async function lookupCurrentBuild(target: ToolTarget): Promise<CurrentBuild> {
  const triple = TARGET_TRIPLES[target];
  if (!triple) throw new Error(`Devin publishes no build for ${target}`);
  const manifest = await fetchVendorJson(CURRENT_MANIFEST_URL, DEVIN_HOSTS);
  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (!/^\d+(?:\.\d+){1,3}$/.test(version)) throw new Error("Devin's manifest names no version");
  const platforms = manifest.platforms && typeof manifest.platforms === "object" ? manifest.platforms as Record<string, unknown> : {};
  const platform = platforms[triple] && typeof platforms[triple] === "object" ? platforms[triple] as Record<string, unknown> : null;
  const url = typeof platform?.url === "string" ? platform.url : "";
  const sha256 = typeof platform?.sha256 === "string" ? platform.sha256 : "";
  if (!onDevinHost(url)) throw new Error(`${triple} is not served from Devin's host`);
  if (!/^[0-9a-fA-F]{64}$/.test(sha256)) throw new Error(`${triple} has no sha256`);
  const archive = url.endsWith(".zip") ? "zip" : url.endsWith(".tar.gz") ? "tar.gz" : null;
  if (!archive) throw new Error(`${triple} is not a .tar.gz or .zip archive`);
  return { version, url, sha256: sha256.toLowerCase(), size: await archiveSize(url), archive };
}

async function fallForward(pin: { package: string; version: string }, target: ToolTarget, context: ToolsContext): Promise<DevinFallForwardOutcome> {
  const failed = (reason: Extract<DevinFallForwardOutcome, { action: "not-switched" }>["reason"], detail: string | null): DevinFallForwardOutcome => ({
    action: "not-switched", reason, detail, pinnedVersion: pin.version,
  });
  let build: CurrentBuild;
  try {
    build = await lookupCurrentBuild(target);
  } catch (error) {
    return failed("lookup-failed", error instanceof Error ? error.message : String(error));
  }
  // The manifest still names the pin while its archive is gone: nothing newer to take.
  if (build.version === pin.version) return failed("same-version", null);
  const draft = {
    tool: DEVIN_TOOL,
    target,
    format: "archive" as const,
    packageName: pin.package,
    overrideVersion: build.version,
    tarball: "",
    integrity: "",
    url: build.url,
    sha256: build.sha256,
    size: build.size,
    archive: build.archive,
    stripComponents: 0,
  };
  let entryPath: string;
  let installedDir: string;
  try {
    // The tools cache checks the host, the sha256 and the size before it unpacks.
    const installed = (await ensureTools([DEVIN_TOOL], { ...context, target, manifest: manifestWithOverride(draft) })).get(DEVIN_TOOL)!;
    entryPath = installed.entryPath;
    installedDir = installed.dir;
  } catch (error) {
    return failed("download-failed", isToolError(error) ? error.kind : String(error));
  }
  const probe = await runProbeProcess(entryPath, ["--version"], { env: process.env, timeoutMs: VERSION_TIMEOUT_MS });
  const reported = probe.exitCode === 0 ? DEVIN_VERSION_OUTPUT.exec(probe.stdout)?.[1] ?? null : null;
  if (reported !== build.version) {
    // A build that failed its check must never run: remove it now.
    fs.rmSync(installedDir, { recursive: true, force: true });
    return failed("probe-failed", reported ? `it reported ${reported}` : "it did not report its version");
  }
  try {
    await writeToolVersionOverride({
      ...draft,
      pinnedVersion: pin.version,
      reason: VENDOR_PIN_DELETED,
      scope: null,
      requiredVersion: null,
      rejectedToolVersion: pin.version,
      overrideToolVersion: build.version,
      at: new Date().toISOString(),
      lastUsedAt: Date.now(),
    }, context);
  } catch (error) {
    return failed("write-failed", error instanceof Error ? error.message : String(error));
  }
  if (!resolveDeletedPinReplacement(DEVIN_TOOL, { ...context, target })) return failed("write-failed", "the override did not resolve");
  return { action: "switched", pinnedVersion: pin.version, devinVersion: build.version };
}

let running: Promise<DevinFallForwardOutcome> | null = null;
let switched: DevinFallForwardOutcome | null = null;

/**
 * The tools cache's `DeletedPinFallback` for Devin (registered in
 * `pinnedProviderTools.ts`): resolves true once Devin's current build stands
 * in for the deleted pin. One attempt at a time; after a switch, later calls
 * answer from it without the network. Never rejects.
 */
export function devinDeletedPinFallback(
  failure: ToolError,
  context: ToolsContext = {},
  logger: FallForwardLogger | null = null,
): Promise<boolean> {
  if (switched) return Promise.resolve(switched.action === "switched");
  let target: ToolTarget;
  let pin: { package: string; version: string };
  try {
    target = context.target ?? detectToolTarget(context.platform ?? process.platform, context.arch ?? os.arch());
    const targetPin = findToolTargetPin(context.manifest ?? loadToolsManifest(), DEVIN_TOOL, target);
    if (targetPin.format !== "archive") return Promise.resolve(false);
    pin = { package: targetPin.package, version: targetPin.version };
  } catch {
    return Promise.resolve(false);
  }
  running ??= fallForward(pin, target, context)
    .catch((error: unknown): DevinFallForwardOutcome => ({
      action: "not-switched", reason: "download-failed", detail: error instanceof Error ? error.message : String(error), pinnedVersion: pin.version,
    }))
    .then((outcome) => {
      const fields = {
        tool: DEVIN_TOOL,
        signal: VENDOR_PIN_DELETED,
        httpStatus: failure.httpStatus ?? null,
        target,
        pinnedVersion: pin.version,
        outcome: outcome.action === "switched" ? "switched" : "not_switched",
        ...(outcome.action === "switched" ? { devinVersion: outcome.devinVersion } : { reason: outcome.reason, detail: outcome.detail }),
      };
      (logger ?? getMachineMainLogger()).warn("ai.devin_fall_forward", fields);
      if (outcome.action === "switched") {
        switched = outcome;
        // Once per process, grouped per pin: the pin needs moving in the next release.
        captureProblem(`Devin deleted the pinned build ${pin.version}; running ${outcome.devinVersion}`, {
          level: "warning",
          handled: true,
          tags: { tool: DEVIN_TOOL, signal: VENDOR_PIN_DELETED, target },
          extra: { pinnedVersion: pin.version, devinVersion: outcome.devinVersion, httpStatus: failure.httpStatus ?? null },
          fingerprint: ["tool-pin-deleted", DEVIN_TOOL, pin.version],
        });
      }
      return outcome;
    })
    .finally(() => {
      running = null;
    });
  return running.then((outcome) => outcome.action === "switched");
}
