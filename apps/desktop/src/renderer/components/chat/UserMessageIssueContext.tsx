import React, { useCallback, useMemo, useState } from "react";

import type { AgentChatContextAttachment, AgentChatFileRef, ChatSurfaceMode } from "../../../shared/types";
import type { LaneJiraIssue } from "../../../shared/types/jira";
import { chatContextAttachmentKey } from "../../../shared/chatContextAttachments";
import { jiraIssueRef, linearIssueRef } from "../../../shared/issueRefs";
import { openIssueRef } from "../../lib/issueNavigation";
import { ChatAttachmentTray } from "./ChatAttachmentTray";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { isAdeAvailable } from "../../lib/adeAvailability";

export function UserMessageIssueContext({
  attachments,
  contextAttachments,
  jiraIssueSnapshotsById,
  mode,
  sessionId,
  accepted = false,
}: {
  attachments: AgentChatFileRef[];
  contextAttachments: AgentChatContextAttachment[];
  jiraIssueSnapshotsById?: ReadonlyMap<string, LaneJiraIssue>;
  mode: ChatSurfaceMode;
  sessionId?: string | null;
  /** The message reached the agent; image previews show a small check. */
  accepted?: boolean;
}) {
  // The machine that owns this chat, so attachment previews read from it.
  // Taken from the chat's runtime scope rather than a prop: this renders inside
  // `AgentChatMessageList`, which sits under `ChatRuntimeScopeProvider` with the
  // identical pin, and the prop form drilled that same value through four
  // layers of transcript row plumbing to arrive here unchanged.
  const machinePin = useChatRuntimeScope().pin;
  const [hiddenContextKeys, setHiddenContextKeys] = useState<string[]>([]);

  const visibleContextAttachments = useMemo(
    () => contextAttachments
      .map((attachment) => {
        if (attachment.type !== "jira_issue") return attachment;
        const latestIssue = jiraIssueSnapshotsById?.get(attachment.issue.id);
        return latestIssue ? { ...attachment, issue: latestIssue } : attachment;
      })
      .filter((attachment) => !hiddenContextKeys.includes(chatContextAttachmentKey(attachment))),
    [contextAttachments, hiddenContextKeys, jiraIssueSnapshotsById],
  );

  // Detaching an issue from the chat used to live in the Linear details modal
  // this chip opened. The chip opens the issue viewer now, so the action moved
  // onto the chip itself.
  const detachContext = useCallback((key: string) => {
    const attachment = visibleContextAttachments.find((entry) => chatContextAttachmentKey(entry) === key);
    if (!attachment || !sessionId) return;
    // Hiding the chip without detaching would lie: the web client has no linear detach.
    if (attachment.type === "linear_issue" && !isAdeAvailable(window.ade?.lanes?.detachLinearIssueFromSession)) return;
    setHiddenContextKeys((current) => [...current, key]);
    if (attachment.type === "linear_issue") {
      void window.ade.lanes.detachLinearIssueFromSession({
        chatSessionId: sessionId,
        issueId: attachment.issue.id,
      }, machinePin);
    } else if (attachment.type === "github_issue") {
      void window.ade?.lanes?.detachGitHubIssueFromSession?.({
        chatSessionId: sessionId,
        issueId: attachment.issue.id,
      }, machinePin);
    } else {
      void window.ade?.lanes?.detachJiraIssueFromSession?.({
        chatSessionId: sessionId,
        issueId: attachment.issue.id,
      }, machinePin);
    }
  }, [machinePin, sessionId, visibleContextAttachments]);

  return (
    <>
      <ChatAttachmentTray
        attachments={attachments}
        contextAttachments={visibleContextAttachments}
        machinePin={machinePin}
        mode={mode}
        accepted={accepted}
        className="mt-1 px-0 py-0"
        onOpenContext={(attachment) => {
          if (attachment.type === "linear_issue") {
            // The issue itself, where you are: the Issues tab beside this chat.
            const ref = linearIssueRef(attachment.issue.identifier, attachment.issue.url ?? null);
            if (ref) openIssueRef({ ref, source: "chip" });
            return;
          }
          if (attachment.type === "github_issue") {
            const issue = attachment.issue;
            openIssueRef({
              ref: { provider: "github", owner: issue.owner, repo: issue.repo, number: issue.number, url: issue.url },
              source: "chip",
            });
            return;
          }
          if (attachment.type === "jira_issue") {
            const ref = jiraIssueRef(attachment.issue.siteUrl, attachment.issue.key, attachment.issue.url);
            if (ref) openIssueRef({ ref, source: "chip", pin: machinePin });
          }
        }}
        onRemoveContext={sessionId ? detachContext : undefined}
      />
    </>
  );
}
