import React, { useMemo, useState } from "react";

import type { AgentChatContextAttachment, AgentChatFileRef, ChatSurfaceMode } from "../../../shared/types";
import { chatContextAttachmentKey } from "../../../shared/chatContextAttachments";
import { GitHubIssueSelectModal } from "../app/GitHubIssueSelectModal";
import { LinearIssueSelectModal } from "../app/LinearIssueSelectModal";
import { useBuiltinSurfaceVisible } from "../plugins/useBuiltinTabs";
import { ChatAttachmentTray } from "./ChatAttachmentTray";
import { useChatRuntimeScope } from "./ChatRuntimeScope";

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
  // The transcript's own copy of the composer's Linear detail pane, and it
  // needs the composer's gate. The chip itself stays — a past turn really did
  // carry that issue — but opening the Linear-branded pane, and offering to
  // detach from a machine with no Linear, does not.
  const linearSurfaceVisible = useBuiltinSurfaceVisible("linear");
  // The machine that owns this chat, so attachment previews read from it.
  // Taken from the chat's runtime scope rather than a prop: this renders inside
  // `AgentChatMessageList`, which sits under `ChatRuntimeScopeProvider` with the
  // identical pin, and the prop form drilled that same value through four
  // layers of transcript row plumbing to arrive here unchanged.
  const machinePin = useChatRuntimeScope().pin;
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
        machinePin={machinePin}
        mode={mode}
        className="mt-1 px-0 py-0"
        onOpenContext={(attachment) => {
          if (attachment.type === "linear_issue") {
            if (!linearSurfaceVisible) return;
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
        open={linearIssue != null && linearSurfaceVisible}
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
