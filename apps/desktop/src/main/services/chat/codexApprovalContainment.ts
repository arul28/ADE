import path from "node:path";

import { stripExtendedLengthPrefix } from "../../../shared/pathContainment";
import { resolvePathWithinRoot } from "../shared/utils";
import type { AgentChatSession } from "../../../shared/types/chat";

/**
 * Which Codex approvals ADE answers itself, and what directory it checks them
 * against.
 *
 * Codex's `thread/start` takes a `SandboxMode` literal, not a sandbox policy
 * object, so ADE cannot hand the app-server a writable root to enforce. The
 * containment check ADE runs on every approval request is therefore the ONLY
 * place a host's `sandboxRoot` can take effect on this provider. That makes
 * these predicates a security surface rather than a convenience, which is why
 * they are here rather than inside the chat service's fifty-thousand-line
 * factory: they are pure, they close over nothing, and they can be read and
 * tested as one unit.
 *
 * Every predicate takes the containment ROOT as a plain string, never a
 * session. The root a request is judged against is not always the session's
 * own directory — a host policy can name another one — so the caller decides
 * which root applies and the predicate only answers about it.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The session fields the two policy questions read. */
export type CodexApprovalSession = Pick<AgentChatSession, "permissionPolicy">;

/**
 * The directory the host policy named, trimmed, or null when it named none.
 *
 * One place decides what counts as "a root the host named", because two
 * questions read it — which root a request is judged against, and whether the
 * policy answers the request at all — and they must not disagree.
 */
