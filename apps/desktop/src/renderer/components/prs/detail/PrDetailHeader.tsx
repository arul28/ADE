import React from "react";
import {
  ArrowRight, ArrowSquareOut, Check, Code, Eye, GithubLogo, PencilSimple, Play, X,
} from "@phosphor-icons/react";

import type { PrWithConflicts } from "../../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../../lanes/laneDesignTokens";
import { BranchIcon, LaneIcon } from "../../ui/vcsIcons";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { getPrStateBadge, InlinePrBadge } from "../shared/prVisuals";
import { isTerminalPrState } from "../../../lib/prState";
import type { PrDetailRouteTab } from "../prsRouteState";
import "./PrDetailHeader.css";

type DetailTab = PrDetailRouteTab;

/**
 * The offer to start local work on a PR's branch.
 *
 * This used to be a "mapping" affordance: an amber "Not mapped to a lane"
 * warning, a lane picker, and a Map button. Mapping is not a state the user has
 * to resolve — it gates nothing, and a PR without a lane is not a problem. All
 * that survives is the one genuinely useful action: check the branch out into a
 * lane so you can work on it locally.
 */
export type UnmappedAffordance = {
  /** Whether a local lane can be created from this PR's branch. */
  canCreateLane: boolean;
  onCreateLane: () => void;
};

/** Header row height. One line, so this is also the header's height. */
const HEADER_HEIGHT = 46;

/**
 * How many trailing characters of the head branch are held back from the
 * ellipsis. Branch names share long prefixes (`ade/…`, `feature/…`) and differ
 * at the end, so the tail is the part worth keeping when space runs out.
 */
const HEAD_BRANCH_TAIL_CHARS = 12;

const TAB_ACTIVE_COLORS: Record<DetailTab, string> = {
  overview: COLORS.accent,
  files: COLORS.info,
  checks: COLORS.checkPass,
};

function HeaderRule({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={className}
      style={{ width: 1, height: 16, flexShrink: 0, alignSelf: "center", background: COLORS.border }}
      data-header-rule
    />
  );
}

/**
 * The "work on this locally" offer. Deliberately quiet: it is an offer, not a
 * status, so it is a small outline button with no colour and no warning text.
 */
function UnmappedPrBanner({ affordance }: { affordance: UnmappedAffordance }) {
  if (!affordance.canCreateLane) return null;
  return (
    <div
      data-testid="pr-unmapped-affordance"
      style={{ display: "flex", alignItems: "center", flexShrink: 0 }}
    >
      <SmartTooltip
        content={{
          label: "Open as lane",
          description: "Check this pull request's branch out into a local lane so you can run and edit it here.",
        }}
      >
        <button
          type="button"
          onClick={affordance.onCreateLane}
          style={outlineButton({ height: 26, padding: "0 8px", fontSize: 11, color: COLORS.textMuted })}
        >
          <BranchIcon size={12} /> Open as lane
        </button>
      </SmartTooltip>
    </div>
  );
}

/** The head branch chip, which keeps its tail when it runs out of room. */
function HeadBranchChip({ branch }: { branch: string }) {
  const splitAt = branch.length > HEAD_BRANCH_TAIL_CHARS + 4
    ? branch.length - HEAD_BRANCH_TAIL_CHARS
    : branch.length;
  const lead = branch.slice(0, splitAt);
  const tail = branch.slice(splitAt);
  return (
    <span
      title={branch}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        minWidth: 0,
        padding: "2px 8px",
        borderRadius: 6,
        background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-accent) 20%, transparent)",
      }}
    >
      <BranchIcon size={12} style={{ color: COLORS.accent, flexShrink: 0 }} />
      <span
        className="ade-pr-detail-header-branch-name"
        style={{ display: "inline-flex", minWidth: 0, overflow: "hidden", fontFamily: MONO_FONT, fontSize: 11, color: COLORS.accent }}
      >
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lead}</span>
        <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{tail}</span>
      </span>
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
  checksCount: number;
  editingTitle: boolean;
  titleDraft: string;
  onTitleDraftChange: (value: string) => void;
  onStartTitleEdit: () => void;
  onCancelTitleEdit: () => void;
  onSubmitTitle: () => void;
  onShowInGraph?: (laneId: string) => void;
  unmappedAffordance?: UnmappedAffordance | null;
};

