import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAdeHomeForOwnership } from "./chatRuntimeOwnership";
import {
  pathIsWithinRoot,
  samePathOnPlatform,
  stripExtendedLengthPrefix,
  trimTrailingSeparators,
} from "../../../shared/pathContainment";
import { MAX_PERSONAL_CHAT_ATTACHMENT_ROOTS } from "../../../shared/types/personalChats";

/**
 * The directories a host may hand a personal (SDK) chat: its working
 * directory (`requestedCwd`) and the extra roots its attachments may point
 * into (`attachmentRoots`). One rule for both, applied on the canonical path.
 * `personalChatScope` validates `requestedCwd` with it; the chat service
 * validates `attachmentRoots` with it, so every route to the service gets it.
 */

/**
 * The two directories the rule refuses around: ADE's own home (`ADE_HOME`, else
 * `~/.ade`) and the user's home. The one source for both callers.
 */
export function personalHostPathContext(): { adeDir: string; homeDir: string } {
  return { adeDir: resolveAdeHomeForOwnership(), homeDir: os.homedir() };
}

/**
 * A filesystem root: "/", a Windows drive root, or a bare UNC share root.
 *
 * Deliberately NOT in `shared/pathContainment.ts` with the containment rule:
 * the UNC branch is specific to this guard. `path.win32.parse("\\\\srv\\share")`
 * reports its root as "\\", so the ordinary root comparison below would let a
 * whole file server through as if it were an ordinary folder.
 *
 * Mirrored by `isFilesystemRoot` in `packages/sdk/src/hostConfig.ts`, which
 * runs the same rule client-side.
 */
function isFilesystemRoot(resolved: string, impl: path.PlatformPath): boolean {
  const value = impl === path.win32 ? stripExtendedLengthPrefix(resolved, "win32") : resolved;
  const trimmed = trimTrailingSeparators(value, impl);
  if (impl === path.win32 && /^[\\/]{2}[^\\/]/.test(trimmed)) {
    const segments = trimmed.slice(2).split(/[\\/]+/).filter((part) => part.length > 0);
    return segments.length <= 2;
  }
  const root = impl.parse(value).root;
  if (!root.length) return false;
  return trimmed === trimTrailingSeparators(root, impl);
}

/**
 * The filesystem seam `validatePersonalHostCwd` needs, so it stays injectable.
 *
 * One call, and it may throw: `fs.realpathSync.native` on a path that does not
 * exist. The walk below is what turns that into an answer.
 */
export type PersonalHostCwdFs = { realpathSync: (target: string) => string };

/**
 * The real on-disk path of the deepest existing ancestor, with the missing tail
 * re-joined.
 *
 * `canonicalWindowsPath()` in `services/projects/machineLayout.ts` does exactly
 * this for Windows; the guards below need it on EVERY platform, because a
 * symlink defeats a lexical check the same way on macOS and Linux. The
 * directory may not exist yet — the create path mkdirs it after this returns —
 * so a plain `realpathSync` would throw on the ordinary case.
 *
 * A path that cannot be resolved at all comes back as the caller's own
 * normalization, which is what the checks used to receive unconditionally.
 */
