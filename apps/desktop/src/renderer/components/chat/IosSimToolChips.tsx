import { useState } from "react";
import { Copy, CursorClick, Desktop, DeviceMobile, Wrench } from "@phosphor-icons/react";
import type { IosSimulatorStatus, IosSimulatorToolStatus } from "../../../shared/types";
import { cn } from "../ui/cn";

export type IosSimChipState = "ok" | "warn" | "missing";

export type IosSimToolChip = {
  key: "macos" | "xcode" | "runtime" | "controls";
  label: string;
  state: IosSimChipState;
  /** One line. A shell command when there is one, otherwise a short instruction. */
  hint: string | null;
  /** True when the hint is a copyable command rather than prose. */
  hintIsCommand: boolean;
};

const CHIP_ICON: Record<IosSimToolChip["key"], typeof Desktop> = {
  macos: Desktop,
  xcode: Wrench,
  runtime: DeviceMobile,
  controls: CursorClick,
};

/** Per-chip accent so a healthy row reads as a palette, not a grey list. */
const CHIP_OK_TONE: Record<IosSimToolChip["key"], string> = {
  macos: "border-sky-300/20 bg-sky-400/[0.07] text-sky-50/80",
  xcode: "border-violet-300/20 bg-violet-400/[0.07] text-violet-50/80",
  runtime: "border-emerald-300/20 bg-emerald-400/[0.07] text-emerald-50/80",
  controls: "border-cyan-300/20 bg-cyan-400/[0.07] text-cyan-50/80",
};

const CHIP_OK_DOT: Record<IosSimToolChip["key"], string> = {
  macos: "bg-sky-300/85",
  xcode: "bg-violet-300/85",
  runtime: "bg-emerald-300/85",
  controls: "bg-cyan-300/85",
};

const WARN_TONE = "border-amber-300/24 bg-amber-400/[0.09] text-amber-50/85";
const MISSING_TONE = "border-rose-300/24 bg-rose-400/[0.09] text-rose-50/85";

function firstHint(...tools: Array<IosSimulatorToolStatus | undefined>): string | null {
  for (const tool of tools) {
    if (tool && !tool.available) {
      const hint = tool.installHint?.trim() || tool.detail?.trim();
      if (hint) return hint;
    }
  }
  return null;
}

function looksLikeCommand(hint: string | null): boolean {
  if (!hint) return false;
  return /^(brew|xcode-select|sudo|npm|pip|gh|open|softwareupdate|idb)\b/u.test(hint.trim());
}

/**
 * Collapses the tool matrix into four chips. Required gaps read rose, the
 * interact-only gap (idb) reads amber, everything healthy keeps its own accent.
 */
export function buildIosSimToolChips(status: IosSimulatorStatus | null): IosSimToolChip[] {
  const byName = new Map((status?.tools ?? []).map((tool) => [tool.name, tool]));
  const xcrun = byName.get("xcrun");
  const xcodebuild = byName.get("xcodebuild");
  const simulatorWindow = byName.get("simulator_window");
  const idb = byName.get("idb");
  const idbCompanion = byName.get("idb_companion");
  const onMac = status ? status.platform === "darwin" : true;

  const xcodeOk = Boolean(xcrun?.available && xcodebuild?.available);
  const runtimeOk = Boolean(simulatorWindow?.available);
  const controlsOk = Boolean(idb?.available && idbCompanion?.available);
  const xcodeHint = firstHint(xcodebuild, xcrun);
  const runtimeHint = firstHint(simulatorWindow);
  const controlsHint = firstHint(idb, idbCompanion);

  return [
    {
      key: "macos",
      label: "macOS",
      state: onMac ? "ok" : "missing",
      hint: onMac ? null : "iOS Simulator runs on macOS only.",
      hintIsCommand: false,
    },
    {
      key: "xcode",
      label: "Xcode",
      state: xcodeOk ? "ok" : "missing",
      hint: xcodeOk ? null : xcodeHint ?? "xcode-select --install",
      hintIsCommand: xcodeOk ? false : looksLikeCommand(xcodeHint) || !xcodeHint,
    },
    {
      key: "runtime",
      label: "Runtime",
      state: runtimeOk ? "ok" : "missing",
      hint: runtimeOk ? null : runtimeHint ?? "Install an iOS runtime in Xcode Settings > Components.",
      hintIsCommand: runtimeOk ? false : looksLikeCommand(runtimeHint),
    },
    {
      key: "controls",
      label: "Controls",
      // idb is optional for viewing but is exactly what tap/type/drag need.
      state: controlsOk ? "ok" : "warn",
      hint: controlsOk ? null : controlsHint ?? "brew install facebook/fb/idb-companion",
      hintIsCommand: controlsOk ? false : looksLikeCommand(controlsHint) || !controlsHint,
    },
  ];
}

