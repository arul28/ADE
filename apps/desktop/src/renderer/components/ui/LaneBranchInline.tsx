import type { CSSProperties, MouseEvent } from "react";
import { cn } from "./cn";
import { BranchIcon, LaneIcon } from "./vcsIcons";

/** Lane + branch metadata row (sidebar lane tabs, grid tile headers, etc.). */
export function LaneBranchInline({
  laneName,
  branchLabel,
  laneColor,
  laneClassName,
  branchClassName,
  iconSize = 12,
  textClassName = "text-[12px] font-medium leading-snug",
  style,
  onLaneClick,
  onLaneContextMenu,
}: {
  laneName: string;
  branchLabel?: string | null;
  laneColor?: string | null;
  laneClassName?: string;
  branchClassName?: string;
  iconSize?: number;
  textClassName?: string;
  style?: CSSProperties;
  onLaneClick?: () => void;
  onLaneContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const branchText = branchLabel?.trim() ?? "";
  const showBranch = branchText.length > 0;
  const laneColorStyle = laneColor?.trim() ? { color: laneColor.trim() } : undefined;

  const laneClusterClassName = cn(
    "ade-lane-branch-inline-lane inline-flex min-w-0 shrink-0 items-center gap-1.5 overflow-hidden border-0 bg-transparent p-0",
    onLaneClick ? "cursor-pointer transition-opacity hover:opacity-80" : undefined,
    laneClassName,
  );
  const laneClusterInner = (
    <>
      <LaneIcon size={iconSize} weight="regular" className="opacity-80" />
      <span className={cn("min-w-0 truncate", textClassName)}>{laneName}</span>
    </>
  );
  const laneCluster = onLaneClick ? (
    <button
      type="button"
      className={laneClusterClassName}
      style={laneColorStyle}
      title={laneName}
      onClick={onLaneClick}
      onContextMenu={onLaneContextMenu}
    >
      {laneClusterInner}
    </button>
  ) : (
    <span
      className={laneClusterClassName}
      style={laneColorStyle}
      title={laneName}
      onContextMenu={onLaneContextMenu}
    >
      {laneClusterInner}
    </span>
  );

  return (
    <div
      className={cn(
        "ade-lane-branch-inline flex min-w-0 items-center gap-2 overflow-hidden",
        showBranch ? "shrink" : "shrink-0",
      )}
      style={style}
    >
      {laneCluster}
      {showBranch ? (
        <span
          className={cn(
            "ade-lane-branch-inline-branch ml-auto inline-flex min-w-0 shrink-[999] items-center gap-1.5 overflow-hidden text-muted-fg/75",
            branchClassName,
          )}
          title={branchText}
        >
          <BranchIcon size={iconSize} weight="regular" className="opacity-60" />
          <span className={cn("min-w-0 truncate", textClassName, "text-muted-fg/75")}>{branchText}</span>
        </span>
      ) : null}
    </div>
  );
}
