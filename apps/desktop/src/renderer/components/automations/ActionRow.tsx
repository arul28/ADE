import {
  ArrowDown,
  ArrowUp,
  Code,
  Gear,
  Lightning,
  Rocket,
  TerminalWindow,
  TestTube,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import type { ElementType } from "react";
import type { TestSuiteDefinition } from "../../../shared/types";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { INPUT_CLS, INPUT_STYLE } from "./shared";
import { AdeActionEditor, type AdeActionValue } from "./AdeActionEditor";

export type ActionRowKind =
  | "agent-session"
  | "ade-action"
  | "run-tests"
  | "run-command"
  | "predict-conflicts"
  | "launch-mission";

export type ActionRowValue = {
  kind: ActionRowKind;
  // Agent-session
  prompt?: string;
  sessionTitle?: string;
  // ade-action
  adeAction?: AdeActionValue;
  // run-tests
  suiteId?: string;
  // run-command
  command?: string;
  cwd?: string;
  // Mission
  missionTitle?: string;
};

const KIND_META: Record<ActionRowKind, { label: string; icon: ElementType; accent: string }> = {
  "agent-session": { label: "Agent session", icon: Lightning, accent: "#38BDF8" },
  "ade-action": { label: "Run ADE action", icon: Code, accent: "#A78BFA" },
  "run-tests": { label: "Run tests", icon: TestTube, accent: "#22C55E" },
  "run-command": { label: "Run command", icon: TerminalWindow, accent: "#F59E0B" },
  "predict-conflicts": { label: "Predict conflicts", icon: Warning, accent: "#F97316" },
  "launch-mission": { label: "Mission", icon: Rocket, accent: "#94A3B8" },
};

export function ActionRow({
  index,
  total,
  value,
  suites,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  total: number;
  value: ActionRowValue;
  suites: TestSuiteDefinition[];
  onChange: (next: ActionRowValue) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const meta = KIND_META[value.kind];
  const Icon = meta.icon;

  return (
    <div
      className="rounded-xl border border-white/[0.08] bg-black/15 p-3"
      style={{ boxShadow: `0 0 0 1px ${meta.accent}22 inset` }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={13} weight="regular" style={{ color: meta.accent }} />
          <span className="text-[11px] font-semibold text-[#F5FAFF]">
            {index + 1}. {meta.label}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            className="rounded p-1 text-[#8FA1B8] hover:text-[#F5FAFF] disabled:opacity-30 disabled:cursor-not-allowed"
            title="Move up"
          >
            <ArrowUp size={12} weight="regular" />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            className="rounded p-1 text-[#8FA1B8] hover:text-[#F5FAFF] disabled:opacity-30 disabled:cursor-not-allowed"
            title="Move down"
          >
            <ArrowDown size={12} weight="regular" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-1 text-[#8FA1B8] hover:text-red-200"
            title="Remove action"
          >
            <Trash size={12} weight="regular" />
          </button>
        </div>
      </div>

      <div className="mt-3">
        {value.kind === "agent-session" ? (
          <div className="space-y-2">
            <input
              className={INPUT_CLS}
              style={INPUT_STYLE}
              value={value.sessionTitle ?? ""}
              onChange={(event) => onChange({ ...value, sessionTitle: event.target.value })}
              placeholder="Thread title (optional)"
            />
            <textarea
              className="min-h-[72px] w-full rounded-md px-3 py-2 font-mono text-[11px] text-[#F5F7FA] placeholder:text-[#7E8A9A]"
              style={INPUT_STYLE}
              value={value.prompt ?? ""}
              onChange={(event) => onChange({ ...value, prompt: event.target.value })}
              placeholder="Prompt for the agent session"
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
          <label className="space-y-1 block">
            <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Suite</span>
            <select
              className={INPUT_CLS}
              style={INPUT_STYLE}
              value={value.suiteId ?? ""}
              onChange={(event) => onChange({ ...value, suiteId: event.target.value })}
            >
              <option value="">Project default</option>
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
              className={INPUT_CLS}
              style={INPUT_STYLE}
              value={value.command ?? ""}
              onChange={(event) => onChange({ ...value, command: event.target.value })}
              placeholder="e.g. npm test"
            />
            <input
              className={INPUT_CLS}
              style={INPUT_STYLE}
              value={value.cwd ?? ""}
              onChange={(event) => onChange({ ...value, cwd: event.target.value })}
              placeholder="Working dir (optional)"
            />
          </div>
        ) : null}

        {value.kind === "predict-conflicts" ? (
          <div className="text-[11px] text-[#93A4B8]">
            Runs the built-in conflict prediction pass against recent lanes. No configuration required.
          </div>
        ) : null}

        {value.kind === "launch-mission" ? (
          <div className="space-y-2">
            <input
              className={cn(INPUT_CLS, "opacity-60")}
              style={INPUT_STYLE}
              value={value.missionTitle ?? ""}
              onChange={(event) => onChange({ ...value, missionTitle: event.target.value })}
              placeholder="Mission title"
              disabled
            />
            <Chip className="text-[9px] text-[#B6B2C9]">
              <Gear size={10} weight="regular" className="mr-1" />
              Mission launches are coming soon.
            </Chip>
          </div>
        ) : null}
      </div>
    </div>
  );
}
