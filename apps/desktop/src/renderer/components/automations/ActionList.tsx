import { useRef, useState } from "react";
import {
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
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { ActionRow, type ActionRowKind, type ActionRowValue } from "./ActionRow";

// `create-lane` is intentionally absent here: lane creation is now a
// first-class EXECUTION setting (`laneMode: "create"`) rather than an action a
// user has to chain manually. Legacy rules carrying a leading `create-lane`
// action are migrated server-side on read.
const ADD_OPTIONS: Array<{ kind: ActionRowKind; label: string; icon: ElementType; disabled?: boolean; hint?: string }> = [
  { kind: "agent-session", label: "Agent session", icon: Lightning },
  { kind: "ade-action", label: "Run ADE action", icon: Code },
  { kind: "run-tests", label: "Run tests", icon: TestTube },
  { kind: "run-command", label: "Run command", icon: TerminalWindow },
  { kind: "predict-conflicts", label: "Predict conflicts", icon: Warning },
  { kind: "launch-mission", label: "Mission", icon: Rocket, disabled: true, hint: "Coming soon" },
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
  const [menuOpen, setMenuOpen] = useState(false);
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
    setMenuOpen(false);
    keysRef.current = [...keysRef.current, newKey()];
    onChange([...actions, createBlankAction(kind, suites)]);
  };

  const updateAction = (index: number, next: ActionRowValue) => {
    // Key at `index` stays the same — only the value mutates.
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
      {actions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/[0.08] bg-[rgba(12,10,22,0.4)] p-4 text-center text-xs text-muted-fg/60">
          No actions yet. Add at least one step below.
        </div>
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

      <div className="relative">
        <Button size="sm" variant="outline" onClick={() => setMenuOpen((open) => !open)}>
          <Plus size={12} weight="regular" />
          Add action
        </Button>
        {menuOpen ? (
          <div
            className="absolute z-20 mt-1 w-[240px] rounded-lg border border-white/[0.08] bg-[rgba(12,10,22,0.95)] p-1 shadow-card backdrop-blur-[20px]"
            onMouseLeave={() => setMenuOpen(false)}
          >
            {ADD_OPTIONS.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.kind}
                  type="button"
                  disabled={option.disabled}
                  onClick={() => !option.disabled && addAction(option.kind)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    option.disabled
                      ? "cursor-not-allowed text-muted-fg/40 opacity-60"
                      : "text-fg/80 hover:bg-white/[0.04] hover:text-fg",
                  )}
                  title={option.hint}
                >
                  <Icon size={12} weight="regular" />
                  <span>{option.label}</span>
                  {option.hint ? (
                    <span className="ml-auto text-[9px] uppercase tracking-[0.08em] text-muted-fg/50">
                      {option.hint}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
