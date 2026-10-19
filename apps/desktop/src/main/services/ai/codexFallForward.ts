/**
 * Codex fall-forward, gated by a model probe.
 *
 * OpenAI refuses old Codex clients per model ("The '<model>' model requires a
 * newer version of Codex…", `providerVersionRejection.ts`). That sentence is
 * also known to appear on clients that are already current (stale caches,
 * openai/codex #31826/#32482), so the words alone never move ADE off its pin.
 * On a match, for that model:
 *
 *   1. re-ask with ADE's pinned build: ONE minimal `codex exec` request with
 *      the same model and the chat's account. If the pin is accepted, the
 *      refusal was not about the version: nothing changes;
 *   2. npm's `latest` `@openai/codex` platform build (same aliased package and
 *      entry as the pin, npm SRI), strictly newer than the refused build,
 *      installed as its own version directory through the tools cache;
 *   3. `--version`, then the same one-request probe on the new build: it must
 *      exit 0, complete the turn and not repeat the refusal. If the newest
 *      build is refused too, the model needs a Codex that does not exist yet:
 *      nothing changes;
 *   4. only then the override record that `resolveCodexExecutable` follows
 *      while the pin it replaces is still the manifest's.
 *
 * The probes use the chat's account (its CODEX_HOME) but keep Codex's
 * databases and logs in a temp dir, so a newer build never migrates the
 * databases the pin reads. They spend a tiny amount of the user's quota; the
 * notice says so. One attempt per (pinned version, model) per process.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isToolError } from "../../../../../ade-cli/src/services/tools/errors";
import { ensureTools } from "../../../../../ade-cli/src/services/tools/install";
import { findToolTargetPin, loadToolsManifest } from "../../../../../ade-cli/src/services/tools/manifest";
import { pinnedToolFetchAllowed } from "../../../../../ade-cli/src/services/tools/onDemand";
import {
  manifestWithOverride,
  writeToolVersionOverride,
  type ToolVersionOverride,
} from "../../../../../ade-cli/src/services/tools/overrides";
import { detectToolTarget } from "../../../../../ade-cli/src/services/tools/paths";
import { CODEX_NO_UPDATE_CHECK_ARGS, providerSelfUpdateEnv } from "../../../shared/pinnedToolSpawnEnv";
import { compareUpdateVersions } from "../../../shared/updateVersions";
import { resolveCodexExecutable, type CodexExecutableResolution } from "./codexExecutable";
import {
  fallForwardOnce,
  fallForwardStatusLine,
  fetchVendorJson,
  runProbeProcess,
  type FallForwardLogger,
} from "./providerFallForward";
import { detectCodexVersionRejectionInExecEvents, type CodexVersionRejection } from "./providerVersionRejection";

const TOOL = "codex";
const NPM_HOSTS = ["registry.npmjs.org"] as const;
const NPM_REGISTRY = "https://registry.npmjs.org";
const VERSION_TIMEOUT_MS = 20_000;
const MODEL_PROBE_TIMEOUT_MS = 90_000;
const MODEL_PROBE_PROMPT = "Reply with OK";
const BASE_VERSION = /^\d+\.\d+\.\d+/;
const CODEX_VERSION_OUTPUT = /^codex-cli (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/m;

export type CodexFallForwardFailure =
  /** Downloads are off in this process (a test, ADE_DISABLE_TOOLS_FETCH, a source checkout). */
  | "not-allowed"
  /** A developer override (CODEX_EXECUTABLE) runs; ADE leaves it alone. */
  | "env-override"
  | "no-pin"
  /** ADE's pinned build was accepted when re-asked: not a version refusal. */
  | "not-reproduced"
  /** Re-asking with the pin failed some other way (sign-in, network, timeout): ADE cannot tell. */
  | "confirm-failed"
  /** npm has nothing newer than the refused build. */
  | "no-newer-build"
  /** OpenAI's newest build is refused for the model too. */
  | "newest-refused"
  | "lookup-failed"
  | "download-failed"
  | "probe-failed"
  | "write-failed";

export type CodexFallForwardOutcome =
  | {
    switched: true;
    model: string;
    pinnedVersion: string;
    overrideVersion: string;
    codexVersion: string;
    rejectedCodexVersion: string | null;
    /** How many one-request probes ran (they use the user's quota). */
    modelProbes: number;
  }
  | {
    switched: false;
    reason: CodexFallForwardFailure;
    detail: string | null;
    model: string;
    rejectedCodexVersion: string | null;
    newestCodexVersion: string | null;
    modelProbes: number;
  };

type Failed = Extract<CodexFallForwardOutcome, { switched: false }>;

