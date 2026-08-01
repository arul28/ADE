import React from "react";
import { DesktopTower, GitPullRequest, Laptop } from "@phosphor-icons/react";

import type { AttentionItem } from "../../../shared/types";
import { relativeWhen } from "../../lib/format";
import { ProviderLogo } from "../shared/ProviderLogos";
import { SessionStatusLabel } from "../terminals/SessionStatusLabel";
import { LaneIcon } from "../ui/vcsIcons";
import { cn } from "../ui/cn";
import { activityItemPresentation } from "./attentionPresentation";
// The row carries its own chrome and the shared tone table, so every surface
// that can render an `ActivityCard` gets both without importing a stylesheet
// it does not otherwise use.
import "./Activity.css";

/* ── Why this is not `terminals/SessionCard` ───────────────────────────────
   Three reasons, all of them load-bearing. Anyone tempted to "simplify" this
   file by adapting an `AttentionItem` into a `TerminalSessionSummary` should
   read them first — the shortcut is not cosmetic, it is a correctness bug.

   1. WRONG-MACHINE MUTATIONS. `SessionCard` renders `SessionStatusSlot`, which
      owns `SessionSnoozeControl` and calls `settleSession` / `unsettleSession`
      against THIS Mac's local session service. An Activity row very often
      belongs to another machine on the account. A fabricated summary would put
      live settle/snooze buttons on it, and because session ids are not
      globally unique per machine, the mutation could land on a same-id LOCAL
      session. The status vocabulary is shared instead, through the pure
      `SessionStatusLabel` extracted from that slot — words and hues cannot
      drift, and no IPC comes along for the ride.

   2. GEOMETRY IS A CONTRACT, NOT A STYLE. `SESSION_ROW_BLEED_CLASS` pays back a
      measured 12px of `SessionListPane` ancestor inset plus a 6px webkit
      scrollbar term, and it must sit on the element carrying
      `content-visibility` because that implies paint containment. Inside a
      popover with different padding the row would bleed under the panel
      border. Activity rows are plain Tailwind and inset-neutral.

   3. THE ADAPTER WOULD BE FICTION. `SessionCard` reads ~30 fields
      `AttentionItem` does not have (`statusNote`, `lastOutputPreview`, `goal`,
      `snoozedUntil`, `exitCode`, `runtimeState`, `orchestration*`, a whole
      `LaneSummary`, …). It also pulls `useSessionDelta`, `useLaneNaming`, the
      app store's project binding, and a work-grid drag source — every one of
      them scoped to the open project, i.e. wrong for an account-wide feed.

   What IS shared: `shared/sessionStatusPresentation.ts` (the one-hue-one-meaning
   table), `SessionStatusLabel`, and `activityItemPresentation()`. That is the
   whole of the vocabulary and none of the machinery.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Machines only tell us their name, so the glyph is a read of that name rather
 * than a hardware fact. It is decoration either way — the name beside it is the
 * identity, and the chip is deliberately neutral because amber means "your
 * move" everywhere in Activity.
 */
function MachineGlyph({ name, size }: { name: string; size: number }) {
  const portable = /\b(?:macbook|laptop|air|book)\b/i.test(name);
  const Glyph = portable ? Laptop : DesktopTower;
  return <Glyph size={size} weight="duotone" aria-hidden className="shrink-0" />;
}

function ActivityMachineChip({ item, size }: { item: AttentionItem; size: number }) {
  const online = item.machine.online;
  return (
    <span
      data-activity-machine={item.machine.name}
      data-machine-online={online ? "true" : "false"}
      className={cn(
        "inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border px-1.5 py-px leading-none",
        online
          ? "border-white/[0.09] bg-white/[0.04] text-muted-fg/75"
          : "border-white/[0.05] bg-white/[0.02] text-muted-fg/40",
      )}
      title={
        online
          ? `On ${item.machine.name}`
          : `On ${item.machine.name} — offline${
            item.machine.lastSeenAt ? `, last seen ${relativeWhen(item.machine.lastSeenAt)}` : ""
          }`
      }
    >
      <MachineGlyph name={item.machine.name} size={size} />
      <span className="min-w-0 truncate text-[10.5px] font-medium">{item.machine.name}</span>
    </span>
  );
}

/** The provider mark, or the PR glyph for pull-request rows. */
function ActivityAvatar({ item, size }: { item: AttentionItem; size: number }) {
  if (item.kind === "pull_request") {
    return (
      <GitPullRequest
        size={size}
        weight="duotone"
        aria-hidden
        className="shrink-0 text-muted-fg/70"
      />
    );
  }
  return (
    <ProviderLogo
      family={item.provider || "agent"}
      size={size}
      className="shrink-0 opacity-75"
    />
  );
}

