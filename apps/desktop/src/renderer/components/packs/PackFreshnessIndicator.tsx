import React from "react";
import { Chip } from "../ui/Chip";

function relativeTime(ts: string | null): string {
  if (!ts) return "never";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

export function PackFreshnessIndicator({
  deterministicUpdatedAt
}: {
  deterministicUpdatedAt: string | null;
  narrativeUpdatedAt?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Chip className="text-[11px]">updated: {relativeTime(deterministicUpdatedAt)}</Chip>
    </div>
  );
}
