import React from "react";
import { cn } from "./cn";

export function EmptyState({
  title,
  description,
  icon: Icon,
  className
}: {
  title: string;
  description?: string;
  icon?: React.ElementType;
  className?: string;
}) {
  return (
    <div className={cn("rounded-2xl shadow-panel bg-[--color-surface-raised] p-10 text-center", className)}>
      {Icon ? (
        <div className="mb-3 inline-flex items-center justify-center w-10 h-10 rounded-xl bg-accent/10 text-accent">
          <Icon className="h-5 w-5" />
        </div>
      ) : null}
      <div className="text-sm font-semibold text-fg/70">{title}</div>
      {description ? <div className="mt-2 text-sm text-muted-fg/70">{description}</div> : null}
    </div>
  );
}
