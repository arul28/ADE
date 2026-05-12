import type {
  AgentChatEventEnvelope,
  AgentChatRewindFilesResult,
  TurnDiffFile,
  TurnDiffSummary,
} from "../../../shared/types";

export type RewindPreviewFile = TurnDiffFile & {
  beforeSha?: string;
  afterSha?: string;
  diffAvailable: boolean;
};

type RewindMessageRef = {
  messageId: string;
  timestamp: string;
};

function normalizePathForMatch(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function pathsMatch(left: string, right: string): boolean {
  const a = normalizePathForMatch(left);
  const b = normalizePathForMatch(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function deriveRewindDiffSummaries(
  events: AgentChatEventEnvelope[],
  messageRef: RewindMessageRef,
): TurnDiffSummary[] {
  const summaries: TurnDiffSummary[] = [];
  let sawTargetMessage = false;
  const fallbackTimestamp = Date.parse(messageRef.timestamp);

  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "user_message" && event.messageId === messageRef.messageId) {
      sawTargetMessage = true;
      continue;
    }

    if (event.type !== "turn_diff_summary") continue;

    const afterTargetMessage = sawTargetMessage
      || (Number.isFinite(fallbackTimestamp) && Date.parse(envelope.timestamp) >= fallbackTimestamp);
    if (!afterTargetMessage) continue;

    summaries.push({
      turnId: event.turnId,
      beforeSha: event.beforeSha,
      afterSha: event.afterSha,
      files: event.files,
      totalAdditions: event.totalAdditions,
      totalDeletions: event.totalDeletions,
    });
  }

  return summaries;
}

export function buildRewindPreviewFiles(
  preview: Pick<AgentChatRewindFilesResult, "filesChanged">,
  summaries: TurnDiffSummary[],
): RewindPreviewFile[] {
  const byPath = new Map<string, RewindPreviewFile>();

  for (const summary of summaries) {
    for (const file of summary.files) {
      const existingKey = [...byPath.keys()].find((key) => pathsMatch(key, file.path));
      const key = existingKey ?? file.path;
      const existing = byPath.get(key);
      byPath.set(key, {
        path: existing?.path ?? file.path,
        additions: file.additions,
        deletions: file.deletions,
        status: file.status,
        beforeSha: existing?.beforeSha ?? summary.beforeSha,
        afterSha: summary.afterSha,
        diffAvailable: true,
      });
    }
  }

  const ordered: RewindPreviewFile[] = [];
  for (const filePath of preview.filesChanged) {
    const existingEntry = [...byPath.values()].find((file) => pathsMatch(file.path, filePath));
    ordered.push(existingEntry ?? {
      path: filePath,
      additions: 0,
      deletions: 0,
      status: "M",
      diffAvailable: false,
    });
  }

  return ordered;
}
