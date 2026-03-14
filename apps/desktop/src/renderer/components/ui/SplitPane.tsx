import React from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { Layout } from "react-resizable-panels";
import { cn } from "./cn";

export { Panel as SplitPanePanel, Separator as SplitPaneSeparator };
export { ResizeGutter } from "./ResizeGutter";
export type SplitPaneLayout = Layout;

export function SplitPane({
  id,
  defaultLayout,
  onLayoutChanged,
  className,
  children
}: {
  id: string;
  defaultLayout: SplitPaneLayout;
  onLayoutChanged?: (layout: SplitPaneLayout) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Group
      id={id}
      orientation="horizontal"
      className={cn(
        "h-full w-full overflow-hidden rounded bg-card/40",
        className
      )}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      {children}
    </Group>
  );
}
