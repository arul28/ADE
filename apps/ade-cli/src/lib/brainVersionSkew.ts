/**
 * What an `ade` does when the machine brain it reached is a different build.
 *
 * Two installs can serve one machine: ADE.app's CLI and the standalone brain
 * `ade brain update` installs at `~/.ade/bin/ade`. They update separately, so
 * the `ade` on PATH is often older or newer than the running brain, and that
 * window is normal. Before this, an `ade` treated any other build as its own
 * stale brain: it shut it down and reinstalled the service (from a normal
 * terminal), or, refused that inside an agent shell, fell back to an
 * in-process runtime whose chat service is a stub and reported `ade new chat`
 * as a success for a chat that never existed (ledger #48, #49).
 *
 * The rule (the desktop's `isCompatibleNewerRuntime` applies the same idea):
 * - The brain runs this very CLI (same entry file): a stale build of itself,
 *   which the CLI may repair or replace, as before.
 * - Any other brain that speaks a compatible runtime protocol (newer, older,
 *   same release from another install): used as it is, never stopped,
 *   replaced or uninstalled. When the versions differ, one stderr note says
 *   which brain is in use and how to line them up.
 * - Protocol-incompatible: refused with one error naming both versions and the
 *   `ade` that matches the brain.
 * - An older brain that does not report what it runs (built before
 *   `cliEntryPath`) counts as this CLI's own only when its process command
 *   line names this CLI's entry; otherwise it is used if compatible.
 */
import fs from "node:fs";
import path from "node:path";
import { compareUpdateVersions } from "../../../desktop/src/shared/updateVersions";
import { isRuntimeProtocolCompatible } from "../../../desktop/src/shared/adeRuntimeProtocol";

export type BrainSkewDecision =
  /** This CLI's own stale build: repair as before. `compatible` says whether it may be used instead. */
  | { kind: "ours"; compatible: boolean }
  /** Another build that speaks this protocol: use it; `note` is set when the versions differ. */
  | { kind: "use"; note: string | null }
  | { kind: "refuse"; message: string };

export type BrainSkewInput = {
  cliVersion: string;
  /** The version a source build reports ("0.0.0"); ordering is unknown for it. */
  placeholderVersion: string;
  /** This CLI's identity: the SEA executable, or the cli.cjs it runs. */
  cliEntry: string | null;
  /** The file this CLI's `serve` command would run, when different. */
  cliServeFile: string | null;
  brain: {
    version: string | null;
    /** What the brain runs, from `runtimeInfo.cliEntryPath`; null for older brains. */
    cliEntryPath: string | null;
    pid: number | null;
    minCompatibleProtocol: number | null;
    protocolVersion: number | null;
    /**
     * The brain process's command line (`ps`), read only for a brain that does
     * not report `cliEntryPath`; null when it could not be read.
     */
    commandLine?: string | null;
  };
  socketPath: string;
  /** The machine ADE home, for the standalone `bin/ade` suggestion. */
  adeHome: string;
  platform?: NodeJS.Platform;
  exists?: (candidate: string) => boolean;
  realpath?: (candidate: string) => string;
};

function defaultRealpath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function defaultExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isRealVersion(version: string | null, placeholder: string): version is string {
  return Boolean(version) && version !== placeholder && /^v?\d+\.\d+\.\d+/.test(version ?? "");
}

/**
 * The command a person should run to reach this brain: its own `ade` when it
 * says what it runs (a SEA `ade`, or the `bin/ade` beside a packaged cli.cjs),
 * else the standalone install in the ADE home when there is one.
 */