/**
 * The status note. `preview` is the agent's own words; `detail` is the
 * publisher's fallback sentence. When the account has hide-details on, the
 * publisher's already-redacted `privacyPreview` is the only line allowed out.
 */
export function activityCardPreview(item: AttentionItem, hideDetails: boolean): string {
  if (hideDetails) return item.privacyPreview.trim();
  return (item.preview || item.detail || item.privacyPreview || "").trim();
}

export type ActivityCardProps = {
  item: AttentionItem;
  /** The row's only side effect. Navigation and acknowledgment live upstream. */
  onOpen: (item: AttentionItem) => void;
  /** Mirrors the account's `hideDetails` preference. */
  hideDetails?: boolean;
  /** Two-line form for dense mirrors (notch panel, mobile hub strip). */
  compact?: boolean;
  /** Keeps the hover treatment on the row whose detail is open. */
  selected?: boolean;
};

/**
 * One Activity row. `AttentionItem` in, `onOpen` out — no store reads, no IPC,
 * no project scoping, so the same row renders in the header popover, the pane,
 * and any surface that can hand it an item.
 */
export function ActivityCard({
  item,
  onOpen,
  hideDetails = false,
  compact = false,
  selected = false,
}: ActivityCardProps) {
  const presentation = activityItemPresentation(item);
  const tone = presentation?.tone ?? "neutral";
  const preview = activityCardPreview(item, hideDetails);
  const laneLabel = item.laneName?.trim() || item.project.name;
  const statusLabel = (
    <SessionStatusLabel
      presentation={presentation}
      // `statusSince` is immutable for the life of a phase; `occurredAt` is the
      // honest approximation while a publisher predates it. `updatedAt` is
      // deliberately not used — it churns on cosmetic republish, so the ticker
      // would reset itself every poll.
      elapsedSince={item.statusSince ?? item.occurredAt}
      timestampLabel={relativeWhen(item.updatedAt)}
      compact={compact}
    />
  );

  return (
    <button
      type="button"
      data-activity-row={item.id}
      data-activity-tone={tone}
      data-selected={selected ? "true" : undefined}
      className={cn(
        "activity-card group/activity relative block w-full rounded-lg text-left",
        `activity-tone-${tone}`,
        !item.machine.online && "opacity-70",
      )}
      onClick={() => onOpen(item)}
      title={`${item.title} — ${item.project.name} · ${item.machine.name}`}
    >
      {compact ? (
        <div className="flex h-[2.75rem] flex-col justify-center gap-0.5 px-2 py-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <ActivityAvatar item={item} size={13} />
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg">
              {item.title}
            </span>
            {statusLabel}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-fg/60">
            <span className="activity-card-lane min-w-0 shrink truncate font-medium">
              {laneLabel}
            </span>
            <span aria-hidden className="shrink-0 text-muted-fg/25">·</span>
            <span className="min-w-0 flex-1 truncate italic">{preview}</span>
          </div>
        </div>
      ) : (
        <div className="h-[4.875rem] px-2 py-2">
          {/* Line 1 — where this work lives, then the status, hard right. */}
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <span
              data-activity-lane={laneLabel}
              className="activity-card-lane inline-flex min-w-0 flex-1 items-center gap-1.5 text-[12px] font-semibold"
            >
              <LaneIcon size={12} weight="regular" className="shrink-0" />
              <span className="min-w-0 truncate">{laneLabel}</span>
            </span>
            <ActivityMachineChip item={item} size={10} />
            {statusLabel}
          </div>

          {/* Line 2 — the item's own title, and nothing competing with it. */}
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
              {item.title}
            </span>
            {item.seenAt ? null : (
              <span className="activity-card-unseen shrink-0" aria-label="Unseen" />
            )}
          </div>

          {/* Line 3 — what it is doing, then the quiet meta. Italic, matching
              the Work sidebar: the title above is what you scan for and this
              line is commentary about it. */}
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted-fg/65">
            {preview ? (
              <span className="min-w-0 flex-1 truncate italic">{preview}</span>
            ) : (
              <span className="flex-1" />
            )}
            {item.model ? (
              <span className="shrink-0 truncate text-[11px] text-muted-fg/45">
                {item.model}
              </span>
            ) : null}
            <ActivityAvatar item={item} size={18} />
          </div>
        </div>
      )}
    </button>
  );
}

export default ActivityCard;
