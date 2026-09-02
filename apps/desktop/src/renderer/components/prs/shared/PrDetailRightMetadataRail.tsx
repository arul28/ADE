import { memo, useState } from "react";
import {
  CheckCircle,
  ChatCircle,
  Clock,
  LinkSimple,
  PencilSimple,
  Prohibit,
  Sparkle,
  Tag,
  UserCircle,
  Users,
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
import { COLORS, MONO_FONT, SANS_FONT } from "../../lanes/laneDesignTokens";
import { PrSection, PR_SECTION_GAP_COMPACT, prFlatButton, prSectionAction } from "./prSection";
import { PrUserAvatar } from "./PrUserAvatar";
import { PrChecksCard } from "./PrChecksCard";
import { isBotLogin, reviewStateForLogin } from "./prMergeRailUtils";
import { useBuiltinSurfaceVisible } from "../../plugins/useBuiltinTabs";
import { PluginToolbarActions, pluginPrContext } from "../../plugins/sockets";

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
  /**
   * Check this PR's branch out into a lane. ADE review needs a working tree to
   * diff, so with no lane the button offers the missing step instead of sitting
   * greyed out with a tooltip nobody hovers.
   */
  onOpenAsLane?: () => void;
  onSelectCheck?: (check: PrCheck) => void;
  onOpenChecksTab?: () => void;
  onRerunChecks?: (target?: PrRerunChecksTarget) => void;
};

export type ReviewerRequest = {
  reviewers: string[];
  teamReviewers: string[];
};

/**
 * How many check rows the rail previews before folding the rest behind
 * "+N more". The rail is a summary, not the CI tab: five rows is enough to show
 * the failures and the in-flight jobs (`buildUnifiedChecks` already orders
 * failure → running → done) without letting a 37-check PR own the column.
 */
const CHECKS_PREVIEW_LIMIT = 5;

