/**
 * The four setup chips, and the card that replaces the stage when one is red.
 *
 * `IosSimToolChips.tsx` moved. The copy button became `host/ui.ts:writeClipboard`
 * — a guest has no `navigator.clipboard` write permission of its own and must
 * ask the host — and nothing else changed.
 */

import React from "react";
import { Copy, CursorClick, Desktop, DeviceMobile, Wrench } from "@phosphor-icons/react";
import { cn } from "@ade-dev/ui";

import type { ToolChip } from "./simFormat";

const CHIP_ICON: Record<ToolChip["key"], typeof Desktop> = {
  macos: Desktop,
  xcode: Wrench,
  runtime: DeviceMobile,
  controls: CursorClick,
};

/** Per-chip accent so a healthy row reads as a palette, not a grey list. */
const CHIP_OK_TONE: Record<ToolChip["key"], string> = {
  macos: "border-sky-300/20 bg-sky-400/[0.07] text-sky-50/80",
  xcode: "border-violet-300/20 bg-violet-400/[0.07] text-violet-50/80",
  runtime: "border-emerald-300/20 bg-emerald-400/[0.07] text-emerald-50/80",
  controls: "border-cyan-300/20 bg-cyan-400/[0.07] text-cyan-50/80",
};

const CHIP_OK_DOT: Record<ToolChip["key"], string> = {
  macos: "bg-sky-300/85",
  xcode: "bg-violet-300/85",
  runtime: "bg-emerald-300/85",
  controls: "bg-cyan-300/85",
};

const WARN_TONE = "border-amber-300/24 bg-amber-400/[0.09] text-amber-50/85";
const MISSING_TONE = "border-rose-300/24 bg-rose-400/[0.09] text-rose-50/85";

function chipTone(chip: ToolChip): string {
  if (chip.state === "ok") return CHIP_OK_TONE[chip.key];
  return chip.state === "warn" ? WARN_TONE : MISSING_TONE;
}

export function ToolChips({
  chips,
  onCopy,
  className,
}: {
  chips: ToolChip[];
  onCopy: (text: string) => void;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)} data-sim-pane="tool-chips">
      {chips.map((chip) => {
        const Icon = CHIP_ICON[chip.key];
        return (
          <div
            key={chip.key}
            className={cn(
              "inline-flex h-6 max-w-full items-center gap-1 rounded-full border px-2 font-sans text-[10px] font-medium",
              chipTone(chip),
            )}
            title={chip.hint ?? `${chip.label} is ready.`}
          >
            <Icon size={11} />
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                chip.state === "ok" ? CHIP_OK_DOT[chip.key] : "bg-current/70",
              )}
            />
            {chip.label}
            {chip.hint ? <span className="min-w-0 truncate opacity-70">{chip.hint}</span> : null}
            {chip.hint && chip.hintIsCommand ? (
              <button
                type="button"
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-white/[0.08]"
                aria-label={`Copy the ${chip.label} install command`}
                onClick={() => onCopy(chip.hint as string)}
              >
                <Copy size={9} />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** What the stage draws when a required chip is red. */
export function UnsupportedCard({
  chips,
  onCopy,
}: {
  chips: ToolChip[];
  onCopy: (text: string) => void;
}): React.ReactElement {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
      data-sim-pane="unsupported"
    >
      <DeviceMobile size={22} className="text-muted-fg/45" />
      <div className="font-sans text-[12px] text-fg/80">This machine cannot drive a simulator</div>
      <div className="max-w-[380px] font-sans text-[11px] text-muted-fg/60">
        iOS Sim Control needs a Mac with Xcode and an installed iOS runtime.
      </div>
      <ToolChips chips={chips} onCopy={onCopy} className="justify-center" />
    </div>
  );
}