function chipTone(chip: IosSimToolChip): string {
  if (chip.state === "ok") return CHIP_OK_TONE[chip.key];
  return chip.state === "warn" ? WARN_TONE : MISSING_TONE;
}

function chipDot(chip: IosSimToolChip): string {
  if (chip.state === "ok") return CHIP_OK_DOT[chip.key];
  return chip.state === "warn" ? "bg-amber-300/90" : "bg-rose-300/90";
}

type IosSimToolChipsProps = {
  chips: IosSimToolChip[];
  onCopy: (text: string) => void;
  className?: string;
};

/** Icon + short name + state dot. Clicking an unhealthy chip reveals its one line. */
export function IosSimToolChips({ chips, onCopy, className }: IosSimToolChipsProps) {
  const [expandedKey, setExpandedKey] = useState<IosSimToolChip["key"] | null>(null);
  const expanded = chips.find((chip) => chip.key === expandedKey && chip.hint) ?? null;

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex flex-wrap items-center gap-1">
        {chips.map((chip) => {
          const Icon = CHIP_ICON[chip.key];
          const interactive = Boolean(chip.hint);
          return (
            <button
              key={chip.key}
              type="button"
              disabled={!interactive}
              aria-expanded={interactive ? expandedKey === chip.key : undefined}
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 font-sans text-[10px] font-medium transition-colors",
                chipTone(chip),
                interactive ? "hover:brightness-125" : "cursor-default",
                expandedKey === chip.key ? "ring-1 ring-white/15" : null,
              )}
              title={chip.hint ?? undefined}
              onClick={() => {
                if (!interactive) return;
                setExpandedKey((current) => (current === chip.key ? null : chip.key));
              }}
            >
              <Icon size={11} />
              {chip.label}
              <span className={cn("size-1.5 rounded-full", chipDot(chip))} />
            </button>
          );
        })}
      </div>
      {expanded?.hint ? (
        <div className="mt-1 flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-black/25 px-2 py-1">
          {expanded.hintIsCommand ? (
            <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg/80">{expanded.hint}</code>
          ) : (
            <span className="min-w-0 flex-1 truncate font-sans text-[10px] text-fg/75">{expanded.hint}</span>
          )}
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 font-sans text-[9px] text-muted-fg/70 transition-colors hover:text-fg/90"
            onClick={() => onCopy(expanded.hint ?? "")}
            title="Copy"
          >
            <Copy size={9} />
            Copy
          </button>
        </div>
      ) : null}
    </div>
  );
}

type IosSimUnsupportedCardProps = {
  chips: IosSimToolChip[];
  onCopy: (text: string) => void;
};

/** The whole unsupported story: one icon, one label, the chip row. No paragraphs. */
export function IosSimUnsupportedCard({ chips, onCopy }: IosSimUnsupportedCardProps) {
  const macOk = chips.find((chip) => chip.key === "macos")?.state === "ok";
  return (
    <div className="flex h-full min-h-[300px] items-center justify-center px-5 py-5">
      <div className="w-full max-w-[360px] rounded-md border border-white/[0.08] bg-white/[0.02] px-3.5 py-3">
        <div className="flex items-center gap-2">
          <DeviceMobile size={16} className="shrink-0 text-rose-200/70" />
          <div className="font-sans text-[12px] font-medium text-fg/85">
            {macOk ? "Simulator unavailable" : "macOS only"}
          </div>
        </div>
        <IosSimToolChips chips={chips} onCopy={onCopy} className="mt-2.5" />
      </div>
    </div>
  );
}
