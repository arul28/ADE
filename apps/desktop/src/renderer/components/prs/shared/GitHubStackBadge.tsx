import React from "react";
import { Stack } from "@phosphor-icons/react";
import type { GitHubPrStackMembership } from "../../../../shared/types";
import { cn } from "../../ui/cn";

export function GitHubStackBadge({
  stack,
  compact = false,
  bare = false,
  className,
}: {
  stack: GitHubPrStackMembership | null | undefined;
  compact?: boolean;
  bare?: boolean;
  className?: string;
}): React.ReactElement | null {
  if (!stack) return null;
  const label = compact
    ? `${stack.position}/${stack.size}`
    : `Stack ${stack.position}/${stack.size}`;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-mono text-[10px] font-semibold leading-none text-violet-200/85",
        bare
          ? "border-0 bg-transparent p-0"
          : "rounded-md border border-violet-400/20 bg-violet-500/[0.08] px-1.5 py-0.5",
        className,
      )}
      title={`GitHub Stack #${stack.number} · pull request ${stack.position} of ${stack.size} · base ${stack.baseBranch}`}
      aria-label={`GitHub Stack ${stack.position} of ${stack.size}`}
    >
      <Stack size={11} weight="fill" aria-hidden />
      <span>{label}</span>
    </span>
  );
}
