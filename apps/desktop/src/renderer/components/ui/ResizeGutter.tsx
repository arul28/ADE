import React from "react";
import { Separator } from "react-resizable-panels";
import { cn } from "./cn";

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
  return (
    <Separator
      className={cn(
        "group shrink-0",
        laneDivider
          ? "ade-lane-divider"
          : thin
            ? "ade-pane-gutter"
            : "ade-gutter",
        orientation === "vertical" ? "vertical" : "horizontal",
        className
      )}
      style={
        laneDivider
          ? orientation === "vertical"
            ? { width: 14 }
            : { height: 14 }
          : thin
            ? orientation === "vertical"
              ? { width: 8 }
              : { height: 8 }
            : undefined
      }
    >
      <div className={thin || laneDivider ? undefined : "ade-gutter-handle"}>
        <div className={thin || laneDivider ? undefined : "ade-gutter-pill"} />
      </div>
    </Separator>
  );
}
