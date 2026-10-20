/**
 * Claude Code fall-forward: the one time ADE runs a build it did not pin.
 *
 * ADE runs only its own pinned Claude Code. When Anthropic provably refuses
 * that pin as too old (`providerVersionRejection.ts` recognises the exact
 * refusals), ADE moves to Anthropic's newest build on its own, marked
 * untested, until a developer moves the pin:
 *
 *   1. look up `@anthropic-ai/claude-agent-sdk-<target>`'s `latest` on npm;
 *      it must be newer than the build that was refused, and the Claude Code
 *      it carries (the SDK package's `claudeCodeVersion`) at least the
 *      version Anthropic named;
 *   2. download it into the tools cache as its own version directory, through
 *      the cache's npm-tarball install (registry host lock, npm SRI, sentinel);
 *   3. probe it without a model request: `--version` must name that Claude
 *      Code, and `auth status --json` must answer;
 *   4. only then record the override (`tools/overrides.ts`), which
 *      `resolveClaudeCodeExecutable` runs from then on, while the pin it
 *      replaces is still the manifest's.
 *
 * One attempt per pinned version per process: a second refusal of the same
 * pin joins the first attempt, and a refusal of the build ADE already moved to
 * stops with the message instead of looping. Everything acts on the tools
 * cache of the process it runs in, i.e. the brain that owns the chat.
 */
import fs from "node:fs";
import os from "node:os";
import { isToolError } from "../../../../../ade-cli/src/services/tools/errors";
import { ensureTools } from "../../../../../ade-cli/src/services/tools/install";
import { findToolTargetPin, loadToolsManifest } from "../../../../../ade-cli/src/services/tools/manifest";
import { pinnedToolFetchAllowed } from "../../../../../ade-cli/src/services/tools/onDemand";
import {
  manifestWithOverride,
  resolveActiveToolVersionOverride,
  writeToolVersionOverride,
  type ToolVersionOverride,
} from "../../../../../ade-cli/src/services/tools/overrides";
import { detectToolTarget } from "../../../../../ade-cli/src/services/tools/paths";
import { providerSelfUpdateEnv } from "../../../shared/pinnedToolSpawnEnv";
import { compareUpdateVersions } from "../../../shared/updateVersions";
import type { Logger } from "../logging/logger";
import { resolveClaudeCodeExecutable, type ClaudeCodeExecutableResolution } from "./claudeCodeExecutable";
import type { ClaudeVersionRejection } from "./providerVersionRejection";
import { fallForwardOnce, fetchVendorJson, runProbeProcess } from "./providerFallForward";

const TOOL = "claude-code";
const NPM_REGISTRY = "https://registry.npmjs.org";
/** The SDK package whose `claudeCodeVersion` names the Claude Code a platform package carries. */
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const CLAUDE_VERSION_OUTPUT = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?) \(Claude Code\)/;

export type ClaudeFallForwardFailure =
  /** Downloads are off in this process (a test, ADE_DISABLE_TOOLS_FETCH, a source checkout). */
  | "not-allowed"
  /** A developer override (CLAUDE_CODE_EXECUTABLE_PATH) runs; ADE leaves it alone. */
  | "env-override"
  /** This ADE pins no Claude Code for this machine. */
  | "no-pin"
  /** The build ADE already moved to was refused too. */
  | "newest-refused"
  /** npm has nothing newer than the refused build. */
  | "no-newer-build"
  /** npm's newest still carries a Claude Code below Anthropic's minimum. */
  | "below-required"
  | "lookup-failed"
  | "download-failed"
  | "probe-failed"
  | "write-failed";

export type ClaudeFallForwardOutcome =
  | {
    switched: true;
    pinnedVersion: string;
    overrideVersion: string;
    claudeCodeVersion: string;
    rejectedClaudeCodeVersion: string | null;
    requiredVersion: string | null;
  }
  | {
    switched: false;
    reason: ClaudeFallForwardFailure;
    /** Plain words for the failure, when there is more to say than the reason. */
    detail: string | null;
    rejectedClaudeCodeVersion: string | null;
    requiredVersion: string | null;
  };

type FallForwardLogger = Pick<Logger, "info" | "warn">;

function failed(
  reason: ClaudeFallForwardFailure,
  rejection: ClaudeVersionRejection,
  rejectedClaudeCodeVersion: string | null,
  detail: string | null = null,
): ClaudeFallForwardOutcome {
  return { switched: false, reason, detail, rejectedClaudeCodeVersion, requiredVersion: rejection.requiredVersion };
}

