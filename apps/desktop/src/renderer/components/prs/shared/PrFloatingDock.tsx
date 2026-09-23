import React from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  Clock,
  GitMerge,
  Prohibit,
  Stack,
  Tag,
  UserCircle,
  Users,
  WarningCircle,
  X,
  XCircle,
  ChatCircle,
  PaperPlaneTilt,
  type Icon,
} from "@phosphor-icons/react";

import type {
  MergeMethod,
  PrCommit,
  PrDetail,
  PrReview,
  PrStatus,
  PrWithConflicts,
  ReviewerRequest,
} from "../../../../shared/types/prs";
import {
  latestReviewOpinionByLogin,
  type PrNextStep,
  type PrNextStepAction,
  type PrRequirementChip,
} from "../../../../shared/prNextStep";
import { classifyPrAuthor, normalizeGithubLogin } from "../../../../shared/prBotIdentity";
import { COLORS, MONO_FONT, SANS_FONT } from "../../lanes/laneDesignTokens";
import { PrAgentAvatar } from "./PrAgentAvatar";
import { PrMarkdownEditor } from "./PrMarkdownEditor";
import { PrMergeDialog, type PrMergeDialogResult } from "./PrMergeDialog";
import { PrShippedSummary } from "./PrShippedSummary";
import { readLastMergeMethod, writeLastMergeMethod } from "./prMergeRailUtils";
import { prSolidButton } from "./prSection";
import type { PrReviewEvent } from "./PrReviewSubmitModal";
import "./PrFloatingDock.css";

/* ══════════════════ The dock ══════════════════ */

export type PrDockId = "merge" | "comment" | "reviewers" | "labels" | "assignees";

export type PrDockItem = {
  id: PrDockId;
  label: string;
  icon: Icon;
  /** Small count on the bubble. */
  badge?: number | null;
  /** Ring in a status color (the merge bubble). */
  ringColor?: string | null;
  /** Changing this pulses the ring once — "the state just moved". */
  pulseKey?: string | null;
  /** Card width in px; the narrow tools panel caps it. */
  cardWidth?: number;
  content: React.ReactNode;
};

/**
 * A column of bubbles at the bottom right of the Overview. One card is open at
 * a time and it floats over the thread — it never pushes the content. The Merge
 * card is open by default because "what happens next" is the question the
 * page exists to answer.
 */
export function PrFloatingDock({
  items,
  openId,
  onOpenChange,
}: {
  items: PrDockItem[];
  openId: PrDockId | null;
  onOpenChange: (id: PrDockId | null) => void;
}) {
  const open = items.find((item) => item.id === openId) ?? null;

  React.useEffect(() => {
    if (!openId) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      onOpenChange(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange, openId]);

  return (
    <div className="ade-pr-dock" data-testid="pr-floating-dock">
      {open ? (
        <div
          className="ade-pr-dock-card"
          role="dialog"
          aria-label={open.label}
          data-testid={`pr-dock-card-${open.id}`}
          style={{ "--ade-dock-card-w": `${open.cardWidth ?? 340}px` } as React.CSSProperties}
        >
          {open.content}
        </div>
      ) : null}
      <div className="ade-pr-dock-column" role="toolbar" aria-label="Pull request panels">
        {items.map((item) => (
          <DockBubble
            key={item.id}
            item={item}
            active={item.id === openId}
            onClick={() => onOpenChange(item.id === openId ? null : item.id)}
          />
        ))}
      </div>
    </div>
  );
}

function DockBubble({ item, active, onClick }: { item: PrDockItem; active: boolean; onClick: () => void }) {
  const Glyph = item.icon;
  const [pulse, setPulse] = React.useState(0);
  const lastKey = React.useRef(item.pulseKey ?? null);
  React.useEffect(() => {
    const next = item.pulseKey ?? null;
    if (lastKey.current !== null && next !== lastKey.current) setPulse((value) => value + 1);
    lastKey.current = next;
  }, [item.pulseKey]);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={item.label}
      aria-pressed={active}
      title={item.label}
      data-testid={`pr-dock-bubble-${item.id}`}
      data-active={active || undefined}
      className="ade-pr-dock-bubble"
      style={item.ringColor ? ({ "--ade-dock-ring": item.ringColor } as React.CSSProperties) : undefined}
    >
      {item.ringColor ? <span aria-hidden className="ade-pr-dock-ring" /> : null}
      {pulse > 0 ? <span aria-hidden key={pulse} className="ade-pr-dock-pulse" /> : null}
      <Glyph size={16} weight={active ? "fill" : "regular"} />
      {item.badge ? <span className="ade-pr-dock-badge">{item.badge > 99 ? "99+" : item.badge}</span> : null}
    </button>
  );
}

