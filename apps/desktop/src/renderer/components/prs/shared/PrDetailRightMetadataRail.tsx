import { memo, useState, type ReactNode } from "react";
import {
  CheckCircle,
  ChatCircle,
  Clock,
  PencilSimple,
  Prohibit,
  Sparkle,
} from "@phosphor-icons/react";

import type { LaneSummary } from "../../../../shared/types";
import type { PrDetail, PrReview, PrUser, PrWithConflicts } from "../../../../shared/types/prs";
import { PrRequestAiReviewDialog } from "./PrRequestAiReviewDialog";
import { PrReviewSubmitModal, type PrReviewEvent } from "./PrReviewSubmitModal";
import { COLORS, MONO_FONT, SANS_FONT } from "../../lanes/laneDesignTokens";
import { PrUserAvatar } from "./PrUserAvatar";
import { isBotLogin, reviewStateForLogin } from "./prMergeRailUtils";

export type PrDetailRightMetadataRailProps = {
  pr: PrWithConflicts;
  lane: LaneSummary | null;
  detail: PrDetail | null;
  reviews: PrReview[];
  participants: PrUser[];
  showReviewerEditor: boolean;
  setShowReviewerEditor: (value: boolean) => void;
  reviewerInput: string;
  setReviewerInput: (value: string) => void;
  showLabelEditor: boolean;
  setShowLabelEditor: (value: boolean) => void;
  labelInput: string;
  setLabelInput: (value: string) => void;
  onRequestReviewers: (reviewers: string[]) => void;
  onSetLabels: (labels: string[]) => void;
  actionBusy: boolean;
  onSubmitReview: (event: PrReviewEvent, body: string) => void;
};

function MetadataSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={`pr-metadata-section-${title.toLowerCase().replace(/\s+/g, "-")}`}
      style={{ borderBottom: `1px solid ${COLORS.border}` }}
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <span
          className="text-[11px] font-semibold"
          style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, letterSpacing: "0.02em" }}
        >
          {title}
        </span>
        {action}
      </div>
      <div className="px-3 pb-3">{children}</div>
    </section>
  );
}

function EmptyValue({ children }: { children: ReactNode }) {
  return (
    <span className="text-[12px]" style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}>
      {children}
    </span>
  );
}

function ReviewStateIcon({ state }: { state: PrReview["state"] | null }) {
  if (state === "approved") {
    return <CheckCircle size={14} weight="fill" style={{ color: COLORS.success }} />;
  }
  if (state === "changes_requested") {
    return <Prohibit size={14} weight="fill" style={{ color: COLORS.danger }} />;
  }
  if (state === "commented") {
    return <ChatCircle size={14} weight="fill" style={{ color: COLORS.textMuted }} />;
  }
  if (state === "pending") {
    return <Clock size={14} weight="fill" style={{ color: COLORS.warning }} />;
  }
  return null;
}

function ReviewerRow({ reviewer, reviews }: { reviewer: PrUser; reviews: PrReview[] }) {
  const state = reviewStateForLogin(reviews, reviewer.login);
  return (
    <div className="flex items-center gap-2 py-1">
      <PrUserAvatar user={reviewer} size={22} />
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
        {reviewer.login}
        {isBotLogin(reviewer.login) ? " bot" : ""}
      </span>
      <ReviewStateIcon state={state} />
    </div>
  );
}

