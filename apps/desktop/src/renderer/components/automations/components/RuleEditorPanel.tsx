import { useEffect, useMemo, useState } from "react";
import {
  FloppyDisk as Save,
  X,
  Flask as FlaskConical,
} from "@phosphor-icons/react";
import type {
  AgentIdentity,
  AutomationDraftConfirmationRequirement,
  AutomationDraftIssue,
  AutomationIngressStatus,
  AutomationRuleDraft,
  TestSuiteDefinition,
} from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { getAutomationsBridge, INPUT_CLS, INPUT_STYLE } from "../shared";

const TOOL_OPTIONS: Array<AutomationRuleDraft["toolPalette"][number]> = ["repo", "git", "tests", "github", "linear", "browser", "memory", "mission"];
const CONTEXT_OPTIONS: Array<AutomationRuleDraft["contextSources"][number]["type"]> = [
  "project-memory",
  "automation-memory",
  "worker-memory",
  "procedures",
  "skills",
  "linked-doc",
  "linked-repo",
  "path-rules",
];
const THINKING_OPTIONS = ["none", "minimal", "low", "medium", "high", "max", "xhigh"] as const;
const PERMISSION_OPTIONS = ["default", "plan", "edit", "full-auto", "config-toml"] as const;
const SANDBOX_OPTIONS = ["read-only", "workspace-write", "danger-full-access"] as const;