function CardHeader({ icon: Glyph, title, onClose, trailing }: { icon: Icon; title: string; onClose?: () => void; trailing?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Glyph size={13} style={{ color: COLORS.textMuted }} />
      <span className="text-[11px] font-semibold uppercase tracking-[0.07em]" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}>
        {title}
      </span>
      <span className="flex-1" />
      {trailing}
      {onClose ? (
        <button type="button" onClick={onClose} aria-label="Close panel" className="inline-flex rounded p-0.5 hover:bg-white/[0.07]" style={{ color: COLORS.textMuted, background: "none", border: "none", cursor: "pointer" }}>
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

/* ══════════════════ Merge card ══════════════════ */

/** Theme tokens (CSS variables). Mix them with `color-mix()` for alpha. */
export const NEXT_STEP_TONE_COLOR: Record<PrNextStep["tone"], string> = {
  success: COLORS.success,
  danger: COLORS.danger,
  warning: COLORS.warning,
  info: COLORS.info,
  neutral: COLORS.textMuted,
  merged: COLORS.accent,
};

const CHIP_COLOR: Record<PrRequirementChip["state"], string> = {
  pass: COLORS.success,
  fail: COLORS.danger,
  pending: COLORS.warning,
  neutral: COLORS.textMuted,
};

/**
 * The Merge button fill. The success token is a light green in the dark theme,
 * so darken it: white text then stays readable in both themes.
 */
const MERGE_BUTTON_FILL = `color-mix(in srgb, ${COLORS.success} 78%, black)`;

function ChipGlyph({ state }: { state: PrRequirementChip["state"] }) {
  if (state === "pass") return <CheckCircle size={11} weight="fill" />;
  if (state === "fail") return <XCircle size={11} weight="fill" />;
  if (state === "pending") return <CircleNotch size={11} className="animate-spin" />;
  return <Clock size={11} />;
}

function NextStepGlyph({ step }: { step: PrNextStep }) {
  const color = NEXT_STEP_TONE_COLOR[step.tone];
  const props = { size: 17, weight: "fill" as const, style: { color, flexShrink: 0 } };
  switch (step.kind) {
    case "merged":
    case "ready":
    case "auto_merge_armed":
      return <GitMerge {...props} />;
    case "closed":
      return <XCircle {...props} />;
    case "computing":
    case "checks_pending":
      return <CircleNotch size={17} className="animate-spin" style={{ color, flexShrink: 0 }} />;
    case "draft":
      return <GitMerge size={17} style={{ color, flexShrink: 0 }} />;
    default:
      return <WarningCircle {...props} />;
  }
}

/** One resolved Merge card button: the action, its label, and its busy state. */
export type PrMergeCardButton = {
  action: PrNextStepAction;
  label: string;
  busy: boolean;
};

export type PrMergeCardActions = {
  /** The lead button. Null when the step has none or the host cannot run it here. */
  primary: PrMergeCardButton | null;
  secondary: PrMergeCardButton | null;
  run: (action: PrNextStepAction) => void;
  onChip?: (chip: PrRequirementChip) => void;
};

export function PrMergeCard({
  pr,
  status,
  step,
  commits,
  mergeMethod,
  actionBusy,
  actions,
  onMerge,
  notice,
  onClose,
}: {
  pr: PrWithConflicts;
  status: PrStatus | null;
  step: PrNextStep;
  commits: PrCommit[];
  mergeMethod: MergeMethod;
  actionBusy: boolean;
  actions: PrMergeCardActions;
  onMerge: (result: PrMergeDialogResult) => void;
  notice?: { tone: "success" | "error"; text: string } | null;
  onClose: () => void;
}) {
  const [dialog, setDialog] = React.useState<{ open: boolean; bypass: boolean }>({ open: false, bypass: false });
  const color = NEXT_STEP_TONE_COLOR[step.tone];
  const { primary, secondary } = actions;
  const openMergeDialog = (bypass: boolean) => setDialog({ open: true, bypass });

  const runAction = (action: PrNextStepAction) => {
    if (action === "merge") openMergeDialog(false);
    else actions.run(action);
  };

  if (pr.stack) {
    return (
      <div data-testid="pr-merge-card" data-kind="stack">
        <CardHeader icon={GitMerge} title="Merge" onClose={onClose} />
        <div className="flex items-center gap-2" style={{ color: COLORS.accent }}>
          <Stack size={16} weight="fill" />
          <span className="text-[13px] font-semibold" style={{ fontFamily: SANS_FONT }}>
            GitHub Stack {pr.stack.position} of {pr.stack.size}
          </span>
        </div>
        <p className="mb-3 mt-1 text-[11.5px] leading-relaxed" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}>
          GitHub manages this stack&apos;s rebases, reviews, and merge order. Finish the merge on GitHub.
        </p>
        <button type="button" onClick={() => void window.ade.app.openExternal(pr.githubUrl)} style={prSolidButton({ height: 32, width: "100%" })}>
          <ArrowSquareOut size={13} /> Review and merge on GitHub
        </button>
      </div>
    );
  }

  const anyway = step.mergeAnyway;
  const primaryIsMerge = primary?.action === "merge";
  return (
    <div data-testid="pr-merge-card" data-kind={step.kind} className="flex flex-col gap-3">
      {/* Status: the state glyph in a soft disc, the headline and one line of
          detail beside it. */}
      <div className={`flex gap-3 ${step.detail ? "items-start" : "items-center"}`}>
        <span
          aria-hidden
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
          style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}
        >
          <NextStepGlyph step={step} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold leading-snug" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }} data-testid="pr-merge-card-headline">
            {step.headline}
          </div>
          {step.detail ? (
            <div className="mt-0.5 text-[12px] leading-snug" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}>{step.detail}</div>
          ) : null}
        </div>
        <button type="button" onClick={onClose} aria-label="Close panel" className="-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-white/[0.07]" style={{ color: COLORS.textMuted, background: "none", border: "none", cursor: "pointer" }}>
          <X size={12} />
        </button>
      </div>

      {/* Requirements: one checklist row each, like GitHub's merge box. */}
      {step.chips.length > 0 ? (
        <ul
          className="flex flex-col overflow-hidden rounded-xl"
          style={{ background: "color-mix(in srgb, var(--color-fg) 3.5%, transparent)", boxShadow: `inset 0 0 0 1px ${COLORS.border}` }}
          data-testid="pr-merge-chips"
        >
          {step.chips.map((chip, index) => (
            <li key={chip.id} style={index > 0 ? { borderTop: `1px solid ${COLORS.border}` } : undefined}>
              <button
                type="button"
                onClick={() => actions.onChip?.(chip)}
                data-chip={chip.id}
                data-state={chip.state}
                className="flex h-8 w-full items-center gap-2 px-3 text-left text-[12px] hover:bg-white/[0.03]"
                style={{ color: chip.state === "pass" ? COLORS.textSecondary : COLORS.textPrimary, background: "none", border: "none", cursor: actions.onChip ? "pointer" : "default", fontFamily: SANS_FONT }}
              >
                <span className="inline-flex shrink-0" style={{ color: CHIP_COLOR[chip.state] }}><ChipGlyph state={chip.state} /></span>
                <span className="min-w-0 flex-1 truncate">{chip.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {step.kind === "merged" ? <PrShippedSummary pr={pr} /> : null}

      {primary || secondary || anyway.visible ? (
        <div className="flex items-center gap-2">
          {primary ? (
            <button
              type="button"
              onClick={() => runAction(primary.action)}
              disabled={primary.busy || (primaryIsMerge && actionBusy)}
              data-testid="pr-merge-card-primary"
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-[12.5px] font-semibold transition-opacity disabled:opacity-60"
              style={{
                color: primaryIsMerge ? "#fff" : color,
                background: primaryIsMerge ? MERGE_BUTTON_FILL : `color-mix(in srgb, ${color} 14%, transparent)`,
                boxShadow: primaryIsMerge ? "none" : `inset 0 0 0 1px color-mix(in srgb, ${color} 34%, transparent)`,
                border: "none",
                cursor: "pointer",
                fontFamily: SANS_FONT,
              }}
            >
              {primary.busy ? <CircleNotch size={13} className="animate-spin" /> : primaryIsMerge ? <GitMerge size={13} weight="bold" /> : null}
              {primary.label}
            </button>
          ) : null}
          {secondary ? (
            <button
              type="button"
              onClick={() => runAction(secondary.action)}
              disabled={secondary.busy}
              data-testid="pr-merge-card-secondary"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[12px] font-medium hover:bg-white/[0.08]"
              style={{ color: COLORS.textSecondary, background: "color-mix(in srgb, var(--color-fg) 6%, transparent)", border: "none", cursor: "pointer", fontFamily: SANS_FONT }}
            >
              {secondary.busy ? <CircleNotch size={12} className="animate-spin" /> : null}
              {secondary.label}
            </button>
          ) : null}
          {anyway.visible ? (
            <button
              type="button"
              onClick={() => openMergeDialog(anyway.bypass)}
              disabled={anyway.blocked || actionBusy}
              title={anyway.blockedReason ?? (anyway.skips.length ? `Skips: ${anyway.skips.join(", ")}` : undefined)}
              data-testid="pr-merge-anyway"
              data-bypass={anyway.bypass || undefined}
              className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40${primary ? "" : " flex-1"}`}
              style={{
                color: anyway.bypass ? COLORS.danger : COLORS.textSecondary,
                background: anyway.bypass ? `color-mix(in srgb, ${COLORS.danger} 12%, transparent)` : "color-mix(in srgb, var(--color-fg) 6%, transparent)",
                border: "none",
                cursor: "pointer",
                fontFamily: SANS_FONT,
              }}
            >
              <GitMerge size={12} />
              {anyway.bypass ? "Bypass & merge" : "Merge anyway"}
            </button>
          ) : null}
        </div>
      ) : null}

      {anyway.visible && anyway.blocked && anyway.blockedReason ? (
        <div className="text-[11.5px] leading-snug" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }} data-testid="pr-merge-blocked-reason">
          {anyway.blockedReason}
        </div>
      ) : null}

      {notice ? (
        <div className="text-[11.5px]" style={{ color: notice.tone === "error" ? COLORS.danger : COLORS.success, fontFamily: SANS_FONT }}>{notice.text}</div>
      ) : null}

      <PrMergeDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        pr={pr}
        status={status}
        commits={commits}
        defaultMethod={readLastMergeMethod(mergeMethod)}
        actionBusy={actionBusy}
        skips={step.kind === "ready" ? [] : anyway.skips}
        preferBypass={dialog.bypass}
        onMethodChange={writeLastMergeMethod}
        onMerge={(result) => {
          writeLastMergeMethod(result.method);
          onMerge(result);
          setDialog({ open: false, bypass: false });
        }}
      />
    </div>
  );
}

/* ══════════════════ Comment card ══════════════════ */

const REVIEW_EVENTS: Array<{ value: PrReviewEvent; label: string; tone: string }> = [
  { value: "APPROVE", label: "Approve", tone: COLORS.success },
  { value: "REQUEST_CHANGES", label: "Request changes", tone: COLORS.danger },
  { value: "COMMENT", label: "Comment", tone: COLORS.textMuted },
];

/**
 * The same editor as the old comment composer — Write / Preview and the full
 * formatting toolbar — in a card wide enough to hold it. A Comment / Review
 * toggle sits above it. The text field grows with the text, so it does not
 * scroll until the text is long.
 */
export function PrCommentCard({
  pr,
  draft,
  setDraft,
  busy,
  onComment,
  onSubmitReview,
  onClose,
}: {
  pr: PrWithConflicts;
  draft: string;
  setDraft: (value: string) => void;
  busy: boolean;
  onComment: () => void;
  /** The host clears the draft only after GitHub accepts the review. */
  onSubmitReview: (event: PrReviewEvent, body: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = React.useState<"comment" | "review">("comment");
  const [reviewEvent, setReviewEvent] = React.useState<PrReviewEvent>("APPROVE");
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const canReview = pr.state === "open" || pr.state === "draft";
  const trimmed = draft.trim();
  const canSend = !busy && (mode === "comment" ? trimmed.length > 0 : reviewEvent === "APPROVE" || trimmed.length > 0);

  React.useEffect(() => {
    cardRef.current?.querySelector("textarea")?.focus();
  }, [mode]);

  const send = () => {
    if (!canSend) return;
    if (mode === "comment") {
      onComment();
      return;
    }
    // Keep the draft: if GitHub rejects the review, the text is not lost.
    onSubmitReview(reviewEvent, draft);
  };

  return (
    <div ref={cardRef} data-testid="pr-comment-card" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {canReview ? (
          <div role="tablist" aria-label="Comment or review" className="inline-flex rounded-lg p-0.5" style={{ background: "color-mix(in srgb, var(--color-fg) 6%, transparent)" }}>
            {(["comment", "review"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
                className="rounded-md px-3 py-1 text-[12px] font-medium capitalize"
                style={{
                  color: mode === value ? COLORS.textPrimary : COLORS.textMuted,
                  background: mode === value ? "color-mix(in srgb, var(--color-fg) 11%, transparent)" : "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: SANS_FONT,
                }}
              >
                {value}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-[11px] font-semibold uppercase tracking-[0.07em]" style={{ color: COLORS.textMuted }}>Comment</span>
        )}
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label="Close panel" className="inline-flex rounded p-1 hover:bg-white/[0.07]" style={{ color: COLORS.textMuted, background: "none", border: "none", cursor: "pointer" }}>
          <X size={12} />
        </button>
      </div>

      {mode === "review" ? (
        <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Review verdict">
          {REVIEW_EVENTS.map(({ value, label, tone }) => {
            const on = reviewEvent === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setReviewEvent(value)}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-[12px] font-medium"
                style={{
                  color: on ? tone : COLORS.textMuted,
                  background: on ? `color-mix(in srgb, ${tone} 13%, transparent)` : "color-mix(in srgb, var(--color-fg) 4%, transparent)",
                  boxShadow: on ? `inset 0 0 0 1px color-mix(in srgb, ${tone} 38%, transparent)` : "none",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: SANS_FONT,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}

      <div
        className="overflow-hidden rounded-xl"
        data-testid="pr-comment-card-editor"
        style={{ background: "color-mix(in srgb, var(--color-fg) 3.5%, transparent)", boxShadow: `inset 0 0 0 1px ${COLORS.border}` }}
      >
        <PrMarkdownEditor
          value={draft}
          onChange={setDraft}
          repoOwner={pr.repoOwner}
          repoName={pr.repoName}
          placeholder={mode === "comment" ? "Leave a comment…" : "Review summary (optional for an approval)…"}
          disabled={busy}
          minHeight={120}
          maxHeight={340}
          autoGrow
          ariaLabel={mode === "comment" ? "PR comment" : "Review summary"}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="flex items-center gap-2 px-3 py-2" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          <span className="text-[11px]" style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}>Markdown supported · ⌘↩ to send</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            data-testid="pr-comment-card-send"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: "var(--color-accent-fg)", background: COLORS.accent, border: "none", cursor: "pointer", fontFamily: SANS_FONT }}
          >
            <PaperPlaneTilt size={13} weight="fill" />
            {busy ? "Sending…" : mode === "comment" ? "Comment" : "Submit review"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════ Reviewers / Labels / Assignees ══════════════════ */

type ReviewerEntry = {
  login: string;
  avatarUrl: string | null;
  isBot: boolean;
  state: PrReview["state"] | null;
  requested: boolean;
  team?: boolean;
};

function reviewTime(review: PrReview): number {
  const at = Date.parse(review.submittedAt ?? "");
  return Number.isFinite(at) ? at : 0;
}

/**
 * Everyone whose review belongs on this card: the people asked, then anyone who
 * reviewed without being asked. A host drops a reviewer from the requested set
 * once they review, which is why "Reviewers: None" showed on a PR with three
 * bot reviews. The state is the reviewer's latest opinion, by the same rule as
 * the Merge card: a later dismissal replaces an approval, and plain comments
 * never replace an opinion. A reviewer who only commented shows "commented".
 */
export function collectPrReviewers(detail: PrDetail | null, reviews: PrReview[]): ReviewerEntry[] {
  const byLogin = new Map<string, ReviewerEntry>();
  for (const user of detail?.requestedReviewers ?? []) {
    byLogin.set(normalizeGithubLogin(user.login), { login: user.login, avatarUrl: user.avatarUrl, isBot: classifyPrAuthor(user.login, user.isBot).isBot, state: null, requested: true });
  }
  const opinions = latestReviewOpinionByLogin(reviews);
  const sorted = [...reviews].sort((a, b) => reviewTime(a) - reviewTime(b));
  for (const review of sorted) {
    const key = normalizeGithubLogin(review.reviewer);
    const existing = byLogin.get(key);
    const isBot = classifyPrAuthor(review.reviewer, review.reviewerIsBot).isBot;
    const opinion = opinions.get(key)?.state ?? null;
    const commented = review.state === "commented" || existing?.state === "commented";
    byLogin.set(key, {
      login: existing?.login ?? review.reviewer,
      avatarUrl: existing?.avatarUrl ?? review.reviewerAvatarUrl,
      isBot: existing?.isBot || isBot,
      state: opinion ?? (commented ? "commented" : existing?.state ?? null),
      requested: existing?.requested ?? false,
    });
  }
  const out = [...byLogin.values()];
  for (const team of detail?.requestedTeams ?? []) {
    out.push({ login: team.name || team.slug, avatarUrl: null, isBot: false, state: null, requested: true, team: true });
  }
  return out;
}

function ReviewStateMark({ entry }: { entry: ReviewerEntry }) {
  if (entry.state === "approved") return <CheckCircle size={13} weight="fill" style={{ color: COLORS.checkPass }} aria-label="Approved" />;
  if (entry.state === "changes_requested") return <Prohibit size={13} weight="fill" style={{ color: COLORS.danger }} aria-label="Changes requested" />;
  if (entry.state === "commented") return <ChatCircle size={13} weight="fill" style={{ color: COLORS.textMuted }} aria-label="Commented" />;
  if (entry.requested) return <Clock size={13} weight="fill" style={{ color: COLORS.warning }} aria-label="Awaiting review" />;
  return null;
}

function ReviewerRows({ title, entries }: { title: string; entries: ReviewerEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.07em]" style={{ color: COLORS.textDim }}>{title}</div>
      {entries.map((entry) => {
        const identity = classifyPrAuthor(entry.login, entry.isBot);
        return (
          <div key={`${entry.team ? "team:" : ""}${entry.login}`} className="flex items-center gap-2 py-1" data-testid="pr-reviewer-row" data-bot={entry.isBot || undefined}>
            {entry.team ? (
              <Users size={18} style={{ color: COLORS.accent }} />
            ) : (
              <PrAgentAvatar login={entry.login} isBot={entry.isBot} avatarUrl={entry.avatarUrl} size={20} />
            )}
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
              {entry.isBot ? identity.displayName : entry.login}
            </span>
            {entry.team ? <span className="text-[10px]" style={{ color: COLORS.textDim }}>team</span> : null}
            {!entry.state && entry.requested ? <span className="text-[10px]" style={{ color: COLORS.textDim }}>requested</span> : null}
            <ReviewStateMark entry={entry} />
          </div>
        );
      })}
    </div>
  );
}

function InlineInput({ value, onChange, onSubmit, placeholder }: { value: string; onChange: (value: string) => void; onSubmit: () => void; placeholder: string }) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      onKeyDown={(event) => { if (event.key === "Enter") onSubmit(); }}
      className="h-7 w-full rounded-md px-2 text-[11px] outline-none"
      style={{ fontFamily: MONO_FONT, color: COLORS.textPrimary, background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}
    />
  );
}

export function PrReviewersCard({
  detail,
  reviews,
  onRequestReviewers,
  onClose,
}: {
  detail: PrDetail | null;
  reviews: PrReview[];
  onRequestReviewers: (request: ReviewerRequest) => void;
  onClose: () => void;
}) {
  const [input, setInput] = React.useState("");
  const entries = collectPrReviewers(detail, reviews);
  const people = entries.filter((entry) => !entry.isBot);
  const agents = entries.filter((entry) => entry.isBot);
  const submit = () => {
    const logins = input.split(",").map((value) => value.trim().replace(/^@/, "")).filter(Boolean);
    const teamReviewers = logins.filter((value) => value.startsWith("team:") || value.includes("/")).map((value) => value.replace(/^team:/, "").split("/").pop() ?? value);
    const reviewers = logins.filter((value) => !value.startsWith("team:") && !value.includes("/"));
    if (reviewers.length || teamReviewers.length) {
      onRequestReviewers({ reviewers, teamReviewers });
      setInput("");
    }
  };
  return (
    <div data-testid="pr-reviewers-card">
      <CardHeader icon={Users} title="Reviewers" onClose={onClose} />
      {entries.length === 0 ? (
        <div className="mb-2 text-[12px]" style={{ color: COLORS.textMuted }}>No reviews yet.</div>
      ) : null}
      <ReviewerRows title="People" entries={people} />
      <ReviewerRows title="Agents" entries={agents} />
      <InlineInput value={input} onChange={setInput} onSubmit={submit} placeholder="Request: alice, team:platform" />
    </div>
  );
}

export function PrLabelsCard({ detail, onSetLabels, onClose }: { detail: PrDetail | null; onSetLabels: (labels: string[]) => void; onClose: () => void }) {
  const current = detail?.labels ?? [];
  const [input, setInput] = React.useState("");
  const remove = (name: string) => onSetLabels(current.map((label) => label.name).filter((value) => value !== name));
  const add = () => {
    const next = input.split(",").map((value) => value.trim()).filter(Boolean);
    if (next.length === 0) return;
    onSetLabels([...new Set([...current.map((label) => label.name), ...next])]);
    setInput("");
  };
  return (
    <div data-testid="pr-labels-card">
      <CardHeader icon={Tag} title="Labels" onClose={onClose} />
      {current.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {current.map((label) => (
            <span
              key={label.name}
              className="group inline-flex items-center gap-1.5 rounded-full py-0.5 pl-2 pr-1 text-[11px] font-semibold"
              title={label.description ?? undefined}
              style={{ color: `#${label.color}`, background: `#${label.color}1f`, fontFamily: SANS_FONT }}
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: `#${label.color}` }} />
              {label.name}
              <button type="button" onClick={() => remove(label.name)} aria-label={`Remove ${label.name}`} className="inline-flex rounded-full p-0.5 opacity-50 hover:opacity-100" style={{ color: "inherit", background: "none", border: "none", cursor: "pointer" }}>
                <X size={9} weight="bold" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="mb-2 text-[12px]" style={{ color: COLORS.textMuted }}>No labels.</div>
      )}
      <InlineInput value={input} onChange={setInput} onSubmit={add} placeholder="Add: bug, enhancement" />
    </div>
  );
}

export function PrAssigneesCard({ detail, onClose }: { detail: PrDetail | null; onClose: () => void }) {
  const assignees = detail?.assignees ?? [];
  return (
    <div data-testid="pr-assignees-card">
      <CardHeader icon={UserCircle} title="Assignees" onClose={onClose} />
      {assignees.length === 0 ? (
        <div className="text-[12px]" style={{ color: COLORS.textMuted }}>Nobody is assigned.</div>
      ) : (
        assignees.map((assignee) => (
          <div key={assignee.login} className="flex items-center gap-2 py-1">
            <PrAgentAvatar login={assignee.login} isBot={assignee.isBot} avatarUrl={assignee.avatarUrl} size={20} />
            <span className="text-[12px] font-medium" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>{assignee.login}</span>
          </div>
        ))
      )}
    </div>
  );
}
