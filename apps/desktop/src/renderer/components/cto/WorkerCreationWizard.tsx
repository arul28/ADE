import React, { useCallback, useState } from "react";
import {
  Code,
  Browsers,
  Bug,
  GearSix,
  BookOpen,
  Wrench,
  UserPlus,
} from "@phosphor-icons/react";
import type { AgentIdentity, AgentRole, AdapterType, WorkerTemplate } from "../../../shared/types";
import { StepWizard } from "./shared/StepWizard";
import type { WizardStep } from "./shared/StepWizard";
import { inputCls, labelCls, selectCls, cardCls, WORKER_TEMPLATES } from "./shared/designTokens";
import { cn } from "../ui/cn";

const TEMPLATE_ICONS: Record<string, React.ElementType> = {
  "backend-engineer": Code,
  "frontend-engineer": Browsers,
  "qa-tester": Bug,
  devops: GearSix,
  researcher: BookOpen,
  custom: Wrench,
};

const STEPS: WizardStep[] = [
  { id: "template", label: "Template", icon: UserPlus },
  { id: "identity", label: "Identity", icon: Code },
  { id: "runtime", label: "Runtime", icon: GearSix },
];

type WizardDraft = {
  templateId: string;
  name: string;
  role: AgentRole;
  title: string;
  capabilities: string;
  reportsTo: string;
  adapterType: AdapterType;
  model: string;
  webhookUrl: string;
  processCommand: string;
  budgetDollars: number;
  heartbeatEnabled: boolean;
  heartbeatIntervalSec: number;
  wakeOnDemand: boolean;
  maxConcurrentRuns: number;
};

const defaultDraft: WizardDraft = {
  templateId: "",
  name: "",
  role: "engineer",
  title: "",
  capabilities: "",
  reportsTo: "",
  adapterType: "claude-local",
  model: "claude-sonnet-4-6",
  webhookUrl: "",
  processCommand: "",
  budgetDollars: 0,
  heartbeatEnabled: false,
  heartbeatIntervalSec: 300,
  wakeOnDemand: true,
  maxConcurrentRuns: 1,
};