function baseVersion(version: string): string {
  return BASE_VERSION.exec(version)?.[0] ?? version;
}

function registryUrl(packageName: string, versionOrTag: string): string {
  return `${NPM_REGISTRY}/${packageName.replace("/", "%2F")}/${encodeURIComponent(versionOrTag)}`;
}

/** The published package an aliased pin's tarball belongs to (`@openai/codex`). */
function publishedPackageName(tarball: string): string | null {
  try {
    return /^\/((?:@[^/]+\/)?[^/@][^/]*)\/-\//.exec(new URL(tarball).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** npm's `latest` Codex for this platform: a plain release, never an alpha tag. */
async function lookupLatestBuild(published: string, platformSuffix: string): Promise<{ version: string; tarball: string; integrity: string }> {
  const latest = await fetchVendorJson(registryUrl(published, "latest"), NPM_HOSTS);
  const latestVersion = typeof latest.version === "string" ? latest.version : "";
  if (latest.name !== published || !/^\d+\.\d+\.\d+$/.test(latestVersion)) {
    throw new Error(`npm's latest ${published} is not a plain release (${latestVersion || "no version"})`);
  }
  const version = `${latestVersion}${platformSuffix}`;
  const document = await fetchVendorJson(registryUrl(published, version), NPM_HOSTS);
  const dist = document.dist && typeof document.dist === "object" ? document.dist as Record<string, unknown> : {};
  const tarball = typeof dist.tarball === "string" ? dist.tarball : "";
  const integrity = typeof dist.integrity === "string" ? dist.integrity : "";
  if (document.name !== published || document.version !== version || !tarball || !integrity.startsWith("sha512-")) {
    throw new Error(`npm's ${published}@${version} is missing its tarball or sha512 integrity`);
  }
  return { version, tarball, integrity };
}

async function probeCodexVersion(executable: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const run = await runProbeProcess(executable, ["--version"], { env, timeoutMs: VERSION_TIMEOUT_MS });
  return run.exitCode === 0 ? CODEX_VERSION_OUTPUT.exec(run.stdout)?.[1] ?? null : null;
}

type ModelProbe = "accepted" | "refused" | { failed: string };

/**
 * ONE minimal request with `model` on `executable`: read-only sandbox, no git
 * check, an empty temp working dir, no user config or rules, Codex's
 * databases and logs in that temp dir, the caller's account env. Accepted
 * means exit 0 and a completed turn without the refusal.
 */
async function probeModel(executable: string, model: string, accountEnv: NodeJS.ProcessEnv): Promise<ModelProbe> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ade-codex-probe-"));
  try {
    const cwd = path.join(scratch, "cwd");
    const state = path.join(scratch, "state");
    const logs = path.join(scratch, "log");
    for (const dir of [cwd, state, logs]) fs.mkdirSync(dir, { recursive: true });
    const run = await runProbeProcess(executable, [
      "exec",
      ...CODEX_NO_UPDATE_CHECK_ARGS,
      "-c", `log_dir=${JSON.stringify(logs)}`,
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--color", "never",
      "--model", model,
      "--cd", cwd,
      MODEL_PROBE_PROMPT,
    ], {
      env: { ...accountEnv, ...providerSelfUpdateEnv("codex"), CODEX_SQLITE_HOME: state, NO_COLOR: "1" },
      cwd,
      timeoutMs: MODEL_PROBE_TIMEOUT_MS,
    });
    if (detectCodexVersionRejectionInExecEvents(run.stdout)) return "refused";
    if (run.timedOut) return { failed: `the request did not finish within ${MODEL_PROBE_TIMEOUT_MS / 1000}s` };
    const completed = /^\s*\{"type":"turn\.completed"/m.test(run.stdout);
    if (run.exitCode === 0 && completed) return "accepted";
    const lastError = [...run.stdout.matchAll(/"message":"([^"]{1,300})"/g)].pop()?.[1] ?? run.stderr.trim().split("\n").pop() ?? "";
    return { failed: `exit ${run.exitCode ?? "none"}${lastError ? `: ${lastError}` : ""}` };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function attemptFallForward(args: {
  rejection: CodexVersionRejection;
  rejected: CodexExecutableResolution;
  pin: { package: string; version: string; tarball: string };
  target: ToolVersionOverride["target"];
  accountEnv: NodeJS.ProcessEnv;
}): Promise<CodexFallForwardOutcome> {
  const { rejection, rejected, pin, target, accountEnv } = args;
  const model = rejection.model;
  let modelProbes = 0;
  let newestCodexVersion: string | null = null;
  const rejectedCodexVersion = rejected.fallForward?.codexVersion
    ?? (rejected.path ? await probeCodexVersion(rejected.path, accountEnv).catch(() => null) : null);
  const failed = (reason: CodexFallForwardFailure, detail: string | null = null): Failed => ({
    switched: false, reason, detail, model, rejectedCodexVersion, newestCodexVersion, modelProbes,
  });

  // 1. The refused build, asked once more: only a repeat refusal goes on.
  if (!rejected.path) return failed("confirm-failed", "ADE has no Codex to re-check");
  modelProbes += 1;
  const confirm = await probeModel(rejected.path, model, accountEnv);
  if (confirm === "accepted") return failed("not-reproduced");
  if (confirm !== "refused") return failed("confirm-failed", confirm.failed);

  // 2. npm's newest platform build of the same aliased package.
  const published = publishedPackageName(pin.tarball);
  const platformSuffix = pin.version.slice(baseVersion(pin.version).length);
  if (!published || !platformSuffix) return failed("no-pin", "the pin is not an aliased @openai/codex platform build");
  let latest: { version: string; tarball: string; integrity: string };
  try {
    latest = await lookupLatestBuild(published, platformSuffix);
  } catch (error) {
    return failed("lookup-failed", error instanceof Error ? error.message : String(error));
  }
  newestCodexVersion = baseVersion(latest.version);
  const floor = baseVersion(rejected.fallForward?.overrideVersion ?? pin.version);
  if (compareUpdateVersions(newestCodexVersion, floor) <= 0) return failed("no-newer-build");

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
    return failed("download-failed", isToolError(error) ? error.kind : String(error));
  }
  // A build that failed its check must never run, not even as the cache's
  // "previous pin" while a new pin downloads: remove it.
  const discard = (outcome: Failed): Failed => {
    fs.rmSync(installedDir, { recursive: true, force: true });
    return outcome;
  };

  // 3. The new build starts, names its version, and is accepted for the model.
  const codexVersion = await probeCodexVersion(entryPath, accountEnv).catch(() => null);
  if (codexVersion !== newestCodexVersion) {
    return discard(failed("probe-failed", codexVersion ? `it reported ${codexVersion}, not ${newestCodexVersion}` : "it did not report its version"));
  }
  modelProbes += 1;
  const probe = await probeModel(entryPath, model, accountEnv);
  if (probe === "refused") return discard(failed("newest-refused"));
  if (probe !== "accepted") return discard(failed("probe-failed", probe.failed));

  // 4. Record it, and check that resolution now runs it.
  try {
    await writeToolVersionOverride({
      ...draft,
      pinnedVersion: pin.version,
      reason: rejection.signal,
      scope: model,
      requiredVersion: null,
      rejectedToolVersion: rejectedCodexVersion,
      overrideToolVersion: codexVersion,
      at: new Date().toISOString(),
      lastUsedAt: Date.now(),
    });
  } catch (error) {
    return failed("write-failed", error instanceof Error ? error.message : String(error));
  }
  if (resolveCodexExecutable({ env: accountEnv }).fallForward?.overrideVersion !== latest.version) {
    return failed("write-failed", "the override did not resolve");
  }
  return {
    switched: true,
    model,
    pinnedVersion: pin.version,
    overrideVersion: latest.version,
    codexVersion,
    rejectedCodexVersion,
    modelProbes,
  };
}

/**
 * React to OpenAI's exact per-model refusal of the Codex that ran
 * (`rejected`, as the caller resolved it): move this machine to OpenAI's
 * newest Codex when the probes prove it helps, at most once per (pinned
 * version, model) per process. `accountEnv` is the chat's (or task's) spawn
 * env, so the probes use the same account. Never rejects.
 */
export function handleCodexVersionRejection(args: {
  rejection: CodexVersionRejection;
  rejected: CodexExecutableResolution;
  accountEnv: NodeJS.ProcessEnv;
  logger?: FallForwardLogger | null;
}): Promise<CodexFallForwardOutcome> {
  const { rejection, rejected } = args;
  const model = rejection.model;
  const early = (reason: CodexFallForwardFailure): Promise<CodexFallForwardOutcome> => Promise.resolve({
    switched: false, reason, detail: null, model, rejectedCodexVersion: rejected.fallForward?.codexVersion ?? null,
    newestCodexVersion: null, modelProbes: 0,
  });
  if (rejected.source === "path") return early("env-override");
  let pin: { package: string; version: string; tarball: string };
  let target: ToolVersionOverride["target"];
  try {
    target = detectToolTarget(process.platform, os.arch());
    const targetPin = findToolTargetPin(loadToolsManifest(), TOOL, target);
    if (targetPin.format !== "npm-tarball") throw new Error("not an npm pin");
    pin = { package: targetPin.package, version: targetPin.version, tarball: targetPin.tarball };
  } catch {
    return early("no-pin");
  }
  // The build ADE already moved to was refused for this model: never loop.
  if (rejected.fallForward) {
    return Promise.resolve({
      switched: false, reason: "newest-refused", detail: null, model,
      rejectedCodexVersion: rejected.fallForward.codexVersion, newestCodexVersion: rejected.fallForward.codexVersion, modelProbes: 0,
    });
  }
  if (!pinnedToolFetchAllowed(TOOL)) return early("not-allowed");
  return fallForwardOnce(
    `${pin.package}@${pin.version}|${model.toLowerCase()}`,
    () => attemptFallForward({ rejection, rejected, pin, target, accountEnv: args.accountEnv })
      .catch((error: unknown): CodexFallForwardOutcome => ({
        switched: false, reason: "download-failed", detail: error instanceof Error ? error.message : String(error), model,
        rejectedCodexVersion: null, newestCodexVersion: null, modelProbes: 0,
      })),
    {
      event: "ai.codex_fall_forward",
      logger: args.logger,
      fields: (outcome) => ({
        tool: TOOL,
        signal: rejection.signal,
        model,
        pinnedVersion: pin.version,
        vendorMessage: rejection.message,
        modelProbes: outcome.modelProbes,
        ...(outcome.switched
          ? { outcome: "switched", overrideVersion: outcome.overrideVersion, codexVersion: outcome.codexVersion }
          : { outcome: "not_switched", reason: outcome.reason, detail: outcome.detail, newestCodexVersion: outcome.newestCodexVersion }),
      }),
    },
  );
}

function codexLabel(version: string | null): string {
  return version ? `Codex ${version}` : "ADE's Codex";
}

const QUOTA_NOTE = "ADE checked with one short request per build, which uses a tiny amount of your Codex quota.";

/**
 * What ADE says about the refusal. `after`: the chat starts again by itself
 * (a refusal before the turn ran), the user sends again (mid-turn; ADE never
 * resends), or a caller retries.
 */
export function codexFallForwardNotice(
  outcome: CodexFallForwardOutcome,
  options: { after: "restart" | "resend" | "retry" },
): string {
  const quota = outcome.modelProbes > 0 ? ` ${QUOTA_NOTE}` : "";
  if (outcome.switched) {
    const switched = `OpenAI stopped supporting ${codexLabel(outcome.rejectedCodexVersion)} for ${outcome.model}; `
      + `ADE switched to the untested Codex ${outcome.codexVersion}`;
    const next = options.after === "restart"
      ? " and is starting this chat again."
      : options.after === "resend" ? ". Send the message again." : ". Try again.";
    return `${switched}${next}${quota}`;
  }
  const refused = `OpenAI says ${outcome.model} needs a newer Codex than ${codexLabel(outcome.rejectedCodexVersion)}.`;
  switch (outcome.reason) {
    case "not-reproduced":
      return `${refused} ADE asked again and ${codexLabel(outcome.rejectedCodexVersion)} was accepted, so it kept its tested Codex. Try again.${quota}`;
    case "newest-refused":
      return `${refused} OpenAI refuses ${outcome.newestCodexVersion ? `its newest Codex (${outcome.newestCodexVersion})` : "its newest Codex"} for this model too, `
        + `so the model needs a Codex release that does not exist yet. Pick another model for now.${quota}`;
    case "no-newer-build":
      return `${refused} OpenAI has published no newer Codex yet, so ADE kept its tested one. Pick another model or update ADE later.${quota}`;
    default: {
      const words: Record<Exclude<CodexFallForwardFailure, "not-reproduced" | "newest-refused" | "no-newer-build">, string> = {
        "not-allowed": "This ADE process does not download Codex builds, so it did not switch.",
        "env-override": "This ADE runs a developer-set Codex (CODEX_EXECUTABLE), so it did not switch.",
        "no-pin": "This ADE has no Codex for this machine.",
        "confirm-failed": "ADE could not re-check the refusal, so it did not switch.",
        "lookup-failed": "ADE could not look up OpenAI's newest Codex.",
        "download-failed": "ADE could not download OpenAI's newest Codex.",
        "probe-failed": "OpenAI's newest Codex did not pass ADE's check.",
        "write-failed": "ADE could not record the switch.",
      };
      return `${refused} ${words[outcome.reason]} Update ADE to get a newer Codex.${quota}`;
    }
  }
}

/** "Running untested Codex X: OpenAI stopped supporting Y for <model>." or null. */
export function codexFallForwardStatusLine(): string | null {
  return fallForwardStatusLine(TOOL, "Codex", "OpenAI");
}
