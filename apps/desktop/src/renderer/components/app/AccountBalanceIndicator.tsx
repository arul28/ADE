import React from "react";
import { WarningCircle } from "@phosphor-icons/react";
import type { AccountBalanceIssue } from "../../../shared/types/usage";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import { settingsRouteFor } from "../settings/settingsManifest";
import { useUsageSnapshot } from "../usage/useUsageSnapshot";

const WARNING = "#FBBF24";
const WARNING_TEXT = "#FCD34D";

/**
 * The provider's settings page: it holds the accounts (where a signed-out one
 * signs in again) and the smart balance switch, so every kind of issue opens it.
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
          "text-[11px] font-medium transition-[background-color,box-shadow] duration-150",
        )}
        // Inline, not Tailwind: `.ade-shell-control` is unlayered CSS and wins
        // over utility colors, which turned the warning gray.
        style={{
          WebkitAppRegion: "no-drag",
          color: WARNING_TEXT,
          borderColor: `${WARNING}8c`,
          background: `${WARNING}38`,
          boxShadow: `0 0 18px ${WARNING}33`,
        } as React.CSSProperties}
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