function canonicalDeepestExisting(
  value: string,
  impl: path.PlatformPath,
  fsImpl: PersonalHostCwdFs,
): string {
  const original = impl.normalize(value);
  const missingParts: string[] = [];
  let cursor = original;
  for (;;) {
    try {
      return impl.join(fsImpl.realpathSync(cursor), ...missingParts);
    } catch {
      const parent = impl.dirname(cursor);
      if (parent === cursor) return original;
      missingParts.unshift(impl.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * The working directory a host asked a personal chat to run in.
 *
 * A personal chat's agent runs in a 0700 scratch directory under ADE_HOME by
 * default, which is the wrong place for a host whose value is acting on the
 * user's own files: anything the agent writes there is, to that user, gone. So
 * the host may name a directory — but only a directory it plausibly meant.
 *
 * Refused, and why each one:
 *  - a relative path, which would otherwise resolve against whatever the
 *    runtime process happens to be sitting in;
 *  - "~", because expanding it here and not expanding it in the SDK is exactly
 *    the kind of split that makes two careful readers disagree;
 *  - a filesystem, drive, or UNC share root, because a host that passes "/" by
 *    accident and an always-allow permission preset is a very bad afternoon;
 *  - the home directory itself, for the same reason one step smaller;
 *  - anything inside ADE's own state directory, because the agent would be
 *    editing the database, transcripts, and credentials of the runtime hosting
 *    it.
 *
 * Every one of those tests runs on the CANONICAL path, not on a lexical
 * normalization. A lexical check reads `~/work/shortcut` as a folder under
 * `~/work` and admits it, while the symlink behind that name points at `~/.ade`
 * or at `/` — which is precisely the thing the last two rules exist to refuse.
 * `adeDir` and `homeDir` are canonicalized the same way, or a symlinked ADE
 * home would fail to match a canonical candidate that is genuinely inside it.
 *
 * The message is prefixed `invalid_argument:` so the SDK can map it to a stable
 * error code rather than matching on prose.
 *
 * This function is the AUTHORITATIVE copy of the rule. `validateThreadCwd` in
 * `packages/sdk/src/hostConfig.ts` refuses the same five things lexically, on
 * the client, so a caller hears about a bad `cwd` before a round trip; that
 * copy cannot canonicalize because the SDK ships standalone to npm and has no
 * engine filesystem to consult. When a refusal changes here, change it there
 * too.
 */
export function validatePersonalHostCwd(
  value: unknown,
  context: {
    adeDir: string;
    homeDir: string;
    platform?: NodeJS.Platform;
    /** Injected so a test can stage a symlink without touching a real disk. */
    fs?: PersonalHostCwdFs;
    /** The argument name the refusals quote. Defaults to `requestedCwd`. */
    field?: string;
  },
): string | undefined {
  const field = context.field ?? "requestedCwd";
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`invalid_argument: ${field} must be a string.`);
  }
  const raw = value.trim();
  if (!raw.length) return undefined;
  const platform = context.platform ?? process.platform;
  const impl = platform === "win32" ? path.win32 : path.posix;
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
    throw new Error(
      `invalid_argument: ${field} must not start with '~'. Expand the home directory yourself `
      + "and pass an absolute path.",
    );
  }
  if (!impl.isAbsolute(raw)) {
    throw new Error(`invalid_argument: ${field} must be an absolute path. Received '${raw}'.`);
  }
  const fsImpl = context.fs ?? { realpathSync: (target: string) => fs.realpathSync.native(target) };
  // Strip `\\?\` after canonicalize and before every refusal. realpath on
  // Windows can keep the prefix while `os.homedir()` / ADE home do not, and
  // `\\?\C:\` looks like a UNC root to Node — a missed home or ADE-state
  // refusal, or a missed UNC share-root refusal. The returned path is the
  // unprefixed spelling so later containment sees one form.
  const resolved = stripExtendedLengthPrefix(canonicalDeepestExisting(raw, impl, fsImpl), platform);
  const homeDir = stripExtendedLengthPrefix(canonicalDeepestExisting(context.homeDir, impl, fsImpl), platform);
  const adeDir = stripExtendedLengthPrefix(canonicalDeepestExisting(context.adeDir, impl, fsImpl), platform);
  if (isFilesystemRoot(resolved, impl)) {
    throw new Error(
      `invalid_argument: ${field} must not be a filesystem root. Received '${raw}'.`,
    );
  }
  // `samePathOnPlatform`, not `===`: the case fold and the trailing-separator trim both
  // decide this answer, and the platform is passed rather than the path flavor
  // so macOS folds. A guard that refuses must fold — a missed fold skips the
  // refusal while the OS opens the very same folder.
  if (samePathOnPlatform(resolved, homeDir, platform)) {
    throw new Error(
      `invalid_argument: ${field} must not be the home directory itself. Name a folder inside it.`,
    );
  }
  if (pathIsWithinRoot(adeDir, resolved, platform)) {
    throw new Error(
      `invalid_argument: ${field} must not be inside ADE's own state directory.`,
    );
  }
  return trimTrailingSeparators(resolved, impl);
}

/**
 * The extra directories a host lets absolute attachment paths point into.
 *
 * Each entry passes the same rule as `requestedCwd` (see
 * `validatePersonalHostCwd`), and the refusal names its index:
 * `attachmentRoots[2] must be an absolute path. …`. One bad entry refuses the
 * whole call. `undefined` means "not given"; `null` and `[]` both clear.
 * Duplicates after canonicalization are dropped.
 */
export function validatePersonalAttachmentRoots(
  value: unknown,
  context: Omit<Parameters<typeof validatePersonalHostCwd>[1], "field">,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("invalid_argument: attachmentRoots must be an array of absolute paths.");
  }
  if (value.length > MAX_PERSONAL_CHAT_ATTACHMENT_ROOTS) {
    throw new Error(
      `invalid_argument: attachmentRoots accepts at most ${MAX_PERSONAL_CHAT_ATTACHMENT_ROOTS} entries. Received ${value.length}.`,
    );
  }
  const roots: string[] = [];
  value.forEach((entry, index) => {
    const field = `attachmentRoots[${index}]`;
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`invalid_argument: ${field} must be a non-empty string.`);
    }
    const root = validatePersonalHostCwd(entry, { ...context, field });
    if (root && !roots.includes(root)) roots.push(root);
  });
  return roots;
}