/**
 * One line: number, title, state badge, hover-revealed edit pencil │ branch pair
 * │ tabs … GitHub.
 *
 * It used to be three stacked lines. The two that went carried a repository name
 * the surface already establishes, a CI rollup the CI / Checks tab counts and the
 * overview merge rail explains in full, and a per-PR refresh the tab's global
 * refresh already covers. What is left is what you cannot get anywhere else on
 * the screen, and the body gets the two lines back.
 */
export const PrDetailHeader = React.memo(function PrDetailHeader({
  pr,
  provisional,
  activeTab,
  onSelectTab,
  filesCount,
  checksCount,
  editingTitle,
  titleDraft,
  onTitleDraftChange,
  onStartTitleEdit,
  onCancelTitleEdit,
  onSubmitTitle,
  onShowInGraph,
  unmappedAffordance = null,
}: PrDetailHeaderProps) {
  const tabs: Array<{ id: DetailTab; label: string; icon: React.ElementType; count?: number }> = [
    { id: "overview", label: "Overview", icon: Eye },
    { id: "files", label: "Files", icon: Code, count: filesCount },
    { id: "checks", label: "CI / Checks", icon: Play, count: checksCount },
  ];

  const handleTitleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") onSubmitTitle();
    if (event.key === "Escape") onCancelTitleEdit();
  };

  const handleOpenInGitHub = () => {
    // Open the PR's GitHub URL directly. `openInGitHub(pr.id)` resolves via a DB
    // row and would fail for unmapped PRs.
    if (pr.githubUrl) {
      void window.ade.app.openExternal(pr.githubUrl);
    } else {
      void window.ade.prs.openInGitHub(pr.id);
    }
  };

  return (
    <div
      className="ade-pr-detail-header"
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 10,
        height: HEADER_HEIGHT,
        padding: "0 14px 0 20px",
        borderBottom: `1px solid ${COLORS.border}`,
        flexShrink: 0,
        overflow: "hidden",
        background: COLORS.prSurface,
      }}
    >
      {editingTitle ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 auto", minWidth: 0 }}>
          <input
            value={titleDraft}
            onChange={(event) => onTitleDraftChange(event.target.value)}
            onKeyDown={handleTitleKeyDown}
            autoFocus
            aria-label="Pull request title"
            style={{
              flex: 1, minWidth: 0, height: 30, padding: "0 10px", fontSize: 14, fontWeight: 600,
              fontFamily: SANS_FONT, color: COLORS.textPrimary,
              background: COLORS.recessedBg, border: `1px solid ${COLORS.accent}`, borderRadius: 8, outline: "none",
            }}
          />
          <button
            type="button"
            onClick={onSubmitTitle}
            aria-label="Save title"
            style={outlineButton({ height: 26, padding: "0 8px", color: COLORS.success, borderColor: "color-mix(in srgb, var(--color-success) 40%, transparent)" })}
          >
            <Check size={13} weight="bold" />
          </button>
          <button
            type="button"
            onClick={onCancelTitleEdit}
            aria-label="Cancel title edit"
            style={outlineButton({ height: 26, padding: "0 8px" })}
          >
            <X size={13} weight="bold" />
          </button>
        </div>
      ) : (
        <>
          {/* Number, title, state, edit. Sized to its content so the badge and
              the pencil hug the title; the title is the only thing in here that
              shrinks, and it never disappears. */}
          <div
            className="ade-pr-detail-header-identity"
            style={{ alignItems: "center", gap: 8, flex: "0 1 auto", minWidth: 0 }}
          >
            <span style={{ fontFamily: MONO_FONT, fontSize: 13, color: COLORS.accent, fontWeight: 600, opacity: 0.8, flexShrink: 0 }}>
              #{pr.githubPrNumber}
            </span>
            <span
              className="ade-pr-detail-header-title"
              title={pr.title}
              style={{
                minWidth: 0, fontSize: 15, fontWeight: 600, color: COLORS.textPrimary, fontFamily: SANS_FONT,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "-0.01em",
              }}
            >
              {pr.title}
            </span>
            <span className="ade-pr-detail-header-badge" style={{ flexShrink: 0 }}>
              <InlinePrBadge {...(provisional
                ? { label: "RESOLVING", color: COLORS.textMuted, bg: `${COLORS.textMuted}18`, border: `${COLORS.textMuted}30` }
                : getPrStateBadge(pr.state))} />
            </span>
            {/* No lane gate: the tooltip says it renames the PR on GitHub, and
                that is exactly what it does — `updateTitle` resolves a synthetic
                `gh:` id like every other mutation. */}
            <SmartTooltip content={{ label: "Edit title", description: "Rename this pull request on GitHub." }}>
              <button
                type="button"
                className="ade-pr-detail-header-edit"
                onClick={onStartTitleEdit}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: COLORS.textMuted, flexShrink: 0, display: "inline-flex" }}
                aria-label="Edit title"
              >
                <PencilSimple size={14} />
              </button>
            </SmartTooltip>
          </div>

          <HeaderRule className="ade-pr-detail-header-rule-lead" />

          {/* Shrink factor 100 against the title's 1: whatever the row is short
              of comes out of the branch pair first, and the title only starts to
              ellipse once this group has given everything it has. */}
          <div
            className="ade-pr-detail-header-branches"
            style={{ alignItems: "center", gap: 6, minWidth: 0, flex: "0 100 auto", overflow: "hidden" }}
          >
            <HeadBranchChip branch={pr.headBranch} />
            <ArrowRight size={10} style={{ color: COLORS.textDim, flexShrink: 0 }} />
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0,
              padding: "2px 8px", borderRadius: 6,
              background: "color-mix(in srgb, var(--color-info) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-info) 20%, transparent)",
            }}>
              <BranchIcon size={12} style={{ color: COLORS.info }} />
              <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.info, whiteSpace: "nowrap" }}>{pr.baseBranch}</span>
            </span>
          </div>

          <HeaderRule />
        </>
      )}

      {/* Tabs. They stretch the full header height so the active underline lands
          on the header's own bottom border. */}
      <div style={{ display: "flex", alignItems: "stretch", gap: 2, flexShrink: 0 }}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          const tabColor = TAB_ACTIVE_COLORS[tab.id];
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              aria-label={tab.label}
              aria-current={isActive ? "page" : undefined}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "0 12px", fontSize: 12, fontWeight: isActive ? 600 : 500, fontFamily: SANS_FONT,
                color: isActive ? COLORS.textPrimary : COLORS.textMuted,
                background: isActive ? `${tabColor}14` : "transparent",
                borderBottom: isActive ? `2.5px solid ${tabColor}` : "2.5px solid transparent",
                borderTop: "none",
                borderLeft: "none",
                borderRight: "none",
                borderRadius: "8px 8px 0 0",
                cursor: "pointer", transition: "all 120ms ease",
                whiteSpace: "nowrap",
              }}
            >
              <Icon size={15} weight={isActive ? "fill" : "regular"} style={{ color: isActive ? tabColor : COLORS.textMuted, transition: "color 120ms ease" }} />
              <span className="ade-pr-detail-header-tab-label">{tab.label}</span>
              {tab.count != null && tab.count > 0 && (
                <span style={{
                  fontSize: 10, fontFamily: MONO_FONT, padding: "1px 6px", fontVariantNumeric: "tabular-nums",
                  borderRadius: 10,
                  background: isActive ? `${tabColor}28` : "color-mix(in srgb, var(--color-muted-fg) 30%, transparent)",
                  color: isActive ? tabColor : COLORS.textMuted,
                  fontWeight: 600,
                }}>
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        {/* Never shown for a terminal PR: its one action — check the branch out
            into a lane — requires an open PR. The merge rail carries the shipped
            summary instead. */}
        {!pr.laneId && unmappedAffordance && !isTerminalPrState(pr.state) ? (
          <UnmappedPrBanner affordance={unmappedAffordance} />
        ) : null}
        {/* The one control here that genuinely needs a lane: the graph focuses a
            lane node, and an unmapped PR carries an empty `laneId` that would
            build a route with nothing to focus. */}
        {onShowInGraph && pr.laneId ? (
          <button
            type="button"
            onClick={() => onShowInGraph(pr.laneId)}
            style={outlineButton({ height: 26, padding: "0 10px", color: COLORS.info, borderColor: "color-mix(in srgb, var(--color-info) 40%, transparent)" })}
          >
            <LaneIcon size={14} /> Graph
          </button>
        ) : null}
        <SmartTooltip content={{ label: "Open on GitHub", description: "Open this pull request in your browser." }}>
          <button
            type="button"
            onClick={handleOpenInGitHub}
            aria-label="Open on GitHub"
            style={outlineButton({ height: 26, padding: "0 8px", gap: 4 })}
          >
            <GithubLogo size={14} />
            <ArrowSquareOut size={11} />
          </button>
        </SmartTooltip>
      </div>
    </div>
  );
});

export default PrDetailHeader;
