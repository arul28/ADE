import { useEffect, useRef, useState } from "react";
import {
  CaretDown,
  Code,
  Lightning,
  Plus,
  Rocket,
  TerminalWindow,
  TestTube,
  Warning,
} from "@phosphor-icons/react";
import type { ElementType } from "react";
import type { ModelConfig, TestSuiteDefinition } from "../../../shared/types";
import { useClickOutside } from "../../hooks/useClickOutside";
import { cn } from "../ui/cn";
import { ActionRow, type ActionRowKind, type ActionRowValue } from "./ActionRow";

// `create-lane` is intentionally absent here: lane creation is now a
// first-class EXECUTION setting (`laneMode: "create"`) rather than an action a
// user has to chain manually. Legacy rules carrying a leading `create-lane`
// action are migrated server-side on read.
type AddOption = {
  kind: ActionRowKind;
  label: string;
  icon: ElementType;
  accent: string;
  description: string;
  disabled?: boolean;
  hint?: string;
};

const ADD_OPTIONS: readonly AddOption[] = [
  {
    kind: "agent-session",
    label: "Agent session",
    icon: Lightning,
    accent: "#38BDF8",
    description: "Send a prompt to an agent and let it work in a chat thread.",
  },
  {
    kind: "ade-action",
    label: "ADE action",
    icon: Code,
    accent: "#A78BFA",
    description: "Call any ADE CLI domain — git, lane, PR, tests, memory, and more.",
  },
  {
    kind: "run-tests",
    label: "Run tests",
    icon: TestTube,
    accent: "#22C55E",
    description: "Run a configured test suite and report the result.",
  },
  {
    kind: "run-command",
    label: "Run command",
    icon: TerminalWindow,
    accent: "#F59E0B",
    description: "Execute a shell command in the project workspace.",
  },
  {
    kind: "predict-conflicts",
    label: "Predict conflicts",
    icon: Warning,
    accent: "#F97316",
    description: "Run the conflict prediction pass against recent lanes.",
  },
  {
    kind: "launch-mission",
    label: "Launch mission",
    icon: Rocket,
    accent: "#94A3B8",
    description: "Spin up a multi-step mission for this rule.",
    disabled: true,
    hint: "Soon",
  },
];

function createBlankAction(kind: ActionRowKind, suites: TestSuiteDefinition[]): ActionRowValue {
  switch (kind) {
    case "create-lane":
      return {
        kind,
        laneNameTemplate: "{{trigger.issue.title}}",
        laneDescriptionTemplate: "GitHub issue #{{trigger.issue.number}}\n{{trigger.issue.url}}\n\n{{trigger.issue.body}}",
      };
    case "agent-session":
      return { kind, prompt: "", sessionTitle: "" };
    case "ade-action":
      return { kind, adeAction: { domain: "", action: "" } };
    case "run-tests":
      return { kind, suiteId: suites[0]?.id ?? "" };
    case "run-command":
      return { kind, command: "", cwd: "" };
    case "predict-conflicts":
      return { kind };
    case "launch-mission":
      return { kind, missionTitle: "" };
  }
}

