/**
 * The compiled `UserMessageIssueContext`, Linear half, moved.
 *
 * Source: `apps/desktop/src/renderer/components/chat/UserMessageIssueContext.tsx`
 * for the pane's own logic, and `ChatAttachmentTray` for the rows it drew.
 *
 * The tray is no longer approximated. `AttachmentTray` and
 * `IssueAttachmentChip` are the compiled markup, ported into `@ade-dev/ui/attachments`
 * — the same container, the same `data-chat-attachment-tray` attribute, the
 * same chip classes, styles, `title` and `data-testid` — so this pane and the
 * app's own composer draw one implementation rather than two copies that agree
 * today. The kit carries the rest of the set beside it: the file chip, the
 * image thumbnail and its copy affordance, the pending-image preview, the
 * image-URL chip, the orchestration-annotation chip and the GitHub brand of
 * this very chip.
 *
 * What this PANE draws is still only the Linear chips, and the reason is data
 * rather than markup: a transcript's file refs, staged images and annotations
 * are the renderer's own state, and the only fact a guest can read about a past
 * turn is which Linear issues were linked to its session (`pageLanes`). The
 * GitHub chips are another plugin's to draw. When either grows a source, the
 * chip it needs is already in the kit.
 *
 * Two smaller things did not come across:
 *
 * - `chatContextAttachmentKey`. It is a renderer module; the hidden set is keyed
 *   by issue id here, which is the same identity for a Linear attachment.
 * - `useChatRuntimeScope()` and `useBuiltinSurfaceVisible("linear")`. The first
 *   pinned the machine an attachment's bytes are read from, which this pane
 *   reads none of; the second gated ADE's own pane behind this very plugin, and
 *   the page IS that plugin.
 */

import React, { useMemo, useState } from "react";
import { cn, LinearMark, LINEAR_BRAND } from "@ade-dev/ui";
import { AttachmentTray, IssueAttachmentChip } from "@ade-dev/ui/attachments";

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
      {/* `mt-1 px-0 py-0` is the caller's own override in the compiled
          transcript: the tray's default padding belongs to the composer, and
          under a user message the row sits flush. */}
      <AttachmentTray className={cn("mt-1 px-0 py-0", className)}>
        {visibleContextAttachments.map((issue) => (
          <LinearIssueContextChip
            key={issue.id}
            issue={issue}
            onOpen={() => setLinearDetailsIssueId(issue.id)}
          />
        ))}
      </AttachmentTray>
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
 * One Linear issue, as the compiled tray's chip.
 *
 * The markup is `IssueAttachmentChip` in the kit; this wrapper is the Linear
 * BRAND applied to it, and the one place the pane knows what a Linear issue
 * looks like. The compiled `onRemove` removed the attachment from a COMPOSER
 * draft, which a transcript pane never passed, so no remove button is drawn
 * here — removal is the details modal's "Remove", exactly as it was.
 */
function LinearIssueContextChip({
  issue,
  onOpen,
}: {
  issue: LaneLinearIssue;
  onOpen?: () => void;
}) {
  const projectLabel = issue.projectName?.trim() || issue.projectSlug || issue.teamKey || null;
  return (
    <IssueAttachmentChip
      identifier={issue.identifier}
      title={issue.title}
      secondaryLabel={projectLabel}
      brand={LINEAR_BRAND}
      glyph={<LinearMark size={9} />}
      tooltip={[issue.identifier, issue.title, projectLabel, issue.stateName]
        .filter(Boolean)
        .join(" - ")}
      testId="linear-issue-context-chip"
      {...(onOpen ? { onOpen } : {})}
    />
  );
}