export const PrDetailRightMetadataRail = memo(function PrDetailRightMetadataRail({
  pr,
  lane,
  detail,
  reviews,
  participants,
  showReviewerEditor,
  setShowReviewerEditor,
  reviewerInput,
  setReviewerInput,
  showLabelEditor,
  setShowLabelEditor,
  labelInput,
  setLabelInput,
  onRequestReviewers,
  onSetLabels,
  actionBusy,
  onSubmitReview,
}: PrDetailRightMetadataRailProps) {
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [submitReviewOpen, setSubmitReviewOpen] = useState(false);
  const [reviewBody, setReviewBody] = useState("");
  const [reviewEvent, setReviewEvent] = useState<PrReviewEvent>("APPROVE");

  const requestReviewEnabled = Boolean(pr.laneId && lane && (pr.state === "open" || pr.state === "draft"));
  const requestReviewers = () => {
    const reviewers = reviewerInput.split(",").map((value) => value.trim()).filter(Boolean);
    if (reviewers.length) onRequestReviewers(reviewers);
  };
  const setLabels = () => {
    const labels = labelInput.split(",").map((value) => value.trim()).filter(Boolean);
    if (labels.length) onSetLabels(labels);
  };

  return (
    <div
      data-testid="pr-detail-right-metadata-rail"
      className="h-full w-full overflow-y-auto"
      style={{
        background: COLORS.cardBg,
        borderLeft: `1px solid ${COLORS.border}`,
      }}
    >
      <section
        data-testid="pr-detail-metadata-actions"
        className="px-3 py-3"
        style={{ borderBottom: `1px solid ${COLORS.border}` }}
      >
        <span
          className="mb-2 block text-[11px] font-semibold"
          style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, letterSpacing: "0.02em" }}
        >
          PR actions
        </span>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setReviewDialogOpen(true)}
            disabled={!requestReviewEnabled}
            className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              fontFamily: SANS_FONT,
              color: COLORS.accent,
              background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)",
            }}
          >
            <Sparkle size={13} weight="fill" />
            Request AI review
          </button>
          {(pr.state === "open" || pr.state === "draft") ? (
            <button
              type="button"
              onClick={() => setSubmitReviewOpen(true)}
              disabled={actionBusy}
              className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              style={{
                fontFamily: SANS_FONT,
                color: COLORS.textPrimary,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.border}`,
              }}
            >
              <CheckCircle size={13} weight="bold" />
              Submit review
            </button>
          ) : null}
        </div>
      </section>

      <PrReviewSubmitModal
        open={submitReviewOpen}
        actionBusy={actionBusy}
        reviewBody={reviewBody}
        setReviewBody={setReviewBody}
        reviewEvent={reviewEvent}
        setReviewEvent={setReviewEvent}
        onCancel={() => setSubmitReviewOpen(false)}
        onSubmit={() => {
          onSubmitReview(reviewEvent, reviewBody);
          setSubmitReviewOpen(false);
          setReviewBody("");
        }}
      />

      <PrRequestAiReviewDialog
        open={reviewDialogOpen}
        onOpenChange={setReviewDialogOpen}
        pr={pr}
        lane={lane}
      />

      <MetadataSection
        title="Reviewers"
        action={(
          <button
            type="button"
            onClick={() => setShowReviewerEditor(!showReviewerEditor)}
            className="inline-flex items-center gap-1 text-[11px]"
            style={{ color: COLORS.accent, fontFamily: SANS_FONT, background: "none", border: "none", cursor: "pointer" }}
          >
            {showReviewerEditor ? <PencilSimple size={12} /> : null}
            Request
          </button>
        )}
      >
        {detail?.requestedReviewers?.length ? (
          detail.requestedReviewers.map((reviewer) => (
            <ReviewerRow key={reviewer.login} reviewer={reviewer} reviews={reviews} />
          ))
        ) : (
          <EmptyValue>None yet</EmptyValue>
        )}
        {showReviewerEditor ? (
          <div className="mt-2">
            <input
              value={reviewerInput}
              onChange={(event) => setReviewerInput(event.target.value)}
              placeholder="username1, username2"
              onKeyDown={(event) => {
                if (event.key === "Enter") requestReviewers();
              }}
              className="h-7 w-full px-2 text-[11px] outline-none"
              style={{
                fontFamily: MONO_FONT,
                color: COLORS.textPrimary,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.border}`,
              }}
            />
          </div>
        ) : null}
      </MetadataSection>

      <MetadataSection title="Assignees">
        {detail?.assignees?.length ? (
          detail.assignees.map((assignee) => (
            <div key={assignee.login} className="flex items-center gap-2 py-1">
              <PrUserAvatar user={assignee} size={22} />
              <span className="text-[12px] font-medium" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                {assignee.login}
              </span>
            </div>
          ))
        ) : (
          <EmptyValue>None yet</EmptyValue>
        )}
      </MetadataSection>

      <MetadataSection
        title="Labels"
        action={(
          <button
            type="button"
            onClick={() => setShowLabelEditor(!showLabelEditor)}
            className="inline-flex items-center gap-1 text-[11px]"
            style={{ color: COLORS.accent, fontFamily: SANS_FONT, background: "none", border: "none", cursor: "pointer" }}
          >
            {showLabelEditor ? <PencilSimple size={12} /> : null}
            Edit
          </button>
        )}
      >
        {detail?.labels?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {detail.labels.map((label) => (
              <span
                key={label.name}
                className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold"
                style={{
                  fontFamily: SANS_FONT,
                  color: `#${label.color}`,
                  background: `#${label.color}18`,
                  border: `1px solid #${label.color}35`,
                }}
              >
                <span
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: `#${label.color}` }}
                />
                {label.name}
              </span>
            ))}
          </div>
        ) : (
          <EmptyValue>None yet</EmptyValue>
        )}
        {showLabelEditor ? (
          <div className="mt-2">
            <input
              value={labelInput}
              onChange={(event) => setLabelInput(event.target.value)}
              placeholder="bug, enhancement"
              onKeyDown={(event) => {
                if (event.key === "Enter") setLabels();
              }}
              className="h-7 w-full px-2 text-[11px] outline-none"
              style={{
                fontFamily: MONO_FONT,
                color: COLORS.textPrimary,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.border}`,
              }}
            />
          </div>
        ) : null}
      </MetadataSection>

      <MetadataSection title="Projects">
        <EmptyValue>None yet</EmptyValue>
      </MetadataSection>

      <MetadataSection title="Milestone">
        {detail?.milestone ? (
          <span className="text-[12px]" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
            {detail.milestone}
          </span>
        ) : (
          <EmptyValue>None yet</EmptyValue>
        )}
      </MetadataSection>

      <MetadataSection title="Development">
        {detail?.linkedIssues?.length ? (
          <div className="flex flex-col gap-1">
            {detail.linkedIssues.map((issue) => (
              <span key={issue.number} className="text-[12px]" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                #{issue.number} {issue.title}
              </span>
            ))}
          </div>
        ) : (
          <EmptyValue>None yet</EmptyValue>
        )}
      </MetadataSection>

      <MetadataSection title="Notifications">
        <EmptyValue>None yet</EmptyValue>
      </MetadataSection>

      <MetadataSection title="Participants">
        {participants.length ? (
          <div className="flex flex-wrap gap-1.5">
            {participants.map((participant) => (
              <span key={participant.login} title={participant.login}>
                <PrUserAvatar user={participant} size={24} />
              </span>
            ))}
          </div>
        ) : (
          <EmptyValue>None yet</EmptyValue>
        )}
      </MetadataSection>
    </div>
  );
});

export default PrDetailRightMetadataRail;
