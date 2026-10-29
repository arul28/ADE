import React from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CloudArrowUp,
  DotsThree,
  FileCode,
  FolderOpen,
  GitCommit,
  NotePencil,
} from "@phosphor-icons/react";
import type { GitUpstreamSyncStatus, LaneSummary, OpenProjectBinding } from "../../../../shared/types";
import { relativeWhen } from "../../../lib/format";
import { revealLabel } from "../../../lib/platform";
import { ProviderLogo } from "../../shared/ProviderLogos";
import { WorkToolChromeButton } from "../../terminals/workToolChrome";
import { cn } from "../../ui/cn";
import { LaneIcon } from "../../ui/vcsIcons";
import { LaneBranchSwitcher } from "../detail/LaneBranchSwitcher";
import { LinearIssueBadge } from "../LinearIssueBadge";
import { COLORS, toneText } from "../laneDesignTokens";
import type { LaneRebaseLine } from "../laneRebaseNeeds";
import { providerDisplayName } from "./laneHistoryModel";
import { laneStatusItems, type LaneStatusItem, type LaneStatusTone } from "./laneOverviewModel";
import { cssZoomOf } from "../../../lib/webZoom";
import { LaneEmojiGlyph } from "../LaneEmojiGlyph";

function Sep() {
  return <span aria-hidden className="text-muted-fg/35">·</span>;
}

/**
 * About the lane menu's width in CSS pixels. The menu opens at the x it is
 * given, so the "…" button hands over a spot this far left of its own right
 * edge; the menu then opens down and to the left and stays inside the
 * overview column instead of covering the Git pane.
 */
// The lane menu's own width (LaneContextMenu minWidth plus room), so its right edge meets the button.
const LANE_MENU_WIDTH = 210;

/** The hosted web client zooms <body>; Electron zooms the whole frame (factor 1). */
const TONE_COLOR: Record<LaneStatusTone, string> = {
  muted: COLORS.textMuted,
  accent: "var(--ade-lane-violet, #B9A6F5)",
  warning: COLORS.warning,
  success: COLORS.success,
};

/**
 * A fact read off the lane's own git status (ahead/behind its base, uncommitted
 * work, and the "Up to date" that sums them), as opposed to the upstream
 * push/pull counts, which come from their own live read.
 */
function isLaneStatusFact(item: LaneStatusItem): boolean {
  return item.key !== "remote" || item.glyph === "check";
}

function StatusGlyph({ item }: { item: LaneStatusItem }) {
  const color = TONE_COLOR[item.tone];
  if (item.glyph === "up") return <ArrowUp size={12} weight="bold" style={{ color }} aria-hidden />;
  if (item.glyph === "down") return <ArrowDown size={12} weight="bold" style={{ color }} aria-hidden />;
  if (item.glyph === "cloud") return <CloudArrowUp size={13} weight="bold" style={{ color }} aria-hidden />;
  if (item.glyph === "check") return <Check size={12} weight="bold" style={{ color }} aria-hidden />;
  return <span aria-hidden className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: color }} />;
}

/** The small ghost button that runs the rebase the status line asks for. */
function RebaseAction({ line, onRebase }: { line: LaneRebaseLine; onRebase: () => void }) {
  return (
    <button
      type="button"
      className="kit-btn kit-btn-ghost shrink-0"
      data-size="sm"
      // Negative block margin keeps the 26px button from growing the line.
      style={{ marginBlock: -4 }}
      title={line.title}
      onClick={onRebase}
      data-testid="lane-rebase-action"
    >
      {line.actionLabel}
    </button>
  );
}

/**
 * The top of the lane overview: the lane's name and branch, where it came
 * from, a few actions, and its git state in one line. No card: the name is
 * the heading of the page, marked with the lane glyph in the lane's color
 * like the sidebar row.
 */
