import React from "react";
import {
  ArrowLeft, ArrowSquareOut, ArrowsClockwise, Check, ChatTeardropText, CheckCircle, CircleNotch, Code, Eye,
  GitPullRequest, PencilSimple, Play, WarningCircle, X,
} from "@phosphor-icons/react";

import type { AgentChatSessionSummary, LaneSummary, PrUser, PrWithConflicts } from "../../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../../lanes/laneDesignTokens";
import { BranchIcon } from "../../ui/vcsIcons";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { LaneChip } from "../../terminals/LaneChip";
import { getPrStateBadge, InlinePrBadge } from "../shared/prVisuals";
import { PrUserAvatar } from "../shared/PrUserAvatar";
import { PrActionsDropdown, type PrActionsContext } from "../shared/PrActionsMenu";
import { chatLabel } from "../shared/prChatActions";
import { isTerminalPrState } from "../../../lib/prState";
import { relativeWhen } from "../../../lib/format";
import type { PrDetailRouteTab } from "../prsRouteState";
import "./PrDetailHeader.css";

type DetailTab = PrDetailRouteTab;

/**
 * The offer to start local work on a PR's branch: check the branch out into a
 * lane. A PR without a lane is not a problem, so this is an offer, not a warning.
 */
export type UnmappedAffordance = {
  /** Whether a local lane can be created from this PR's branch. */
  canCreateLane: boolean;
  onCreateLane: () => void;
};

/** Live note beside the Checks tab: counts while running, a dot once settled. */
export type PrHeaderChecksNote = {
  state: "running" | "passing" | "failing" | "none";
  passed: number;
  total: number;
};

const MAX_CHAT_CHIPS = 3;

function ChecksNote({ note }: { note: PrHeaderChecksNote }) {
  if (note.state === "none" || note.total === 0) return null;
  if (note.state === "running") {
    return (
      <span
        className="ade-pr-detail-header-checks-note"
        data-testid="pr-header-checks-note"
        data-state="running"
        style={{ display: "inline-flex", alignItems: "center", gap: 4, color: COLORS.warning, fontFamily: MONO_FONT, fontSize: 10.5 }}
      >
        <CircleNotch size={11} className="animate-spin" />
        {note.passed}/{note.total}
      </span>
    );
  }
  const passing = note.state === "passing";
  return (
    <span
      className="ade-pr-detail-header-checks-note"
      data-testid="pr-header-checks-note"
      data-state={note.state}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, color: passing ? COLORS.success : COLORS.danger, fontFamily: MONO_FONT, fontSize: 10.5 }}
    >
      {passing ? <CheckCircle size={11} weight="fill" /> : <WarningCircle size={11} weight="fill" />}
      {passing ? note.total : `${note.total - note.passed} failing`}
    </span>
  );
}

export type PrDetailHeaderProps = {
  pr: PrWithConflicts;
  /** The route has coordinates but GitHub has not resolved the row yet. */
  provisional: boolean;
  activeTab: DetailTab;
  onSelectTab: (tab: DetailTab) => void;
  filesCount: number;
  checksNote: PrHeaderChecksNote;
  author: PrUser | null;
  lane: LaneSummary | null;
  linkedChats: AgentChatSessionSummary[];
  onOpenChat: (session: AgentChatSessionSummary) => void;
  onOpenLane?: (() => void) | null;
  editingTitle: boolean;
  titleDraft: string;
  onTitleDraftChange: (value: string) => void;
  onStartTitleEdit: () => void;
  onCancelTitleEdit: () => void;
  onSubmitTitle: () => void;
  onReadyForReview: () => void;
  readyForReviewBusy: boolean;
  /** The ⋯ menu's context. Its `onRefresh` and `refreshing` also drive the refresh button. */
  actions: PrActionsContext;
  unmappedAffordance?: UnmappedAffordance | null;
};

/**
 * The PR card: who and when · the title · where it merges and what it belongs
 * to · the tabs with their actions. Modeled on t3code's PR header, but it also
 * carries ADE's own links — the lane and the chats working on this PR.
 */
