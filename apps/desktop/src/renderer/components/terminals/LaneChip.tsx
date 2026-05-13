import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "../ui/cn";

export type LaneChipProps = {
  laneName: string;
  laneColor?: string | null;
  maxWidth?: number;
  className?: string;
  onClick?: () => void;
} & Omit<HTMLAttributes<HTMLElement>, "onClick" | "children">;

export function LaneChip({
  laneName,
  laneColor,
  maxWidth = 140,
  className,
  onClick,
  style,
  ...rest
}: LaneChipProps) {
  const hasColor = laneColor != null && String(laneColor).trim() !== "";
  const color = hasColor ? String(laneColor).trim() : null;
  const background = color
    ? `color-mix(in srgb, ${color} 85%, rgba(10,10,12,0.4))`
    : "color-mix(in srgb, var(--color-fg) 6%, transparent)";
  const border = color
    ? `1px solid color-mix(in srgb, ${color} 55%, rgba(255,255,255,0.08))`
    : "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)";
  const textColor = color ? "rgba(255,255,255,0.96)" : "var(--color-fg)";
  const chipClassName = cn(
    "inline-flex items-center text-[11px] font-medium leading-none rounded-full select-none transition-opacity",
    onClick ? "cursor-pointer hover:opacity-85" : null,
    className,
  );
  const chipStyle = {
    maxWidth,
    padding: "3px 8px",
    background,
    border,
    color: textColor,
    ...style,
  };
  const label = (
    <span className="overflow-hidden text-ellipsis whitespace-nowrap">
      {laneName}
    </span>
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
