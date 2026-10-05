import React from "react";
import { CaretDown, CaretLeft, CaretRight, Check } from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import type { PrSummary } from "../../../../shared/types";
import { lanePrAttention, lanePrAttentionColor, lanePrStateColor, lanePrStateLabel } from "../../../lib/lanePrBadge";
import { cn } from "../../ui/cn";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_LABEL_CLASS } from "../../ui/paneMenuTokens";

/**
 * Several pull requests belong to one chat. A caret beside the PR number opens
 * the list and ‹ 1/3 › steps through it, so a pane spends no row on chips.
 */
export type PrSwitcher = {
  prs: Array<Pick<PrSummary, "id" | "githubPrNumber" | "title" | "state" | "checksStatus" | "reviewStatus" | "mergeConflicts" | "behindBaseBy">>;
  selectedId: string;
  onSelect: (prId: string) => void;
};

const ICON_BUTTON_CLASS = cn(
  "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] text-muted-fg transition-colors",
  "hover:bg-fg/[0.08] hover:text-fg data-[state=open]:bg-fg/[0.08] data-[state=open]:text-fg",
);

export function PrSwitcherMenu({ switcher, className }: { switcher: PrSwitcher; className?: string }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={cn(ICON_BUTTON_CLASS, className)}
          data-testid="pr-switcher"
          title={`Switch pull request (${switcher.prs.length})`}
          aria-label={`Switch pull request, ${switcher.prs.length} in this chat`}
        >
          <CaretDown size={10} weight="bold" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className={cn(MENU_CONTENT_CLASS, "w-[300px]")}>
          <DropdownMenu.Label className={MENU_LABEL_CLASS}>Pull requests · {switcher.prs.length}</DropdownMenu.Label>
          {switcher.prs.map((entry) => {
            const selected = entry.id === switcher.selectedId;
            return (
              <DropdownMenu.Item
                key={entry.id}
                className={cn(MENU_ITEM_CLASS, "gap-2", selected && "bg-white/[0.06]")}
                data-testid="pr-switcher-item"
                onSelect={() => switcher.onSelect(entry.id)}
              >
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: lanePrAttentionColor(lanePrAttention(entry)) }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold">
                    <span className="tabular-nums">#{entry.githubPrNumber}</span>
                    <span style={{ color: lanePrStateColor(entry.state) }}>{lanePrStateLabel(entry.state)}</span>
                  </span>
                  <span className="block truncate text-[10.5px] text-fg/55">{entry.title || "Untitled pull request"}</span>
                </span>
                {selected ? <Check size={12} className="shrink-0 text-fg/60" /> : null}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function PrSwitcherStepper({ switcher, className }: { switcher: PrSwitcher; className?: string }) {
  const count = switcher.prs.length;
  const index = Math.max(0, switcher.prs.findIndex((entry) => entry.id === switcher.selectedId));
  const step = (delta: number) => {
    const next = switcher.prs[(index + delta + count) % count];
    if (next) switcher.onSelect(next.id);
  };
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-0.5 font-mono text-[10.5px] text-muted-fg", className)}
      data-testid="pr-switcher-stepper"
    >
      <button type="button" className={ICON_BUTTON_CLASS} aria-label="Previous pull request" onClick={() => step(-1)}>
        <CaretLeft size={11} weight="bold" />
      </button>
      <span className="tabular-nums" aria-live="polite">{index + 1}/{count}</span>
      <button type="button" className={ICON_BUTTON_CLASS} aria-label="Next pull request" onClick={() => step(1)}>
        <CaretRight size={11} weight="bold" />
      </button>
    </span>
  );
}