export const PrDetailHeader = React.memo(function PrDetailHeader({
  pr,
  provisional,
  activeTab,
  onSelectTab,
  filesCount,
  checksNote,
  author,
  lane,
  linkedChats,
  onOpenChat,
  onOpenLane = null,
  editingTitle,
  titleDraft,
  onTitleDraftChange,
  onStartTitleEdit,
  onCancelTitleEdit,
  onSubmitTitle,
  onReadyForReview,
  readyForReviewBusy,
  actions,
  unmappedAffordance = null,
}: PrDetailHeaderProps) {
  const tabs: Array<{ id: DetailTab; label: string; icon: React.ElementType; count?: number; note?: React.ReactNode }> = [
    { id: "overview", label: "Overview", icon: Eye },
    { id: "files", label: "Files", icon: Code, count: filesCount },
    { id: "checks", label: "Checks", icon: Play, note: <ChecksNote note={checksNote} /> },
  ];

  const handleTitleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") onSubmitTitle();
    if (event.key === "Escape") onCancelTitleEdit();
  };

  const openOnGitHub = () => {
    if (pr.githubUrl) void window.ade.app.openExternal(pr.githubUrl);
    else void window.ade.prs.openInGitHub(pr.id);
  };

  const badge = provisional
    ? {
      label: "RESOLVING",
      color: COLORS.textMuted,
      bg: `color-mix(in srgb, ${COLORS.textMuted} 9%, transparent)`,
      border: `color-mix(in srgb, ${COLORS.textMuted} 19%, transparent)`,
    }
    : getPrStateBadge(pr.state);
  const shownChats = linkedChats.slice(0, MAX_CHAT_CHIPS);
  const hiddenChats = linkedChats.length - shownChats.length;
  const showOpenAsLane = !pr.laneId && unmappedAffordance?.canCreateLane && !isTerminalPrState(pr.state);
  const refreshing = Boolean(actions.refreshing);

  return (
    <div
      className="ade-pr-detail-header"
      data-testid="pr-detail-header"
      style={{ flexShrink: 0, borderBottom: `1px solid ${COLORS.border}`, background: COLORS.prSurface }}
    >
      <div className="ade-pr-detail-header-card">
        {/* Row 1 — number, author, age, state · Open as lane */}
        <div className="ade-pr-detail-header-meta">
          <SmartTooltip content={{ label: "Open on GitHub", description: pr.githubUrl }}>
            <button
              type="button"
              onClick={openOnGitHub}
              className="ade-pr-detail-header-number"
              style={{ fontFamily: MONO_FONT, fontSize: 12.5, fontWeight: 600, color: COLORS.accent }}
            >
              #{pr.githubPrNumber}
              <ArrowSquareOut size={11} />
            </button>
          </SmartTooltip>
          {author?.login ? (
            <span className="ade-pr-detail-header-author">
              <span aria-hidden style={{ color: COLORS.textDim }}>·</span>
              <PrUserAvatar user={author} size={16} />
              <span style={{ color: COLORS.textSecondary, fontWeight: 500 }}>{author.login}</span>
            </span>
          ) : null}
          {pr.createdAt ? (
            <span style={{ color: COLORS.textMuted }} title={new Date(pr.createdAt).toLocaleString()}>
              <span aria-hidden style={{ color: COLORS.textDim, marginRight: 6 }}>·</span>
              opened {relativeWhen(pr.createdAt)}
            </span>
          ) : null}
          {/* Only when it says something the "opened" time does not. */}
          {pr.createdAt && pr.updatedAt && relativeWhen(pr.updatedAt) !== relativeWhen(pr.createdAt) ? (
            <span style={{ color: COLORS.textMuted }} title={new Date(pr.updatedAt).toLocaleString()} data-testid="pr-header-updated">
              <span aria-hidden style={{ color: COLORS.textDim, marginRight: 6 }}>·</span>
              updated {relativeWhen(pr.updatedAt)}
            </span>
          ) : null}
          <span className="ade-pr-detail-header-badge" style={{ flexShrink: 0 }}>
            <InlinePrBadge {...badge} />
          </span>
          <span style={{ flex: 1 }} />
          {showOpenAsLane ? (
            <SmartTooltip content={{ label: "Open as lane", description: "Check this pull request's branch out into a local lane so you can run and edit it here." }}>
              <button
                type="button"
                onClick={unmappedAffordance?.onCreateLane}
                data-testid="pr-unmapped-affordance"
                style={outlineButton({ height: 24, padding: "0 8px", fontSize: 11, color: COLORS.textSecondary })}
              >
                <BranchIcon size={12} /> Open as lane
              </button>
            </SmartTooltip>
          ) : null}
        </div>

        {/* Row 2 — title */}
        {editingTitle ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <input
              value={titleDraft}
              onChange={(event) => onTitleDraftChange(event.target.value)}
              onKeyDown={handleTitleKeyDown}
              autoFocus
              aria-label="Pull request title"
              style={{
                flex: 1, minWidth: 0, height: 30, padding: "0 10px", fontSize: 15, fontWeight: 600,
                fontFamily: SANS_FONT, color: COLORS.textPrimary,
                background: COLORS.recessedBg, border: `1px solid ${COLORS.accent}`, borderRadius: 8, outline: "none",
              }}
            />
            <button type="button" onClick={onSubmitTitle} aria-label="Save title" style={outlineButton({ height: 26, padding: "0 8px", color: COLORS.success })}>
              <Check size={13} weight="bold" />
            </button>
            <button type="button" onClick={onCancelTitleEdit} aria-label="Cancel title edit" style={outlineButton({ height: 26, padding: "0 8px" })}>
              <X size={13} weight="bold" />
            </button>
          </div>
        ) : (
          <div className="ade-pr-detail-header-identity">
            <h2 className="ade-pr-detail-header-title" title={pr.title}>{pr.title}</h2>
            <SmartTooltip content={{ label: "Edit title", description: "Rename this pull request on GitHub." }}>
              <button type="button" className="ade-pr-detail-header-edit" onClick={onStartTitleEdit} aria-label="Edit title">
                <PencilSimple size={13} />
              </button>
            </SmartTooltip>
          </div>
        )}

        {/* Row 3 — base ← head · lane · chats */}
        <div className="ade-pr-detail-header-links">
          <span className="ade-pr-detail-header-branches" title={`${pr.headBranch} → ${pr.baseBranch}`}>
            <span style={{ color: COLORS.textSecondary }}>{pr.baseBranch}</span>
            <ArrowLeft size={10} style={{ color: COLORS.textDim, flexShrink: 0 }} />
            <span className="ade-pr-detail-header-head">{pr.headBranch}</span>
          </span>
          {lane ? (
            <LaneChip
              laneName={lane.name}
              laneColor={lane.color}
              maxWidth={180}
              style={{ maxWidth: "100%" }}
              onClick={onOpenLane ?? undefined}
              data-testid="pr-header-lane-chip"
              className="ade-pr-detail-header-lane"
            />
          ) : null}
          {shownChats.map((session) => (
            <button
              key={session.sessionId}
              type="button"
              className="ade-pr-detail-header-chat"
              data-testid="pr-header-chat-chip"
              onClick={() => onOpenChat(session)}
              title={`Open ${chatLabel(session)}`}
            >
              <ChatTeardropText size={11} weight="fill" />
              <span>{chatLabel(session)}</span>
            </button>
          ))}
          {hiddenChats > 0 ? (
            <span style={{ fontSize: 10.5, color: COLORS.textMuted }}>+{hiddenChats}</span>
          ) : null}
        </div>
      </div>

      {/* Tabs row — the tabs, then refresh · ready for review · ⋯ */}
      <div className="ade-pr-detail-header-tabs">
        <div className="ade-pr-detail-header-tablist" role="tablist">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                onClick={() => onSelectTab(tab.id)}
                aria-label={tab.label}
                aria-selected={isActive}
                aria-current={isActive ? "page" : undefined}
                data-active={isActive || undefined}
                className="ade-pr-detail-header-tab"
              >
                <Icon size={14} weight={isActive ? "fill" : "regular"} />
                <span className="ade-pr-detail-header-tab-label">{tab.label}</span>
                {tab.count != null && tab.count > 0 ? (
                  <span className="ade-pr-detail-header-tab-count">{tab.count}</span>
                ) : null}
                {tab.note}
              </button>
            );
          })}
        </div>
        <div className="ade-pr-detail-header-actions">
          {actions.onRefresh ? (
            <SmartTooltip content={{ label: refreshing ? "Refreshing" : "Refresh", description: "Read this pull request from GitHub again." }}>
              <button
                type="button"
                onClick={actions.onRefresh}
                disabled={refreshing}
                aria-label="Refresh pull request"
                className="ade-pr-detail-header-icon-button"
              >
                <ArrowsClockwise size={14} className={refreshing ? "animate-spin" : undefined} />
              </button>
            </SmartTooltip>
          ) : null}
          {pr.state === "draft" ? (
            <button
              type="button"
              onClick={onReadyForReview}
              disabled={readyForReviewBusy}
              data-testid="pr-header-ready-for-review"
              className="ade-pr-detail-header-ready"
            >
              {readyForReviewBusy ? <CircleNotch size={12} className="animate-spin" /> : <GitPullRequest size={12} weight="bold" />}
              Ready for review
            </button>
          ) : null}
          <PrActionsDropdown {...actions} />
        </div>
      </div>
    </div>
  );
});

export default PrDetailHeader;
