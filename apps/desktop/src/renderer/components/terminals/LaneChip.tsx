import type { ButtonHTMLAttributes, HTMLAttributes, MouseEvent } from "react";
import { cn } from "../ui/cn";
import { LaneIcon, BranchIcon } from "../ui/vcsIcons";

const DEFAULT_LANE_COLOR = "#ffffff";

export function laneDisplayColor(laneColor?: string | null): string {
  const trimmed = laneColor?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_LANE_COLOR;
}

export function LaneLogoMark({
  color,
  size = 10,
}: {
  color: string;
  size?: number;
}) {
  return <LaneIcon size={size} weight="regular" className="shrink-0" style={{ color }} />;
}

export type LaneChipProps = {
  laneName: string;
  laneColor?: string | null;
  maxWidth?: number;
  compact?: boolean;
  className?: string;
  onClick?: () => void;
} & Omit<HTMLAttributes<HTMLElement>, "onClick" | "children">;

export function LaneChip({
  laneName,
  laneColor,
  maxWidth = 140,
  compact = false,
  className,
  onClick,
  style,
  ...rest
}: LaneChipProps) {
  const color = laneDisplayColor(laneColor);
  const chipClassName = cn(
    "inline-flex min-w-0 items-center gap-1 font-medium leading-none select-none",
    compact ? "text-[9px]" : "text-[10px]",
    onClick ? "cursor-pointer transition-opacity hover:opacity-80" : null,
    className,
  );
  const chipStyle = {
    maxWidth,
    color,
    ...style,
  };
  const label = (
    <>
      <LaneLogoMark color={color} size={compact ? 9 : 10} />
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
        {laneName}
      </span>
    </>
  );

  if (onClick) {
    return (
      <button
        {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
        type="button"
        onClick={onClick}
        className={chipClassName}
        style={chipStyle}
        title={laneName}
      >
        {label}
      </button>
    );
  }

  return (
    <span
      {...rest}
      className={chipClassName}
      style={chipStyle}
      title={laneName}
    >
      {label}
    </span>
  );
}

export function SessionLaneHeaderLabel({
  sessionTitle,
  laneName,
  laneColor,
  branchLabel,
  laneMaxWidth = 120,
  sessionTitleClassName,
  onSessionTitleClick,
  onLaneClick,
  onLaneContextMenu,
}: {
  sessionTitle: string;
  laneName: string;
  laneColor?: string | null;
  /** Git branch label (e.g. from `branchNameFromRef`); truncates before lane/session title. */
  branchLabel?: string | null;
  laneMaxWidth?: number;
  sessionTitleClassName?: string;
  /** Opens this session in the Work tabs view. */
  onSessionTitleClick?: () => void;
  onLaneClick?: () => void;
  onLaneContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const color = laneDisplayColor(laneColor);
  const branchText = branchLabel?.trim() ?? "";
  const sessionTitleClass = cn(
    "ade-session-lane-header-title min-w-0 shrink-0 truncate text-[13px] font-bold leading-none text-fg/90",
    onSessionTitleClick ? "cursor-pointer transition-opacity hover:opacity-80" : undefined,
    sessionTitleClassName,
  );
  const sessionTitleNode = onSessionTitleClick ? (
    <button
      type="button"
      className={cn(sessionTitleClass, "border-0 bg-transparent p-0 text-left")}
      title={`Open in Tabs view: ${sessionTitle}`}
      onClick={(event) => {
        event.stopPropagation();
        onSessionTitleClick();
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {sessionTitle}
    </button>
  ) : (
    <span className={sessionTitleClass} title={sessionTitle}>
      {sessionTitle}
    </span>
  );

  return (
    <div className="ade-session-lane-header flex w-full min-w-0 items-center gap-1.5 overflow-hidden">
      {sessionTitleNode}
      {onLaneClick ? (
        <button
          type="button"
          className={cn(
            "ade-lane-branch-inline-lane inline-flex min-w-0 shrink items-center gap-1.5 overflow-hidden border-0 bg-transparent p-0",
            "cursor-pointer transition-opacity hover:opacity-80",
          )}
          style={{ color }}
          title={`Open lane: ${laneName}`}
          onClick={(event) => {
            event.stopPropagation();
            onLaneClick?.();
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={onLaneContextMenu}
        >
          <LaneIcon size={12} weight="regular" className="opacity-80" />
          <span className="min-w-0 truncate text-[11px] font-medium leading-none">{laneName}</span>
        </button>
      ) : (
        <span
          className="ade-lane-branch-inline-lane inline-flex min-w-0 shrink items-center gap-1.5 overflow-hidden"
          style={{ color }}
          title={laneName}
          onContextMenu={onLaneContextMenu}
        >
          <LaneIcon size={12} weight="regular" className="opacity-80" />
          <span className="min-w-0 truncate text-[11px] font-medium leading-none">{laneName}</span>
        </span>
      )}
      {branchText ? (
        <span
          className="ade-lane-branch-inline-branch ml-auto inline-flex min-w-0 shrink-[999] items-center gap-1.5 overflow-hidden text-muted-fg/75"
          title={branchText}
        >
          <BranchIcon size={12} weight="regular" className="opacity-60" />
          <span className="min-w-0 truncate text-[11px] font-medium leading-none text-muted-fg/75">{branchText}</span>
        </span>
      ) : null}
    </div>
  );
}