function joinList(values: string[] | undefined | null): string {
  return Array.isArray(values) ? values.join(", ") : "";
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function IssueList({ issues }: { issues: AutomationDraftIssue[] }) {
  if (!issues.length) return null;
  return (
    <div className="space-y-2">
      {issues.map((issue, index) => (
        <div
          key={`${issue.path}-${index}`}
          className={cn("p-2 text-xs", issue.level === "error" ? "text-red-200" : "text-amber-200")}
          style={{ background: issue.level === "error" ? "rgba(239,68,68,0.10)" : "rgba(245,158,11,0.10)" }}
        >
          <span className="font-mono">{issue.path}</span>: {issue.message}
        </div>
      ))}
    </div>
  );
}

function ConfirmationsChecklist({
  required,
  accepted,
  onToggle,
}: {
  required: AutomationDraftConfirmationRequirement[];
  accepted: Set<string>;
  onToggle: (key: string, checked: boolean) => void;
}) {
  if (!required.length) return null;
  return (
    <div className="p-3 shadow-card" style={{ background: "#181423", border: "1px solid #2D2840" }}>
      <div className="text-xs font-semibold text-[#FAFAFA]">Confirmations</div>
      <div className="mt-2 space-y-2">
        {required.map((requirement) => (
          <label key={requirement.key} className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={accepted.has(requirement.key)}
              onChange={(event) => onToggle(requirement.key, event.target.checked)}
              className="accent-[#A78BFA] mt-0.5"
            />
            <div className="min-w-0">
              <div className={cn("font-semibold", requirement.severity === "danger" ? "text-red-200" : "text-amber-200")}>
                {requirement.title}
              </div>
              <div className="text-[#8B8B9A]">{requirement.message}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

function section(title: string, children: import("react").ReactNode) {
  return (
    <div className="p-3 space-y-2" style={{ background: "#181423", border: "1px solid #2D2840" }}>
      <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">{title}</div>
      {children}
    </div>
  );
}

export function RuleEditorPanel({
  draft,
  setDraft,
  suites,
  issues,
  requiredConfirmations,
  acceptedConfirmations,
  setAcceptedConfirmations,
  saving,
  onSave,
  onSimulate,
  onClose,
}: {
  draft: AutomationRuleDraft;
  setDraft: (next: AutomationRuleDraft) => void;
  suites: TestSuiteDefinition[];
  issues: AutomationDraftIssue[];
  requiredConfirmations: AutomationDraftConfirmationRequirement[];
  acceptedConfirmations: Set<string>;
  setAcceptedConfirmations: (next: Set<string>) => void;
  saving: boolean;
  onSave: () => void;
  onSimulate: () => void;
  onClose: () => void;
}) {
  const trigger = draft.triggers[0] ?? { type: "manual" as const };
  const legacyActions = draft.legacyActions ?? [];
  const [agents, setAgents] = useState<AgentIdentity[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [ingressStatus, setIngressStatus] = useState<AutomationIngressStatus | null>(null);
  const [ingressLoading, setIngressLoading] = useState(false);

  const automationsBridge = getAutomationsBridge();
  const providerPermissions = draft.permissionConfig?.providers ?? {};
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === draft.executor.targetId) ?? null,
    [agents, draft.executor.targetId],
  );

  const updateTrigger = (patch: Partial<typeof trigger>) => {
    const nextTrigger = { ...trigger, ...patch };
    setDraft({ ...draft, trigger: nextTrigger, triggers: [nextTrigger] });
  };

  const updateExecutor = (patch: Partial<AutomationRuleDraft["executor"]>) => {
    setDraft({ ...draft, executor: { ...draft.executor, ...patch } });
  };

  const updateModelConfig = (patch: Partial<NonNullable<AutomationRuleDraft["modelConfig"]>>) => {
    const current = draft.modelConfig ?? { orchestratorModel: { modelId: "" } };
    setDraft({
      ...draft,
      modelConfig: {
        ...current,
        ...patch,
        orchestratorModel: {
          ...current.orchestratorModel,
          ...(patch.orchestratorModel ?? {}),
        },
      },
    });
  };

  const updateProviderPermissions = (patch: Partial<NonNullable<NonNullable<AutomationRuleDraft["permissionConfig"]>["providers"]>>) => {
    setDraft({
      ...draft,
      permissionConfig: {
        ...(draft.permissionConfig ?? {}),
        providers: {
          ...providerPermissions,
          ...patch,
        },
      },
    });
  };

  const updateLegacyAction = (index: number, patch: Record<string, unknown>) => {
    const next = [...legacyActions];
    next[index] = { ...(next[index] as Record<string, unknown>), ...patch } as any;
    setDraft({ ...draft, actions: next, legacyActions: next });
  };

  const addLegacyAction = (type: string) => {
    const next = [...legacyActions];
    if (type === "run-tests") next.push({ type: "run-tests", suite: suites[0]?.id ?? "" } as any);
    else if (type === "run-command") next.push({ type: "run-command", command: "" } as any);
    else next.push({ type } as any);
    setDraft({ ...draft, actions: next, legacyActions: next });
  };

  const removeLegacyAction = (index: number) => {
    const next = legacyActions.filter((_action, currentIndex) => currentIndex !== index);
    setDraft({ ...draft, actions: next, legacyActions: next });
  };

  useEffect(() => {
    if (!(draft.executor.mode === "employee" || draft.executor.mode === "cto-route")) {
      return;
    }
    if (!window.ade?.cto?.listAgents) {
      setAgents([]);
      return;
    }
    let cancelled = false;
    setAgentsLoading(true);
    window.ade.cto
      .listAgents({})
      .then((next) => {
        if (!cancelled) setAgents(next);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      })
      .finally(() => {
        if (!cancelled) setAgentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.executor.mode]);

  useEffect(() => {
    if (!(trigger.type === "github-webhook" || trigger.type === "webhook") || !automationsBridge.getIngressStatus) {
      setIngressStatus(null);
      return;
    }
    let cancelled = false;
    setIngressLoading(true);
    automationsBridge
      .getIngressStatus()
      .then((next) => {
        if (!cancelled) setIngressStatus(next);
      })
      .catch(() => {
        if (!cancelled) setIngressStatus(null);
      })
      .finally(() => {
        if (!cancelled) setIngressLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [automationsBridge, trigger.type]);

  return (
    <div className="flex h-full flex-col" style={{ background: "#14111D" }}>
      <div className="shrink-0 flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid #2D2840" }}>
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-[#FAFAFA] tracking-[-0.3px]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            {draft.id ? "Edit Rule" : "Create Rule"}
          </div>
          {draft.id ? <div className="mt-0.5 font-mono text-[9px] text-[#71717A]">{draft.id}</div> : null}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onSimulate}>
            <FlaskConical size={12} weight="regular" />
            Simulate
          </Button>
          <Button size="sm" variant="primary" disabled={saving} onClick={onSave}>
            <Save size={12} weight="regular" />
            Save
          </Button>
          <button type="button" onClick={onClose} className="p-1 text-[#71717A] hover:text-[#FAFAFA] transition-colors">
            <X size={14} weight="regular" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        <IssueList issues={issues} />

        <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
          <label className="space-y-1">
            <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Name</div>
            <input className={INPUT_CLS} style={INPUT_STYLE} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-[1px] text-[#71717A] h-8">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} className="accent-[#A78BFA]" />
            enabled
          </label>
        </div>

        <label className="space-y-1 block">
          <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Description</div>
          <input
            className={INPUT_CLS}
            style={INPUT_STYLE}
            value={draft.description ?? ""}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="Optional summary for the rule card"
          />
        </label>

        {section("Execution", (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="space-y-1">
                <div className="font-mono text-[9px] text-[#71717A]">Mode</div>
                <select className={INPUT_CLS} style={INPUT_STYLE} value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as AutomationRuleDraft["mode"] })}>
                  <option value="review">review</option>
                  <option value="fix">fix</option>
                  <option value="monitor">monitor</option>
                </select>
              </label>
              <label className="space-y-1">
                <div className="font-mono text-[9px] text-[#71717A]">Review profile</div>
                <select className={INPUT_CLS} style={INPUT_STYLE} value={draft.reviewProfile} onChange={(e) => setDraft({ ...draft, reviewProfile: e.target.value as AutomationRuleDraft["reviewProfile"] })}>
                  <option value="quick">quick</option>
                  <option value="incremental">incremental</option>
                  <option value="full">full</option>
                  <option value="security">security</option>
                  <option value="release-risk">release-risk</option>
                  <option value="cross-repo-contract">cross-repo-contract</option>
                </select>
              </label>
              <label className="space-y-1">
                <div className="font-mono text-[9px] text-[#71717A]">Run as</div>
                <select
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={draft.executor.mode}
                  onChange={(e) => updateExecutor({ mode: e.target.value as AutomationRuleDraft["executor"]["mode"] })}
                >
                  <option value="automation-bot">automation-bot</option>
                  <option value="employee">employee</option>
                  <option value="cto-route">cto-route</option>
                  <option value="night-shift">night-shift</option>
                </select>
              </label>
            </div>

            {(draft.executor.mode === "employee" || draft.executor.mode === "cto-route") && (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="space-y-1">
                  <div className="font-mono text-[9px] text-[#71717A]">
                    {draft.executor.mode === "employee" ? "Target worker" : "Preferred worker"}
                  </div>
                  <select
                    className={INPUT_CLS}
                    style={INPUT_STYLE}
                    value={draft.executor.targetId ?? ""}
                    onChange={(e) => updateExecutor({ targetId: e.target.value || null })}
                  >
                    <option value="">{agentsLoading ? "Loading workers..." : draft.executor.mode === "employee" ? "Select worker" : "Auto-route"}</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} ({agent.role})
                      </option>
                    ))}
                  </select>
                </label>
                {draft.executor.mode === "cto-route" ? (
                  <label className="space-y-1">
                    <div className="font-mono text-[9px] text-[#71717A]">Required capabilities</div>
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={joinList(draft.executor.routingHints?.requiredCapabilities)}
                      onChange={(e) =>
                        updateExecutor({
                          routingHints: {
                            ...draft.executor.routingHints,
                            requiredCapabilities: parseList(e.target.value),
                          },
                        })
                      }
                      placeholder="frontend, review, release"
                    />
                  </label>
                ) : (
                  <div className="space-y-1">
                    <div className="font-mono text-[9px] text-[#71717A]">Worker continuity</div>
                    <div className="rounded px-3 py-2 text-[11px] text-[#A1A1AA]" style={{ background: "#0B0A0F", border: "1px solid #2D284080" }}>
                      Reuses the selected worker’s task session and memory for recurring follow-through.
                    </div>
                  </div>
                )}
              </div>
            )}

            {selectedAgent ? (
              <div className="rounded px-3 py-2 text-[10px] text-[#A1A1AA]" style={{ background: "#0B0A0F", border: "1px solid #2D284080" }}>
                {selectedAgent.title ?? selectedAgent.role} · {selectedAgent.status} · capabilities {selectedAgent.capabilities.join(", ") || "none listed"}
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="space-y-1">
                <div className="font-mono text-[9px] text-[#71717A]">Model</div>
                <input
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={draft.modelConfig?.orchestratorModel.modelId ?? ""}
                  onChange={(e) => updateModelConfig({ orchestratorModel: { modelId: e.target.value } })}
                  placeholder="anthropic/claude-sonnet-4-6"
                />
              </label>
              <label className="space-y-1">
                <div className="font-mono text-[9px] text-[#71717A]">Thinking</div>
                <select
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={draft.modelConfig?.orchestratorModel.thinkingLevel ?? ""}
                  onChange={(e) =>
                    updateModelConfig({
                      orchestratorModel: {
                        modelId: draft.modelConfig?.orchestratorModel.modelId ?? "",
                        thinkingLevel: (e.target.value || undefined) as (typeof THINKING_OPTIONS)[number] | undefined,
                      },
                    })
                  }
                >
                  <option value="">default</option>
                  {THINKING_OPTIONS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="space-y-1">
                <div className="font-mono text-[9px] text-[#71717A]">Unified permissions</div>
                <select
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={providerPermissions.unified ?? ""}
                  onChange={(e) => updateProviderPermissions({ unified: (e.target.value || undefined) as typeof providerPermissions.unified })}
                >
                  <option value="">default</option>
                  {PERMISSION_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <div className="font-mono text-[9px] text-[#71717A]">Claude permissions</div>
                <select
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={providerPermissions.claude ?? ""}
                  onChange={(e) => updateProviderPermissions({ claude: (e.target.value || undefined) as typeof providerPermissions.claude })}
                >
                  <option value="">default</option>
                  {PERMISSION_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <div className="font-mono text-[9px] text-[#71717A]">Codex sandbox</div>
                <select
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={providerPermissions.codexSandbox ?? ""}
                  onChange={(e) => updateProviderPermissions({ codexSandbox: (e.target.value || undefined) as typeof providerPermissions.codexSandbox })}
                >
                  <option value="">default</option>
                  {SANDBOX_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="space-y-1">
                <div className="font-mono text-[9px] text-[#71717A]">Allowed tools</div>
                <input
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={joinList(providerPermissions.allowedTools)}
                  onChange={(e) => updateProviderPermissions({ allowedTools: parseList(e.target.value) })}
                  placeholder="git, openai, linear"
                />
              </label>
              <label className="space-y-1">
                <div className="font-mono text-[9px] text-[#71717A]">Writable paths</div>
                <input
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={joinList(providerPermissions.writablePaths)}
                  onChange={(e) => updateProviderPermissions({ writablePaths: parseList(e.target.value) })}
                  placeholder="/repo/tmp, /repo/reports"
                />
              </label>
            </div>
          </div>
        ))}

        {section("Trigger", (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="space-y-1">
                <div className="font-mono text-[9px] text-[#71717A]">Type</div>
                <select className={INPUT_CLS} style={INPUT_STYLE} value={trigger.type} onChange={(e) => updateTrigger({ type: e.target.value as typeof trigger.type })}>
                  <option value="manual">manual</option>
                  <option value="session-end">session-end</option>
                  <option value="commit">commit</option>
                  <option value="schedule">schedule</option>
                  <option value="github-webhook">github-webhook</option>
                  <option value="webhook">webhook</option>
                </select>
              </label>
              {trigger.type === "schedule" ? (
                <label className="space-y-1 md:col-span-2">
                  <div className="font-mono text-[9px] text-[#71717A]">Cron</div>
                  <input
                    className={INPUT_CLS}
                    style={INPUT_STYLE}
                    value={trigger.cron ?? ""}
                    onChange={(e) => updateTrigger({ cron: e.target.value })}
                    placeholder="0 9 * * 1-5"
                  />
                </label>
              ) : (
                <>
                  <label className="space-y-1">
                    <div className="font-mono text-[9px] text-[#71717A]">Event</div>
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={trigger.event ?? ""}
                      onChange={(e) => updateTrigger({ event: e.target.value })}
                      placeholder={trigger.type === "github-webhook" ? "pull_request" : "push"}
                    />
                  </label>
                  <label className="space-y-1">
                    <div className="font-mono text-[9px] text-[#71717A]">Branch</div>
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={trigger.branch ?? ""}
                      onChange={(e) => updateTrigger({ branch: e.target.value })}
                      placeholder="main"
                    />
                  </label>
                </>
              )}
            </div>

            {(trigger.type === "commit" || trigger.type === "github-webhook" || trigger.type === "webhook") && (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="space-y-1">
                  <div className="font-mono text-[9px] text-[#71717A]">Author</div>
                  <input
                    className={INPUT_CLS}
                    style={INPUT_STYLE}
                    value={trigger.author ?? ""}
                    onChange={(e) => updateTrigger({ author: e.target.value })}
                    placeholder="octocat"
                  />
                </label>
                <label className="space-y-1">
                  <div className="font-mono text-[9px] text-[#71717A]">Draft state</div>
                  <select
                    className={INPUT_CLS}
                    style={INPUT_STYLE}
                    value={trigger.draftState ?? "any"}
                    onChange={(e) => updateTrigger({ draftState: e.target.value as typeof trigger.draftState })}
                  >
                    <option value="any">any</option>
                    <option value="draft">draft</option>
                    <option value="ready">ready</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <div className="font-mono text-[9px] text-[#71717A]">Labels</div>
                  <input
                    className={INPUT_CLS}
                    style={INPUT_STYLE}
                    value={joinList(trigger.labels)}
                    onChange={(e) => updateTrigger({ labels: parseList(e.target.value) })}
                    placeholder="backend, urgent"
                  />
                </label>
                <label className="space-y-1">
                  <div className="font-mono text-[9px] text-[#71717A]">Changed paths</div>
                  <input
                    className={INPUT_CLS}
                    style={INPUT_STYLE}
                    value={joinList(trigger.paths)}
                    onChange={(e) => updateTrigger({ paths: parseList(e.target.value) })}
                    placeholder="apps/desktop/**, docs/**"
                  />
                </label>
                <label className="space-y-1 md:col-span-2">
                  <div className="font-mono text-[9px] text-[#71717A]">Keywords</div>
                  <input
                    className={INPUT_CLS}
                    style={INPUT_STYLE}
                    value={joinList(trigger.keywords)}
                    onChange={(e) => updateTrigger({ keywords: parseList(e.target.value) })}
                    placeholder="release note, regression, urgent"
                  />
                </label>
                {trigger.type === "webhook" ? (
                  <label className="space-y-1 md:col-span-2">
                    <div className="font-mono text-[9px] text-[#71717A]">Secret ref</div>
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={trigger.secretRef ?? ""}
                      onChange={(e) => updateTrigger({ secretRef: e.target.value })}
                      placeholder="automations.webhooks.github"
                    />
                  </label>
                ) : null}
              </div>
            )}

            {(trigger.type === "github-webhook" || trigger.type === "webhook") && (
              <div className="space-y-2 rounded p-3" style={{ background: "#0B0A0F", border: "1px solid #2D284080" }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">Ingress status</div>
                  <div className="text-[10px] text-[#71717A]">{ingressLoading ? "Refreshing..." : "Runtime status"}</div>
                </div>
                {ingressStatus ? (
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    <div className="rounded px-3 py-2" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                      <div className="font-mono text-[9px] text-[#71717A]">GitHub relay</div>
                      <div className="mt-1 text-xs text-[#FAFAFA]">{ingressStatus.githubRelay.status}</div>
                      <div className="mt-1 text-[10px] text-[#8B8B9A]">
                        {ingressStatus.githubRelay.remoteProjectId ?? "No remote project"} · cursor {ingressStatus.githubRelay.lastCursor ?? "none"}
                      </div>
                    </div>
                    <div className="rounded px-3 py-2" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                      <div className="font-mono text-[9px] text-[#71717A]">Local webhook</div>
                      <div className="mt-1 text-xs text-[#FAFAFA]">{ingressStatus.localWebhook.status}</div>
                      <div className="mt-1 text-[10px] text-[#8B8B9A]">{ingressStatus.localWebhook.url ?? "Listener unavailable"}</div>
                    </div>
                  </div>
                ) : (
                  <div className="text-[11px] text-[#8B8B9A]">
                    {automationsBridge.getIngressStatus ? "Waiting for ingress runtime to report status." : "Ingress status will appear once the W5b runtime bridge is available."}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {section("Prompt", (
          <textarea
            className="min-h-[120px] w-full p-3 text-xs text-[#FAFAFA] placeholder:text-[#71717A50]"
            style={INPUT_STYLE}
            value={draft.prompt ?? ""}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            placeholder="Describe how this automation should review, fix, or monitor work."
          />
        ))}

        {section("Outputs", (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <div className="font-mono text-[9px] text-[#71717A]">Disposition</div>
              <select
                className={INPUT_CLS}
                style={INPUT_STYLE}
                value={draft.outputs.disposition}
                onChange={(e) => setDraft({ ...draft, outputs: { ...draft.outputs, disposition: e.target.value as AutomationRuleDraft["outputs"]["disposition"] } })}
              >
                <option value="comment-only">comment-only</option>
                <option value="open-task">open-task</option>
                <option value="open-lane">open-lane</option>
                <option value="prepare-patch">prepare-patch</option>
                <option value="open-pr-draft">open-pr-draft</option>
                <option value="queue-overnight">queue-overnight</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-[10px] font-mono text-[#C4B5FD]">
              <input
                type="checkbox"
                checked={Boolean(draft.verification.verifyBeforePublish)}
                onChange={(e) => setDraft({ ...draft, verification: { ...draft.verification, verifyBeforePublish: e.target.checked } })}
                className="accent-[#A78BFA]"
              />
              verify before publish
            </label>
            <label className="space-y-1">
              <div className="font-mono text-[9px] text-[#71717A]">Verification mode</div>
              <select
                className={INPUT_CLS}
                style={INPUT_STYLE}
                value={draft.verification.mode ?? "intervention"}
                onChange={(e) => setDraft({ ...draft, verification: { ...draft.verification, mode: e.target.value as AutomationRuleDraft["verification"]["mode"] } })}
              >
                <option value="intervention">intervention</option>
                <option value="dry-run">dry-run</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-[10px] font-mono text-[#C4B5FD]">
              <input
                type="checkbox"
                checked={Boolean(draft.outputs.createArtifact)}
                onChange={(e) => setDraft({ ...draft, outputs: { ...draft.outputs, createArtifact: e.target.checked } })}
                className="accent-[#A78BFA]"
              />
              create artifact
            </label>
          </div>
        ))}

        {section("Tools", (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {TOOL_OPTIONS.map((tool) => {
              const active = draft.toolPalette.includes(tool);
              return (
                <label key={tool} className="flex items-center gap-2 text-[10px] font-mono text-[#D4D4D8]">
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...draft.toolPalette, tool]
                        : draft.toolPalette.filter((value) => value !== tool);
                      setDraft({ ...draft, toolPalette: [...new Set(next)] });
                    }}
                    className="accent-[#A78BFA]"
                  />
                  {tool}
                </label>
              );
            })}
          </div>
        ))}

        {section("Context", (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {CONTEXT_OPTIONS.map((type) => {
              const active = draft.contextSources.some((source) => source.type === type);
              return (
                <label key={type} className="flex items-center gap-2 text-[10px] font-mono text-[#D4D4D8]">
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...draft.contextSources, { type }]
                        : draft.contextSources.filter((source) => source.type !== type);
                      setDraft({ ...draft, contextSources: next });
                    }}
                    className="accent-[#A78BFA]"
                  />
                  {type}
                </label>
              );
            })}
          </div>
        ))}

        {section("Compatibility Actions", (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] text-[#8B8B9A]">Optional legacy actions for older rules. Leave empty for mission-powered execution.</div>
              <select className="h-7 px-2 font-mono text-[9px] text-[#FAFAFA]" style={INPUT_STYLE} value="" onChange={(e) => { if (e.target.value) addLegacyAction(e.target.value); e.target.value = ""; }}>
                <option value="">Add legacy action...</option>
                <option value="predict-conflicts">predict-conflicts</option>
                <option value="run-tests">run-tests</option>
                <option value="run-command">run-command</option>
              </select>
            </div>
            {legacyActions.map((action: any, index) => (
              <div key={`${action.type}-${index}`} className="p-3" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 space-y-2">
                    <div className="text-xs font-semibold text-[#FAFAFA]">{action.type}</div>
                    {action.type === "run-command" ? (
                      <textarea
                        className="min-h-[72px] w-full p-2 text-xs font-mono text-[#FAFAFA]"
                        style={INPUT_STYLE}
                        value={action.command ?? ""}
                        onChange={(e) => updateLegacyAction(index, { command: e.target.value })}
                        placeholder="npm test"
                      />
                    ) : null}
                    {action.type === "run-tests" ? (
                      <select className={INPUT_CLS} style={INPUT_STYLE} value={action.suite ?? ""} onChange={(e) => updateLegacyAction(index, { suite: e.target.value })}>
                        <option value="">Select suite</option>
                        {suites.map((suite) => (
                          <option key={suite.id} value={suite.id}>{suite.name || suite.id}</option>
                        ))}
                      </select>
                    ) : null}
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => removeLegacyAction(index)}>Remove</Button>
                </div>
              </div>
            ))}
          </div>
        ))}

        <ConfirmationsChecklist
          required={requiredConfirmations}
          accepted={acceptedConfirmations}
          onToggle={(key, checked) => {
            const next = new Set(acceptedConfirmations);
            if (checked) next.add(key);
            else next.delete(key);
            setAcceptedConfirmations(next);
          }}
        />
      </div>
    </div>
  );
}
