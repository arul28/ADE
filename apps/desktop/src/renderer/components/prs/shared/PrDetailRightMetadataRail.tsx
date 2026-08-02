import { memo, useState, type ReactNode } from "react";
import {
  CheckCircle,
  ChatCircle,
  Clock,
  PencilSimple,
  Prohibit,
  Sparkle,
  UsersThree,
} from "@phosphor-icons/react";

import type { LaneSummary } from "../../../../shared/types";
import type {
  PrActionRun,
  PrCheck,
  PrDetail,
  PrReview,
  PrRerunChecksTarget,
  PrStatus,
  PrTeam,
  PrUser,
  PrWithConflicts,
} from "../../../../shared/types/prs";
import { PrRequestAiReviewDialog } from "./PrRequestAiReviewDialog";
import { PrReviewSubmitModal, type PrReviewEvent } from "./PrReviewSubmitModal";
import { COLORS, MONO_FONT, SANS_FONT, floatingPane } from "../../lanes/laneDesignTokens";
import { PrUserAvatar } from "./PrUserAvatar";
import { PrChecksCard } from "./PrChecksCard";
import { isBotLogin, reviewStateForLogin } from "./prMergeRailUtils";

export type PrDetailRightMetadataRailProps = {
  pr: PrWithConflicts;
  lane: LaneSummary | null;
  detail: PrDetail | null;
  status: PrStatus | null;
  reviews: PrReview[];
  checks: PrCheck[];
  actionRuns: PrActionRun[];
  showReviewerEditor: boolean;
  setShowReviewerEditor: (value: boolean) => void;
  reviewerInput: string;
  setReviewerInput: (value: string) => void;
  showLabelEditor: boolean;
  setShowLabelEditor: (value: boolean) => void;
  labelInput: string;
  setLabelInput: (value: string) => void;
  onRequestReviewers: (request: ReviewerRequest) => void;
  onSetLabels: (labels: string[]) => void;
  actionBusy: boolean;
  onSubmitReview: (event: PrReviewEvent, body: string) => void;
  onSelectCheck?: (check: PrCheck) => void;
  onOpenChecksTab?: () => void;
  onRerunChecks?: (target?: PrRerunChecksTarget) => void;
};

export type ReviewerRequest = {
  reviewers: string[];
  teamReviewers: string[];
};

/** Neutral floating card used for every right-rail section. */
function RightCard({
  title,
  action,
  children,
  padded = true,
  testId,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  padded?: boolean;
  testId?: string;
}) {
  return (
    <section
      style={floatingPane({ padding: 0, overflow: "hidden" })}
      data-testid={testId ?? (title ? `pr-metadata-section-${title.toLowerCase().replace(/\s+/g, "-")}` : undefined)}
    >
      {title ? (
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
          <span
            className="text-[11px] font-medium"
            style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}
          >
            {title}
          </span>
          {action}
        </div>
      ) : null}
      <div className={padded ? "px-3 pb-3 pt-1" : undefined}>{children}</div>
    </section>
  );
}

/** Header row for a sub-section nested inside a shared metadata box. */
function MetaSectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
      <span className="text-[11px] font-medium" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}>
        {title}
      </span>
      {action}
    </div>
  );
}

/** Hairline divider separating sub-sections inside a shared metadata box. */
function MetaSectionDivider() {
  return <div style={{ height: 1, background: COLORS.border, opacity: 0.6 }} />;
}

function EmptyValue({ children }: { children: ReactNode }) {
  return (
    <span className="text-[12px]" style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}>
      {children}
    </span>
  );
}

function EditLink({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-[11px]"
      style={{ color: COLORS.accent, fontFamily: SANS_FONT, background: "none", border: "none", cursor: "pointer" }}
    >
      {active ? <PencilSimple size={12} /> : null}
      {label}
    </button>
  );
}