function registryUrl(packageName: string, versionOrTag: string): string {
  // `@scope/name` stays one path segment.
  return `${NPM_REGISTRY}/${packageName.replace("/", "%2F")}/${encodeURIComponent(versionOrTag)}`;
}

async function fetchRegistryDocument(url: string): Promise<Record<string, unknown>> {
  return fetchVendorJson(url, ["registry.npmjs.org"]);
}

/** npm's `latest` of the platform package: its version, tarball and SRI. */
async function lookupLatestBuild(packageName: string): Promise<{ version: string; tarball: string; integrity: string }> {
  const document = await fetchRegistryDocument(registryUrl(packageName, "latest"));
  const dist = document.dist && typeof document.dist === "object" ? document.dist as Record<string, unknown> : {};
  const version = typeof document.version === "string" ? document.version : "";
  const tarball = typeof dist.tarball === "string" ? dist.tarball : "";
  const integrity = typeof dist.integrity === "string" ? dist.integrity : "";
  if (document.name !== packageName || !version || !tarball || !integrity) {
    throw new Error(`npm's latest ${packageName} is missing its version, tarball or integrity`);
  }
  return { version, tarball, integrity };
}

/** The Claude Code an SDK version carries, or null when npm does not say. */
async function lookupClaudeCodeVersion(sdkVersion: string): Promise<string | null> {
  try {
    const document = await fetchRegistryDocument(registryUrl(SDK_PACKAGE, sdkVersion));
    return typeof document.claudeCodeVersion === "string" ? document.claudeCodeVersion : null;
  } catch {
    // The probe's `--version` is the authority; this only saves a download.
    return null;
  }
}

/** Run a Claude Code with no prompt and no model request; stdout, or the reason it failed. */
function runProbe(executable: string, args: string[]): Promise<{ exitCode: number | null; stdout: string }> {
  return runProbeProcess(executable, args, {
    env: { ...process.env, ...providerSelfUpdateEnv("claude"), NO_COLOR: "1" },
    timeoutMs: 20_000,
  }).then((result) => {
    if (result.timedOut) throw new Error(`\`claude ${args.join(" ")}\` did not finish within 20s`);
    if (result.exitCode === null) throw new Error(result.stderr || `\`claude ${args.join(" ")}\` could not start`);
    return { exitCode: result.exitCode, stdout: result.stdout };
  });
}

async function probeClaudeCodeVersion(executable: string): Promise<string | null> {
  const result = await runProbe(executable, ["--version"]);
  return result.exitCode === 0 ? CLAUDE_VERSION_OUTPUT.exec(result.stdout.trim())?.[1] ?? null : null;
}

/**
 * The probe a new build must pass before ADE runs it: it starts, names its
 * version, and answers `auth status` (signed in or not; exit 1 means signed
 * out) with its JSON. No prompt, no model request.
 */
