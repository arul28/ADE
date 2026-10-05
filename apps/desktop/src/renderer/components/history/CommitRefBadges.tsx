import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Cloud, GitPullRequest } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { BranchIcon, LaneIcon } from "../ui/vcsIcons";
import { Z_LAYERS } from "../ui/zLayers";
import type { CommitRefBadge } from "./commitRowModel";
import { PR_STATE_COLOR } from "./commitRowModel";

export type RefBadgeActions = {
  /** Lanes tab, with the lane selected. */
  onOpenLane: (laneId: string) => void;
  /** History, focused on the lane. */
  onFocusLane: (laneId: string) => void;
  onOpenPr: (badge: CommitRefBadge) => void;
  onCopy: (text: string) => void;
  onFocusOwner: (owner: string | null) => void;
};

function BadgeFace({ badge, laneColor }: { badge: CommitRefBadge; laneColor: string | null }) {
  const label = badge.lane ? badge.lane.name : badge.branch;
  return (
    <>
      {badge.lane ? (
        <LaneIcon size={11} weight={badge.isCurrent ? "bold" : "regular"} style={{ color: laneColor ?? undefined }} />
      ) : badge.kind === "remote" ? (
        <Cloud size={11} className="shrink-0 opacity-70" aria-hidden />
      ) : (
        <BranchIcon size={11} className="opacity-70" />
      )}
      <span className="min-w-0 truncate">{label}</span>
      {badge.synced ? <Cloud size={10} weight="fill" className="shrink-0 opacity-45" aria-hidden /> : null}
      {badge.pr ? (
        <span className="inline-flex shrink-0 items-center gap-0.5 tabular-nums" style={{ color: PR_STATE_COLOR[badge.pr.state] }}>
          <GitPullRequest size={10} weight="bold" aria-hidden />
          {badge.pr.githubPrNumber}
        </span>
      ) : null}
    </>
  );
}

function badgeTitle(badge: CommitRefBadge): string {
  const parts: string[] = [];
  if (badge.lane) parts.push(`Lane ${badge.lane.name}`);
  parts.push(badge.kind === "remote" ? `Remote branch ${badge.branch}` : `Branch ${badge.branch}`);
  if (badge.isCurrent) parts.push("checked out");
  if (badge.synced) parts.push("in sync with remote");
  if (badge.pr) parts.push(`PR #${badge.pr.githubPrNumber} ${badge.pr.state}`);
  return parts.join(" · ");
}

const MENU_ITEM = cn(
  "flex cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12px] text-fg outline-none",
  "data-[highlighted]:bg-white/[0.07] data-[disabled]:cursor-default data-[disabled]:opacity-40",
);

function RefBadge({
  badge,
  laneColor,
  focusLaneId,
  actions,
  ownerKey,
}: {
  badge: CommitRefBadge;
  laneColor: string | null;
  focusLaneId: string | null;
  actions: RefBadgeActions;
  ownerKey: string | null;
}) {
  const tinted = badge.lane && laneColor;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title={badgeTitle(badge)}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerEnter={() => actions.onFocusOwner(ownerKey)}
          onPointerLeave={() => actions.onFocusOwner(null)}
          className={cn(
            "inline-flex h-[18px] min-w-[92px] max-w-[176px] shrink items-center gap-1 rounded-[5px] px-1.5 text-[11px] font-medium leading-none",
            "transition-[background-color,box-shadow] duration-100 outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
            tinted ? null : "bg-white/[0.06] text-fg/75 hover:bg-white/[0.1]",
            badge.isCurrent && !tinted ? "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]" : null,
          )}
          style={tinted ? {
            color: `color-mix(in srgb, ${laneColor} 82%, var(--color-fg))`,
            background: `color-mix(in srgb, ${laneColor} ${badge.isCurrent ? 22 : 13}%, transparent)`,
            boxShadow: badge.isCurrent ? `inset 0 0 0 1px color-mix(in srgb, ${laneColor} 45%, transparent)` : undefined,
          } : undefined}
        >
          <BadgeFace badge={badge} laneColor={laneColor} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="min-w-[200px] rounded-[9px] border border-white/[0.08] bg-[var(--color-card)] p-1 shadow-xl"
          style={{ zIndex: Z_LAYERS.popover }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex min-w-0 items-center gap-1.5 px-2 pb-1.5 pt-1 text-[11px] text-muted-fg">
            <BranchIcon size={11} />
            <span className="min-w-0 truncate font-mono">{badge.branch}</span>
          </div>
          {badge.lane ? (
            <>
              {badge.lane.id !== focusLaneId ? (
                <DropdownMenu.Item className={MENU_ITEM} onSelect={() => actions.onFocusLane(badge.lane!.id)}>
                  <LaneIcon size={13} style={{ color: laneColor ?? undefined }} />
                  Show this lane's history
                </DropdownMenu.Item>
              ) : null}
              <DropdownMenu.Item className={MENU_ITEM} onSelect={() => actions.onOpenLane(badge.lane!.id)}>
                <LaneIcon size={13} style={{ color: laneColor ?? undefined }} />
                Open {badge.lane.name} in Lanes
              </DropdownMenu.Item>
            </>
          ) : null}
          {badge.pr ? (
            <DropdownMenu.Item className={MENU_ITEM} onSelect={() => actions.onOpenPr(badge)}>
              <GitPullRequest size={13} style={{ color: PR_STATE_COLOR[badge.pr.state] }} />
              Open PR #{badge.pr.githubPrNumber}
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => actions.onCopy(badge.branch)}>
            <BranchIcon size={13} className="opacity-70" />
            Copy branch name
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * A commit's refs: the first two as badges, the rest as "+N". A badge opens a
 * small menu: the lane's history, the lane in Lanes, its PR, copy the name.
 */
export const CommitRefBadges = React.memo(function CommitRefBadges({
  badges,
  max,
  colorOfLane,
  ownerOfLane,
  focusLaneId,
  actions,
}: {
  badges: CommitRefBadge[];
  max: number;
  colorOfLane: (laneId: string) => string | null;
  ownerOfLane: (laneId: string) => string | null;
  focusLaneId: string | null;
  actions: RefBadgeActions;
}) {
  const shown = badges.slice(0, max);
  const hidden = badges.slice(max);
  return (
    <span className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 overflow-hidden">
      {shown.map((badge) => (
        <RefBadge
          key={badge.key}
          badge={badge}
          laneColor={badge.lane ? colorOfLane(badge.lane.id) : null}
          focusLaneId={focusLaneId}
          actions={actions}
          ownerKey={badge.lane ? ownerOfLane(badge.lane.id) : null}
        />
      ))}
      {hidden.length > 0 ? (
        <span
          className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-white/[0.05] px-1.5 text-[11px] font-medium tabular-nums text-muted-fg"
          title={hidden.map((badge) => (badge.lane ? `${badge.lane.name} (${badge.branch})` : badge.branch)).join("\n")}
        >
          +{hidden.length}
        </span>
      ) : null}
    </span>
  );
});
