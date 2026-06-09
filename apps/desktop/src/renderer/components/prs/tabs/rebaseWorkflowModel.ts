import type { OperationRecord, RebaseNeed } from "../../../../shared/types";

export type RebaseOperationMetadata = Record<string, unknown>;

function safeParseMetadata(raw: string | null | undefined): RebaseOperationMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RebaseOperationMetadata : {};
  } catch {
    return {};
  }
}

export function getActiveRebaseNeeds(needs: RebaseNeed[]): RebaseNeed[] {
  return needs.filter((need) => need.behindBy > 0);
}

export function parseRebaseOperationMetadata(operation: OperationRecord): RebaseOperationMetadata {
  return safeParseMetadata(operation.metadataJson);
}

export function isRebaseHistoryOperation(operation: OperationRecord): boolean {
  if (operation.kind === "lane_rebase" || operation.kind === "git_sync_rebase") return true;
  if (operation.kind !== "git_pull") return false;
  return parseRebaseOperationMetadata(operation).mode === "rebase";
}

export function getRebaseHistoryOperations(operations: OperationRecord[]): OperationRecord[] {
  return operations.filter(isRebaseHistoryOperation);
}

export function sortRebaseHistoryOperations(operations: OperationRecord[]): OperationRecord[] {
  return [...operations].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export function getRebaseOperationLabel(operation: OperationRecord): string {
  if (operation.kind === "lane_rebase") return "Lane rebase";
  if (operation.kind === "git_sync_rebase") return "Sync rebase";
  if (operation.kind === "git_pull") return "Pull --rebase";
  return operation.kind.replace(/[_-]+/g, " ");
}
