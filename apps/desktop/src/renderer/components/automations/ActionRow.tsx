import {
  ArrowDown,
  ArrowUp,
  Code,
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
  "ade-action": { label: "ADE action", icon: Code, accent: "#A78BFA" },
  "run-tests": { label: "Run tests", icon: TestTube, accent: "#22C55E" },
  "run-command": { label: "Run command", icon: TerminalWindow, accent: "#F59E0B" },
  "predict-conflicts": { label: "Predict conflicts", icon: Warning, accent: "#F97316" },
  "launch-mission": { label: "Launch mission", icon: Rocket, accent: "#94A3B8" },
};

export function ActionRow({
  index,
  total,
  value,
  lanes,
  suites,
  fallbackModel,
  executionLaneMode,
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
  executionLaneMode?: string | null;
  onChange: (next: ActionRowValue) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onOpenAiSettings?: () => void;
}) {
  const meta = KIND_META[value.kind];
  const Icon = meta.icon;
  const triggerSuppliesLane = executionLaneMode === "require-on-trigger"
    || executionLaneMode === "provided"
    || executionLaneMode === "prompt-at-run";
  const activeModel = value.modelConfig ?? fallbackModel;
  const permissionMeta = permissionControlsForModel(activeModel.modelId);
  const currentPermission = permissionMeta
    ? value.permissionConfig?.providers?.[permissionMeta.key] ?? ""
    : "";
  const patchValue = (patch: Partial<ActionRowValue>) => {
    const next = { ...value, ...patch };
    if ("condition" in patch && !patch.condition?.trim()) delete next.condition;
    if ("targetLaneId" in patch && !patch.targetLaneId) delete next.targetLaneId;
    if ("timeoutMs" in patch && patch.timeoutMs == null) delete next.timeoutMs;
    if ("retry" in patch && patch.retry == null) delete next.retry;
    if ("continueOnFailure" in patch && !patch.continueOnFailure) delete next.continueOnFailure;
    onChange(next);
  };

  return (
    <div
      className="rounded-xl border border-white/[0.08] bg-black/20"
      style={{ boxShadow: `inset 0 0 0 1px ${meta.accent}1f` }}
    >
      <div
        className="flex items-center justify-between gap-2 rounded-t-xl border-b border-white/[0.06] px-3 py-2"
        style={{ background: `${meta.accent}0d` }}
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
          <span className="text-[10px] font-bold tracking-wider text-[#7E8A9A]">
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
          <div className="text-[11px] leading-relaxed text-[#93A4B8]">
            Runs the built-in conflict prediction pass against recent lanes. No configuration required.
          </div>
        ) : null}

        {value.kind === "launch-mission" ? (
          <div className="space-y-2">
            <input
              className={inputCls}
              value={value.missionTitle ?? ""}
              onChange={(event) => onChange({ ...value, missionTitle: event.target.value })}
              placeholder="Mission title"
            />
            <Chip className="text-[9px] text-[#B6B2C9]">Starts a mission and records the mission id in run history.</Chip>
          </div>
        ) : null}

        {value.kind !== "create-lane" ? (
          <RuntimeControls
            value={value}
            lanes={lanes}
            showLaneOverride={supportsLaneOverride(value.kind)}
            triggerSuppliesLane={triggerSuppliesLane}
            onChange={patchValue}
          />
        ) : null}
      </div>
    </div>
  );
}

function supportsLaneOverride(kind: ActionRowKind): boolean {
  return kind === "agent-session"
    || kind === "run-tests"
    || kind === "run-command"
    || kind === "predict-conflicts"
    || kind === "launch-mission";
}

function secondsFromMs(ms: number | undefined): number | "" {
  if (!Number.isFinite(ms)) return "";
  return Math.max(1, Math.round((ms ?? 0) / 1000));
}

