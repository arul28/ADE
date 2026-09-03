import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdeError } from "./errors.js";
import type {
  AgentChatHostConfigLevel,
  AgentChatInstructions,
  AgentChatSettingSources,
} from "./types.js";

/**
 * Normalization and honesty reports for the three per-thread host-configuration
 * options: `instructions`, `cwd`, and `settingSources`.
 *
 * All three are the same shape of problem as MCP strict mode — the caller asks
 * for one thing and six providers do six different things with it — so all
 * three report back the same way, through a capability object that is null when
 * nothing was asked for.
 */

/** Host instructions for a thread. A bare string means `{ mode: "append" }`. */
export type ThreadInstructions =
  | string
  | { mode: "append" | "replace"; text: string };

const SETTING_SOURCES: readonly AgentChatSettingSources[] = ["none", "project", "user", "all"];

/**
 * The wire form of `instructions`.
 *
 * A bare string is shorthand for append, because appending keeps ADE's own
 * personal-chat framing and is the safe default; replacing it is the choice a
 * host makes deliberately when the chat is branded as its own assistant.
 */
export function normalizeInstructions(
  value: ThreadInstructions | undefined,
): AgentChatInstructions | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (!value.trim()) {
      throw new AdeError("invalid_option", "instructions text must not be empty.");
    }
    return { mode: "append", text: value };
  }
  if (typeof value !== "object" || value === null) {
    throw new AdeError(
      "invalid_option",
      "instructions must be a string or { mode: \"append\" | \"replace\", text }.",
    );
  }
  if (value.mode !== "append" && value.mode !== "replace") {
    throw new AdeError(
      "invalid_option",
      `instructions.mode must be "append" or "replace"; got ${JSON.stringify(value.mode)}.`,
    );
  }
  if (typeof value.text !== "string" || !value.text.trim()) {
    throw new AdeError("invalid_option", "instructions.text must be a non-empty string.");
  }
  return { mode: value.mode, text: value.text };
}

export function normalizeSettingSources(
  value: string | undefined,
): AgentChatSettingSources | undefined {
  if (value === undefined) return undefined;
  if (!(SETTING_SOURCES as readonly string[]).includes(value)) {
    throw new AdeError(
      "invalid_option",
      `settingSources must be one of ${SETTING_SOURCES.join(", ")}; got ${JSON.stringify(value)}.`,
    );
  }
  return value as AgentChatSettingSources;
}

/**
 * Case folding on `win32` AND `darwin`, Linux left case-sensitive.
 *
 * A deliberate mirror of ADE's own rule — `main/services/shared/pathCompare.ts`
 * and `renderer/lib/pathUtils.ts`, both of which fold on the same two
 * platforms. This package ships standalone to npm and cannot import from the
 * app, which is the same constraint `windowsSystemTools.ts` documents; update
 * this when that rule changes.
 *
 * macOS matters as much as Windows here: the default volume is
 * case-insensitive, so without folding `/USERS/alice` is not the user's home
 * directory as far as `samePath` is concerned, and the home-directory refusal
 * below is bypassed by nothing more than a capital letter.
 */
const FOLD_PATH_CASE = process.platform === "win32" || process.platform === "darwin";

/**
 * Drop Windows' extended-length (`\\?\`) prefix. Byte-identical to
 * `stripExtendedLengthPrefix` in `apps/desktop/src/shared/pathContainment.ts`;
 * this package ships standalone and cannot import the app.
 *
 * Node treats `\\?\C:\` as a UNC root, so a lexical home or ADE-home check
 * against `C:\Users\...` misses and the refusal never fires. Non-win32 callers
 * must not use this: `\\?\` is a legal POSIX filename.
 */
function stripWin32ExtendedLengthPrefix(input: string): string {
  if (input.startsWith("\\\\?\\UNC\\")) return `\\\\${input.slice(8)}`;
  if (input.startsWith("\\\\?\\")) return input.slice(4);
  return input;
}

function pathKey(value: string): string {
  const stripped = process.platform === "win32" ? stripWin32ExtendedLengthPrefix(value) : value;
  return FOLD_PATH_CASE ? stripped.toLowerCase() : stripped;
}

function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

function isInside(parent: string, child: string): boolean {
  // Compared through the folded key, because `path.relative` is case-sensitive
  // on darwin and would let `.../ADE/scratch` escape a `.../ade` parent.
  const relative = path.relative(pathKey(parent), pathKey(child));
  if (!relative) return true;
  if (relative.startsWith("..")) return false;
  return !path.isAbsolute(relative);
}

