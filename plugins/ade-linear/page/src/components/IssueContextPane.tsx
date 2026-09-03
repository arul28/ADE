/**
 * The compiled `UserMessageIssueContext`, Linear half, moved.
 *
 * Source: `apps/desktop/src/renderer/components/chat/UserMessageIssueContext.tsx`
 * for the pane's own logic, and the `LinearIssueContextChip` half of
 * `apps/desktop/src/renderer/components/chat/ChatAttachmentTray.tsx` for the
 * rows it drew — the chip is self-contained, so it is moved verbatim rather than
 * approximated.
 *
 * What did NOT come across, and is reported as a gap rather than faked:
 *
 * - `ChatAttachmentTray` itself. It draws file refs, pending image previews,
 *   image-URL chips, orchestration-annotation chips and the GitHub chip beside
 *   the Linear one, and reads previews off a machine pin through
 *   `useChatRuntimeScope()`. None of that is this plugin's, and a guest has no
 *   runtime scope. Its Linear-only layout — `flex flex-wrap items-center gap-2`
 *   with the caller's `mt-1 px-0 py-0` — is what this pane keeps.
 * - The GitHub half (`GitHubIssueSelectModal`, `detachGitHubIssueFromSession`).
 * - `chatContextAttachmentKey`. It is a renderer module; the hidden set is keyed
 *   by issue id here, which is the same identity for a Linear attachment.
 * - `useChatRuntimeScope()` and `useBuiltinSurfaceVisible("linear")`. The first
 *   has no guest counterpart; the second gated ADE's own pane behind this very
 *   plugin, and the page IS that plugin.
 */

import React, { useMemo, useState } from "react";
import { cn, LinearMark, LINEAR_BRAND } from "@ade-dev/ui";

import type { LaneLinearIssue } from "../types";
import { unlinkIssueFromLane } from "../host/actions";
import { LinearIssueSelectModal } from "./LinearIssueSelectModal";

export function IssueContextPane({
  issues,
  laneId,
  className,
}: {
  issues: LaneLinearIssue[];
  /**
   * The lane the transcript's session belongs to. The compiled pane detached
   * from the SESSION (`window.ade.lanes.detachLinearIssueFromSession`); the
   * page's counterpart is `unlinkIssueFromLane(issueId, laneId)`, and the
   * plugin's own action resolves the session side.
   */
  laneId?: string | null;
  className?: string;
}) {
  const [linearDetailsIssueId, setLinearDetailsIssueId] = useState<string | null>(null);
  const [hiddenContextKeys, setHiddenContextKeys] = useState<string[]>([]);

  const visibleContextAttachments = useMemo(
    () => issues.filter((issue) => !hiddenContextKeys.includes(issue.id)),
    [issues, hiddenContextKeys],
  );
  const linearIssue = visibleContextAttachments.find(
    (issue) => issue.id === linearDetailsIssueId,
  ) ?? null;

  if (!visibleContextAttachments.length) return null;

  return (
    <>
      <div
        className={cn("flex flex-wrap items-center gap-2 px-4 py-3", "mt-1 px-0 py-0", className)}
        data-chat-attachment-tray="true"
      >
        {visibleContextAttachments.map((issue) => (
          <LinearIssueContextChip
            key={issue.id}
            issue={issue}
            onOpen={() => setLinearDetailsIssueId(issue.id)}
          />
        ))}
      </div>
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
          setHiddenContextKeys((current) => [...current, issue.id]);
          if (laneId) {
            void unlinkIssueFromLane(issue.id, laneId);
          }
          setLinearDetailsIssueId(null);
        }}
      />
    </>
  );
}

/**
 * `ChatAttachmentTray`'s `LinearIssueContextChip`, moved.
 *
 * The compiled chip took an `AgentChatContextAttachment` and read
 * `attachment.issue`; a page has the issue itself, so the prop is the issue and
 * every class name, style, `title` and `data-testid` below is the compiled one.
 * The compiled `onRemove` removed the attachment from a COMPOSER draft, which a
 * transcript pane never passed, so the chip's remove button is not drawn here —
 * removal is the details modal's "Remove", exactly as it was.
 */
function LinearIssueContextChip({
  issue,
  onOpen,
}: {
  issue: LaneLinearIssue;
  onOpen?: () => void;
}) {
  const projectLabel = issue.projectName?.trim() || issue.projectSlug || issue.teamKey || null;
  const title = [
    issue.identifier,
    issue.title,
    projectLabel,
    issue.stateName,
  ].filter(Boolean).join(" - ");

  return (
    <span
      className={cn(
        "ade-liquid-glass-pill group inline-flex max-w-full items-center gap-2 rounded-[var(--chat-radius-pill)] border px-2.5 py-1.5 text-[10px] transition-colors",
        onOpen ? "cursor-pointer" : "",
      )}
      style={{
        borderColor: LINEAR_BRAND.borderSubtle,
        background: LINEAR_BRAND.surface,
        color: LINEAR_BRAND.text,
      }}
      title={title}
      data-testid="linear-issue-context-chip"
      onClick={onOpen ? () => onOpen() : undefined}
    >
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
        style={{ background: LINEAR_BRAND.surfaceHover, color: LINEAR_BRAND.primaryBright }}
      >
        <LinearMark size={9} />
      </span>
      <span
        className="shrink-0 rounded font-mono text-[10px] font-semibold"
        style={{ background: "rgba(255,255,255,0.08)", color: LINEAR_BRAND.text, padding: "1px 4px" }}
      >
        {issue.identifier}
      </span>
      <span className="min-w-0 max-w-[240px] truncate font-sans text-[11px] font-medium text-fg/90">
        {issue.title}
      </span>
      {projectLabel ? (
        <span
          className="hidden shrink-0 rounded font-mono text-[9px] sm:inline"
          style={{ background: "rgba(255,255,255,0.05)", color: LINEAR_BRAND.textMuted, padding: "1px 4px" }}
        >
          {projectLabel}
        </span>
      ) : null}
    </span>
  );
}
