import {
  ArrowDown,
  ArrowUp,
  Code,
  Gear,
  GitBranch,
  Lightning,
  Rocket,
  TerminalWindow,
  TestTube,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import type { ElementType } from "react";
import type {
  MissionPermissionConfig,
  ModelConfig,
  TestSuiteDefinition,
} from "../../../shared/types";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { ModelSelector } from "../missions/ModelSelector";
import { permissionControlsForModel, patchPermissionConfig } from "./permissionControls";
import { inputCls, labelCls, selectCls, textareaCls } from "./designTokens";
import { AdeActionEditor, type AdeActionValue } from "./AdeActionEditor";

export type ActionRowKind =
  | "create-lane"
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
  targetLaneId?: string | null;
  modelConfig?: ModelConfig;
  permissionConfig?: MissionPermissionConfig;
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
  // Mission
  missionTitle?: string;
};

const KIND_META: Record<ActionRowKind, { label: string; icon: ElementType; accent: string }> = {
  "create-lane": { label: "Create lane", icon: GitBranch, accent: "#2DD4BF" },
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
  lanes,
  suites,
  fallbackModel,
  onChange,
  onRemove,
  onMove,
  onOpenAiSettings,
}: {
  index: number;
  total: number;
  value: ActionRowValue;
  lanes: Array<{ id: string; name: string }>;
  suites: TestSuiteDefinition[];
  fallbackModel: ModelConfig;
  onChange: (next: ActionRowValue) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onOpenAiSettings?: () => void;
}) {
  const meta = KIND_META[value.kind];
  const Icon = meta.icon;
  const activeModel = value.modelConfig ?? fallbackModel;
  const permissionMeta = permissionControlsForModel(activeModel.modelId);
  const currentPermission = permissionMeta
    ? value.permissionConfig?.providers?.[permissionMeta.key] ?? ""
    : "";

  return (
    <div
      className="rounded-xl border border-white/[0.08] bg-[rgba(12,10,22,0.4)] p-3 transition-colors hover:border-white/[0.12]"
      style={{ borderLeft: `2px solid ${meta.accent}` }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon size={13} weight="regular" style={{ color: meta.accent }} />
          <span className="text-[11px] font-semibold text-fg">
            {index + 1}. {meta.label}
          </span>
          {value.kind === "create-lane" ? (
            <Chip className="text-[9px] text-warning">legacy · now in Execution</Chip>
          ) : null}
          {value.kind === "agent-session" && value.modelConfig ? (
            <Chip className="text-[9px] text-accent">custom model</Chip>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            className="rounded p-1 text-muted-fg/60 transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
            title="Move up"
          >
            <ArrowUp size={12} weight="regular" />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            className="rounded p-1 text-muted-fg/60 transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
            title="Move down"
          >
            <ArrowDown size={12} weight="regular" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-1 text-muted-fg/60 transition-colors hover:text-error"
            title="Remove action"
          >
            <Trash size={12} weight="regular" />
          </button>
        </div>
      </div>

      <div className="mt-3">
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
            {/* Per-action lane override removed — every action inherits the
                rule's EXECUTION lane setting. Model + Permissions remain
                here as overrides since users do legitimately want different
                models per step in a multi-step pipeline. */}
            <div className="grid gap-2 md:grid-cols-[1.2fr_1fr]">
              <div className="min-w-0 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className={labelCls}>Model</div>
                  {value.modelConfig ? (
                    <button
                      type="button"
                      className="text-[10px] text-muted-fg/60 transition-colors hover:text-fg"
                      onClick={() => onChange({ ...value, modelConfig: undefined })}
                    >
                      Use rule
                    </button>
                  ) : null}
                </div>
                <ModelSelector
                  value={activeModel}
                  onChange={(modelConfig) => onChange({ ...value, modelConfig })}
                  compact
                  onOpenAiSettings={onOpenAiSettings}
                />
              </div>
              <label className="block space-y-1.5">
                <div className={labelCls}>Permissions</div>
                <select
                  className={selectCls}
                  value={currentPermission}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      permissionConfig: patchPermissionConfig(value.permissionConfig, activeModel.modelId, event.target.value),
                    })
                  }
                  disabled={!permissionMeta}
                >
                  <option value="">Rule permissions</option>
                  {permissionMeta?.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <input
              className={inputCls}
              value={value.sessionTitle ?? ""}
              onChange={(event) => onChange({ ...value, sessionTitle: event.target.value })}
              placeholder="Thread title (optional)"
            />
            <textarea
              className={cn(textareaCls, "min-h-[72px] font-mono text-[11px]")}
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
          <label className="block space-y-1.5">
            <div className={labelCls}>Suite</div>
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
          <div className="text-[11px] text-muted-fg/60">
            Runs the built-in conflict prediction pass against recent lanes. No configuration required.
          </div>
        ) : null}

        {value.kind === "launch-mission" ? (
          <div className="space-y-2">
            <input
              className={cn(inputCls, "opacity-60")}
              value={value.missionTitle ?? ""}
              onChange={(event) => onChange({ ...value, missionTitle: event.target.value })}
              placeholder="Mission title"
              disabled
            />
            <Chip className="text-[9px] text-muted-fg">
              <Gear size={10} weight="regular" className="mr-1" />
              Mission launches are coming soon.
            </Chip>
          </div>
        ) : null}
      </div>
    </div>
  );
}
