import React from "react";
import { cn } from "./cn";

export function EmptyState({
  title,
  description,
  icon: Icon,
  className,
  children
}: {
  title: string;
  description?: string;
  icon?: React.ElementType;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded shadow-panel bg-[--color-surface-raised] p-10 text-center", className)}>
      {Icon ? (
        <div className="mb-4 inline-flex items-center justify-center">
          <Icon size={48} weight="regular" className="text-muted-fg/30" />
        </div>
      ) : null}
      <div className="text-lg font-medium text-fg">{title}</div>
      {description ? <div className="mt-2 text-sm text-muted-fg max-w-[45ch] mx-auto">{description}</div> : null}
      {children}
    </div>
  );
}
