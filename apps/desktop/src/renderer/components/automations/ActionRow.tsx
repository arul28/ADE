import {
  ArrowDown,
  ArrowUp,
  Code,
  GitBranch,
  Lightning,
  TerminalWindow,
  TestTube,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import type { ElementType } from "react";
import type {
  AutomationRuleDraft,
  ModelConfig,
  TestSuiteDefinition,
} from "../../../shared/types";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { inputCls, labelCls, selectCls, textareaCls } from "./designTokens";
import { AdeActionEditor, type AdeActionValue } from "./AdeActionEditor";

export type ActionRowKind =
  | "create-lane"
  | "agent-session"
  | "ade-action"
  | "run-tests"
  | "run-command"
  | "predict-conflicts";

type AutomationPermissionConfig = NonNullable<AutomationRuleDraft["permissionConfig"]>;

export type ActionRowValue = {
  kind: ActionRowKind;
  // Runtime
  targetLaneId?: string | null;
  condition?: string;
  continueOnFailure?: boolean;
  timeoutMs?: number;
  retry?: number;
  // Agent-session
  prompt?: string;
  sessionTitle?: string;
  modelConfig?: ModelConfig;
  fastMode?: boolean;
  permissionConfig?: AutomationPermissionConfig;
  // Create lane
  laneNameTemplate?: string;
  laneDescriptionTemplate?: string;
  parentLaneId?: string | null;
  // ade-action
  adeAction?: AdeActionValue;
  // run-tests
  suiteId?: string;
  // run-command
  command?: string;
  cwd?: string;
};

const KIND_META: Record<ActionRowKind, { label: string; icon: ElementType; accent: string }> = {
  "create-lane": { label: "Create lane", icon: GitBranch, accent: "#2DD4BF" },
  "agent-session": { label: "Agent session", icon: Lightning, accent: "#38BDF8" },
  "ade-action": { label: "ADE action", icon: Code, accent: "#A78BFA" },
  "run-tests": { label: "Run tests", icon: TestTube, accent: "#22C55E" },
  "run-command": { label: "Run command", icon: TerminalWindow, accent: "#F59E0B" },
  "predict-conflicts": { label: "Predict conflicts", icon: Warning, accent: "#F97316" },
};

export function ActionRow({
  index,
  total,
  value,
  lanes,
  suites,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  total: number;
  value: ActionRowValue;
  lanes: Array<{ id: string; name: string }>;
  suites: TestSuiteDefinition[];
  onChange: (next: ActionRowValue) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const meta = KIND_META[value.kind];
  const Icon = meta.icon;

  return (
    <div
      className="rounded-xl border border-white/[0.12] bg-[#162235]"
      style={{ boxShadow: `inset 0 0 0 1px ${meta.accent}24, 0 10px 26px rgba(0,0,0,0.14)` }}
    >
      <div
        className="flex items-center justify-between gap-2 rounded-t-xl border-b border-white/[0.10] px-3 py-2"
        style={{ background: `linear-gradient(90deg, ${meta.accent}14, rgba(28,43,64,0.82))` }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
            style={{
              background: `${meta.accent}26`,
              color: meta.accent,
              boxShadow: `inset 0 0 0 1px ${meta.accent}55`,
            }}
          >
            <Icon size={12} weight="fill" />
          </span>
          <span className="text-[10px] font-bold tracking-wider text-[#AFC0D4]">
            STEP {index + 1}
          </span>
          <span className="text-[12px] font-semibold text-[#F5FAFF]">{meta.label}</span>
          {value.kind === "create-lane" ? (
            <Chip className="text-[9px] text-warning">legacy · now in Execution</Chip>
          ) : null}
          {value.kind === "agent-session" && value.modelConfig ? (
            <Chip className="text-[9px] text-accent">custom model</Chip>
          ) : null}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            className="rounded p-1 text-[#8FA1B8] hover:text-[#F5FAFF] disabled:cursor-not-allowed disabled:opacity-30"
            title="Move up"
          >
            <ArrowUp size={11} weight="bold" />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            className="rounded p-1 text-[#8FA1B8] hover:text-[#F5FAFF] disabled:cursor-not-allowed disabled:opacity-30"
            title="Move down"
          >
            <ArrowDown size={11} weight="bold" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-1 text-[#8FA1B8] hover:text-red-300"
            title="Remove step"
          >
            <Trash size={11} weight="regular" />
          </button>
        </div>
      </div>

      <div className="p-3">
        {value.kind === "create-lane" ? (
          // Read-only legacy view. Lane creation is now an EXECUTION setting,
          // but old rules still on disk render their stored template here so
          // the user can see what they had before migrating.
          <div className="space-y-2">
            <div className="rounded-md border border-warning/25 bg-warning/[0.06] px-3 py-2 text-[11px] text-warning">
              Lane creation moved to the Execution block above. This action is
              kept for legacy rules and ignored on save once you switch to the
              new "Create new lane per run" mode.
            </div>
            <div className="grid gap-2 md:grid-cols-[1.2fr_1fr]">
              <label className="block space-y-1.5">
                <div className={labelCls}>Lane name (legacy)</div>
                <input
                  className={cn(inputCls, "opacity-70")}
                  value={value.laneNameTemplate ?? ""}
                  readOnly
                />
              </label>
              <label className="block space-y-1.5">
                <div className={labelCls}>Base lane (legacy)</div>
                <input
                  className={cn(inputCls, "opacity-70")}
                  value={lanes.find((l) => l.id === value.parentLaneId)?.name ?? "Primary lane"}
                  readOnly
                />
              </label>
            </div>
          </div>
        ) : null}

        {value.kind === "agent-session" ? (
          <div className="space-y-2">
            <input
              className={inputCls}
              value={value.sessionTitle ?? ""}
              onChange={(event) => onChange({ ...value, sessionTitle: event.target.value })}
              placeholder="Thread title (optional)"
            />
            <textarea
              className={cn(textareaCls, "min-h-[112px] text-[12px] leading-relaxed")}
              value={value.prompt ?? ""}
              onChange={(event) => onChange({ ...value, prompt: event.target.value })}
              placeholder="Prompt for the agent session"
              spellCheck
              autoCorrect="on"
              autoCapitalize="sentences"
              autoComplete="on"
            />
          </div>
        ) : null}

        {value.kind === "ade-action" ? (
          <AdeActionEditor
            value={value.adeAction ?? { domain: "", action: "" }}
            onChange={(nextAdeAction) => onChange({ ...value, adeAction: nextAdeAction })}
          />
        ) : null}

        {value.kind === "run-tests" ? (
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Suite</span>
            <select
              className={selectCls}
              value={value.suiteId ?? ""}
              onChange={(event) => onChange({ ...value, suiteId: event.target.value })}
            >
              <option value="" disabled>Select a suite</option>
              {suites.map((suite) => (
                <option key={suite.id} value={suite.id}>
                  {suite.name ?? suite.id}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {value.kind === "run-command" ? (
          <div className="grid gap-2 md:grid-cols-[2fr_1fr]">
            <input
              className={inputCls}
              value={value.command ?? ""}
              onChange={(event) => onChange({ ...value, command: event.target.value })}
              placeholder="e.g. npm test"
            />
            <input
              className={inputCls}
              value={value.cwd ?? ""}
              onChange={(event) => onChange({ ...value, cwd: event.target.value })}
              placeholder="Working dir (optional)"
            />
          </div>
        ) : null}

        {value.kind === "predict-conflicts" ? (
          <div className="text-[11px] leading-relaxed text-[#AFC0D4]">
            Runs the built-in conflict prediction pass against recent lanes. No configuration required.
          </div>
        ) : null}
      </div>
    </div>
  );
}
