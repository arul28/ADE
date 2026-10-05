import type { AgentChatEventEnvelope, AgentChatRewindSkippedFile } from "../../../shared/types/chat";

export type CodexRewindFileRestore = {
  path: string;
  beforeSha: string;
};

export type CodexRewindPlan = {
  targetFound: boolean;
  targetTurnId: string | null;
  hasLaterUserMessage: boolean;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  restoreFiles: CodexRewindFileRestore[];
  skippedFiles: AgentChatRewindSkippedFile[];
  busyPeerTitle: string | null;
};

/** Another chat writing into the same worktree. Read only when there is something to restore. */
export type CodexRewindPeer = {
  title: string | null;
  active: boolean;
  envelopes: () => readonly AgentChatEventEnvelope[];
};

/**
 * What a Codex file rewind to `messageId` may restore. Restoring writes the
 * file as it was at the turn's starting commit, so it is safe only for a file
 * that was clean when the turn began and that no other chat in the worktree
 * has changed since; anything else is reported in `skippedFiles` and left as
 * it is.
 */
export function planCodexRewind(args: {
  envelopes: readonly AgentChatEventEnvelope[];
  messageId: string;
  peers: () => readonly CodexRewindPeer[];
}): CodexRewindPlan {
  let sawTargetMessage = false;
  let targetTurnId: string | null = null;
  let targetAtMs: number | null = null;
  let hasLaterUserMessage = false;
  const restoreByPath = new Map<string, CodexRewindFileRestore>();
  const skippedByPath = new Map<string, AgentChatRewindSkippedFile["reason"]>();
  let insertions = 0;
  let deletions = 0;

  for (const envelope of args.envelopes) {
    const event = envelope.event;
    if (event.type === "user_message" && event.messageId === args.messageId) {
      sawTargetMessage = true;
      targetTurnId = event.turnId?.trim() || null;
      const at = Date.parse(envelope.timestamp);
      targetAtMs = Number.isFinite(at) ? at : null;
      continue;
    }

    if (!sawTargetMessage) continue;
    if (event.type === "user_message") {
      hasLaterUserMessage = true;
    } else if (!targetTurnId) {
      targetTurnId = "turnId" in event && typeof event.turnId === "string"
        ? event.turnId.trim() || null
        : null;
    }

    if (event.type !== "turn_diff_summary") continue;
    insertions += Math.max(0, event.totalAdditions);
    deletions += Math.max(0, event.totalDeletions);
    const dirtyAtStart = event.dirtyAtStart ? new Set(event.dirtyAtStart) : null;
    for (const file of event.files) {
      const filePath = file.path.trim();
      if (!filePath || restoreByPath.has(filePath) || skippedByPath.has(filePath)) continue;
      if (!dirtyAtStart) {
        skippedByPath.set(filePath, "unknown_start_state");
      } else if (dirtyAtStart.has(filePath)) {
        skippedByPath.set(filePath, "dirty_before_turn");
      } else {
        restoreByPath.set(filePath, { path: filePath, beforeSha: event.beforeSha });
      }
    }
  }

  // Another chat sharing the worktree since this message: a running turn has
  // not reported what it touched yet, so nothing can be shown safe; a
  // finished one names its files in its own diff summaries.
  let busyPeerTitle: string | null = null;
  if (sawTargetMessage && restoreByPath.size) {
    for (const peer of args.peers()) {
      if (peer.active) {
        busyPeerTitle = peer.title?.trim() || "Another chat";
        break;
      }
      for (const envelope of peer.envelopes()) {
        if (envelope.event.type !== "turn_diff_summary") continue;
        const at = Date.parse(envelope.timestamp);
        if (targetAtMs != null && Number.isFinite(at) && at < targetAtMs) continue;
        for (const file of envelope.event.files) {
          const filePath = file.path.trim();
          if (restoreByPath.delete(filePath)) skippedByPath.set(filePath, "other_chat");
        }
      }
    }
  }

  return {
    targetFound: sawTargetMessage,
    targetTurnId,
    hasLaterUserMessage,
    filesChanged: [...restoreByPath.keys()],
    insertions,
    deletions,
    restoreFiles: [...restoreByPath.values()],
    skippedFiles: [...skippedByPath].map(([filePath, reason]) => ({ path: filePath, reason })),
    busyPeerTitle,
  };
}
