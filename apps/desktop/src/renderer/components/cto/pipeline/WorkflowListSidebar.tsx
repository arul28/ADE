import React from "react";
import { ArrowClockwise, Lightning, Plus } from "@phosphor-icons/react";
import type { LinearConnectionStatus, LinearWorkflowDefinition, LinearWorkflowTargetType } from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { cardCls } from "../shared/designTokens";
import { cn } from "../../ui/cn";
import { TARGET_TYPE_LABELS, STAGE_COLORS, PRESET_TEMPLATE_DESCRIPTIONS } from "./pipelineLabels";

const PRESET_TEMPLATES: ReadonlyArray<{ type: LinearWorkflowTargetType; label: string; color: string; description: string }> = [
  { type: "employee_session", label: "Employee", color: STAGE_COLORS.employee_session, description: PRESET_TEMPLATE_DESCRIPTIONS.employee_session },
  { type: "mission", label: "Mission", color: STAGE_COLORS.mission, description: PRESET_TEMPLATE_DESCRIPTIONS.mission },
  { type: "worker_run", label: "Worker Run", color: STAGE_COLORS.worker_run, description: PRESET_TEMPLATE_DESCRIPTIONS.worker_run },
  { type: "pr_resolution", label: "PR Resolution", color: STAGE_COLORS.pr_resolution, description: PRESET_TEMPLATE_DESCRIPTIONS.pr_resolution },
  { type: "review_gate", label: "Review Gate", color: STAGE_COLORS.review_gate, description: PRESET_TEMPLATE_DESCRIPTIONS.review_gate },
];

function triggerSummary(workflow: LinearWorkflowDefinition): string {
  const parts: string[] = [];
  if (workflow.triggers.assignees?.length) parts.push(`assignee: ${workflow.triggers.assignees.join(", ")}`);
  if (workflow.triggers.labels?.length) parts.push(`label: ${workflow.triggers.labels.join(", ")}`);
  if (workflow.triggers.teamKeys?.length) parts.push(`team: ${workflow.triggers.teamKeys.join(", ")}`);
  if (workflow.triggers.projectSlugs?.length) parts.push(`project: ${workflow.triggers.projectSlugs.join(", ")}`);
  if (workflow.triggers.priority?.length) parts.push(`priority: ${workflow.triggers.priority.join(", ")}`);
  if (workflow.triggers.stateTransitions?.length) {
    parts.push(
      `state: ${workflow.triggers.stateTransitions
        .map((transition) => {
          const to = (transition.to ?? []).join(" | ");
          const from = (transition.from ?? []).join(" | ");
          return from.length ? `${from} -> ${to}` : to;
        })
        .join("; ")}`,
    );
  }
  if (workflow.triggers.owner?.length) parts.push(`owner: ${workflow.triggers.owner.join(", ")}`);
  if (workflow.triggers.creator?.length) parts.push(`creator: ${workflow.triggers.creator.join(", ")}`);
  if (workflow.triggers.metadataTags?.length) parts.push(`tag: ${workflow.triggers.metadataTags.join(", ")}`);
  if (workflow.routing?.watchOnly) parts.push("watch only");
  return parts.length ? parts.join(" + ") : "No triggers";
}

type Props = {
  connection: LinearConnectionStatus | null;
  workflows: LinearWorkflowDefinition[];
  selectedWorkflowId: string | null;
  loading: boolean;
  onSelectWorkflow: (id: string) => void;
  onAddPreset: (type: LinearWorkflowTargetType) => void;
  onRefresh: () => void;
  onSyncNow: () => void;
  onNavigateSettings: () => void;
};