/**
 * A filesystem root: "/", a Windows drive root, or a bare UNC share root.
 *
 * The UNC branch is why this is not a plain `parse().root` comparison.
 * `path.win32.parse("\\\\srv\\share")` reports its root as "\\", so the ordinary
 * comparison would let a whole file server through as an ordinary folder and a
 * `cwd` of `\\\\srv\\share` would put the agent at the top of a server.
 *
 * A deliberate mirror of `isFilesystemRoot` in the engine's
 * `apps/ade-cli/src/services/personalChats/personalChatScope.ts`, which this
 * package cannot import; keep the two in step.
 *
 * `impl` is injectable so the Windows rule can be asserted from any host.
 */
export function isFilesystemRoot(resolved: string, impl: path.PlatformPath = path): boolean {
  const trimTrailing = (value: string): string =>
    value.length > 1 ? value.replace(/[\\/]+$/, "") || value : value;
  const value = impl === path.win32 ? stripWin32ExtendedLengthPrefix(resolved) : resolved;
  const trimmed = trimTrailing(value);
  if (impl === path.win32 && /^[\\/]{2}[^\\/]/.test(trimmed)) {
    const segments = trimmed.slice(2).split(/[\\/]+/).filter((part) => part.length > 0);
    return segments.length <= 2;
  }
  const root = impl.parse(value).root;
  if (!root.length) return false;
  return samePath(trimmed, trimTrailing(root));
}

/**
 * Validates `cwd` before it reaches the engine.
 *
 * The refusals are not paranoia about typos. A `cwd` the caller did not mean —
 * `/`, a UNC share root, the user's home, the SDK's own state root — combined
 * with a wide permission grant is an agent loose in the wrong tree, and a
 * relative path would resolve against the RUNTIME's working directory, which
 * the caller cannot see and did not choose. Every refusal names the rule it
 * broke.
 *
 * This check is LEXICAL and advisory. The engine repeats every one of these
 * refusals canonically in `validatePersonalHostCwd`
 * (`apps/ade-cli/src/services/personalChats/personalChatScope.ts`), which is
 * the authoritative copy: it resolves the path first, so it also refuses a
 * symlink whose name looks harmless while the link points at `~/.ade` or at
 * `/`. Do not add a symlink test here and believe it is enforced — this
 * package ships standalone to npm, has no engine filesystem to consult, and
 * only tells the caller early what the engine would say. Keep the two in step
 * when either changes.
 */
/**
 * The one spelling of a path, with every symlink in it resolved.
 *
 * The engine canonicalizes `requestedCwd` before it stores it, and the SDK
 * records what the engine stored. So a caller who passes the SAME string twice
 * — created with it, then reopened with it — has their second one compared
 * against a different spelling of the same directory and is told their `cwd`
 * was ignored when it was not. On macOS every path under the system temp
 * directory has two spellings, so this is the common case, not an edge one.
 *
 * The leaf usually does not exist yet: the engine creates it. So this resolves
 * the deepest ancestor that DOES exist and re-appends the rest, which is the
 * same answer realpath would give once the directory is there. A path with no
 * existing ancestor at all comes back untouched rather than throwing —
 * refusing a `cwd` for not existing is the engine's decision, not this
 * function's.
 */
function canonicalizePath(resolved: string): string {
  const strip = (value: string): string =>
    process.platform === "win32" ? stripWin32ExtendedLengthPrefix(value) : value;
  const trailing: string[] = [];
  let candidate = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync.native(candidate);
      const joined = trailing.length ? path.join(real, ...trailing.reverse()) : real;
      return strip(joined);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return strip(resolved);
      trailing.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * The canonical spelling of a caller-supplied `cwd`, with no refusals applied.
 *
 * For the resume comparison, which asks "is this the same directory the thread
 * already has?" rather than "may this directory be used?". Resolving without
 * canonicalizing compares the caller's spelling against the engine's, and on
 * macOS those differ for every path under the temp root — so a caller who
 * passed the SAME string twice was told their `cwd` had been ignored.
 *
 * Deliberately does not throw: a resume that supplies an unusable `cwd` should
 * report it as ignored, which is what it is, rather than fail an open of a
 * thread whose directory was settled when it was created.
 */
export function canonicalThreadCwd(value: string): string {
  return canonicalizePath(path.resolve(value));
}

export function validateThreadCwd(value: string, sdkHome: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AdeError("invalid_option", "cwd must be a non-empty absolute path.");
  }
  const raw = value.trim();
  // `~`, `~/` and `~\` only, which is exactly what the engine refuses. A bare
  // `startsWith("~")` also refused a directory literally NAMED `~backup`, which
  // the engine accepts — so the client rejected a path the runtime would have
  // run in, and the two copies disagreed on a real filesystem.
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
    throw new AdeError(
      "invalid_option",
      `cwd must be an absolute path, and "~" is not expanded: pass the real path instead of "${raw}".`,
    );
  }
  if (!path.isAbsolute(raw)) {
    throw new AdeError(
      "invalid_option",
      `cwd must be an absolute path; "${raw}" is relative and would resolve against the runtime's own working directory, not yours.`,
    );
  }
  // Canonicalized BEFORE the refusals below, not after, and that ordering is
  // load-bearing: the containment checks compare paths as strings, so a
  // symlinked spelling of the SDK home would otherwise walk straight past the
  // check that exists to keep an agent out of it.
  const resolved = canonicalizePath(path.resolve(raw));
  if (isFilesystemRoot(resolved)) {
    throw new AdeError(
      "invalid_option",
      `cwd must not be a filesystem root; "${resolved}" would put the agent's working directory at the top of the disk.`,
    );
  }
  const home = canonicalizePath(path.resolve(os.homedir()));
  if (samePath(resolved, home)) {
    throw new AdeError(
      "invalid_option",
      `cwd must not be the user's home directory itself ("${resolved}"). Point it at a directory your app owns.`,
    );
  }
  const stateRoot = canonicalizePath(path.resolve(sdkHome));
  if (isInside(stateRoot, resolved)) {
    throw new AdeError(
      "invalid_option",
      `cwd must not be inside the SDK home ("${stateRoot}"): that directory holds the runtime's own state, and an agent editing it corrupts the client that started it.`,
    );
  }
  return resolved;
}