function EditLink({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1"
      style={prSectionAction()}
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
  onOpenAsLane,
  onSelectCheck,
  onOpenChecksTab,
  onRerunChecks,
}: PrDetailRightMetadataRailProps) {
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [submitReviewOpen, setSubmitReviewOpen] = useState(false);
  const [reviewBody, setReviewBody] = useState("");
  const [reviewEvent, setReviewEvent] = useState<PrReviewEvent>("APPROVE");

  const isOpenOrDraft = pr.state === "open" || pr.state === "draft";
  // Compiled ADE review reports into the compiled Review tab, so the button
  // goes wherever that tab goes. Installing `ade-review` hides this control
  // and the plugin's `toolbar-action` on this rail stands in its place.
  const reviewSurfaceVisible = useBuiltinSurfaceVisible("review");
  const pluginReviewContext = pluginPrContext({
    number: pr.githubPrNumber,
    title: pr.title,
    branch: pr.headBranch,
    state: pr.state,
    id: pr.id,
    laneId: pr.laneId,
  });
  // ADE review starts an agent inside the lane's worktree, so this one really
  // does need a local checkout. A disabled button that explains itself beats a
  // button that silently does nothing when clicked.
  const requestReviewEnabled = Boolean(pr.laneId && lane && isOpenOrDraft);
  const canOfferOpenAsLane = Boolean(!requestReviewEnabled && isOpenOrDraft && onOpenAsLane);
  const requestReviewBlockedReason = isOpenOrDraft && !requestReviewEnabled
    ? "ADE review runs an agent on a local checkout of this branch. Open it as a lane first."
    : undefined;
  const requestedReviewers = detail?.requestedReviewers ?? [];
  const requestedTeams = detail?.requestedTeams ?? [];
  const reviewerCount = requestedReviewers.length + requestedTeams.length;
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
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
    >
      {/* People: Reviewers, Labels, Assignees — one group, so no hairlines
          between them. Their labelled headers already carry the grouping, and on
          the common PR all three are empty one-liners: two rules through a
          three-line list is noise that costs 74px. The hairlines in this rail
          are spent where a real boundary is: Checks and Files changed. */}
      <div
        className="flex shrink-0 flex-col"
        style={{ gap: PR_SECTION_GAP_COMPACT }}
        data-testid="pr-metadata-section-people"
      >
        <PrSection
          icon={Users}
          title="Reviewers"
          meta={reviewerCount || undefined}
          inlineEmpty={reviewerCount ? undefined : "None"}
          // No lane gate: requesting a reviewer is a GitHub API call and
          // `requestReviewers` resolves a synthetic `gh:` id like every other
          // mutation. A lane is a convenience link, not an authorization.
          action={<EditLink active={showReviewerEditor} label="Request" onClick={() => setShowReviewerEditor(!showReviewerEditor)} />}
        >
          {requestedReviewers.length || requestedTeams.length ? (
            <>
              {requestedReviewers.map((reviewer) => (
                <ReviewerRow key={reviewer.login} reviewer={reviewer} reviews={reviews} />
              ))}
              {requestedTeams.map((team) => (
                <TeamReviewerRow key={team.slug || team.name} team={team} />
              ))}
            </>
          ) : null}
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

          {/* Review actions fold in here as a compact two-up row. Both are flat
              outlines: the merge button on the neighbouring rail is the one
              filled control on this surface. */}
          {isOpenOrDraft ? (
            <div className="mt-2 flex gap-1.5" data-testid="pr-detail-metadata-actions">
              {/* With no lane the button does not go dead — it offers the step
                  that unblocks it. ADE review diffs a working tree, so checking
                  the branch out IS the prerequisite; making the user find that
                  themselves is what turned this into a button that "does
                  nothing". */}
              {reviewSurfaceVisible ? (
              <button
                type="button"
                onClick={() => (requestReviewEnabled ? setReviewDialogOpen(true) : onOpenAsLane?.())}
                disabled={!requestReviewEnabled && !canOfferOpenAsLane}
                title={
                  requestReviewEnabled
                    ? undefined
                    : canOfferOpenAsLane
                      ? "ADE review diffs a local checkout. This opens the branch as a lane first."
                      : requestReviewBlockedReason
                }
                className="min-w-0 flex-1 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                style={prFlatButton({ tone: COLORS.accent, height: 26, fontSize: 10.5 })}
                data-tour="prs.requestAiReview"
              >
                <Sparkle size={11} weight="fill" />
                {canOfferOpenAsLane ? "Open as lane to review" : "ADE review"}
              </button>
              ) : (
                <PluginToolbarActions
                  surface="prs"
                  context={pluginReviewContext}
                  style={{ flex: 1, minWidth: 0 }}
                />
              )}
              <button
                type="button"
                onClick={() => setSubmitReviewOpen(true)}
                // No lane gate: submitting a review is a GitHub API call, and
                // `submitReview` resolves a synthetic `gh:` id like every other
                // mutation. This was the last survivor of the mapping sweep.
                disabled={actionBusy}
                className="min-w-0 flex-1 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                style={prFlatButton({ color: COLORS.textSecondary, height: 26, fontSize: 10.5 })}
              >
                <CheckCircle size={11} weight="bold" />
                Submit review
              </button>
            </div>
          ) : null}
        </PrSection>

        <PrSection
          icon={Tag}
          title="Labels"
          meta={detail?.labels?.length || undefined}
          inlineEmpty={detail?.labels?.length ? undefined : "None"}
          // Same as Reviewers above: `setLabels` is a plain GitHub mutation.
          action={<EditLink active={showLabelEditor} label="Edit" onClick={() => setShowLabelEditor(!showLabelEditor)} />}
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
          ) : null}
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
        </PrSection>

        <PrSection
          icon={UserCircle}
          title="Assignees"
          meta={detail?.assignees?.length || undefined}
          inlineEmpty={detail?.assignees?.length ? undefined : "None"}
        >
          {detail?.assignees?.length
            ? detail.assignees.map((assignee) => (
                <div key={assignee.login} className="flex items-center gap-2 py-1">
                  <PrUserAvatar user={assignee} size={22} />
                  <span className="text-[12px] font-medium" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                    {assignee.login}
                  </span>
                </div>
              ))
            : null}
        </PrSection>
      </div>

      {detail?.linkedIssues?.length ? (
        <PrSection
          divided
          icon={LinkSimple}
          title="Linked issues"
          meta={detail.linkedIssues.length}
          className="shrink-0"
          data-testid="pr-metadata-section-development"
        >
          <div className="flex flex-col gap-1">
            {detail.linkedIssues.map((issue) => (
              <span key={issue.number} className="truncate text-[12px]" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                #{issue.number} {issue.title}
              </span>
            ))}
          </div>
        </PrSection>
      ) : null}

      {/* Checks take the column's slack (`fill`) so the rail never ends in dead
          air, but the LIST is capped: the rail previews the top five and sends
          the rest to the CI tab. */}
      <PrChecksCard
        fill
        autoFillPreview
        previewLimit={CHECKS_PREVIEW_LIMIT}
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
        open={reviewDialogOpen && reviewSurfaceVisible}
        onOpenChange={setReviewDialogOpen}
        pr={pr}
        lane={lane}
      />
    </div>
  );
});

export default PrDetailRightMetadataRail;
