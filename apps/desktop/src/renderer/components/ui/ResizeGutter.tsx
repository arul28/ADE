import React from "react";
import { Separator } from "react-resizable-panels";
import { cn } from "./cn";

function getGutterVariant(laneDivider?: boolean, thin?: boolean): string {
  if (laneDivider) return "ade-lane-divider";
  if (thin) return "ade-pane-gutter";
  return "ade-gutter";
}

function getGutterStyle(
  orientation: "vertical" | "horizontal",
  laneDivider?: boolean,
  thin?: boolean
): React.CSSProperties | undefined {
  const isVertical = orientation === "vertical";
  if (laneDivider) return isVertical ? { width: 14 } : { height: 14 };
  if (thin) return isVertical ? { width: 8 } : { height: 8 };
  return undefined;
}

export function ResizeGutter({
  orientation,
  className,
  thin,
  laneDivider
}: {
  orientation: "vertical" | "horizontal";
  className?: string;
  thin?: boolean;
  laneDivider?: boolean;
}) {
  const showHandle = !thin && !laneDivider;

  return (
    <Separator
      className={cn(
        "group shrink-0",
        getGutterVariant(laneDivider, thin),
        orientation === "vertical" ? "vertical" : "horizontal",
        className
      )}
      style={getGutterStyle(orientation, laneDivider, thin)}
    >
      <div className={showHandle ? "ade-gutter-handle" : undefined}>
        <div className={showHandle ? "ade-gutter-pill" : undefined} />
      </div>
    </Separator>
  );
}
