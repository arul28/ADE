import React, { useCallback, useState } from "react";
import {
  ArrowLeft,
  Code,
  Browsers,
  Bug,
  GearSix,
  BookOpen,
  Wrench,
} from "@phosphor-icons/react";
import type { AgentIdentity, AgentRole, WorkerTemplate } from "../../../shared/types";
import { ProviderModelSelector } from "../shared/ProviderModelSelector";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { inputCls, labelCls, selectCls, WORKER_TEMPLATES } from "./shared/designTokens";

const TEMPLATE_ICONS: Record<string, React.ElementType> = {
  "backend-engineer": Code,
  "frontend-engineer": Browsers,
  "qa-tester": Bug,
  devops: GearSix,
  researcher: BookOpen,
  custom: Wrench,
};

type WizardDraft = {
  templateId: string;
  name: string;
  role: AgentRole;
  capabilities: string;
  model: string;
  budgetDollars: number;
};

const defaultDraft: WizardDraft = {
  templateId: "",
  name: "",
  role: "engineer",
  capabilities: "",
  model: "claude-sonnet-4-6",
  budgetDollars: 0,
};

export function WorkerCreationWizard({
  onComplete,
  onCancel,
}: {
  agents: AgentIdentity[];
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"template" | "configure">("template");
  const [draft, setDraft] = useState<WizardDraft>(defaultDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyTemplate = useCallback((template: WorkerTemplate) => {
    setDraft((d) => ({
      ...d,
      templateId: template.id,
      name: template.id === "custom" ? "" : template.name,
      role: template.role,
      capabilities: template.capabilities.join(", "),
      model: template.model ?? "claude-sonnet-4-6",
    }));
    setStep("configure");
  }, []);

  const handleSave = useCallback(async () => {
    if (!window.ade?.cto || !draft.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await window.ade.cto.saveAgent({
        agent: {
          name: draft.name,
          role: draft.role,
          capabilities: draft.capabilities.split(",").map((s) => s.trim()).filter(Boolean),
          adapterType: "claude-local",
          adapterConfig: { model: draft.model.trim() || undefined },
          runtimeConfig: {
            heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true },
            maxConcurrentRuns: 1,
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

  /* ── Step 1: Choose Template ── */
  if (step === "template") {
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onCancel} className="text-muted-fg/50 hover:text-fg transition-colors">
            <ArrowLeft size={16} />
          </button>
          <div>
            <div className="text-sm font-semibold text-fg">Hire a Worker</div>
            <div className="text-[11px] text-muted-fg/50">Step 1 of 2 — Choose a template to get started.</div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {WORKER_TEMPLATES.map((template) => {
            const Icon = TEMPLATE_ICONS[template.id] ?? Wrench;
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => applyTemplate(template)}
                className={cn(
                  "text-left rounded-lg p-4 border transition-all duration-150",
                  "border-white/[0.06] bg-white/[0.03] hover:border-accent/30 hover:bg-accent/5",
                )}
              >
                <div className="flex items-center gap-2.5 mb-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/10 border border-accent/15">
                    <Icon size={16} weight="duotone" className="text-accent" />
                  </div>
                  <span className="text-xs font-semibold text-fg">{template.name}</span>
                </div>
                <div className="text-[11px] leading-relaxed text-muted-fg/55 mb-2.5">{template.description}</div>
                {template.capabilities.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {template.capabilities.map((cap) => (
                      <span key={cap} className="rounded-sm bg-white/[0.04] border border-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-fg/50">{cap}</span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  /* ── Step 2: Name & Model ── */
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setStep("template")} className="text-muted-fg/50 hover:text-fg transition-colors">
          <ArrowLeft size={16} />
        </button>
        <div>
          <div className="text-sm font-semibold text-fg">Configure Worker</div>
          <div className="text-[11px] text-muted-fg/50">Step 2 of 2 — Set a name, model, and optional settings.</div>
        </div>
      </div>

      <div className="max-w-lg space-y-4">
        {/* Name + Role */}
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1.5">
            <div className={labelCls}>Worker Name</div>
            <input
              className={inputCls}
              placeholder="e.g. Backend Engineer"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              autoFocus
            />
          </label>
          <label className="space-y-1.5">
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
        </div>

        {/* Capabilities */}
        <label className="block space-y-1.5">
          <div className={labelCls}>Capabilities</div>
          <input
            className={inputCls}
            placeholder="api, database, react (comma-separated)"
            value={draft.capabilities}
            onChange={(e) => setDraft((d) => ({ ...d, capabilities: e.target.value }))}
          />
        </label>

        {/* Model */}
        <div className="space-y-1.5">
          <div className={labelCls}>Model</div>
          <ProviderModelSelector
            value={draft.model}
            onChange={(modelId) => setDraft((d) => ({ ...d, model: modelId }))}
          />
        </div>

        {/* Budget */}
        <label className="block space-y-1.5">
          <div className={labelCls}>Monthly Budget</div>
          <input
            className={cn(inputCls, "max-w-[200px]")}
            type="number"
            min={0}
            step={1}
            placeholder="$0 = unlimited"
            value={draft.budgetDollars || ""}
            onChange={(e) => setDraft((d) => ({ ...d, budgetDollars: Number(e.target.value || 0) }))}
          />
          <div className="text-[10px] text-muted-fg/40 mt-1">$0 means no spending cap.</div>
        </label>

        {/* Error */}
        {error && <div className="text-xs text-error">{error}</div>}

        {/* Actions */}
        <div className="flex items-center gap-3 pt-2">
          <Button variant="primary" onClick={() => void handleSave()} disabled={saving || !draft.name.trim()}>
            {saving ? "Creating..." : "Create Worker"}
          </Button>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
