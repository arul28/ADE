import React from "react";
import { ArrowDown, CircleDashed, CircleNotch, UsersThree, Warning } from "@phosphor-icons/react";
import type { LaneListSnapshot, LaneSummary } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { relativeTimeCompact } from "../../../lib/format";
import { ToolLogo } from "../../terminals/ToolLogos";
import { BranchIcon, LaneIcon } from "../../ui/vcsIcons";
import { LinearMark } from "../linearBrand";
import { getLaneAccent } from "../laneColorPalette";
import { COLORS } from "../laneDesignTokens";
import type { LaneAgent } from "../laneAgents";
import type { LaneTabPrTag } from "../lanePageModel";
import { LaneSidebarPrChip } from "./LaneSidebarPrChip";
import {
  LANE_SIDEBAR_INDENT_PX,
  laneAgentToolType,
  laneBranchLabel,
  laneLastActivityAt,
  laneSidebarAgentStatus,
} from "./laneSidebarModel";

const MAX_AVATARS = 3;
const AVATAR_SIZE = 14;
const ROW_PAD_X = 8;

type LaneRuntime = LaneListSnapshot["runtime"];

export type LaneSidebarRowProps = {
  lane: LaneSummary;
  depth: number;
  indentLevel: number;
  fallbackColorIndex: number;
  selected: boolean;
  multiSelected: boolean;
  pulsing: boolean;
  runtime: LaneRuntime | null;
  agents: LaneAgent[];
  prs: LaneTabPrTag[] | undefined;
  rebaseSuggestion: LaneListSnapshot["rebaseSuggestion"];
  autoRebaseStatus: LaneListSnapshot["autoRebaseStatus"];
  /** Set while a delete runs; the row is inert and shows the step. */
  deleteStatusLabel: string | null;
  creating: boolean;
  /** Stack parent shown as "↳ name" when the row is not indented under it. */
  parentHint?: string | null;
  /** Why the lane needs the user (PR failing, rebase broke…), or null. */
  needsYouReason?: string | null;
  onSelect: (laneId: string, event: React.MouseEvent) => void;
  onContextMenu: (laneId: string, event: React.MouseEvent) => void;
  onOpenPr: (pr: LaneTabPrTag) => void;
  onOpenAgent: (agent: LaneAgent) => void;
};

/** Thin vertical guides, one per indent level, like an editor's file tree. */
function IndentGuides({ indentLevel }: { indentLevel: number }) {
  if (indentLevel <= 0) return null;
  return (
    <>
      {Array.from({ length: indentLevel }, (_, index) => (
        <span
          key={index}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px"
          style={{
            left: ROW_PAD_X + 5 + index * LANE_SIDEBAR_INDENT_PX,
            background: "color-mix(in srgb, var(--color-fg) 10%, transparent)",
          }}
        />
      ))}
    </>
  );
}

