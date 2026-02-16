import React from "react";
import { Separator } from "react-resizable-panels";
import { cn } from "./cn";

export function ResizeGutter({
  orientation,
  className,
  thin
}: {
  orientation: "vertical" | "horizontal";
  className?: string;
  thin?: boolean;
}) {
  return (
    <Separator
      className={cn(
        "group shrink-0",
        thin ? "ade-pane-gutter" : "ade-gutter",
        orientation === "vertical" ? "vertical" : "horizontal",
        className
      )}
    >
      <div className={thin ? undefined : "ade-gutter-handle"}>
        <div className={thin ? undefined : "ade-gutter-pill"} />
      </div>
    </Separator>
  );
}