export function WorkerCreationWizard({
  agents,
  onComplete,
  onCancel,
}: {
  agents: AgentIdentity[];
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [activeStep, setActiveStep] = useState("template");
  const [draft, setDraft] = useState<WizardDraft>(defaultDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyTemplate = useCallback((template: WorkerTemplate) => {
    setDraft((d) => ({
      ...d,
      templateId: template.id,
      name: template.id === "custom" ? "" : template.name,
      role: template.role,
      title: template.title,
      capabilities: template.capabilities.join(", "),
      adapterType: template.adapterType,
      model: template.model ?? "claude-sonnet-4-6",
    }));
    setActiveStep("identity");
  }, []);

  const handleSave = useCallback(async () => {
    if (!window.ade?.cto || !draft.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const adapterConfig: Record<string, unknown> =
        draft.adapterType === "openclaw-webhook"
          ? { url: draft.webhookUrl }
          : draft.adapterType === "process"
            ? { command: draft.processCommand }
            : { model: draft.model.trim() || undefined };

      await window.ade.cto.saveAgent({
        agent: {
          name: draft.name,
          role: draft.role,
          title: draft.title.trim() || undefined,
          reportsTo: draft.reportsTo || null,
          capabilities: draft.capabilities.split(",").map((s) => s.trim()).filter(Boolean),
          adapterType: draft.adapterType,
          adapterConfig,
          runtimeConfig: {
            heartbeat: {
              enabled: draft.heartbeatEnabled,
              intervalSec: draft.heartbeatIntervalSec,
              wakeOnDemand: draft.wakeOnDemand,
            },
            maxConcurrentRuns: draft.maxConcurrentRuns,
          },
          budgetMonthlyCents: Math.round(draft.budgetDollars * 100),
        },
      });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create worker.");
    } finally {
      setSaving(false);
    }
  }, [draft, onComplete]);

  return (
    <div className={cn(cardCls, "flex flex-col")} style={{ height: 480 }}>
      <StepWizard
        steps={STEPS}
        activeStep={activeStep}
        onStepChange={setActiveStep}
        onComplete={handleSave}
        onBack={onCancel}
        onSkip={onCancel}
        showSkip={false}
        completing={saving}
        completeLabel="Create Worker"
      >
        {/* Step 1: Template */}
        {activeStep === "template" && (
          <div className="space-y-3">
            <div className="font-sans text-xs font-bold text-fg">Choose a Template</div>
            <div className="grid grid-cols-2 gap-2">
              {WORKER_TEMPLATES.map((template) => {
                const Icon = TEMPLATE_ICONS[template.id] ?? Wrench;
                const isSelected = draft.templateId === template.id;
                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => applyTemplate(template)}
                    className={cn(
                      "text-left p-3 border transition-all",
                      isSelected
                        ? "border-accent/40 bg-accent/5"
                        : "border-border/15 bg-surface-recessed hover:border-border/30",
                    )}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <Icon size={14} weight="duotone" className={isSelected ? "text-accent" : "text-muted-fg/50"} />
                      <span className="font-mono text-[10px] font-bold text-fg">{template.name}</span>
                    </div>
                    <div className="font-mono text-[9px] text-muted-fg/50 line-clamp-2">{template.description}</div>
                    {template.capabilities.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {template.capabilities.slice(0, 3).map((cap) => (
                          <span key={cap} className="font-mono text-[8px] text-muted-fg/40 bg-border/10 px-1 py-0.5">{cap}</span>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 2: Identity */}
        {activeStep === "identity" && (
          <div className="space-y-3 max-w-md">
            <div className="font-sans text-xs font-bold text-fg">Configure Identity</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <div className={labelCls}>Name</div>
                <input className={inputCls} placeholder="Worker name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              </label>
              <label className="space-y-1">
                <div className={labelCls}>Title</div>
                <input className={inputCls} placeholder="Optional title" value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <div className={labelCls}>Role</div>
                <select className={selectCls} value={draft.role} onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value as AgentRole }))}>
                  <option value="engineer">Engineer</option>
                  <option value="qa">QA</option>
                  <option value="designer">Designer</option>
                  <option value="devops">DevOps</option>
                  <option value="researcher">Researcher</option>
                  <option value="general">General</option>
                </select>
              </label>
              <label className="space-y-1">
                <div className={labelCls}>Reports to</div>
                <select className={selectCls} value={draft.reportsTo} onChange={(e) => setDraft((d) => ({ ...d, reportsTo: e.target.value }))}>
                  <option value="">CTO (root)</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="space-y-1 block">
              <div className={labelCls}>Capabilities</div>
              <input className={inputCls} placeholder="api, db, react (comma-separated)" value={draft.capabilities} onChange={(e) => setDraft((d) => ({ ...d, capabilities: e.target.value }))} />
            </label>
          </div>
        )}

        {/* Step 3: Runtime */}
        {activeStep === "runtime" && (
          <div className="space-y-3 max-w-md">
            <div className="font-sans text-xs font-bold text-fg">Adapter & Runtime</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <div className={labelCls}>Adapter</div>
                <select className={selectCls} value={draft.adapterType} onChange={(e) => setDraft((d) => ({ ...d, adapterType: e.target.value as AdapterType }))}>
                  <option value="claude-local">claude-local</option>
                  <option value="codex-local">codex-local</option>
                  <option value="openclaw-webhook">openclaw-webhook</option>
                  <option value="process">process</option>
                </select>
              </label>
              {(draft.adapterType === "claude-local" || draft.adapterType === "codex-local") && (
                <label className="space-y-1">
                  <div className={labelCls}>Model</div>
                  <input className={inputCls} placeholder="claude-sonnet-4-6" value={draft.model} onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))} />
                </label>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <div className={labelCls}>Budget $/mo</div>
                <input className={inputCls} type="number" min={0} step={1} placeholder="0 = no cap" value={draft.budgetDollars || ""} onChange={(e) => setDraft((d) => ({ ...d, budgetDollars: Number(e.target.value || 0) }))} />
              </label>
              <label className="space-y-1">
                <div className={labelCls}>Max concurrent</div>
                <input className={inputCls} type="number" min={1} max={10} value={draft.maxConcurrentRuns} onChange={(e) => setDraft((d) => ({ ...d, maxConcurrentRuns: Number(e.target.value || 1) }))} />
              </label>
            </div>

            <div className="border border-border/10 bg-card/60 p-3 space-y-2">
              <div className={labelCls}>Heartbeat</div>
              <label className="flex items-center gap-2 text-xs text-muted-fg cursor-pointer">
                <input type="checkbox" checked={draft.heartbeatEnabled} onChange={(e) => setDraft((d) => ({ ...d, heartbeatEnabled: e.target.checked }))} />
                Timer-based heartbeat
              </label>
              {draft.heartbeatEnabled && (
                <label className="space-y-1 block pl-5">
                  <div className="text-[9px] text-muted-fg/50">Interval (seconds)</div>
                  <input className={inputCls} type="number" min={0} value={draft.heartbeatIntervalSec} onChange={(e) => setDraft((d) => ({ ...d, heartbeatIntervalSec: Number(e.target.value || 0) }))} />
                </label>
              )}
              <label className="flex items-center gap-2 text-xs text-muted-fg cursor-pointer">
                <input type="checkbox" checked={draft.wakeOnDemand} onChange={(e) => setDraft((d) => ({ ...d, wakeOnDemand: e.target.checked }))} />
                Wake on demand
              </label>
            </div>

            {error && <div className="text-xs text-error">{error}</div>}
          </div>
        )}
      </StepWizard>
    </div>
  );
}