function ReviewStateIcon({ state }: { state: PrReview["state"] | null }) {
  if (state === "approved") {
    return <CheckCircle size={14} weight="fill" style={{ color: COLORS.checkPass }} />;
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

function TeamReviewerRow({ team }: { team: PrTeam }) {
  const label = team.name || team.slug;
  return (
    <div className="flex items-center gap-2 py-1">
      <div
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full"
        style={{
          color: COLORS.accent,
          background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
          border: `1px solid ${COLORS.border}`,
        }}
      >
        <UsersThree size={13} weight="bold" />
      </div>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
        {label}
      </span>
      <span className="text-[10px]" style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}>
        team
      </span>
    </div>
  );
}

function parseReviewerRequestInput(input: string): ReviewerRequest {
  const reviewers: string[] = [];
  const teamReviewers: string[] = [];
  for (const rawPart of input.split(",")) {
    let value = rawPart.trim();
    if (!value) continue;
    const lower = value.toLowerCase();
    if (lower.startsWith("team:")) {
      value = value.slice("team:".length).trim();
      const parts = value.split("/").map((part) => part.trim()).filter(Boolean);
      const slug = parts[parts.length - 1];
      if (slug) teamReviewers.push(slug);
      continue;
    }
    if (value.startsWith("@")) value = value.slice(1).trim();
    if (value.includes("/")) {
      const parts = value.split("/").map((part) => part.trim()).filter(Boolean);
      const slug = parts[parts.length - 1];
      if (slug) teamReviewers.push(slug);
      continue;
    }
    reviewers.push(value);
  }
  return { reviewers, teamReviewers };
}

export const PrDetailRightMetadataRail = memo(function PrDetailRightMetadataRail({
  pr,
  lane,
  detail,
  reviews,
  checks,
  actionRuns,
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
  onSelectCheck,
  onOpenChecksTab,
  onRerunChecks,
}: PrDetailRightMetadataRailProps) {
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [submitReviewOpen, setSubmitReviewOpen] = useState(false);
  const [reviewBody, setReviewBody] = useState("");
  const [reviewEvent, setReviewEvent] = useState<PrReviewEvent>("APPROVE");

  const isOpenOrDraft = pr.state === "open" || pr.state === "draft";
  const requestReviewEnabled = Boolean(pr.laneId && lane && isOpenOrDraft);
  const requestedReviewers = detail?.requestedReviewers ?? [];
  const requestedTeams = detail?.requestedTeams ?? [];
  const requestReviewers = () => {
    const request = parseReviewerRequestInput(reviewerInput);
    if (request.reviewers.length || request.teamReviewers.length) onRequestReviewers(request);
  };
  const setLabels = () => {
    const labels = labelInput.split(",").map((value) => value.trim()).filter(Boolean);
    if (labels.length) onSetLabels(labels);
  };

  return (
    <div
      data-testid="pr-detail-right-metadata-rail"
      // "Can this land", read top-to-bottom: who → what's running. The column
      // itself no longer scrolls — the Checks card is the single growth target
      // (`flex-1 min-h-0`) and scrolls its own list, so the rail can't end in a
      // band of dead air under a stack of intrinsic-height cards.
      className="flex h-full min-h-0 w-full flex-col gap-2 overflow-hidden"
    >
      {/* Combined people box: Reviewers, Labels, Assignees — one card, three
          headers separated by hairline dividers. */}
      <section
        style={floatingPane({ padding: 0, overflow: "hidden" })}
        className="shrink-0"
        data-testid="pr-metadata-section-people"
      >
        {/* Reviewers */}
        <MetaSectionHeader
          title="Reviewers"
          action={pr.laneId ? <EditLink active={showReviewerEditor} label="Request" onClick={() => setShowReviewerEditor(!showReviewerEditor)} /> : undefined}
        />
        <div className="px-3 pb-3 pt-1">
          {requestedReviewers.length || requestedTeams.length ? (
            <>
              {requestedReviewers.map((reviewer) => (
                <ReviewerRow key={reviewer.login} reviewer={reviewer} reviews={reviews} />
              ))}
              {requestedTeams.map((team) => (
                <TeamReviewerRow key={team.slug || team.name} team={team} />
              ))}
            </>
          ) : (
            <EmptyValue>None yet</EmptyValue>
          )}
          {showReviewerEditor ? (
            <div className="mt-2">
              <input
                value={reviewerInput}
                onChange={(event) => setReviewerInput(event.target.value)}
                placeholder="alice, bob, team:platform"
                onKeyDown={(event) => {
                  if (event.key === "Enter") requestReviewers();
                }}
                className="h-7 w-full px-2 text-[11px] outline-none"
                style={{
                  fontFamily: MONO_FONT,
                  color: COLORS.textPrimary,
                  background: COLORS.recessedBg,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 6,
                }}
              />
            </div>
          ) : null}

          {/* Review actions fold in here as a compact two-up row. A standalone
              pane holding nothing but these two buttons used to be the last card
              in the rail — i.e. the thing that absorbed all the column's slack. */}
          {isOpenOrDraft ? (
            <div className="mt-2 flex gap-1.5" data-testid="pr-detail-metadata-actions">
              <button
                type="button"
                onClick={() => setReviewDialogOpen(true)}
                disabled={!requestReviewEnabled}
                className="inline-flex h-6 min-w-0 flex-1 items-center justify-center gap-1 rounded-md text-[10.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                style={{
                  fontFamily: SANS_FONT,
                  color: COLORS.accent,
                  background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
                  border: `1px solid ${COLORS.accentBorder}`,
                }}
                data-tour="prs.requestAiReview"
              >
                <Sparkle size={11} weight="fill" />
                ADE review
              </button>
              <button
                type="button"
                onClick={() => setSubmitReviewOpen(true)}
                disabled={actionBusy || !pr.laneId}
                title={!pr.laneId ? "Map this PR to a lane to review" : undefined}
                className="inline-flex h-6 min-w-0 flex-1 items-center justify-center gap-1 rounded-md text-[10.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                style={{
                  fontFamily: SANS_FONT,
                  color: COLORS.textSecondary,
                  background: COLORS.recessedBg,
                  border: `1px solid ${COLORS.outlineBorder}`,
                }}
              >
                <CheckCircle size={11} weight="bold" />
                Submit review
              </button>
            </div>
          ) : null}
        </div>

        <MetaSectionDivider />

        {/* Labels */}
        <MetaSectionHeader
          title="Labels"
          action={pr.laneId ? <EditLink active={showLabelEditor} label="Edit" onClick={() => setShowLabelEditor(!showLabelEditor)} /> : undefined}
        />
        <div className="px-3 pb-3 pt-1">
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
                  borderRadius: 6,
                }}
              />
            </div>
          ) : null}
        </div>

        <MetaSectionDivider />

        {/* Assignees */}
        <MetaSectionHeader title="Assignees" />
        <div className="px-3 pb-3 pt-1">
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
        </div>
      </section>

      {detail?.linkedIssues?.length ? (
        <div className="shrink-0">
          <RightCard title="Development">
            <div className="flex flex-col gap-1">
              {detail.linkedIssues.map((issue) => (
                <span key={issue.number} className="text-[12px]" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                  #{issue.number} {issue.title}
                </span>
              ))}
            </div>
          </RightCard>
        </div>
      ) : null}

      {/* THE growth target: checks are the one genuinely variable-length list in
          this column, so they take the slack and scroll internally. */}
      <PrChecksCard
        fill
        missingRequired={pr.checksMissingRequired}
        checksStatus={pr.checksStatus}
        checks={checks}
        actionRuns={actionRuns}
        onSelectCheck={onSelectCheck}
        onOpenChecksTab={onOpenChecksTab}
        onRerunChecks={onRerunChecks}
        actionBusy={actionBusy}
      />

      <PrReviewSubmitModal
        open={submitReviewOpen}
        actionBusy={actionBusy}
        reviewBody={reviewBody}
        setReviewBody={setReviewBody}
        reviewEvent={reviewEvent}
        setReviewEvent={setReviewEvent}
        repoOwner={pr.repoOwner}
        repoName={pr.repoName}
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
    </div>
  );
});

export default PrDetailRightMetadataRail;
