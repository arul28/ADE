import React, { useMemo, useState } from "react";

import type { AgentChatContextAttachment, AgentChatFileRef, ChatSurfaceMode } from "../../../shared/types";
import { chatContextAttachmentKey } from "../../../shared/chatContextAttachments";
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
  const [linearDetailsIssueId, setLinearDetailsIssueId] = useState<string | null>(null);
  const [githubDetailsIssueId, setGitHubDetailsIssueId] = useState<string | null>(null);
  const [hiddenContextKeys, setHiddenContextKeys] = useState<string[]>([]);

  const visibleContextAttachments = useMemo(
    () => contextAttachments.filter((attachment) => !hiddenContextKeys.includes(chatContextAttachmentKey(attachment))),
    [contextAttachments, hiddenContextKeys],
  );
  const linearIssue = visibleContextAttachments.find(
    (attachment): attachment is Extract<AgentChatContextAttachment, { type: "linear_issue" }> => (
      attachment.type === "linear_issue" && attachment.issue.id === linearDetailsIssueId
    ),
  )?.issue ?? null;
  const githubIssue = visibleContextAttachments.find(
    (attachment): attachment is Extract<AgentChatContextAttachment, { type: "github_issue" }> => (
      attachment.type === "github_issue" && attachment.issue.id === githubDetailsIssueId
    ),
  )?.issue ?? null;

  return (
    <>
      <ChatAttachmentTray
        attachments={attachments}
        contextAttachments={visibleContextAttachments}
        mode={mode}
        className="mt-1 px-0 py-0"
        onOpenContext={(attachment) => {
          if (attachment.type === "linear_issue") {
            setLinearDetailsIssueId(attachment.issue.id);
            return;
          }
          if (attachment.type === "github_issue") {
            setGitHubDetailsIssueId(attachment.issue.id);
            return;
          }
        }}
      />
      <LinearIssueSelectModal
        open={linearIssue != null}
        ariaLabel="Linear issue"
        selectedIssue={linearIssue}
        mode="details"
        showBranchPreview={false}
        onOpenChange={(open) => {
          if (!open) setLinearDetailsIssueId(null);
        }}
        onSelectIssue={() => undefined}
        onRemoveIssue={(issue) => {
          const attachment = visibleContextAttachments.find(
            (entry) => entry.type === "linear_issue" && entry.issue.id === issue.id,
          );
          if (attachment) {
            setHiddenContextKeys((current) => [...current, chatContextAttachmentKey(attachment)]);
          }
          if (sessionId) {
            void window.ade?.lanes?.detachLinearIssueFromSession?.({
              chatSessionId: sessionId,
              issueId: issue.id,
            });
          }
          setLinearDetailsIssueId(null);
        }}
      />
      <GitHubIssueSelectModal
        open={githubIssue != null}
        ariaLabel="GitHub issue"
        selectedIssue={githubIssue}
        mode="details"
        onOpenChange={(open) => {
          if (!open) setGitHubDetailsIssueId(null);
        }}
        onSelectIssue={() => undefined}
        onRemoveIssue={(issue) => {
          const attachment = visibleContextAttachments.find(
            (entry) => entry.type === "github_issue" && entry.issue.id === issue.id,
          );
          if (attachment) {
            setHiddenContextKeys((current) => [...current, chatContextAttachmentKey(attachment)]);
          }
          if (sessionId) {
            void window.ade?.lanes?.detachGitHubIssueFromSession?.({
              chatSessionId: sessionId,
              issueId: issue.id,
            });
          }
          setGitHubDetailsIssueId(null);
        }}
      />
    </>
  );
}
