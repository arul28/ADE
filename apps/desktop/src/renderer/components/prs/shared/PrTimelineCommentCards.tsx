import { useState, type ReactNode } from "react";
import { CaretRight } from "@phosphor-icons/react";

import type { PrTimelineEvent } from "../../../../shared/types/prs";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { relativeWhen } from "../../../lib/format";
import { PrMarkdown } from "./PrMarkdown";
import { PrReactionBar } from "./PrReactionBar";
import { PrUserAvatar } from "./PrUserAvatar";
import { PrCommentEditForm } from "./PrCommentEditForm";
import { usePrCommentEdit } from "./usePrCommentEdit";

function Card({
  author,
  avatarUrl,
  ts,
  children,
}: {
  author: string | null;
  avatarUrl?: string | null;
  ts: string;
  children: ReactNode;
}) {
  // No filled box: an avatar gutter, a name line, the body, and a hairline
  // under it. The hover fill is the only surface, so a long thread reads as a
  // conversation instead of a stack of cards.
  return (
    <div
      className="group flex gap-3 rounded-[10px] px-3 py-3 transition-colors hover:bg-white/[0.02]"
      style={{ borderBottom: `1px solid ${COLORS.borderMuted}` }}
      data-testid="pr-comment-card"
    >
      <div className="shrink-0 pt-0.5">
        <PrUserAvatar user={{ login: author ?? "unknown", avatarUrl: avatarUrl ?? null }} size={22} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2 text-[12px]">
          <span style={{ color: COLORS.textPrimary, fontWeight: 600 }}>{author ?? "unknown"}</span>
          <span className="text-[11px]" style={{ color: COLORS.textDim }}>
            {relativeWhen(ts)}
          </span>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}

const COLLAPSED_BOT_COMMENT_MAX_HEIGHT = 220;

function isLongBotCommentBody(body: string): boolean {
  return body.split(/\r?\n/).length > 12 || body.length > 900;
}

function CollapsibleCommentBody({
  body,
  repoOwner,
  repoName,
}: {
  body: string;
  repoOwner: string;
  repoName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div
        style={{
          position: "relative",
          maxHeight: open ? undefined : COLLAPSED_BOT_COMMENT_MAX_HEIGHT,
          overflow: "hidden",
        }}
      >
        <PrMarkdown repoOwner={repoOwner} repoName={repoName} dense>
          {body}
        </PrMarkdown>
        {open ? null : (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: "auto 0 0 0",
              height: 48,
              background: `linear-gradient(to bottom, transparent, ${COLORS.prSurface})`,
            }}
          />
        )}
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 self-start text-[11px] transition-colors"
        style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT }}
      >
        <CaretRight
          size={11}
          weight="bold"
          className="transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        />
        {open ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

export function DescriptionContent({
  event,
  prId,
  viewerLogin,
  repoOwner,
  repoName,
  plain = false,
}: {
  event: Extract<PrTimelineEvent, { type: "description" }>;
  prId: string;
  viewerLogin: string | null;
  repoOwner: string;
  repoName: string;
  /** The Overview: the description is the page, not a comment in it. */
  plain?: boolean;
}) {
  const [reactionError, setReactionError] = useState<string | null>(null);
  if (plain) {
    return (
      <article data-testid="pr-description" className="px-1 pb-4 pt-1" style={{ borderBottom: `1px solid ${COLORS.borderMuted}` }}>
        {event.body?.trim() ? (
          <PrMarkdown repoOwner={repoOwner} repoName={repoName} variant="document">
            {event.body}
          </PrMarkdown>
        ) : (
          <p className="text-[13px] italic" style={{ color: COLORS.textMuted }}>No description provided.</p>
        )}
        <div className="mt-3">
          <PrReactionBar
            prId={prId}
            subjectId={event.subjectId}
            reactions={event.reactions}
            viewerLogin={viewerLogin}
            onError={(err) => setReactionError(err instanceof Error ? err.message : String(err))}
          />
        </div>
        {reactionError ? (
          <div role="alert" className="text-[11px]" style={{ color: COLORS.danger }}>
            {reactionError}
          </div>
        ) : null}
      </article>
    );
  }
  return (
    <Card author={event.author} avatarUrl={event.avatarUrl} ts={event.timestamp}>
      {event.body ? (
        <PrMarkdown repoOwner={repoOwner} repoName={repoName} dense>
          {event.body}
        </PrMarkdown>
      ) : null}
      <PrReactionBar
        prId={prId}
        subjectId={event.subjectId}
        reactions={event.reactions}
        viewerLogin={viewerLogin}
        onError={(err) => setReactionError(err instanceof Error ? err.message : String(err))}
      />
      {reactionError ? (
        <div role="alert" className="text-[11px]" style={{ color: COLORS.danger }}>
          {reactionError}
        </div>
      ) : null}
    </Card>
  );
}

export function IssueCommentContent({
  event,
  prId,
  viewerLogin,
  repoOwner,
  repoName,
}: {
  event: Extract<PrTimelineEvent, { type: "issue_comment" }>;
  prId: string;
  viewerLogin: string | null;
  repoOwner: string;
  repoName: string;
}) {
  const [reactionError, setReactionError] = useState<string | null>(null);
  const {
    body,
    editing,
    editValue,
    setEditValue,
    editBusy,
    editError,
    beginEdit,
    cancelEdit,
    saveEdit,
    canEdit,
  } = usePrCommentEdit({
    prId,
    commentId: event.commentGithubId,
    source: "issue",
    initialBody: event.body,
    author: event.author,
    viewerLogin,
  });
  const error = editError ?? reactionError;

  const collapseBotComment = Boolean(event.isBot && body && isLongBotCommentBody(body));
  let bodyNode: ReactNode = null;
  if (editing) {
    bodyNode = (
      <PrCommentEditForm
        editValue={editValue}
        setEditValue={setEditValue}
        editBusy={editBusy}
        cancelEdit={cancelEdit}
        saveEdit={saveEdit}
        ariaLabel="Edit pull request comment"
        cancelStyle={{ color: COLORS.textMuted, background: "transparent", border: "none", cursor: "pointer", fontSize: 11 }}
        saveStyle={{
          color: COLORS.accent,
          background: COLORS.accentSubtle,
          border: `1px solid ${COLORS.accentBorder}`,
          borderRadius: 6,
          padding: "4px 9px",
          fontSize: 11,
        }}
      />
    );
  } else if (body && collapseBotComment) {
    bodyNode = <CollapsibleCommentBody body={body} repoOwner={repoOwner} repoName={repoName} />;
  } else if (body) {
    bodyNode = (
      <PrMarkdown repoOwner={repoOwner} repoName={repoName} dense>
        {body}
      </PrMarkdown>
    );
  }
  return (
    <Card author={event.author} avatarUrl={event.avatarUrl} ts={event.timestamp}>
      {bodyNode}
      <div className="flex items-center gap-2">
        <PrReactionBar
          prId={prId}
          subjectId={event.commentNodeId}
          reactions={event.reactions}
          viewerLogin={viewerLogin}
          onError={(err) => setReactionError(err instanceof Error ? err.message : String(err))}
        />
        {canEdit && !editing ? (
          <button
            type="button"
            onClick={() => { setReactionError(null); beginEdit(); }}
            className="text-[11px] hover:underline"
            style={{ color: COLORS.textMuted }}
          >
            Edit
          </button>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="text-[11px]" style={{ color: COLORS.danger }}>
          {error}
        </div>
      ) : null}
    </Card>
  );
}