async function probeNewBuild(executable: string): Promise<{ claudeCodeVersion: string } | { error: string }> {
  try {
    const claudeCodeVersion = await probeClaudeCodeVersion(executable);
    if (!claudeCodeVersion) return { error: "it did not report its version" };
    const auth = await runProbe(executable, ["auth", "status", "--json"]);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(auth.stdout.trim());
    } catch {
      parsed = null;
    }
    const loggedIn = parsed && typeof parsed === "object" ? (parsed as { loggedIn?: unknown }).loggedIn : undefined;
    if ((auth.exitCode !== 0 && auth.exitCode !== 1) || typeof loggedIn !== "boolean") {
      return { error: "it could not read this machine's Claude sign-in" };
    }
    return { claudeCodeVersion };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function attemptFallForward(args: {
  rejection: ClaudeVersionRejection;
  rejected: ClaudeCodeExecutableResolution;
  pin: { package: string; version: string };
  target: ToolVersionOverride["target"];
}): Promise<ClaudeFallForwardOutcome> {
  const { rejection, rejected, pin, target } = args;
  const rejectedClaudeCodeVersion = rejection.rejectedVersion
    ?? rejected.fallForward?.claudeCodeVersion
    ?? (rejected.path ? await probeClaudeCodeVersion(rejected.path).catch(() => null) : null);

  let latest: { version: string; tarball: string; integrity: string };
  try {
    latest = await lookupLatestBuild(pin.package);
  } catch (error) {
    return failed("lookup-failed", rejection, rejectedClaudeCodeVersion, error instanceof Error ? error.message : String(error));
  }
  // Newer than what was refused: the pin, or the build ADE already moved to.
  const floor = rejected.fallForward?.overrideVersion ?? pin.version;
  if (compareUpdateVersions(latest.version, floor) <= 0) {
    return failed("no-newer-build", rejection, rejectedClaudeCodeVersion);
  }
  const expectedClaudeCodeVersion = await lookupClaudeCodeVersion(latest.version);
  if (
    expectedClaudeCodeVersion && rejection.requiredVersion
    && compareUpdateVersions(expectedClaudeCodeVersion, rejection.requiredVersion) < 0
  ) {
    return failed("below-required", rejection, rejectedClaudeCodeVersion, expectedClaudeCodeVersion);
  }

  const draft = {
    tool: TOOL,
    target,
    format: "npm-tarball" as const,
    packageName: pin.package,
    overrideVersion: latest.version,
    tarball: latest.tarball,
    integrity: latest.integrity,
  };
  let entryPath: string;
  let installedDir: string;
  try {
    const installed = await ensureTools([TOOL], { manifest: manifestWithOverride(draft) });
    entryPath = installed.get(TOOL)!.entryPath;
    installedDir = installed.get(TOOL)!.dir;
  } catch (error) {
    return failed("download-failed", rejection, rejectedClaudeCodeVersion, isToolError(error) ? error.kind : String(error));
  }
  // A build that failed its check must never run, not even as the cache's
  // "previous pin" while a new pin downloads: remove it.
  const discard = (outcome: ClaudeFallForwardOutcome): ClaudeFallForwardOutcome => {
    fs.rmSync(installedDir, { recursive: true, force: true });
    return outcome;
  };

  const probed = await probeNewBuild(entryPath);
  if ("error" in probed) return discard(failed("probe-failed", rejection, rejectedClaudeCodeVersion, probed.error));
  const { claudeCodeVersion } = probed;
  if (expectedClaudeCodeVersion && claudeCodeVersion !== expectedClaudeCodeVersion) {
    return discard(failed("probe-failed", rejection, rejectedClaudeCodeVersion, `it reported ${claudeCodeVersion}, not ${expectedClaudeCodeVersion}`));
  }
  if (rejection.requiredVersion && compareUpdateVersions(claudeCodeVersion, rejection.requiredVersion) < 0) {
    return discard(failed("below-required", rejection, rejectedClaudeCodeVersion, claudeCodeVersion));
  }
  if (rejectedClaudeCodeVersion && compareUpdateVersions(claudeCodeVersion, rejectedClaudeCodeVersion) <= 0) {
    return discard(failed("no-newer-build", rejection, rejectedClaudeCodeVersion));
  }

  try {
    await writeToolVersionOverride({
      ...draft,
      pinnedVersion: pin.version,
      reason: rejection.signal,
      requiredVersion: rejection.requiredVersion,
      rejectedToolVersion: rejectedClaudeCodeVersion,
      overrideToolVersion: claudeCodeVersion,
      at: new Date().toISOString(),
      lastUsedAt: Date.now(),
    });
  } catch (error) {
    return failed("write-failed", rejection, rejectedClaudeCodeVersion, error instanceof Error ? error.message : String(error));
  }
  // What every spawn will now resolve; anything else means the record did not take.
  if (resolveClaudeCodeExecutable().fallForward?.overrideVersion !== latest.version) {
    return failed("write-failed", rejection, rejectedClaudeCodeVersion, "the override did not resolve");
  }
  return {
    switched: true,
    pinnedVersion: pin.version,
    overrideVersion: latest.version,
    claudeCodeVersion,
    rejectedClaudeCodeVersion,
    requiredVersion: rejection.requiredVersion,
  };
}

/**
 * React to an exact Claude Code "too old" refusal: move this machine to
 * Anthropic's newest build when it can, at most once per pinned version per
 * process. `rejected` is the executable that was refused, as the caller
 * resolved it. Never rejects; the outcome says what happened.
 */
export function handleClaudeVersionRejection(args: {
  rejection: ClaudeVersionRejection;
  rejected: ClaudeCodeExecutableResolution;
  logger?: FallForwardLogger | null;
}): Promise<ClaudeFallForwardOutcome> {
  const { rejection, rejected } = args;
  if (rejected.source === "env") {
    return Promise.resolve(failed("env-override", rejection, rejection.rejectedVersion));
  }
  let pin: { package: string; version: string };
  let target: ToolVersionOverride["target"];
  try {
    target = detectToolTarget(process.platform, os.arch());
    const targetPin = findToolTargetPin(loadToolsManifest(), TOOL, target);
    if (targetPin.format !== "npm-tarball") throw new Error("not an npm pin");
    pin = { package: targetPin.package, version: targetPin.version };
  } catch {
    return Promise.resolve(failed("no-pin", rejection, rejection.rejectedVersion));
  }
  const key = `${pin.package}@${pin.version}`;
  if (!pinnedToolFetchAllowed(TOOL)) {
    return Promise.resolve(failed("not-allowed", rejection, rejection.rejectedVersion));
  }
  return fallForwardOnce(key, () => attemptFallForward({ rejection, rejected, pin, target })
    .catch((error: unknown) => failed("download-failed", rejection, rejection.rejectedVersion, error instanceof Error ? error.message : String(error))), {
    event: "ai.claude_fall_forward",
    logger: args.logger,
    fields: (outcome) => {
      const fields = {
        tool: TOOL,
        signal: rejection.signal,
        pinnedVersion: pin.version,
        rejectedClaudeCodeVersion: outcome.rejectedClaudeCodeVersion,
        requiredVersion: rejection.requiredVersion,
        vendorMessage: rejection.message,
        ...(outcome.switched
          ? { outcome: "switched", overrideVersion: outcome.overrideVersion, claudeCodeVersion: outcome.claudeCodeVersion }
          : { outcome: "not_switched", reason: outcome.reason, detail: outcome.detail }),
      };
      return fields;
    },
  }).then((outcome) => rejected.fallForward
    && outcome.switched
    && outcome.overrideVersion === rejected.fallForward.overrideVersion
    ? failed("newest-refused", rejection, rejected.fallForward.claudeCodeVersion)
    : outcome);
}

function versionLabel(version: string | null): string {
  return version ? `Claude Code ${version}` : "ADE's Claude Code";
}

const FAILURE_WORDS: Readonly<Record<ClaudeFallForwardFailure, string>> = {
  "not-allowed": "This ADE process does not download Claude Code builds, so it did not switch.",
  "env-override": "This ADE runs a developer-set Claude Code (CLAUDE_CODE_EXECUTABLE_PATH), so it did not switch.",
  "no-pin": "This ADE has no Claude Code for this machine.",
  "newest-refused": "ADE had already switched to Anthropic's newest build, and Anthropic refused that too.",
  "no-newer-build": "Anthropic has published no newer build yet.",
  "below-required": "Anthropic's newest build is still older than that.",
  "lookup-failed": "ADE could not look up Anthropic's newest build.",
  "download-failed": "ADE could not download Anthropic's newest build.",
  "probe-failed": "Anthropic's newest build did not pass ADE's start-up check.",
  "write-failed": "ADE could not record the switch.",
};

/**
 * What ADE says about a refusal. `after` is what happens next once ADE has
 * switched: it starts the chat again itself (a refusal at startup), the user
 * sends the message again (a refusal mid-turn, never resent), or the caller
 * tries again.
 */
export function claudeFallForwardNotice(
  outcome: ClaudeFallForwardOutcome,
  options: { after: "restart" | "resend" | "retry" },
): string {
  if (outcome.switched) {
    const switched = `Anthropic stopped supporting ${versionLabel(outcome.rejectedClaudeCodeVersion)}; ADE switched to the untested ${outcome.claudeCodeVersion}`;
    if (options.after === "restart") return `${switched} and is starting this chat again.`;
    return options.after === "resend" ? `${switched}. Send the message again.` : `${switched}. Try again.`;
  }
  const required = outcome.requiredVersion ? ` (it requires ${outcome.requiredVersion} or newer)` : "";
  return `Anthropic no longer accepts ${versionLabel(outcome.rejectedClaudeCodeVersion)}${required}. `
    + `${FAILURE_WORDS[outcome.reason]} Update ADE to get a newer Claude Code.`;
}

/**
 * The status line while an override runs on this machine:
 * "Running untested Claude Code X: Anthropic stopped supporting Y." Null when
 * ADE runs its pin. No spawn, no network.
 */
export function claudeFallForwardStatusLine(): string | null {
  const active = resolveActiveToolVersionOverride(TOOL);
  if (!active) return null;
  const running = active.override.overrideToolVersion ?? active.override.overrideVersion;
  const refused = active.override.rejectedToolVersion ?? `ADE's pinned build (${active.override.pinnedVersion})`;
  return `Running untested Claude Code ${running}: Anthropic stopped supporting ${refused}.`;
}
