import type { PendingInputRequest } from "../../../shared/types/chat";

/**
 * The key "Allow for this session" is remembered by, from a card's own
 * provider metadata. Exact: the same command, the same file root or set of
 * files, the same OpenCode action on the same resources. Null for a card with
 * nothing to key, which is then never answered from a grant.
 */
export function sessionApprovalGrantKey(request: PendingInputRequest | null | undefined): string | null {
  const meta = request?.providerMetadata;
  if (!request || !meta) return null;
  if (request.source === "codex") {
    // The command where it runs and with what extra access: the same command
    // asking for more, or somewhere else, is a new question.
    if (typeof meta.command === "string" && meta.command.trim()) {
      return `codex:command:${JSON.stringify([meta.command, meta.cwd ?? null, meta.additionalPermissions ?? null])}`;
    }
    if (typeof meta.grantRoot === "string" && meta.grantRoot.trim()) return `codex:file_root:${meta.grantRoot}`;
    // Like Codex's own "don't ask again for these files": the same set of files.
    const paths = Array.isArray(meta.paths) ? meta.paths.filter((entry): entry is string => typeof entry === "string") : [];
    if (paths.length) return `codex:file_change:${JSON.stringify([...new Set(paths)].sort())}`;
    return null;
  }
  if (request.source === "opencode" && typeof meta.type === "string") {
    // An ask that names no resource names nothing to match: no grant.
    const resources = Array.isArray(meta.resources) ? meta.resources.filter((entry): entry is string => typeof entry === "string") : [];
    if (!resources.length) return null;
    return `opencode:${JSON.stringify([meta.type, [...new Set(resources)].sort()])}`;
  }
  return null;
}
