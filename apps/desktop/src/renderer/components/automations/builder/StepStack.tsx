import { useEffect, useRef, useState } from "react";
import { Broom, CaretDown, Plus } from "@phosphor-icons/react";
import type { TestSuiteDefinition } from "../../../../shared/types";
import { useClickOutside } from "../../../hooks/useClickOutside";
import { cn } from "../../ui/cn";
import { ADD_STEP_ORDER, stepDef, type StepKind } from "../actionCatalog";
import { blankStep, type WorkflowStep } from "./draftBridge";
import { StepCard } from "./StepCard";

function newKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Steps offered in the add menu — cleanup (delete-lane) has its own zone.
const ADDABLE_KINDS = ADD_STEP_ORDER.filter((kind) => kind !== "delete-lane");

function isCleanupStep(step: WorkflowStep): boolean {
  return step.kind === "delete-lane";
}

export function StepStack({
  steps,
  triggerType,
  suites,
  onChange,
}: {
  steps: WorkflowStep[];
  triggerType: string;
  suites: TestSuiteDefinition[];
  onChange: (next: WorkflowStep[]) => void;
}) {
  const keysRef = useRef<string[]>(steps.map(() => newKey()));
  if (keysRef.current.length !== steps.length) {
    const next = keysRef.current.slice(0, steps.length);
    while (next.length < steps.length) next.push(newKey());
    keysRef.current = next;
  }

  // The cleanup zone is a trailing delete-lane step. Everything before it is a
  // normal step.
  const hasTrailingCleanup = steps.length > 0 && isCleanupStep(steps[steps.length - 1]!);
  const cleanupIndex = hasTrailingCleanup ? steps.length - 1 : -1;
  const normalCount = hasTrailingCleanup ? steps.length - 1 : steps.length;

  const insertStep = (at: number, kind: StepKind) => {
    const keys = [...keysRef.current];
    keys.splice(at, 0, newKey());
    keysRef.current = keys;
    const next = [...steps];
    next.splice(at, 0, blankStep(kind, suites[0]?.id));
    onChange(next);
  };

  const updateStep = (index: number, next: WorkflowStep) => {
    onChange(steps.map((s, i) => (i === index ? next : s)));
  };

  const removeStep = (index: number) => {
    keysRef.current = keysRef.current.filter((_, i) => i !== index);
    onChange(steps.filter((_, i) => i !== index));
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    // Never move a normal step past the cleanup zone.
    if (target < 0 || target >= normalCount) return;
    const nextSteps = [...steps];
    const nextKeys = [...keysRef.current];
    [nextSteps[index], nextSteps[target]] = [nextSteps[target]!, nextSteps[index]!];
    [nextKeys[index], nextKeys[target]] = [nextKeys[target]!, nextKeys[index]!];
    keysRef.current = nextKeys;
    onChange(nextSteps);
  };

  const addCleanup = () => {
    keysRef.current = [...keysRef.current, newKey()];
    onChange([...steps, blankStep("delete-lane")]);
  };

  return (
    <div className="space-y-2">
      {normalCount === 0 ? (
        <EmptyStepPicker onAdd={(kind) => insertStep(hasTrailingCleanup ? cleanupIndex : steps.length, kind)} />
      ) : (
        steps.slice(0, normalCount).map((step, index) => (
          <div key={keysRef.current[index] ?? `step-${index}`}>
            <StepCard
              step={step}
              index={index}
              total={normalCount}
              triggerType={triggerType}
              suites={suites}
              isCleanup={false}
              onChange={(next) => updateStep(index, next)}
              onRemove={() => removeStep(index)}
              onMove={(direction) => moveStep(index, direction)}
            />
            <StepInserter onAdd={(kind) => insertStep(index + 1, kind)} />
          </div>
        ))
      )}

      {normalCount > 0 ? (
        <div className="pt-1">
          <AddStepButton onAdd={(kind) => insertStep(normalCount, kind)} />
        </div>
      ) : null}

      {/* Cleanup zone */}
      {hasTrailingCleanup ? (
        <div className="pt-2">
          <StepCard
            step={steps[cleanupIndex]!}
            index={cleanupIndex}
            total={steps.length}
            triggerType={triggerType}
            suites={suites}
            isCleanup
            onChange={(next) => updateStep(cleanupIndex, next)}
            onRemove={() => removeStep(cleanupIndex)}
            onMove={() => {}}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={addCleanup}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/[0.1] px-3 py-2 text-[11px] font-medium text-muted-fg/70 transition-colors hover:border-amber-500/30 hover:text-amber-200"
        >
          <Broom size={13} weight="regular" />
          Add a cleanup step (delete the lane when done)
        </button>
      )}
    </div>
  );
}

function StepInserter({ onAdd }: { onAdd: (kind: StepKind) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(wrapRef, () => setOpen(false), open);
  return (
    <div ref={wrapRef} className="relative flex items-center justify-center py-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded-full border transition-colors",
          open
            ? "border-accent/50 bg-accent/15 text-accent"
            : "border-white/[0.1] bg-white/[0.03] text-muted-fg/50 hover:border-accent/40 hover:text-accent",
        )}
        title="Insert step here"
      >
        <Plus size={11} weight="bold" />
      </button>
      {open ? (
        <StepMenu
          onPick={(kind) => {
            onAdd(kind);
            setOpen(false);
          }}
          className="absolute top-7 z-30"
        />
      ) : null}
    </div>
  );
}

function AddStepButton({ onAdd }: { onAdd: (kind: StepKind) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(wrapRef, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);
  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[12px] font-medium transition-colors",
          open
            ? "border-accent/40 bg-accent/[0.06] text-fg"
            : "border-white/[0.08] bg-white/[0.03] text-fg/85 hover:border-accent/30 hover:bg-white/[0.05]",
        )}
      >
        <span className="flex items-center gap-2">
          <Plus size={12} weight="bold" className="text-accent" />
          Add step
        </span>
        <CaretDown size={11} weight="bold" className={cn("text-muted-fg/60 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <StepMenu
          onPick={(kind) => {
            onAdd(kind);
            setOpen(false);
          }}
          className="absolute left-0 right-0 z-30 mt-1"
        />
      ) : null}
    </div>
  );
}

function StepMenu({ onPick, className }: { onPick: (kind: StepKind) => void; className?: string }) {
  return (
    <div className={cn("w-[280px] rounded-xl border border-white/[0.08] bg-surface-overlay p-1 shadow-float", className)} role="menu">
      {ADDABLE_KINDS.map((kind) => {
        const def = stepDef(kind);
        const Icon = def.icon;
        return (
          <button
            key={kind}
            type="button"
            role="menuitem"
            onClick={() => onPick(kind)}
            className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.05]"
          >
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
              <Icon size={12} weight="fill" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-semibold text-fg">{def.label}</span>
              <span className="mt-0.5 block text-[10.5px] leading-snug text-muted-fg/65">{def.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function EmptyStepPicker({ onAdd }: { onAdd: (kind: StepKind) => void }) {
  return (
    <div className="rounded-xl border border-dashed border-white/[0.1] bg-white/[0.02] p-3">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-fg/60">Pick a first step</div>
      <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {ADDABLE_KINDS.map((kind) => {
          const def = stepDef(kind);
          const Icon = def.icon;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onAdd(kind)}
              className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:border-accent/30 hover:bg-white/[0.05]"
            >
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
                <Icon size={12} weight="fill" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-semibold text-fg">{def.label}</span>
                <span className="mt-0.5 block text-[10.5px] leading-snug text-muted-fg/65">{def.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