export function matchingBrainCliHint(input: Pick<BrainSkewInput, "brain" | "adeHome" | "platform" | "exists">): string | null {
  const platform = input.platform ?? process.platform;
  const exists = input.exists ?? defaultExists;
  const api = platform === "win32" ? path.win32 : path.posix;
  const entry = input.brain.cliEntryPath?.trim() || null;
  if (entry) {
    if (!/\.(?:cjs|mjs|js|ts)$/i.test(entry)) return entry;
    const wrapper = api.join(api.dirname(entry), "bin", platform === "win32" ? "ade.cmd" : "ade");
    return exists(wrapper) ? wrapper : null;
  }
  const standalone = api.join(input.adeHome, "bin", platform === "win32" ? "ade.exe" : "ade");
  return exists(standalone) ? standalone : null;
}

export function decideBrainSkew(input: BrainSkewInput): BrainSkewDecision {
  const platform = input.platform ?? process.platform;
  const realpath = input.realpath ?? defaultRealpath;
  const fold = (value: string) => (platform === "win32" || platform === "darwin" ? value.toLowerCase() : value);
  const same = (left: string | null, right: string | null): boolean =>
    Boolean(left && right) && fold(realpath(left as string)) === fold(realpath(right as string));
  const ownFiles = [input.cliEntry, input.cliServeFile].filter((file): file is string => Boolean(file));
  const brainEntry = input.brain.cliEntryPath?.trim() || null;
  const commandLine = input.brain.commandLine?.trim() || null;
  const owned = brainEntry
    ? ownFiles.some((file) => same(brainEntry, file))
    : commandLine
      ? ownFiles.some((file) => fold(commandLine).includes(fold(file)) || fold(commandLine).includes(fold(realpath(file))))
      : false;
  const compatible = isRuntimeProtocolCompatible({
    minCompatibleProtocol: input.brain.minCompatibleProtocol,
    protocolVersion: input.brain.protocolVersion,
  });
  if (owned) return { kind: "ours", compatible };
  if (!compatible) return { kind: "refuse", message: incompatibleMessage(input) };
  return { kind: "use", note: versionNote(input) };
}

function label(version: string | null, placeholder: string): string {
  if (!version) return "an unknown version";
  return version === placeholder ? "a source build" : `v${version.replace(/^v/i, "")}`;
}

/** One line for stderr when this `ade` and the brain it uses are different versions. */
function versionNote(input: BrainSkewInput): string | null {
  const brainVersion = input.brain.version;
  if (!brainVersion || brainVersion === input.cliVersion) return null;
  const known = isRealVersion(brainVersion, input.placeholderVersion) && isRealVersion(input.cliVersion, input.placeholderVersion);
  const order = known ? compareUpdateVersions(brainVersion, input.cliVersion) : 0;
  const where = input.brain.cliEntryPath ? ` (${input.brain.cliEntryPath})` : "";
  const fix = order > 0
    ? "; update ADE.app to match"
    : order < 0
      ? "; run `ade brain update` (or restart ADE.app) to update the brain"
      : "";
  return `ade ${label(input.cliVersion, input.placeholderVersion)} is using the ADE brain ${label(brainVersion, input.placeholderVersion)}${where}${fix}.`;
}

function incompatibleMessage(input: BrainSkewInput): string {
  const brainVersion = label(input.brain.version, input.placeholderVersion);
  const brainWhat = [
    input.brain.pid ? `pid ${input.brain.pid}` : null,
    input.brain.cliEntryPath ? `running ${input.brain.cliEntryPath}` : null,
    `protocol ${input.brain.minCompatibleProtocol ?? "?"}-${input.brain.protocolVersion ?? "?"}`,
  ].filter(Boolean).join(", ");
  const hint = matchingBrainCliHint(input);
  return `This ade is ${label(input.cliVersion, input.placeholderVersion)}${input.cliEntry ? ` (${input.cliEntry})` : ""}, `
    + `and the ADE brain on ${input.socketPath} is ${brainVersion} (${brainWhat}), which speaks a runtime protocol this ade does not. `
    + "This ade did not start that brain, so it leaves it running. "
    + `Use the ade that matches the brain${hint ? `: ${hint}` : ""}, or update ADE.app and the brain (\`ade brain update\`) to the same release.`;
}