function newKey(): string {
  // Prefer crypto.randomUUID in modern browsers / Electron; fall back to a
  // timestamp-based id so tests and legacy runtimes don't crash.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ActionList({
  actions,
  lanes,
  suites,
  fallbackModel,
  onChange,
  onOpenAiSettings,
}: {
  actions: ActionRowValue[];
  lanes: Array<{ id: string; name: string }>;
  suites: TestSuiteDefinition[];
  fallbackModel: ModelConfig;
  onChange: (next: ActionRowValue[]) => void;
  onOpenAiSettings?: () => void;
}) {
  // Stable per-row keys that survive reorders so React preserves focus/DOM
  // identity when the user clicks up/down arrows. Keys are regenerated only
  // when the row count changes (backfilling appended rows or trimming).
  const keysRef = useRef<string[]>(actions.map(() => newKey()));
  if (keysRef.current.length !== actions.length) {
    const next = keysRef.current.slice(0, actions.length);
    while (next.length < actions.length) next.push(newKey());
    keysRef.current = next;
  }

  const addAction = (kind: ActionRowKind) => {
    keysRef.current = [...keysRef.current, newKey()];
    onChange([...actions, createBlankAction(kind, suites)]);
  };

  const updateAction = (index: number, next: ActionRowValue) => {
    onChange(actions.map((action, i) => (i === index ? next : action)));
  };

  const removeAction = (index: number) => {
    keysRef.current = keysRef.current.filter((_, i) => i !== index);
    onChange(actions.filter((_, i) => i !== index));
  };

  const moveAction = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= actions.length) return;
    const nextActions = [...actions];
    const nextKeys = [...keysRef.current];
    [nextActions[index], nextActions[target]] = [nextActions[target], nextActions[index]];
    [nextKeys[index], nextKeys[target]] = [nextKeys[target], nextKeys[index]];
    keysRef.current = nextKeys;
    onChange(nextActions);
  };

  return (
    <div className="space-y-3">
      {/* Always-visible add bar at the TOP — its menu opens downward into the
          surrounding column without ever being clipped by overflowing rows. */}
      <AddStepBar onAdd={addAction} />

      {actions.length === 0 ? (
        <EmptyPicker onAdd={addAction} />
      ) : (
        <div className="space-y-2">
          {actions.map((action, index) => (
            <ActionRow
              key={keysRef.current[index] ?? `action-${index}`}
              index={index}
              total={actions.length}
              value={action}
              lanes={lanes}
              suites={suites}
              fallbackModel={fallbackModel}
              onChange={(next) => updateAction(index, next)}
              onRemove={() => removeAction(index)}
              onMove={(direction) => moveAction(index, direction)}
              onOpenAiSettings={onOpenAiSettings}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AddStepBar({ onAdd }: { onAdd: (kind: ActionRowKind) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useClickOutside(wrapRef, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "group flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-[12px] font-semibold transition-colors",
          open
            ? "border-[#5FA0E0]/50 bg-[#13263A] text-[#F5FAFF]"
            : "border-white/[0.08] bg-black/15 text-[#D8E3F2] hover:border-[#5FA0E0]/40 hover:bg-[#13263A]/60",
        )}
      >
        <span className="flex items-center gap-2">
          <Plus size={13} weight="bold" className="text-[#7DD3FC]" />
          Add step
        </span>
        <CaretDown
          size={11}
          weight="bold"
          className={cn("text-[#8FA1B8] transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div
          className="absolute left-0 right-0 z-30 mt-1.5 grid gap-1 rounded-xl border border-white/[0.1] bg-[#0B121A] p-1.5 shadow-2xl"
          role="menu"
        >
          {ADD_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <button
                key={option.kind}
                type="button"
                role="menuitem"
                disabled={option.disabled}
                onClick={() => {
                  if (option.disabled) return;
                  onAdd(option.kind);
                  setOpen(false);
                }}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                  option.disabled
                    ? "cursor-not-allowed opacity-50"
                    : "hover:bg-white/[0.05]",
                )}
              >
                <span
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    background: `${option.accent}1f`,
                    color: option.accent,
                    boxShadow: `inset 0 0 0 1px ${option.accent}40`,
                  }}
                >
                  <Icon size={13} weight="fill" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[12px] font-semibold text-[#F5FAFF]">{option.label}</span>
                    {option.hint ? (
                      <span className="rounded bg-white/[0.06] px-1 py-px text-[8px] uppercase tracking-[1px] text-[#8FA1B8]">
                        {option.hint}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[10.5px] leading-snug text-[#93A4B8]">
                    {option.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function EmptyPicker({ onAdd }: { onAdd: (kind: ActionRowKind) => void }) {
  return (
    <div className="rounded-xl border border-dashed border-white/[0.1] bg-black/15 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[1px] text-[#8FA1B8]">
        Pick a starting step
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {ADD_OPTIONS.filter((option) => !option.disabled).map((option) => {
          const Icon = option.icon;
          return (
            <button
              key={option.kind}
              type="button"
              onClick={() => onAdd(option.kind)}
              className="group flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2.5 text-left transition-colors hover:border-white/[0.16] hover:bg-black/30"
            >
              <span
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                style={{
                  background: `${option.accent}1f`,
                  color: option.accent,
                  boxShadow: `inset 0 0 0 1px ${option.accent}40`,
                }}
              >
                <Icon size={13} weight="fill" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-semibold text-[#F5FAFF]">{option.label}</span>
                <span className="mt-0.5 block text-[10.5px] leading-snug text-[#93A4B8]">
                  {option.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
