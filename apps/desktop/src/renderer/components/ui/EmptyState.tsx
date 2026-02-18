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
    <div className={cn("rounded-2xl shadow-panel bg-[--color-surface-raised] p-10 text-center", className)}>
      <div className="text-sm font-semibold text-fg/70">{title}</div>
      {description ? <div className="mt-2 text-sm text-muted-fg/70">{description}</div> : null}
    </div>
  );
}
