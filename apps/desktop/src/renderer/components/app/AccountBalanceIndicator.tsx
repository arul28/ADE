import React from "react";
import { WarningCircle } from "@phosphor-icons/react";
import type { AccountBalanceIssue } from "../../../shared/types/usage";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import { settingsRouteFor } from "../settings/settingsManifest";
import { useUsageSnapshot } from "../usage/useUsageSnapshot";

/**
 * Settings entry that fixes each kind of issue. A signed-out account is fixed
 * on its provider's accounts panel; the other kinds are read on the same page,
 * next to the smart balance switch.
 */
function settingsEntryFor(issue: AccountBalanceIssue): string {
  return issue.provider === "claude" ? "agents.provider.claude" : "agents.provider.codex";
}

/**
 * The top-bar pill for smart balance problems.
 *
 * Smart balance fails quietly by nature: a chat that could not balance still
 * starts, on the default account. This pill is what makes that visible. It
 * shows while the host reports a `balanceIssues` entry and goes away on its
 * own when the next snapshot has none.
 */
export function AccountBalanceIndicator() {
  const { snapshot } = useUsageSnapshot();
  const issues = snapshot?.balanceIssues ?? [];
  const first = issues[0];
  if (!first) return null;

  const label = issues.length > 1 ? `${first.title} +${issues.length - 1}` : first.title;
  const description = issues.map((issue) => issue.detail).join("\n\n");

  return (
    <SmartTooltip
      forceEnabled
      side="bottom"
      content={{ label: "Smart balance", description }}
      wrapperStyle={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <button
        type="button"
        role="status"
        data-ade-account-balance-issue={first.kind}
        className={cn(
          "ade-shell-control shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1",
          "border border-amber-300/55 bg-amber-400/15 text-[11px] font-medium text-amber-100",
          "shadow-[0_0_18px_rgba(245,158,11,0.2)] transition-colors duration-150 hover:bg-amber-400/24",
        )}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        aria-label={`${label}. ${description}`}
        onClick={() => {
          window.location.hash = `#${settingsRouteFor(settingsEntryFor(first))}`;
        }}
      >
        <WarningCircle size={12} weight="fill" aria-hidden="true" />
        <span>{label}</span>
      </button>
    </SmartTooltip>
  );
}
