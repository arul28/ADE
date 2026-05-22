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
  thin?: boolean,
  narrow?: boolean,
): React.CSSProperties | undefined {
  const isVertical = orientation === "vertical";
  if (laneDivider) return isVertical ? { width: 7 } : { height: 7 };
  if (narrow) return isVertical ? { width: 4 } : { height: 4 };
  if (thin) return isVertical ? { width: 8 } : { height: 8 };
  return undefined;
}

export function ResizeGutter({
  orientation,
  className,
  thin,
  laneDivider,
  narrow,
}: {
  orientation: "vertical" | "horizontal";
  className?: string;
  thin?: boolean;
  laneDivider?: boolean;
  narrow?: boolean;
}) {
  const useThinStyle = thin || narrow;
  const showHandle = !useThinStyle && !laneDivider;

  return (
    <Separator
      className={cn(
        "group shrink-0",
        getGutterVariant(laneDivider, useThinStyle),
        orientation === "vertical" ? "vertical" : "horizontal",
        className
      )}
      style={getGutterStyle(orientation, laneDivider, thin, narrow)}
    >
      <div className={showHandle ? "ade-gutter-handle" : undefined}>
        <div className={showHandle ? "ade-gutter-pill" : undefined} />
      </div>
    </Separator>
  );
}