function RuntimeControls({
  value,
  lanes,
  showLaneOverride,
  triggerSuppliesLane,
  onChange,
}: {
  value: ActionRowValue;
  lanes: Array<{ id: string; name: string }>;
  showLaneOverride: boolean;
  triggerSuppliesLane: boolean;
  onChange: (patch: Partial<ActionRowValue>) => void;
}) {
  const condition = value.condition?.trim() ?? "";
  const conditionMode =
    condition === ""
      ? "always"
      : condition === "provider-enabled"
        ? "provider-enabled"
        : condition === "false"
          ? "false"
          : "custom";
  const sortedLanes = [...lanes].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="mt-3 border-t border-white/[0.06] pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className={labelCls}>Runtime</div>
        <div className="text-[10px] text-[#7E8A9A]">Controls how this step runs</div>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <label className="block space-y-1.5">
          <div className={labelCls}>Condition</div>
          <select
            className={selectCls}
            value={conditionMode}
            onChange={(event) => {
              const next = event.target.value;
              if (next === "always") onChange({ condition: undefined });
              else if (next === "provider-enabled") onChange({ condition: "provider-enabled" });
              else if (next === "false") onChange({ condition: "false" });
              else onChange({ condition: condition || "provider-enabled" });
            }}
          >
            <option value="always">Always run</option>
            <option value="provider-enabled">Only when providers are enabled</option>
            <option value="false">Always skip</option>
            <option value="custom">Stored expression</option>
          </select>
        </label>

        <label className="block space-y-1.5">
          <div className={labelCls}>On failure</div>
          <select
            className={selectCls}
            value={value.continueOnFailure ? "continue" : "stop"}
            onChange={(event) => onChange({ continueOnFailure: event.target.value === "continue" })}
          >
            <option value="stop">Stop workflow</option>
            <option value="continue">Continue to next step</option>
          </select>
        </label>

        <label className="block space-y-1.5">
          <div className={labelCls}>Timeout (sec)</div>
          <input
            className={inputCls}
            type="number"
            min={1}
            value={secondsFromMs(value.timeoutMs)}
            onChange={(event) => {
              const raw = event.target.value.trim();
              if (!raw) {
                onChange({ timeoutMs: undefined });
                return;
              }
              const parsed = Number(raw);
              onChange({ timeoutMs: Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) * 1000 : undefined });
            }}
            placeholder="Default"
          />
        </label>

        <label className="block space-y-1.5">
          <div className={labelCls}>Retries</div>
          <input
            className={inputCls}
            type="number"
            min={0}
            max={5}
            value={Number.isFinite(value.retry) ? value.retry : ""}
            onChange={(event) => {
              const raw = event.target.value.trim();
              if (!raw) {
                onChange({ retry: undefined });
                return;
              }
              const parsed = Number(raw);
              onChange({ retry: Number.isFinite(parsed) ? Math.max(0, Math.min(5, Math.floor(parsed))) : undefined });
            }}
            placeholder="0"
          />
        </label>
      </div>

      {conditionMode === "custom" ? (
        <label className="mt-2 block space-y-1.5">
          <div className={labelCls}>Stored condition</div>
          <input
            className={inputCls}
            value={value.condition ?? ""}
            onChange={(event) => onChange({ condition: event.target.value })}
            placeholder="provider-enabled"
          />
          <div className="text-[10px] leading-snug text-[#7E8A9A]">
            Runtime currently treats <span className="font-mono text-[#A7B7CA]">false</span> and{" "}
            <span className="font-mono text-[#A7B7CA]">provider-enabled</span> specially.
          </div>
        </label>
      ) : null}

      {triggerSuppliesLane ? (
        <div className="mt-2 rounded-md border border-[#2DD4BF]/20 bg-[#2DD4BF]/[0.06] px-2.5 py-2 text-[10.5px] leading-snug text-[#9BE7D8]">
          This rule uses the lane supplied at run time for every step. Saved step lane overrides are ignored and removed on save.
        </div>
      ) : showLaneOverride ? (
        <label className="mt-2 block space-y-1.5">
          <div className={labelCls}>Lane override</div>
          <select
            className={selectCls}
            value={value.targetLaneId ?? ""}
            onChange={(event) => onChange({ targetLaneId: event.target.value || null })}
          >
            <option value="">Use execution lane</option>
            {sortedLanes.map((lane) => (
              <option key={lane.id} value={lane.id}>
                {lane.name}
              </option>
            ))}
          </select>
        </label>
      ) : value.targetLaneId ? (
        <div className="mt-2 rounded-md border border-warning/20 bg-warning/[0.06] px-2.5 py-2 text-[10.5px] text-warning">
          This saved step has a lane override, but this action type does not use it at runtime.
        </div>
      ) : null}
    </div>
  );
}
