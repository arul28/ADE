import React from "react";
import { cn } from "./cn";

export function EmptyState({
  title,
  description,
  className
}: {
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-card/70 p-6 text-card-fg", className)}>
      <div className="text-sm font-semibold">{title}</div>
      {description ? <div className="mt-1 text-sm text-muted-fg">{description}</div> : null}
    </div>
  );
}