/**
 * What the provider did with a host-configuration request.
 *
 * Null means one of two things, exactly as `mcpCapability` does: this thread
 * asked for nothing, or it asked and an older runtime reported nothing. The
 * SDK does not invent a level for the second case — an unverified guarantee is
 * reported as unverified.
 */
export type HostConfigCapability = {
  /**
   * Always true on a non-null report: a report exists only for a request that
   * was made. Retained because the field is part of the published shape and
   * because a null report is ambiguous, so code that has a report in hand can
   * still say plainly which of the two cases it is not in.
   */
  requested: boolean;
  level: AgentChatHostConfigLevel;
  /** How the provider implemented it, for logs and support threads. */
  mechanism: string;
  /** Why the level is not `"applied"`, or null when it is. */
  detail: string | null;
} & Record<string, unknown>;

export type InstructionsCapability = HostConfigCapability & {
  mode: "append" | "replace";
};

export type SettingSourcesCapability = HostConfigCapability & {
  value: AgentChatSettingSources;
};

/**
 * What the provider could actually enforce of a permission policy.
 *
 * `"enforced"` means the provider itself gates every tool call against the
 * policy. `"best-effort"` means ADE approximated it with the containment and
 * approval knobs the provider does expose, and `residual` names what the policy
 * therefore does not cover. `"unsupported"` means the provider has no gate at
 * all and only the coarse preset applies.
 */
export type PermissionCapability = {
  level: "enforced" | "best-effort" | "unsupported";
  mechanism: string;
  residual: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readLevel(value: unknown): AgentChatHostConfigLevel | null {
  return value === "applied" || value === "best-effort" || value === "ignored" ? value : null;
}

function readText(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function readDetail(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function normalizeInstructionsCapability(
  value: unknown,
  requested: boolean,
): InstructionsCapability | null {
  if (!requested) return null;
  const record = asRecord(value);
  const level = readLevel(record?.level);
  if (!record || !level) return null;
  const mode = record.mode === "replace" ? "replace" : "append";
  return {
    requested: true,
    level,
    mode,
    mechanism: readText(record.mechanism, ""),
    detail: readDetail(record.detail),
  };
}

export function normalizeSettingSourcesCapability(
  value: unknown,
  requested: boolean,
): SettingSourcesCapability | null {
  if (!requested) return null;
  const record = asRecord(value);
  const level = readLevel(record?.level);
  if (!record || !level) return null;
  const reported = record.value;
  const resolved = (SETTING_SOURCES as readonly unknown[]).includes(reported)
    ? (reported as AgentChatSettingSources)
    : "none";
  return {
    requested: true,
    level,
    value: resolved,
    mechanism: readText(record.mechanism, ""),
    detail: readDetail(record.detail),
  };
}

export function normalizePermissionCapability(
  value: unknown,
  requested: boolean,
): PermissionCapability | null {
  if (!requested) return null;
  const record = asRecord(value);
  const level = record?.level;
  if (!record || (level !== "enforced" && level !== "best-effort" && level !== "unsupported")) {
    return null;
  }
  return {
    level,
    mechanism: readText(record.mechanism, ""),
    residual: readDetail(record.residual),
  };
}