function AgentCluster({
  lane,
  agents,
  runtime,
  needsYouReason,
  onOpenAgent,
}: {
  lane: LaneSummary;
  agents: LaneAgent[];
  runtime: LaneRuntime | null;
  needsYouReason: string | null;
  onOpenAgent: (agent: LaneAgent) => void;
}) {
  const agentStatus = laneSidebarAgentStatus(agents, runtime);
  // A lane can need the user without any agent asking (a failing PR, a broken
  // rebase). It still gets the amber dot, with the reason as its tooltip.
  const status = agentStatus
    ?? (needsYouReason ? { tone: "attention" as const, agents: [] as LaneAgent[], label: needsYouReason } : null);
  if (!status) return null;
  const shown = status.agents.slice(0, MAX_AVATARS);
  const hidden = status.agents.length - shown.length;
  const attention = status.tone === "attention" || needsYouReason != null;
  const label = needsYouReason && status.tone !== "attention" ? `${status.label} · ${needsYouReason}` : status.label;
  return (
    <span
      className="flex shrink-0 items-center gap-1"
      data-testid="lane-sidebar-agent-status"
      data-tone={attention ? "attention" : status.tone}
      title={`${lane.name}: ${label}`}
    >
      {shown.length > 0 ? (
        <span className="flex items-center">
          {shown.map((agent, index) => (
            <button
              key={agent.sessionId}
              type="button"
              tabIndex={-1}
              className="relative inline-flex items-center justify-center rounded-full bg-bg ring-2 ring-bg transition-transform hover:z-10 hover:scale-110"
              style={{ width: AVATAR_SIZE, height: AVATAR_SIZE, marginLeft: index === 0 ? 0 : -4, zIndex: MAX_AVATARS - index }}
              title={`${agent.name} · ${agent.providerLabel}${agent.activity === "awaiting-input" ? " · waiting for you" : ""}`}
              aria-label={`Open ${agent.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenAgent(agent);
              }}
            >
              <ToolLogo toolType={laneAgentToolType(agent)} size={AVATAR_SIZE} className="block shrink-0" />
            </button>
          ))}
          {hidden > 0 ? (
            <span className="ml-1 text-[10px] tabular-nums" style={{ color: COLORS.textDim }}>+{hidden}</span>
          ) : null}
        </span>
      ) : null}
      {/* Same status marks as the Work list: a filled amber dot when it is
          your move, the dashed "working" circle otherwise. */}
      {attention ? (
        <span aria-hidden className="inline-block h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: COLORS.warning }} />
      ) : (
        <CircleDashed size={12} weight="bold" aria-hidden className="shrink-0 text-sky-400 motion-safe:animate-[spin_3s_linear_infinite]" />
      )}
    </span>
  );
}

function RebaseHint({
  lane,
  rebaseSuggestion,
  autoRebaseStatus,
}: Pick<LaneSidebarRowProps, "lane" | "rebaseSuggestion" | "autoRebaseStatus">) {
  const broken = autoRebaseStatus?.state === "rebaseConflict" || autoRebaseStatus?.state === "rebaseFailed";
  if (broken) {
    return (
      <span className="inline-flex shrink-0" title={autoRebaseStatus?.message ?? "Rebase needs attention"} style={{ color: COLORS.danger }}>
        <Warning size={11} weight="bold" />
      </span>
    );
  }
  // Only a rebase ADE suggests is worth a mark in the list; the plain
  // ahead/behind counts live in the lane header.
  if (!rebaseSuggestion || lane.laneType === "primary") return null;
  const behind = rebaseSuggestion.behindCount;
  const base = rebaseSuggestion.baseLabel?.trim() || laneBranchLabel(lane.baseRef) || "base";
  return (
    <span
      className="inline-flex shrink-0 items-center text-[10.5px] tabular-nums"
      title={`Needs rebase: ${behind} commit${behind === 1 ? "" : "s"} behind ${base}`}
      style={{ color: COLORS.warning }}
    >
      <ArrowDown size={10} weight="bold" />
      {behind}
    </span>
  );
}

function devicePresenceTitle(devicesOpen: NonNullable<LaneSummary["devicesOpen"]>): string {
  const names = devicesOpen.map((device) => device.displayName.trim()).filter(Boolean);
  if (names.length === 0) return "Open on another device";
  if (names.length === 1) return `Open on ${names[0]}`;
  return `Open on ${names.length} devices: ${names.join(", ")}`;
}

/**
 * One lane in the sidebar list, drawn like a lane card in the Work list.
 * Line one: the lane glyph and name in the lane's color, then live agents and
 * the time since anything happened. Line two, muted: branch, PR, git hints.
 */
export const LaneSidebarRow = React.memo(function LaneSidebarRow(props: LaneSidebarRowProps) {
  const {
    lane,
    depth,
    indentLevel,
    fallbackColorIndex,
    selected,
    multiSelected,
    pulsing,
    runtime,
    agents,
    prs,
    rebaseSuggestion,
    autoRebaseStatus,
    deleteStatusLabel,
    creating,
    parentHint = null,
    needsYouReason = null,
    onSelect,
    onContextMenu,
    onOpenPr,
    onOpenAgent,
  } = props;
  const deleting = deleteStatusLabel != null;
  const branch = laneBranchLabel(lane.branchRef);
  const lastActivityAt = laneLastActivityAt(lane, agents);
  const devicesOpen = lane.devicesOpen ?? [];
  // The lane color lives on the name only, as in the Work list.
  const accent = getLaneAccent(lane, fallbackColorIndex);

  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={deleting || undefined}
      data-lane-id={lane.id}
      data-testid="lane-sidebar-row"
      data-tour={selected && lane.laneType !== "primary" && !deleting ? "lanes.laneTab" : undefined}
      tabIndex={-1}
      // Dragging a row out of ADE drops an "Open in ADE" link into chat apps.
      draggable={!deleting}
      onDragStart={(event) => {
        if (deleting) return;
        const url = `ade://lane/${encodeURIComponent(lane.id)}`;
        const title = (lane.name || "ADE lane")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
        event.dataTransfer.effectAllowed = "copyLink";
        event.dataTransfer.setData("text/uri-list", url);
        event.dataTransfer.setData("text/plain", url);
        event.dataTransfer.setData("text/html", `<a href="${url}">${title}</a>`);
      }}
      // Surface is for interaction only, as in the Work list: a neutral fill
      // on hover and a slightly stronger one when selected.
      className={cn(
        "group relative flex cursor-pointer select-none flex-col gap-1 rounded-md py-[7px] transition-colors duration-100",
        selected
          ? "bg-fg/[0.07]"
          : multiSelected
            ? "bg-fg/[0.05] ring-1 ring-inset ring-accent/35"
            : "hover:bg-fg/[0.045]",
        deleting && "cursor-not-allowed opacity-55",
        pulsing && "ade-lane-row-pulse",
      )}
      style={{
        paddingLeft: ROW_PAD_X + indentLevel * LANE_SIDEBAR_INDENT_PX,
        paddingRight: ROW_PAD_X,
      }}
      onClick={(event) => {
        if (deleting) return;
        onSelect(lane.id, event);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (deleting) return;
        onContextMenu(lane.id, event);
      }}
    >
      <IndentGuides indentLevel={indentLevel} />

      <div className="flex h-4 min-w-0 items-center gap-1.5">
        <span
          className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] font-semibold leading-4"
          style={{ color: accent }}
          title={depth > indentLevel ? `${lane.name} (stack level ${depth + 1})` : lane.name}
        >
          <LaneIcon size={12} />
          <span className="min-w-0 truncate">{lane.name}</span>
        </span>
        {deleting || creating ? (
          <CircleNotch size={12} className="shrink-0 animate-spin" style={{ color: deleting ? COLORS.textMuted : COLORS.accent }} />
        ) : (
          <>
            <AgentCluster
              lane={lane}
              agents={agents}
              runtime={runtime}
              needsYouReason={needsYouReason}
              onOpenAgent={onOpenAgent}
            />
            {lastActivityAt ? (
              <span className="shrink-0 text-[11px] tabular-nums leading-4 text-muted-fg/60">
                {relativeTimeCompact(lastActivityAt)}
              </span>
            ) : null}
          </>
        )}
      </div>

      <div className="flex h-4 min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-fg/70">
        {deleting ? (
          <span className="truncate">{deleteStatusLabel}</span>
        ) : creating ? (
          <span className="truncate">Setting up…</span>
        ) : (
          <>
            {parentHint ? (
              <span
                className="min-w-0 max-w-[45%] shrink truncate text-muted-fg/55"
                title={`Stacked on ${parentHint}`}
                data-testid="lane-sidebar-parent-hint"
              >
                ↳ {parentHint}
              </span>
            ) : null}
            <span className="flex min-w-0 shrink items-center gap-1" title={branch}>
              <BranchIcon size={11} className="opacity-60" />
              <span className="min-w-0 truncate">{branch}</span>
            </span>
            <span className="min-w-0 flex-1" />
            <RebaseHint lane={lane} rebaseSuggestion={rebaseSuggestion} autoRebaseStatus={autoRebaseStatus} />
            {lane.linearIssue ? (
              <span
                className="inline-flex shrink-0 opacity-60"
                title={`${lane.linearIssue.identifier} · ${lane.linearIssue.title}`}
              >
                <LinearMark size={10} />
              </span>
            ) : null}
            {devicesOpen.length > 0 ? (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums"
                title={devicePresenceTitle(devicesOpen)}
              >
                <UsersThree size={11} />
                {devicesOpen.length > 1 ? devicesOpen.length : null}
              </span>
            ) : null}
            {prs && prs.length > 0 ? <LaneSidebarPrChip prs={prs} onOpenPr={onOpenPr} /> : null}
          </>
        )}
      </div>
    </div>
  );
});

/** Placeholder for a lane a batch launch is still creating. */
export function LaneSidebarCreatingRow({ name }: { name: string }) {
  return (
    <div
      aria-disabled
      data-testid="lane-sidebar-creating-row"
      className="pointer-events-none flex flex-col gap-1 rounded-md py-[7px] opacity-80"
      style={{ paddingLeft: ROW_PAD_X, paddingRight: ROW_PAD_X }}
      title={`Creating ${name}…`}
    >
      <div className="flex h-4 min-w-0 items-center gap-1.5 text-[12px] font-semibold text-fg/75">
        <CircleNotch size={12} className="shrink-0 animate-spin" style={{ color: COLORS.accent }} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </div>
      <div className="h-4 text-[11px] leading-4 text-muted-fg/70">Creating…</div>
    </div>
  );
}