function policySandboxRoot(session: CodexApprovalSession): string | null {
  const sandboxRoot = session.permissionPolicy?.sandboxRoot;
  if (typeof sandboxRoot !== "string") return null;
  const trimmed = sandboxRoot.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * The directory a Codex approval is checked against.
 *
 * The host policy's `sandboxRoot` when it named one, and the session's own
 * worktree otherwise. Callers pass the session's `laneWorktreePath` as the
 * fallback, which for a personal chat with a host `requestedCwd` is that
 * directory rather than the synthetic lane root.
 */
export function resolveCodexContainmentRoot(
  session: CodexApprovalSession,
  laneWorktreePath: string,
): string {
  return policySandboxRoot(session) ?? laneWorktreePath;
}

/**
 * Whether ADE answers this Codex approval itself instead of asking the user.
 *
 * Two ways in. Full auto is the legacy one and unchanged. A structured
 * permission policy is the new one, and ONLY when it named a `sandboxRoot`:
 * the root is the thing the host approved in writing, so a request that stays
 * inside it is already answered. A policy with no root approved no directory,
 * and the presence of a policy object cannot stand in for one — a host that
 * sends `{ fallback: "ask" }` is asking to be asked, and auto-accepting every
 * command in the session's own working directory is the opposite of that.
 * A rootless policy therefore falls through to `fallback`: "ask" parks the
 * request on an `approval_request`, "deny" declines it.
 *
 * `codexIsFullAuto` is passed rather than computed, because full auto is
 * derived from the session's approval policy, sandbox, and config source, and
 * that derivation belongs to the chat service's own legacy-mode ladder.
 */
export function codexApprovalAutoAccepts(
  session: CodexApprovalSession,
  codexIsFullAuto: boolean,
): boolean {
  if (codexIsFullAuto) return true;
  return policySandboxRoot(session) !== null;
}

/**
 * Whether the policy refuses an approval outright rather than raising it.
 *
 * The counterpart of {@link codexApprovalAutoAccepts}, and the reason it is a
 * named function rather than an inline `fallback === "deny"` test at each of
 * the three approval handlers: "what does the policy say about this request"
 * now has exactly two spellings, both here, instead of one here and three
 * pasted into the handlers.
 */
export function codexApprovalDeniesByPolicy(session: CodexApprovalSession): boolean {
  return session.permissionPolicy?.fallback === "deny";
}

/** A single path, resolved against the root and required to stay inside it. */
export function codexApprovalPathStaysWithinRoot(
  root: string,
  candidate: string | null | undefined,
): boolean {
  const trimmed = typeof candidate === "string" ? candidate.trim() : "";
  if (!trimmed.length) return false;
  // Codex records cwd and grant roots as `\\?\C:\...`. Node treats that as a
  // UNC path, so `path.relative("C:\\lane", "\\\\?\\C:\\lane\\src")` is
  // absolute and every contained escape looks outside the sandbox. Strip
  // both sides before the canonical walk; on non-win32 this is a no-op.
  try {
    resolvePathWithinRoot(
      stripExtendedLengthPrefix(root),
      stripExtendedLengthPrefix(trimmed),
      { allowMissing: true },
    );
    return true;
  } catch {
    return false;
  }
}

/** A permission path, which may be relative to the request's own `cwd`. */
export function codexPermissionPathStaysWithinRoot(
  root: string,
  cwd: string,
  candidate: string | null | undefined,
): boolean {
  const trimmed = typeof candidate === "string" ? candidate.trim() : "";
  if (!trimmed.length) return false;
  const resolvedCandidate = path.isAbsolute(trimmed)
    ? trimmed
    : path.join(cwd, trimmed);
  return codexApprovalPathStaysWithinRoot(root, resolvedCandidate);
}

/**
 * Every path a filesystem permission grant would open, checked.
 *
 * Unknown shapes refuse. A `deny` entry is skipped because it grants nothing,
 * and a `project_roots` special resolves its subpath against the root itself.
 */
export function codexFileSystemPermissionsStayWithinRoot(
  root: string,
  cwd: string,
  fileSystemPermissions: Record<string, unknown>,
): boolean {
  const legacyPaths = [
    ...(Array.isArray(fileSystemPermissions.read) ? fileSystemPermissions.read : []),
    ...(Array.isArray(fileSystemPermissions.write) ? fileSystemPermissions.write : []),
  ];
  for (const candidate of legacyPaths) {
    if (typeof candidate !== "string" || !codexPermissionPathStaysWithinRoot(root, cwd, candidate)) {
      return false;
    }
  }

  const entries = fileSystemPermissions.entries;
  if (entries == null) return true;
  if (!Array.isArray(entries)) return false;
  for (const entryValue of entries) {
    const entry = asRecord(entryValue);
    if (!entry) return false;
    if (entry.access === "deny") continue;
    const entryPath = asRecord(entry.path);
    if (!entryPath) return false;
    if (entryPath.type === "path") {
      if (!codexPermissionPathStaysWithinRoot(root, cwd, typeof entryPath.path === "string" ? entryPath.path : null)) {
        return false;
      }
      continue;
    }
    if (entryPath.type === "special") {
      const value = asRecord(entryPath.value);
      if (value?.kind !== "project_roots") return false;
      const subpath = value.subpath;
      if (subpath == null) return false;
      if (typeof subpath !== "string" || !codexPermissionPathStaysWithinRoot(root, root, subpath)) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

/** A whole permissions payload: its `cwd` plus every filesystem grant in it. */
export function codexPermissionsStayWithinRoot(
  root: string,
  cwd: string | null | undefined,
  permissions: unknown,
): boolean {
  const permissionCwd = typeof cwd === "string" && cwd.trim().length ? cwd.trim() : root;
  if (!codexApprovalPathStaysWithinRoot(root, permissionCwd)) return false;
  const permissionRecord = asRecord(permissions);
  if (!permissionRecord) return permissions == null;
  if (permissionRecord.fileSystem == null) return true;
  const fileSystemPermissions = asRecord(permissionRecord.fileSystem);
  return fileSystemPermissions
    ? codexFileSystemPermissionsStayWithinRoot(root, permissionCwd, fileSystemPermissions)
    : false;
}

/** A command execution: its working directory plus any escalation it asks for. */
export function codexCommandApprovalStaysWithinRoot(
  root: string,
  cwd: string | null | undefined,
  additionalPermissions: unknown,
): boolean {
  if (!codexApprovalPathStaysWithinRoot(root, cwd)) return false;
  return additionalPermissions == null
    || codexPermissionsStayWithinRoot(root, cwd, additionalPermissions);
}
