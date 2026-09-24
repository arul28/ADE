import React from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CloudArrowUp,
  DotsThree,
  FileCode,
  FolderOpen,
  NotePencil,
} from "@phosphor-icons/react";
import type { GitUpstreamSyncStatus, LaneSummary } from "../../../../shared/types";
import { relativeWhen } from "../../../lib/format";
import { revealLabel } from "../../../lib/platform";
import { ProviderLogo } from "../../shared/ProviderLogos";
import { WorkToolChromeButton } from "../../terminals/workToolChrome";
import { LaneIcon } from "../../ui/vcsIcons";
import { LaneBranchSwitcher } from "../detail/LaneBranchSwitcher";
import { LinearIssueBadge } from "../LinearIssueBadge";
import { COLORS } from "../laneDesignTokens";
import { providerDisplayName } from "./laneHistoryModel";
import { laneStatusItems, type LaneStatusItem, type LaneStatusTone } from "./laneOverviewModel";

function Sep() {
  return <span aria-hidden className="text-muted-fg/35">·</span>;
}

/**
 * About the lane menu's width in CSS pixels. The menu opens at the x it is
 * given, so the "…" button hands over a spot this far left of its own right
 * edge; the menu then opens down and to the left and stays inside the
 * overview column instead of covering the Git pane.
 */
const LANE_MENU_WIDTH = 340;

/** The hosted web client zooms <body>; Electron zooms the whole frame (factor 1). */
function webZoomFactor(): number {
  const raw = document.documentElement?.style?.getPropertyValue("--ade-web-zoom-factor");
  const factor = raw ? Number.parseFloat(raw) : 1;
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

const TONE_COLOR: Record<LaneStatusTone, string> = {
  muted: COLORS.textMuted,
  accent: "var(--ade-lane-violet, #B9A6F5)",
  warning: COLORS.warning,
  success: COLORS.success,
};

function StatusGlyph({ item }: { item: LaneStatusItem }) {
  const color = TONE_COLOR[item.tone];
  if (item.glyph === "up") return <ArrowUp size={12} weight="bold" style={{ color }} aria-hidden />;
  if (item.glyph === "down") return <ArrowDown size={12} weight="bold" style={{ color }} aria-hidden />;
  if (item.glyph === "cloud") return <CloudArrowUp size={13} weight="bold" style={{ color }} aria-hidden />;
  if (item.glyph === "check") return <Check size={12} weight="bold" style={{ color }} aria-hidden />;
  return <span aria-hidden className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: color }} />;
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
  parentLane,
  upstream,
  createdBy,
  active,
  canReveal,
  onStartChat,
  onOpenFiles,
  onReveal,
  onOpenMenu,
  onSelectLane,
}: {
  lane: LaneSummary;
  accent: string;
  primaryLane: LaneSummary | null;
  parentLane: LaneSummary | null;
  upstream: GitUpstreamSyncStatus | null;
  /** The chat that started with the lane, when known. */
  createdBy: { provider: string | null; title: string | null } | null;
  active: boolean;
  canReveal: boolean;
  onStartChat: (() => void) | null;
  onOpenFiles: () => void;
  onReveal: () => void;
  onOpenMenu: (anchor: DOMRect) => void;
  onSelectLane: (laneId: string) => void;
}) {
  const isPrimary = lane.laneType === "primary";
  const baseLabel = (parentLane?.branchRef ?? lane.baseRef ?? "").replace(/^refs\/heads\//, "") || "base";
  const status = laneStatusItems({ lane, baseLabel, upstream });
  const menuRef = React.useRef<HTMLSpanElement>(null);

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="lane-identity">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="flex shrink-0" style={{ color: accent }}>
              <LaneIcon size={16} />
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
            {canReveal ? (
              <WorkToolChromeButton label={revealLabel} onClick={onReveal} testId="lane-reveal">
                <FolderOpen size={16} />
              </WorkToolChromeButton>
            ) : null}
            <span ref={menuRef} className="inline-flex">
              <WorkToolChromeButton
                label="More lane actions"
                onClick={() => {
                  const rect = menuRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  // The menu is placed in CSS pixels inside <body>, so undo
                  // any hosted-web zoom on the button's screen position.
                  const zoom = webZoomFactor();
                  const right = rect.right / zoom;
                  const left = Math.max(8, right - LANE_MENU_WIDTH);
                  onOpenMenu(new DOMRect(left, rect.top / zoom, right - left, rect.height / zoom));
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
            <LaneBranchSwitcher lane={lane} primaryLane={primaryLane} active={active} />
          </span>
          <Sep />
          {isPrimary ? (
            <span className="shrink-0">Primary lane</span>
          ) : parentLane ? (
            <span className="inline-flex min-w-0 shrink items-center">
              <span className="min-w-0 truncate">
                stacked on{" "}
                <button
                  type="button"
                  className="text-fg/80 underline-offset-2 transition-colors hover:text-fg hover:underline"
                  onClick={() => onSelectLane(parentLane.id)}
                  data-testid="lane-identity-parent"
                >
                  {parentLane.name}
                </button>
              </span>
            </span>
          ) : (
            <span className="shrink-0">from <span className="text-fg/80">{baseLabel}</span></span>
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
        {status.map((item) => (
          <span key={item.key} className="inline-flex shrink-0 items-center gap-1.5 tabular-nums" title={item.title} data-status={item.key}>
            <StatusGlyph item={item} />
            {item.text}
          </span>
        ))}
      </div>
    </div>
  );
}
