import React from "react";
import { Chip } from "../ui/Chip";

function formatTs(ts: string | null): string {
  if (!ts) return "never";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString();
}

export function PackFreshnessIndicator({
  deterministicUpdatedAt,
  narrativeUpdatedAt
}: {
  deterministicUpdatedAt: string | null;
  narrativeUpdatedAt: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Chip className="text-[11px]">deterministic: {formatTs(deterministicUpdatedAt)}</Chip>
      <Chip className="text-[11px]">narrative: {formatTs(narrativeUpdatedAt)}</Chip>
    </div>
  );
}
