import React from "react";
import * as Popover from "@radix-ui/react-popover";
import { normalizeLaneEmoji } from "../../../shared/laneEmoji";
import { usePortalContainer } from "../ui/portalContainer";
import { Z_LAYERS } from "../ui/zLayers";

export const LANE_EMOJI_OPTIONS: readonly { emoji: string; meaning: string }[] = [
  { emoji: "🐛", meaning: "bug fix, crash, error, regression" },
  { emoji: "✨", meaning: "feature, improvement, new capability" },
  { emoji: "💡", meaning: "idea, exploration, prototype" },
  { emoji: "🎨", meaning: "design, styling, visual polish" },
  { emoji: "🧪", meaning: "tests, experiments, quality" },
  { emoji: "✅", meaning: "verification, validation, completed work" },
  { emoji: "📋", meaning: "checklist, planning, task tracking" },
  { emoji: "📝", meaning: "writing, notes, changelog" },
  { emoji: "📚", meaning: "documentation, learning, references" },
  { emoji: "🔬", meaning: "research, investigation, debugging" },
  { emoji: "⚡", meaning: "performance, speed, responsiveness" },
  { emoji: "🚀", meaning: "release, launch, deployment" },
  { emoji: "🔒", meaning: "security, permissions, access control" },
  { emoji: "🛡️", meaning: "safety, protection, resilience" },
  { emoji: "🚨", meaning: "urgent fix, alert, outage" },
  { emoji: "🔧", meaning: "tooling, maintenance, repair" },
  { emoji: "🛠️", meaning: "infrastructure, engineering tools" },
  { emoji: "⚙️", meaning: "configuration, settings, systems" },
  { emoji: "🧹", meaning: "cleanup, refactor, remove dead code" },
  { emoji: "🏗️", meaning: "large implementation, construction" },
  { emoji: "🧭", meaning: "navigation, routing, discovery" },
  { emoji: "📱", meaning: "iOS, mobile, phone experience" },
  { emoji: "💻", meaning: "desktop, client application" },
  { emoji: "🖥️", meaning: "desktop UI, renderer, display" },
  { emoji: "🌐", meaning: "web, networking, cross-platform" },
  { emoji: "🔗", meaning: "integration, linking, connections" },
  { emoji: "📈", meaning: "analytics, growth, metrics" },
  { emoji: "📊", meaning: "charts, reporting, visualization" },
  { emoji: "🔍", meaning: "search, filtering, lookup" },
  { emoji: "🧵", meaning: "threads, concurrency, async work" },
  { emoji: "📦", meaning: "packaging, dependencies, distribution" },
  { emoji: "🧩", meaning: "plugin, extension, modular feature" },
  { emoji: "🎛️", meaning: "controls, preferences, interaction" },
  { emoji: "🪄", meaning: "automation, AI, smart assistance" },
  { emoji: "🧠", meaning: "AI, reasoning, machine learning" },
  { emoji: "🗂️", meaning: "organization, workspace, file management" },
  { emoji: "🏷️", meaning: "labels, metadata, categorization" },
  { emoji: "🔄", meaning: "sync, refresh, retry, state updates" },
  { emoji: "⏱️", meaning: "timing, scheduling, waits" },
  { emoji: "🕸️", meaning: "web interface, browser, frontend" },
  { emoji: "💬", meaning: "chat, messaging, conversation" },
  { emoji: "🔔", meaning: "notifications, alerts, attention" },
  { emoji: "🎯", meaning: "focus, goals, precision" },
  { emoji: "🧬", meaning: "data model, schema, migration" },
  { emoji: "🧊", meaning: "cache, storage, cold start" },
  { emoji: "🪵", meaning: "logging, traces, diagnostics" },
  { emoji: "🪲", meaning: "bugs, defects, unexpected behavior" },
  { emoji: "🧑‍💻", meaning: "developer workflow, coding experience" },
  { emoji: "🧑‍🔬", meaning: "research, analysis, technical discovery" },
  { emoji: "🗺️", meaning: "maps, location, routing" },
  { emoji: "📡", meaning: "remote machines, connectivity, relay" },
  { emoji: "🔋", meaning: "capacity, resources, system health" },
  { emoji: "🎉", meaning: "milestone, completion, celebration" },
];

export function LaneEmojiPicker({
  value,
  onChange,
  disabled = false,
  label = "Lane emoji",
  overlayLayer = Z_LAYERS.dialogPopover,
}: {
  value: string | null | undefined;
  onChange: (emoji: string | null) => void;
  disabled?: boolean;
  label?: string;
  overlayLayer?: number;
}) {
  const [open, setOpen] = React.useState(false);
  const [customValue, setCustomValue] = React.useState(value ?? "");
  const portalContainer = usePortalContainer();
  const customValid = React.useMemo(() => {
    if (!customValue.trim()) return true;
    try {
      normalizeLaneEmoji(customValue);
      return true;
    } catch {
      return false;
    }
  }, [customValue]);

  React.useEffect(() => setCustomValue(value ?? ""), [value]);

  const pick = (emoji: string | null) => {
    setCustomValue(emoji ?? "");
    onChange(emoji);
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-fg/[0.1] bg-fg/[0.035] px-2 text-sm text-fg/85 hover:bg-fg/[0.07] disabled:opacity-45"
          aria-label={value ? `Change lane emoji, current ${value}` : "Set lane emoji"}
          title={label}
          disabled={disabled}
        >
          {value || <span className="text-xs text-muted-fg">＋</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal container={portalContainer ?? undefined}>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={5}
          collisionPadding={10}
          className="w-64 rounded-xl border border-fg/[0.12] bg-background p-2 shadow-xl"
          style={{ zIndex: overlayLayer }}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.stopPropagation();
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <span className="text-[11px] font-semibold text-fg/80">{label}</span>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-fg hover:bg-fg/[0.06] hover:text-fg"
              onClick={() => pick(null)}
            >
              Clear
            </button>
          </div>
          <div className="grid max-h-40 grid-cols-8 gap-0.5 overflow-y-auto">
            {LANE_EMOJI_OPTIONS.map(({ emoji, meaning }) => (
              <button
                key={emoji}
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded text-base hover:bg-fg/[0.08] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                aria-label={`${emoji} ${meaning}`}
                aria-pressed={value === emoji}
                title={meaning}
                onClick={() => pick(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
          <label className="mt-2 block text-[10px] text-muted-fg">
            Any emoji
            <input
              className="mt-1 h-7 w-full rounded-md border border-fg/[0.1] bg-fg/[0.035] px-2 text-sm text-fg outline-none focus:border-accent/50"
              value={customValue}
              disabled={disabled}
              aria-label="Enter any emoji"
              aria-invalid={!customValid}
              placeholder="Paste one emoji"
              onChange={(event) => {
                const next = event.target.value;
                setCustomValue(next);
                if (!next.trim()) {
                  onChange(null);
                  return;
                }
                try {
                  onChange(normalizeLaneEmoji(next));
                } catch {
                  // Keep partial text editable; service validation is final.
                }
              }}
            />
          </label>
          {!customValid ? <div className="mt-1 text-[10px] text-muted-fg">Enter one emoji.</div> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