export function WorkflowListSidebar({
  connection,
  workflows,
  selectedWorkflowId,
  loading,
  onSelectWorkflow,
  onAddPreset,
  onRefresh,
  onSyncNow,
  onNavigateSettings,
}: Props) {
  return (
    <aside
      className="border-r p-3 overflow-y-auto"
      style={{ borderColor: "rgba(167,139,250,0.06)", background: "rgba(12,10,20,0.4)" }}
    >
      <div className="space-y-3">
        {/* Connection status */}
        <div className={cn(cardCls, "space-y-3 p-3.5")}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-fg/40">
                Linear connection
              </div>
              <div className="mt-1.5 text-xs leading-relaxed text-fg/70">
                {connection?.connected
                  ? `Connected${connection.viewerName ? ` as ${connection.viewerName}` : ""}.`
                  : "Not connected. Connect Linear in Settings, then come back here to manage workflows."}
              </div>
            </div>
            <span
              className="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider"
              style={{
                color: connection?.connected ? "#34D399" : "#F59E0B",
                background: connection?.connected ? "rgba(52, 211, 153, 0.08)" : "rgba(245, 158, 11, 0.08)",
                border: `1px solid ${connection?.connected ? "rgba(52, 211, 153, 0.15)" : "rgba(245, 158, 11, 0.15)"}`,
              }}
            >
              {connection?.connected ? "Connected" : "Needs setup"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="!text-[11px]" onClick={onNavigateSettings}>
              {connection?.connected ? "Manage in Settings" : "Connect in Settings"}
            </Button>
            <Button variant="ghost" size="sm" className="!h-7 !text-[11px]" onClick={onRefresh} disabled={loading} aria-busy={loading}>
              <ArrowClockwise size={11} aria-hidden="true" />
              Refresh
            </Button>
          </div>
        </div>

        {/* Workflow list */}
        <div>
          <div className="mb-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-muted-fg/40 uppercase tracking-[0.12em]">Workflows</span>
              {workflows.length > 0 && (
                <span
                  className="inline-flex h-[1.125rem] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums"
                  style={{ background: "rgba(56,189,248,0.12)", color: "#38BDF8" }}
                >
                  {workflows.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" className="!h-6 !px-1.5" onClick={onSyncNow} disabled={loading} title="Sync now" aria-label="Sync now" aria-busy={loading}>
                <Lightning size={11} aria-hidden="true" />
              </Button>
              <Button variant="ghost" size="sm" className="!h-6 !px-1.5" onClick={onRefresh} disabled={loading} title="Refresh" aria-label="Refresh" aria-busy={loading}>
                <ArrowClockwise size={11} aria-hidden="true" />
              </Button>
            </div>
          </div>

          {/* New Workflow button */}
          <button
            type="button"
            onClick={() => onAddPreset("employee_session")}
            className="mb-2.5 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold transition-all duration-200 hover:bg-white/[0.04]"
            style={{
              border: "1px solid transparent",
              backgroundImage: "linear-gradient(rgba(12,10,20,0.95), rgba(12,10,20,0.95)), linear-gradient(135deg, rgba(56,189,248,0.5), rgba(167,139,250,0.5))",
              backgroundOrigin: "border-box",
              backgroundClip: "padding-box, border-box",
              color: "#38BDF8",
            }}
          >
            <Plus size={12} weight="bold" />
            New Workflow
          </button>

          <div className="space-y-1.5">
            {workflows.map((workflow) => {
              const isSelected = selectedWorkflowId === workflow.id;
              const typeLabel = TARGET_TYPE_LABELS[workflow.target.type]?.displayName ?? workflow.target.type;
              const triggers = triggerSummary(workflow);
              return (
                <button
                  key={workflow.id}
                  type="button"
                  onClick={() => onSelectWorkflow(workflow.id)}
                  className={cn(
                    "w-full rounded-lg px-3 py-2.5 text-left transition-all duration-200",
                    isSelected ? "bg-[rgba(167,139,250,0.08)]" : "hover:bg-white/[0.03]",
                  )}
                  style={isSelected ? { border: "1px solid rgba(167,139,250,0.15)" } : { border: "1px solid transparent" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-xs font-medium text-fg">{workflow.name}</div>
                    <div
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ background: workflow.enabled ? "#34D399" : "#6B7280" }}
                    />
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-fg/40">{typeLabel}</div>
                  <div className="mt-0.5 truncate text-[10px] text-muted-fg/30 leading-snug">{triggers}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Add from template */}
        <div>
          <div className="mb-2.5 text-[11px] font-semibold text-muted-fg/40 uppercase tracking-[0.12em]">
            Add from template
          </div>
          <div className="grid gap-2">
            {PRESET_TEMPLATES.map(({ type, label, color, description }) => (
              <button
                key={type}
                type="button"
                onClick={() => onAddPreset(type)}
                className="rounded-lg px-3 py-2.5 text-left transition-all duration-200 hover:bg-white/[0.04] hover:translate-x-[1px]"
                style={{ border: `1px solid ${color}15`, background: `${color}06` }}
              >
                <div className="flex items-center gap-2">
                  <Plus size={11} style={{ color }} />
                  <span className="text-xs font-semibold" style={{ color }}>{label}</span>
                </div>
                <div className="mt-1 text-[11px] text-muted-fg/35 leading-snug">{description}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
