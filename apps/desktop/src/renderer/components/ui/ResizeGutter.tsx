import React from "react";
import { Separator } from "react-resizable-panels";
import { cn } from "./cn";

export function ResizeGutter({
  orientation,
  className
}: {
  orientation: "vertical" | "horizontal";
  className?: string;
}) {
  return (
    <Separator
      className={cn(
        "ade-gutter group shrink-0",
        orientation === "vertical" ? "vertical" : "horizontal",
        className
      )}
    >
      <div className="ade-gutter-handle">
        <div className="ade-gutter-pill" />
      </div>
    </Separator>
  );
}