export function LaneIdentity({
  lane,
  accent,
  primaryLane,
  compareBase,
  rebaseLine,
  onRebase,
  upstream,
  createdBy,
  active,
  pin = null,
  machineId = null,
  canReveal,
  revealUnavailableReason = null,
  onStartChat,
  onOpenFiles,
  onOpenHistory,
  onReveal,
  onOpenMenu,
  statusStale = false,
}: {
  lane: LaneSummary;
  accent: string;
  primaryLane: LaneSummary | null;
  /** The branch ahead/behind is measured against: the open PR's base, else the lane's base. */
  compareBase: string;
  /** The quiet rebase line, when the lane needs one; adds a small Rebase action. */
  rebaseLine: LaneRebaseLine | null;
  onRebase: () => void;
  upstream: GitUpstreamSyncStatus | null;
  /** The chat that started with the lane, when known. */
  createdBy: { provider: string | null; title: string | null } | null;
  active: boolean;
  /** The lane's machine when it is not the tab's; the branch picker acts there. */
  pin?: OpenProjectBinding | null;
  /** That machine's id, for refreshing its lane list. */
  machineId?: string | null;
  canReveal: boolean;
  /**
   * Why reveal is shown but disabled ("On Mac Studio"): the lane's folder is on
   * another machine, and reveal only opens this Mac's Finder.
   */
  revealUnavailableReason?: string | null;
  onStartChat: (() => void) | null;
  onOpenFiles: () => void;
  /** History's commit graph, focused on this lane. */
  onOpenHistory?: () => void;
  onReveal: () => void;
  onOpenMenu: (anchor: DOMRect) => void;
  /**
   * The lane's git status was not measured within the freshness window (a read
   * is out, or failed): its facts render quietly, never as current.
   */
  statusStale?: boolean;
}) {
  const isPrimary = lane.laneType === "primary";
  const fromLabel = (lane.baseRef ?? "").replace(/^refs\/heads\//, "") || "base";
  // "Up to date" would contradict a lane that still needs a rebase.
  const status = laneStatusItems({ lane, baseLabel: compareBase, upstream })
    .filter((item) => !(rebaseLine && item.glyph === "check"));
  // "3 behind main" is already a status fact; the rebase line adds its action
  // after it. "Built on work now in main" has no status fact, so it is its own.
  const behindShown = status.some((item) => item.key === "behind");
  const menuRef = React.useRef<HTMLSpanElement>(null);

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="lane-identity">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="flex shrink-0" style={{ color: toneText(accent) }}>
              <LaneEmojiGlyph
                emoji={lane.emoji}
                icon={lane.icon}
                className="text-sm leading-none"
                fallback={<LaneIcon size={16} />}
              />
            </span>
            <h1 className="m-0 truncate text-[16px] font-semibold leading-[24px] tracking-[-0.01em] text-fg" title={lane.name}>
              {lane.name}
            </h1>
          </div>
          <div className="-mr-1.5 flex shrink-0 items-center gap-0.5" data-testid="lane-identity-actions">
            {onStartChat ? (
              <WorkToolChromeButton label="New chat in this lane" onClick={onStartChat} testId="lane-new-chat">
                <NotePencil size={16} />
              </WorkToolChromeButton>
            ) : null}
            <WorkToolChromeButton label="Open in Files" onClick={onOpenFiles} testId="lane-open-files">
              <FileCode size={16} />
            </WorkToolChromeButton>
            {onOpenHistory ? (
              <WorkToolChromeButton label="Commit history" onClick={onOpenHistory} testId="lane-open-history">
                <GitCommit size={16} />
              </WorkToolChromeButton>
            ) : null}
            {canReveal ? (
              <WorkToolChromeButton label={revealLabel} onClick={onReveal} testId="lane-reveal">
                <FolderOpen size={16} />
              </WorkToolChromeButton>
            ) : revealUnavailableReason ? (
              <WorkToolChromeButton
                label={`${revealLabel} · ${revealUnavailableReason}`}
                onClick={() => {}}
                disabled
                testId="lane-reveal"
              >
                <FolderOpen size={16} />
              </WorkToolChromeButton>
            ) : null}
            <span ref={menuRef} className="inline-flex">
              <WorkToolChromeButton
                label="More lane actions"
                onClick={() => {
                  const rect = menuRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  // Screen px throughout: the consumer converts a rect into its frame.
                  // The layout width and the 8px gutter are scaled to screen px here.
                  const zoom = cssZoomOf();
                  const right = rect.right;
                  const left = Math.max(8 * zoom, right - LANE_MENU_WIDTH * zoom);
                  onOpenMenu(new DOMRect(left, rect.top, right - left, rect.height));
                }}
                testId="lane-more"
              >
                <DotsThree size={16} weight="bold" />
              </WorkToolChromeButton>
            </span>
          </div>
        </div>
        {/* One line that never wraps: the branch gives way first. */}
        <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-[12px] text-muted-fg" data-testid="lane-identity-meta">
          <span className="-ml-2 -mr-1 flex min-w-0 shrink">
            <LaneBranchSwitcher lane={lane} primaryLane={primaryLane} active={active} pin={pin} machineId={machineId} />
          </span>
          <Sep />
          {isPrimary ? (
            <span className="shrink-0">Primary lane</span>
          ) : (
            <span className="shrink-0">from <span className="text-fg/80">{fromLabel}</span></span>
          )}
          {!isPrimary && lane.createdAt ? (
            <>
              <Sep />
              <span className="inline-flex shrink-0 items-center gap-1" title={new Date(lane.createdAt).toLocaleString()}>
                created {relativeWhen(lane.createdAt)}
                {createdBy?.provider ? (
                  <span className="inline-flex items-center gap-1" title={createdBy.title ?? undefined}>
                    {" "}by <ProviderLogo family={createdBy.provider} size={12} />
                    <span className="text-fg/80">{providerDisplayName(createdBy.provider)}</span>
                  </span>
                ) : null}
              </span>
            </>
          ) : null}
          {lane.linearIssue ? (
            <>
              <Sep />
              <span className="flex min-w-0 shrink">
                <LinearIssueBadge issue={lane.linearIssue} />
              </span>
            </>
          ) : null}
        </div>
      </div>

      {/* One line; a narrow column clips the last facts rather than wrapping. */}
      <div className="flex min-w-0 items-center gap-x-4 overflow-hidden whitespace-nowrap text-[12.5px] text-fg/75" data-testid="lane-status-line">
        {rebaseLine && (rebaseLine.kind === "built_on_merged" || !behindShown) ? (
          <span className="inline-flex shrink-0 items-center gap-1.5" title={rebaseLine.title} data-status="rebase">
            <span aria-hidden className="kit-dot" data-state="warn" />
            {rebaseLine.text}
            <RebaseAction line={rebaseLine} onRebase={onRebase} />
          </span>
        ) : null}
        {status.map((item) => (
          <span
            key={item.key}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 tabular-nums transition-opacity duration-150",
              statusStale && isLaneStatusFact(item) && "opacity-50",
            )}
            title={item.title}
            data-status={item.key}
            data-stale={(statusStale && isLaneStatusFact(item)) || undefined}
          >
            <StatusGlyph item={item} />
            {item.text}
            {item.key === "behind" && rebaseLine?.kind === "behind" ? (
              <RebaseAction line={rebaseLine} onRebase={onRebase} />
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}
