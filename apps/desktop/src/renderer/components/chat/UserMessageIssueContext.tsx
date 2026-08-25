import React, { useState } from "react";

import type { AgentChatContextAttachment, AgentChatFileRef, ChatSurfaceMode } from "../../../shared/types";
import { GitHubIssueSelectModal } from "../app/GitHubIssueSelectModal";
import { LinearIssueSelectModal } from "../app/LinearIssueSelectModal";
import { ChatAttachmentTray } from "./ChatAttachmentTray";

export function UserMessageIssueContext({
  attachments,
  contextAttachments,
  mode,
  sessionId,
}: {
  attachments: AgentChatFileRef[];
  contextAttachments: AgentChatContextAttachment[];
  mode: ChatSurfaceMode;
  sessionId?: string | null;
}) {
  const [linearDetailsOpen, setLinearDetailsOpen] = useState(false);
  const [githubDetailsOpen, setGitHubDetailsOpen] = useState(false);
  const linearIssue = contextAttachments.find(
    (attachment): attachment is Extract<AgentChatContextAttachment, { type: "linear_issue" }> => (
      attachment.type === "linear_issue"
    ),
  )?.issue ?? null;
  const githubIssue = contextAttachments.find(
    (attachment): attachment is Extract<AgentChatContextAttachment, { type: "github_issue" }> => (
      attachment.type === "github_issue"
    ),
  )?.issue ?? null;

  return (
    <>
      <ChatAttachmentTray
        attachments={attachments}
        contextAttachments={contextAttachments}
        mode={mode}
        className="mt-1 px-0 py-0"
        onOpenContext={(attachment) => {
          if (attachment.type === "linear_issue") setLinearDetailsOpen(true);
          if (attachment.type === "github_issue") setGitHubDetailsOpen(true);
        }}
      />
      <LinearIssueSelectModal
        open={linearDetailsOpen}
        ariaLabel="Linear issue"
        selectedIssue={linearIssue}
        mode="details"
        showBranchPreview={false}
        onOpenChange={setLinearDetailsOpen}
        onSelectIssue={() => undefined}
        onRemoveIssue={(issue) => {
          if (sessionId) {
            void window.ade?.lanes?.detachLinearIssueFromSession?.({
              chatSessionId: sessionId,
              issueId: issue.id,
            });
          }
          setLinearDetailsOpen(false);
        }}
      />
      <GitHubIssueSelectModal
        open={githubDetailsOpen}
        ariaLabel="GitHub issue"
        selectedIssue={githubIssue}
        mode="details"
        onOpenChange={setGitHubDetailsOpen}
        onSelectIssue={() => undefined}
        onRemoveIssue={(issue) => {
          if (sessionId) {
            void window.ade?.lanes?.detachGitHubIssueFromSession?.({
              chatSessionId: sessionId,
              issueId: issue.id,
            });
          }
          setGitHubDetailsOpen(false);
        }}
      />
    </>
  );
}
