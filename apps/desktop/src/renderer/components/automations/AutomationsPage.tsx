import React, { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowClockwise as RefreshCw,
  Plus,
  Play,
  ClockCounterClockwise as HistoryIcon,
  ShieldCheck,
  Sparkle as Sparkles,
  Flask as FlaskConical,
  FloppyDisk as Save,
} from "@phosphor-icons/react";
import type {
  AgentTool,
  AutomationDraftConfirmationRequirement,
  AutomationDraftIssue,
  AutomationParseNaturalLanguageResult,
  AutomationPlannerConfig,
  AutomationRuleDraft,
  AutomationRuleSummary,
  AutomationRun,
  AutomationRunDetail,
  TestSuiteDefinition
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
function statusTone(status: string | null): string {
  if (status === "succeeded") return "border-emerald-500/40 text-emerald-300";
  if (status === "failed") return "border-red-500/40 text-red-300";
  if (status === "running") return "border-amber-500/40 text-amber-300";
  if (status === "skipped") return "border-border text-muted-fg";
  if (status === "cancelled") return "border-border text-muted-fg";
  return "border-border text-muted-fg";
}

function formatWhen(ts: string | null): string {
  if (!ts) return "Never";
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return ts;
  return new Date(parsed).toLocaleString();
}

function summarizeActions(rule: { actions: Array<{ type: string }> }): string {
  if (!rule.actions.length) return "(no actions)";
  return rule.actions.map((a) => a.type).join(", ");
}

function toDraftFromRule(rule: AutomationRuleSummary): AutomationRuleDraft {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    trigger: rule.trigger,
    actions: rule.actions.map((a) => {
      if (a.type === "run-tests") {
        return {
          type: a.type,
          suite: a.suiteId ?? "",
          ...(a.condition ? { condition: a.condition } : {}),
          ...(a.continueOnFailure != null ? { continueOnFailure: a.continueOnFailure } : {}),
          ...(a.timeoutMs != null ? { timeoutMs: a.timeoutMs } : {}),
          ...(a.retry != null ? { retry: a.retry } : {})
        };
      }
      if (a.type === "run-command") {
        return {
          type: a.type,
          command: a.command ?? "",
          ...(a.cwd ? { cwd: a.cwd } : {}),
          ...(a.condition ? { condition: a.condition } : {}),
          ...(a.continueOnFailure != null ? { continueOnFailure: a.continueOnFailure } : {}),
          ...(a.timeoutMs != null ? { timeoutMs: a.timeoutMs } : {}),
          ...(a.retry != null ? { retry: a.retry } : {})
        };
      }
      return {
        type: a.type,
        ...(a.condition ? { condition: a.condition } : {}),
        ...(a.continueOnFailure != null ? { continueOnFailure: a.continueOnFailure } : {}),
        ...(a.timeoutMs != null ? { timeoutMs: a.timeoutMs } : {}),
        ...(a.retry != null ? { retry: a.retry } : {})
      };
    }) as any
  };
}

function IssueList({ issues }: { issues: AutomationDraftIssue[] }) {
  if (!issues.length) return null;
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  return (
    <div className="space-y-2">
      {errors.length ? (
        <div className="rounded-lg bg-red-500/10 p-2 text-xs text-red-200">
          <div className="font-semibold">Errors</div>
          <ul className="mt-1 list-disc pl-4">
            {errors.slice(0, 8).map((e, idx) => (
              <li key={`${e.path}-${idx}`}>
                <span className="font-mono">{e.path}</span>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {warnings.length ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
          <div className="font-semibold">Warnings</div>
          <ul className="mt-1 list-disc pl-4">
            {warnings.slice(0, 8).map((w, idx) => (
              <li key={`${w.path}-${idx}`}>
                <span className="font-mono">{w.path}</span>: {w.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function HistoryDialog({
  open,
  onOpenChange,
  rule,
  onError
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule: AutomationRuleSummary | null;
  onError: (err: string) => void;
}) {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AutomationRunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);

  useEffect(() => {
    if (!open || !rule) return;
    setBusy(true);
    setRuns([]);
    setSelectedRunId(null);
    setDetail(null);
    window.ade.automations
      .getHistory({ id: rule.id, limit: 160 })
      .then((next) => setRuns(next))
      .catch((err) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }, [open, rule]);

  const loadDetail = (runId: string) => {
    setSelectedRunId(runId);
    setDetailBusy(true);
    setDetail(null);
    window.ade.automations
      .getRunDetail(runId)
      .then((next) => setDetail(next))
      .catch((err) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setDetailBusy(false));
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-[8%] z-50 w-[min(980px,calc(100vw-24px))] -translate-x-1/2 rounded bg-card border border-border/40 p-3 shadow-float focus:outline-none">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold truncate">Automation History</Dialog.Title>
              {rule ? (
                <div className="mt-0.5 text-xs text-muted-fg truncate">
                  {rule.name} · <span className="font-mono">{rule.id}</span>
                </div>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm">
                Close
              </Button>
            </Dialog.Close>
          </div>

          {busy ? (
            <div className="rounded shadow-card bg-card/40 p-3 text-xs text-muted-fg">Loading runs…</div>
          ) : null}

          <div className="grid min-h-0 grid-cols-[360px_1fr] gap-3">
            <div className="max-h-[65vh] overflow-auto rounded bg-card/30 p-2">
              {runs.length === 0 ? (
                <div className="p-2 text-xs text-muted-fg">No runs yet.</div>
              ) : (
                <div className="space-y-2">
                  {runs.map((run) => {
                    const selected = selectedRunId === run.id;
                    return (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => loadDetail(run.id)}
                        className={cn(
                          "w-full rounded border px-2 py-2 text-left",
                          selected ? "border-accent bg-accent/10" : "border-border bg-bg/40 hover:bg-muted/40"
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="truncate text-xs font-semibold">{run.triggerType}</div>
                          <Chip className={cn("text-[11px]", statusTone(run.status))}>{run.status}</Chip>
                        </div>
                        <div className="mt-1 text-xs text-muted-fg">{formatWhen(run.startedAt)}</div>
                        <div className="mt-1 text-xs text-muted-fg">
                          {run.actionsCompleted}/{run.actionsTotal} actions
                          {run.errorMessage ? ` · ${run.errorMessage}` : ""}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="max-h-[65vh] overflow-auto rounded bg-card/30 p-3">
              {detailBusy ? (
                <div className="text-xs text-muted-fg">Loading run detail…</div>
              ) : !detail ? (
                <div className="text-xs text-muted-fg">Select a run to view action results.</div>
              ) : (
                <div className="space-y-2">
                  <div className="text-xs text-muted-fg">
                    run: <span className="font-mono">{detail.run.id}</span>
                  </div>
                  {detail.actions.map((action) => (
                    <div key={action.id} className="rounded bg-muted/20 p-2">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <div className="font-semibold text-fg">
                          #{action.actionIndex + 1} {action.actionType}
                        </div>
                        <Chip className={cn("text-[11px]", statusTone(action.status))}>{action.status}</Chip>
                      </div>
                      {action.errorMessage ? <div className="mt-1 text-xs text-red-300">{action.errorMessage}</div> : null}
                      {action.output ? (
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/20 p-2 text-xs leading-relaxed text-fg">
                          {action.output}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ConfirmationsChecklist({
  required,
  accepted,
  onToggle
}: {
  required: AutomationDraftConfirmationRequirement[];
  accepted: Set<string>;
  onToggle: (key: string, checked: boolean) => void;
}) {
  if (!required.length) return null;
  return (
    <div className="rounded shadow-card bg-card/40 p-2">
      <div className="text-xs font-semibold">Confirmations</div>
      <div className="mt-2 space-y-2">
        {required.map((r) => (
          <label key={r.key} className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={accepted.has(r.key)}
              onChange={(e) => onToggle(r.key, e.target.checked)}
            />
            <div className="min-w-0">
              <div className={cn("font-semibold", r.severity === "danger" ? "text-red-200" : "text-amber-200")}>{r.title}</div>
              <div className="text-muted-fg">{r.message}</div>
              <div className="mt-0.5 text-xs text-muted-fg">
                key: <span className="font-mono">{r.key}</span>
              </div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

function RuleEditor({
  draft,
  setDraft,
  suites,
  onSave,
  saving,
  requiredConfirmations,
  acceptedConfirmations,
  setAcceptedConfirmations
}: {
  draft: AutomationRuleDraft;
  setDraft: (next: AutomationRuleDraft) => void;
  suites: TestSuiteDefinition[];
  onSave: () => void;
  saving: boolean;
  requiredConfirmations: AutomationDraftConfirmationRequirement[];
  acceptedConfirmations: Set<string>;
  setAcceptedConfirmations: (next: Set<string>) => void;
}) {
  const updateAction = (idx: number, patch: Record<string, unknown>) => {
    const nextActions = [...draft.actions];
    nextActions[idx] = { ...(nextActions[idx] as any), ...patch } as any;
    setDraft({ ...draft, actions: nextActions });
  };

  const removeAction = (idx: number) => {
    const nextActions = draft.actions.filter((_a, i) => i !== idx);
    setDraft({ ...draft, actions: nextActions });
  };

  const addAction = (type: string) => {
    const nextActions = [...draft.actions];
    if (type === "run-tests") {
      nextActions.push({ type: "run-tests", suite: suites[0]?.id ?? "" } as any);
    } else if (type === "run-command") {
      nextActions.push({ type: "run-command", command: "" } as any);
    } else if (type === "update-packs" || type === "predict-conflicts") {
      nextActions.push({ type } as any);
    }
    setDraft({ ...draft, actions: nextActions });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1">
          <div className="text-xs text-muted-fg">Name</div>
          <input
            className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="My automation"
          />
        </label>

        <label className="flex items-end gap-2 text-xs text-muted-fg">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          enabled
        </label>
      </div>

      <div className="rounded shadow-card bg-card/40 p-2">
        <div className="text-xs font-semibold">Trigger</div>
        <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="space-y-1">
            <div className="text-xs text-muted-fg">Type</div>
            <select
              className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs"
              value={draft.trigger.type}
              onChange={(e) => setDraft({ ...draft, trigger: { ...draft.trigger, type: e.target.value as any } })}
            >
              <option value="manual">manual</option>
              <option value="session-end">session-end</option>
              <option value="commit">commit</option>
              <option value="schedule">schedule</option>
            </select>
          </label>

          {draft.trigger.type === "schedule" ? (
            <label className="space-y-1 md:col-span-2">
              <div className="text-xs text-muted-fg">Cron</div>
              <input
                className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs font-mono"
                value={draft.trigger.cron ?? ""}
                onChange={(e) => setDraft({ ...draft, trigger: { ...draft.trigger, cron: e.target.value } })}
                placeholder="0 9 * * 1-5"
              />
            </label>
          ) : (
            <label className="space-y-1 md:col-span-2">
              <div className="text-xs text-muted-fg">Branch (optional)</div>
              <input
                className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs font-mono"
                value={draft.trigger.branch ?? ""}
                onChange={(e) => setDraft({ ...draft, trigger: { ...draft.trigger, branch: e.target.value } })}
                placeholder="main"
              />
            </label>
          )}
        </div>
      </div>

      <div className="rounded shadow-card bg-card/40 p-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold">Actions</div>
          <select
            className="h-8 rounded-lg bg-muted/30 px-2 text-xs"
            value=""
            onChange={(e) => {
              const t = e.target.value;
              if (t) addAction(t);
              e.target.value = "";
            }}
          >
            <option value="">Add action…</option>
            <option value="update-packs">update-packs</option>
            <option value="predict-conflicts">predict-conflicts</option>
            <option value="run-tests">run-tests</option>
            <option value="run-command">run-command</option>
          </select>
        </div>

        {draft.actions.length === 0 ? (
          <div className="mt-2 text-xs text-muted-fg">No actions yet.</div>
        ) : (
          <div className="mt-2 space-y-2">
            {draft.actions.map((action: any, idx: number) => (
              <div key={idx} className="rounded bg-muted/20 p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="text-xs font-semibold">{action.type}</div>
                    </div>
                    {action.type === "run-tests" ? (
                      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                        <label className="space-y-1">
                          <div className="text-xs text-muted-fg">Suite</div>
                          <select
                            className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs"
                            value={action.suite ?? ""}
                            onChange={(e) => updateAction(idx, { suite: e.target.value })}
                          >
                            <option value="">Select suite</option>
                            {suites.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name || s.id} ({s.id})
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    ) : null}
                    {action.type === "run-command" ? (
                      <div className="mt-2 space-y-2">
                        <label className="space-y-1 block">
                          <div className="text-xs text-muted-fg">Command</div>
                          <textarea
                            className="min-h-[84px] w-full rounded-lg bg-muted/30 p-2 text-xs font-mono"
                            value={action.command ?? ""}
                            onChange={(e) => updateAction(idx, { command: e.target.value })}
                            placeholder='codex exec "..."'
                          />
                        </label>
                        <label className="space-y-1 block">
                          <div className="text-xs text-muted-fg">cwd (optional)</div>
                          <input
                            className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs font-mono"
                            value={action.cwd ?? ""}
                            onChange={(e) => updateAction(idx, { cwd: e.target.value })}
                            placeholder="apps/desktop"
                          />
                        </label>
                      </div>
                    ) : null}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-muted-fg">Advanced</summary>
                      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                        <label className="space-y-1">
                          <div className="text-xs text-muted-fg">Condition</div>
                          <input
                            className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs font-mono"
                            value={action.condition ?? ""}
                            onChange={(e) => updateAction(idx, { condition: e.target.value })}
                            placeholder="provider-enabled"
                          />
                        </label>
                        <label className="space-y-1">
                          <div className="text-xs text-muted-fg">Timeout (ms)</div>
                          <input
                            className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs font-mono"
                            value={action.timeoutMs ?? ""}
                            onChange={(e) => updateAction(idx, { timeoutMs: e.target.value ? Number(e.target.value) : undefined })}
                            placeholder="300000"
                          />
                        </label>
                        <label className="space-y-1">
                          <div className="text-xs text-muted-fg">Retry</div>
                          <input
                            className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs font-mono"
                            value={action.retry ?? ""}
                            onChange={(e) => updateAction(idx, { retry: e.target.value ? Number(e.target.value) : undefined })}
                            placeholder="0"
                          />
                        </label>
                        <label className="flex items-end gap-2 text-xs text-muted-fg">
                          <input
                            type="checkbox"
                            checked={Boolean(action.continueOnFailure)}
                            onChange={(e) => updateAction(idx, { continueOnFailure: e.target.checked })}
                          />
                          continue on failure
                        </label>
                      </div>
                    </details>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => removeAction(idx)}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmationsChecklist
        required={requiredConfirmations}
        accepted={acceptedConfirmations}
        onToggle={(key, checked) => {
          const next = new Set([...acceptedConfirmations]);
          if (checked) next.add(key);
          else next.delete(key);
          setAcceptedConfirmations(next);
        }}
      />

      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="primary" disabled={saving} onClick={onSave}>
          <Save size={16} weight="regular" />
          Save
        </Button>
      </div>
    </div>
  );
}

function CreateWithNaturalLanguageDialog({
  open,
  onOpenChange,
  onCreated,
  suites
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (ruleId: string) => void;
  suites: TestSuiteDefinition[];
}) {
  const [intent, setIntent] = useState("");
  const [provider, setProvider] = useState<AutomationPlannerConfig["provider"]>("codex");
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [dangerAck, setDangerAck] = useState(false);
  const [plannerCodex, setPlannerCodex] = useState<AutomationPlannerConfig & { provider: "codex" }>({
    provider: "codex",
    codex: {
      sandbox: "read-only",
      askForApproval: "never",
      webSearch: false,
      additionalWritableDirs: []
    }
  });
  const [plannerClaude, setPlannerClaude] = useState<AutomationPlannerConfig & { provider: "claude" }>({
    provider: "claude",
    claude: {
      permissionMode: "dontAsk",
      dangerouslySkipPermissions: false,
      allowedTools: [],
      additionalAllowedDirs: []
    }
  });

  const planner = provider === "codex" ? (plannerCodex as AutomationPlannerConfig) : (plannerClaude as AutomationPlannerConfig);

  const [busy, setBusy] = useState(false);
  const [parseResult, setParseResult] = useState<AutomationParseNaturalLanguageResult | null>(null);
  const [draft, setDraft] = useState<AutomationRuleDraft | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [requiredConfirmations, setRequiredConfirmations] = useState<AutomationDraftConfirmationRequirement[]>([]);
  const [acceptedConfirmations, setAcceptedConfirmations] = useState<Set<string>>(new Set());
  const [issues, setIssues] = useState<AutomationDraftIssue[]>([]);

  useEffect(() => {
    if (!open) {
      setIntent("");
      setParseResult(null);
      setDraft(null);
      setIssues([]);
      setRequiredConfirmations([]);
      setAcceptedConfirmations(new Set());
      setDangerAck(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.ade.agentTools.detect().then(setTools).catch(() => {});
  }, [open]);

  useEffect(() => {
    // Reset required acknowledgment when switching providers or dangerous options.
    setDangerAck(false);
  }, [provider, plannerClaude.claude.dangerouslySkipPermissions, plannerClaude.claude.permissionMode, plannerCodex.codex.sandbox]);

  const codexTool = tools.find((t) => t.id === "codex") ?? null;
  const claudeTool = tools.find((t) => t.id === "claude") ?? null;
  const providerInstalled = provider === "codex" ? Boolean(codexTool?.installed) : Boolean(claudeTool?.installed);
  const providerDangerous =
    provider === "claude"
      ? plannerClaude.claude.dangerouslySkipPermissions || plannerClaude.claude.permissionMode === "bypassPermissions"
      : plannerCodex.codex.sandbox === "danger-full-access";

  const canGenerate = !busy && Boolean(intent.trim()) && providerInstalled && (!providerDangerous || dangerAck);

  const generate = async () => {
    const trimmed = intent.trim();
    if (!trimmed) return;
    setBusy(true);
    setIssues([]);
    setParseResult(null);
    setDraft(null);
    try {
      const res = await window.ade.automations.parseNaturalLanguage({ intent: trimmed, planner });
      setParseResult(res);
      setIssues(res.issues);
      setDraft(res.draft);
    } catch (err) {
      setIssues([{ level: "error", path: "planner", message: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setBusy(false);
    }
  };

  const validateAndSave = async () => {
    if (!draft) return;
    setSaveBusy(true);
    try {
      const v = await window.ade.automations.validateDraft({ draft, confirmations: [...acceptedConfirmations] });
      setRequiredConfirmations(v.requiredConfirmations);
      setIssues(v.issues);
      if (!v.ok) return;
      const saved = await window.ade.automations.saveDraft({ draft, confirmations: [...acceptedConfirmations] });
      onOpenChange(false);
      onCreated(saved.rule.id);
    } catch (err) {
      setIssues([{ level: "error", path: "save", message: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setSaveBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-[6%] z-50 w-[min(1040px,calc(100vw-24px))] -translate-x-1/2 rounded bg-card border border-border/40 p-3 shadow-float focus:outline-none">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold truncate">Create Automation (Natural Language)</Dialog.Title>
              <div className="mt-0.5 text-xs text-muted-fg">
                Draft is generated locally by calling the selected CLI in headless mode. You will review and confirm before saving.
              </div>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm">
                Close
              </Button>
            </Dialog.Close>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[420px_1fr]">
            <div className="space-y-3">
              <div className="rounded shadow-card bg-card/40 p-2">
                <div className="text-xs font-semibold">Intent</div>
                <textarea
                  className="mt-2 min-h-[120px] w-full rounded-lg bg-muted/30 p-2 text-xs"
                  value={intent}
                  onChange={(e) => setIntent(e.target.value)}
                  placeholder="e.g. When I end a session, refresh packs and run unit tests on main."
                />
                <div className="mt-2 flex items-center justify-end">
                  <Button size="sm" variant="primary" disabled={!canGenerate} onClick={() => void generate()}>
                    <Sparkles size={16} weight="regular" className={cn(busy && "animate-spin")} />
                    Generate draft
                  </Button>
                </div>
              </div>

              <div className="rounded shadow-card bg-card/40 p-2">
                <div className="text-xs font-semibold">Planner Provider</div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={provider === "codex"}
                      disabled={!codexTool?.installed}
                      onChange={() => setProvider("codex")}
                    />
                    Codex CLI
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={provider === "claude"}
                      disabled={!claudeTool?.installed}
                      onChange={() => setProvider("claude")}
                    />
                    Claude Code CLI
                  </label>
                </div>

                <div className="mt-2 rounded bg-muted/20 p-2 text-xs text-muted-fg">
                  {provider === "codex" ? (
                    <>
                      <div>
                        Codex:{" "}
                        {codexTool?.installed
                          ? `${codexTool.detectedVersion ?? "installed"} (${codexTool.detectedPath ?? "in PATH"})`
                          : "not installed"}
                      </div>
                      <div className="mt-1">
                        This uses <span className="font-mono">codex exec</span> and passes sandbox/approval flags shown below.
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        Claude:{" "}
                        {claudeTool?.installed
                          ? `${claudeTool.detectedVersion ?? "installed"} (${claudeTool.detectedPath ?? "in PATH"})`
                          : "not installed"}
                      </div>
                      <div className="mt-1">
                        This uses <span className="font-mono">claude -p</span> headless mode. Note: <span className="font-mono">-p</span>{" "}
                        skips Claude's workspace trust dialog; only use it in directories you trust.
                      </div>
                    </>
                  )}
                </div>

                {provider === "codex" ? (
                  <div className="mt-3 grid grid-cols-1 gap-2">
                    <label className="space-y-1">
                      <div className="text-xs text-muted-fg">Sandbox</div>
                      <select
                        className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs"
                        value={plannerCodex.codex.sandbox}
                        onChange={(e) => setPlannerCodex({ ...plannerCodex, codex: { ...plannerCodex.codex, sandbox: e.target.value as any } })}
                      >
                        <option value="read-only">read-only</option>
                        <option value="workspace-write">workspace-write</option>
                        <option value="danger-full-access">danger-full-access</option>
                      </select>
                    </label>
                    <label className="space-y-1">
                      <div className="text-xs text-muted-fg">Ask for approval</div>
                      <select
                        className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs"
                        value={plannerCodex.codex.askForApproval}
                        onChange={(e) =>
                          setPlannerCodex({ ...plannerCodex, codex: { ...plannerCodex.codex, askForApproval: e.target.value as any } })
                        }
                      >
                        <option value="untrusted">untrusted</option>
                        <option value="on-failure">on-failure</option>
                        <option value="on-request">on-request</option>
                        <option value="never">never</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted-fg">
                      <input
                        type="checkbox"
                        checked={plannerCodex.codex.webSearch}
                        onChange={(e) => setPlannerCodex({ ...plannerCodex, codex: { ...plannerCodex.codex, webSearch: e.target.checked } })}
                      />
                      enable web search
                    </label>
                    <details className="rounded bg-muted/20 p-2">
                      <summary className="cursor-pointer text-xs text-muted-fg">Advanced</summary>
                      <label className="mt-2 block space-y-1">
                        <div className="text-xs text-muted-fg">Additional writable dirs (--add-dir)</div>
                        <textarea
                          className="min-h-[72px] w-full rounded-lg bg-muted/30 p-2 text-xs font-mono"
                          value={plannerCodex.codex.additionalWritableDirs.join("\n")}
                          onChange={(e) =>
                            setPlannerCodex({
                              ...plannerCodex,
                              codex: {
                                ...plannerCodex.codex,
                                additionalWritableDirs: e.target.value
                                  .split(/\r?\n/)
                                  .map((l) => l.trim())
                                  .filter(Boolean)
                              }
                            })
                          }
                          placeholder="/path/one\n/path/two"
                        />
                      </label>
                    </details>
                    {plannerCodex.codex.sandbox === "danger-full-access" ? (
                      <div className="rounded-lg bg-red-500/10 p-2 text-xs text-red-200">
                        <div className="font-semibold">Dangerous sandbox</div>
                        <div className="mt-1">
                          <span className="font-mono">danger-full-access</span> allows the planner to execute commands with full disk access if it chooses to.
                        </div>
                        <label className="mt-2 flex items-start gap-2">
                          <input type="checkbox" checked={dangerAck} onChange={(e) => setDangerAck(e.target.checked)} />
                          <span>I understand and want to proceed.</span>
                        </label>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-3 grid grid-cols-1 gap-2">
                    <label className="space-y-1">
                      <div className="text-xs text-muted-fg">Permission mode</div>
                      <select
                        className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs"
                        value={plannerClaude.claude.permissionMode}
                        onChange={(e) =>
                          setPlannerClaude({ ...plannerClaude, claude: { ...plannerClaude.claude, permissionMode: e.target.value as any } })
                        }
                      >
                        <option value="dontAsk">dontAsk</option>
                        <option value="default">default</option>
                        <option value="plan">plan</option>
                        <option value="acceptEdits">acceptEdits</option>
                        <option value="delegate">delegate</option>
                        <option value="bypassPermissions">bypassPermissions</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted-fg">
                      <input
                        type="checkbox"
                        checked={plannerClaude.claude.dangerouslySkipPermissions}
                        onChange={(e) =>
                          setPlannerClaude({
                            ...plannerClaude,
                            claude: { ...plannerClaude.claude, dangerouslySkipPermissions: e.target.checked }
                          })
                        }
                      />
                      <span className={plannerClaude.claude.dangerouslySkipPermissions ? "text-red-200" : undefined}>
                        use <span className="font-mono">--dangerously-skip-permissions</span>
                      </span>
                    </label>
                    <details className="rounded bg-muted/20 p-2">
                      <summary className="cursor-pointer text-xs text-muted-fg">Advanced</summary>
                      <label className="mt-2 block space-y-1">
                        <div className="text-xs text-muted-fg">Allowed tools (--allowedTools)</div>
                        <input
                          className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs font-mono"
                          value={plannerClaude.claude.allowedTools.join(",")}
                          onChange={(e) =>
                            setPlannerClaude({
                              ...plannerClaude,
                              claude: {
                                ...plannerClaude.claude,
                                allowedTools: e.target.value
                                  .split(/[,\s]+/g)
                                  .map((t) => t.trim())
                                  .filter(Boolean)
                              }
                            })
                          }
                          placeholder='Bash(git:*),Read,Edit'
                        />
                      </label>
                      <label className="mt-2 block space-y-1">
                        <div className="text-xs text-muted-fg">Additional allowed dirs (--add-dir)</div>
                        <textarea
                          className="min-h-[72px] w-full rounded-lg bg-muted/30 p-2 text-xs font-mono"
                          value={plannerClaude.claude.additionalAllowedDirs.join("\n")}
                          onChange={(e) =>
                            setPlannerClaude({
                              ...plannerClaude,
                              claude: {
                                ...plannerClaude.claude,
                                additionalAllowedDirs: e.target.value
                                  .split(/\r?\n/)
                                  .map((l) => l.trim())
                                  .filter(Boolean)
                              }
                            })
                          }
                          placeholder="/path/one\n/path/two"
                        />
                      </label>
                    </details>
                    {plannerClaude.claude.dangerouslySkipPermissions || plannerClaude.claude.permissionMode === "bypassPermissions" ? (
                      <div className="rounded-lg bg-red-500/10 p-2 text-xs text-red-200">
                        <div className="font-semibold">Dangerous permission bypass</div>
                        <div className="mt-1">
                          This bypasses Claude Code permission checks. Only use in an externally sandboxed environment (and only for directories you trust).
                        </div>
                        <label className="mt-2 flex items-start gap-2">
                          <input type="checkbox" checked={dangerAck} onChange={(e) => setDangerAck(e.target.checked)} />
                          <span>I understand and want to proceed.</span>
                        </label>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              {parseResult?.plannerCommandPreview ? (
                <div className="rounded shadow-card bg-card/40 p-2">
                  <div className="text-xs font-semibold">Planner Command Preview</div>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/20 p-2 text-xs leading-relaxed">
                    {parseResult.plannerCommandPreview}
                  </pre>
                </div>
              ) : null}

              {parseResult ? (
                <div className="rounded shadow-card bg-card/40 p-2">
                  <div className="text-xs font-semibold">Fuzzy Matches</div>
                  {parseResult.resolutions.length === 0 ? (
                    <div className="mt-1 text-xs text-muted-fg">No fuzzy resolutions.</div>
                  ) : (
                    <div className="mt-2 space-y-2 text-xs">
                      {parseResult.resolutions.slice(0, 6).map((r, idx) => (
                        <div key={`${r.path}-${idx}`} className="rounded bg-muted/20 p-2">
                          <div>
                            <span className="font-mono">{r.path}</span>: <span className="font-mono">{r.input}</span> →{" "}
                            <span className="font-mono">{r.resolved}</span>{" "}
                            <span className="text-muted-fg">(confidence {r.confidence.toFixed(2)})</span>
                          </div>
                          {r.candidates.length ? (
                            <div className="mt-1 text-xs text-muted-fg">
                              candidates:{" "}
                              {r.candidates
                                .slice(0, 4)
                                .map((c) => `${c.label ?? c.value} (${c.score.toFixed(2)})`)
                                .join(", ")}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}

                  {parseResult.ambiguities.length ? (
                    <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
                      <div className="font-semibold">Ambiguities</div>
                      <ul className="mt-1 list-disc pl-4">
                        {parseResult.ambiguities.slice(0, 6).map((a, idx) => (
                          <li key={`${a.path}-${idx}`}>
                            <span className="font-mono">{a.path}</span>: {a.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <IssueList issues={issues} />

              {requiredConfirmations.length ? (
                <ConfirmationsChecklist
                  required={requiredConfirmations}
                  accepted={acceptedConfirmations}
                  onToggle={(key, checked) => {
                    const next = new Set([...acceptedConfirmations]);
                    if (checked) next.add(key);
                    else next.delete(key);
                    setAcceptedConfirmations(next);
                  }}
                />
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="outline" disabled={!draft || saveBusy} onClick={() => void validateAndSave()}>
                  <Save size={16} weight="regular" className={cn(saveBusy && "animate-spin")} />
                  Save automation
                </Button>
              </div>
            </div>

            <div className="min-h-0">
              {!draft ? (
                <div className="h-full rounded-lg shadow-card bg-card/30 p-4">
                  <div className="text-xs text-muted-fg">Generate a draft to review the structured rule.</div>
                </div>
              ) : (
                <div className="max-h-[76vh] overflow-auto rounded bg-card/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold">Draft</div>
                      {parseResult ? (
                        <div className="mt-0.5 text-xs text-muted-fg">
                          confidence: <span className="font-mono">{parseResult.confidence.toFixed(2)}</span>
                        </div>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        // Reset confirmations; re-validate on save.
                        setRequiredConfirmations([]);
                        setAcceptedConfirmations(new Set());
                      }}
                    >
                      Reset confirmations
                    </Button>
                  </div>

                  <div className="mt-3">
                    <RuleEditor
                      draft={draft}
                      setDraft={setDraft}
                      suites={suites}
                      onSave={() => void validateAndSave()}
                      saving={saveBusy}
                      requiredConfirmations={requiredConfirmations}
                      acceptedConfirmations={acceptedConfirmations}
                      setAcceptedConfirmations={setAcceptedConfirmations}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AutomationsPage() {
  const [rules, setRules] = useState<AutomationRuleSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [simulateText, setSimulateText] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const [configTrustRequired, setConfigTrustRequired] = useState(false);
  const [configSharedHash, setConfigSharedHash] = useState<string | null>(null);

  const [draft, setDraft] = useState<AutomationRuleDraft | null>(null);
  const [draftIssues, setDraftIssues] = useState<AutomationDraftIssue[]>([]);
  const [requiredConfirmations, setRequiredConfirmations] = useState<AutomationDraftConfirmationRequirement[]>([]);
  const [acceptedConfirmations, setAcceptedConfirmations] = useState<Set<string>>(new Set());

  const [suites, setSuites] = useState<TestSuiteDefinition[]>([]);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextRules, cfg, nextSuites] = await Promise.all([
        window.ade.automations.list(),
        window.ade.projectConfig.get(),
        window.ade.tests.listSuites()
      ]);
      setRules(nextRules);
      setSuites(nextSuites);
      setConfigTrustRequired(Boolean(cfg.trust.requiresSharedTrust));
      setConfigSharedHash(cfg.trust.sharedHash ?? null);
      if (!selectedRuleId && nextRules.length) {
        setSelectedRuleId(nextRules[0]!.id);
      }
      if (selectedRuleId && !nextRules.some((r) => r.id === selectedRuleId)) {
        setSelectedRuleId(nextRules[0]?.id ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch(() => {});
    const unsub = window.ade.automations.onEvent(() => {
      refresh().catch(() => {});
    });
    return () => {
      try {
        unsub();
      } catch {
        // ignore
      }
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter((r) => {
      if (r.name.toLowerCase().includes(q)) return true;
      if (r.id.toLowerCase().includes(q)) return true;
      if (r.trigger.type.toLowerCase().includes(q)) return true;
      if (summarizeActions(r).toLowerCase().includes(q)) return true;
      return false;
    });
  }, [rules, search]);

  const selectedRule = useMemo(() => rules.find((r) => r.id === selectedRuleId) ?? null, [rules, selectedRuleId]);

  useEffect(() => {
    if (!selectedRule) {
      setDraft(null);
      return;
    }
    const next = toDraftFromRule(selectedRule);
    setDraft(next);
    setDraftIssues([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
  }, [selectedRuleId]);

  const runNow = async () => {
    if (!selectedRule) return;
    setError(null);
    try {
      await window.ade.automations.triggerManually({ id: selectedRule.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const v = await window.ade.automations.validateDraft({ draft, confirmations: [...acceptedConfirmations] });
      setRequiredConfirmations(v.requiredConfirmations);
      setDraftIssues(v.issues);
      if (!v.ok) return;
      await window.ade.automations.saveDraft({ draft, confirmations: [...acceptedConfirmations] });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const simulate = async () => {
    if (!draft) return;
    setError(null);
    try {
      const res = await window.ade.automations.simulate({ draft });
      const lines: string[] = [];
      if (res.notes.length) {
        lines.push("Notes:");
        for (const n of res.notes) lines.push(`- ${n}`);
        lines.push("");
      }
      if (res.actions.length) {
        lines.push("Plan:");
        for (const a of res.actions) {
          lines.push(`- #${a.index + 1} ${a.type}: ${a.summary}`);
          if (a.commandPreview) lines.push(`  command: ${a.commandPreview}`);
          if (a.cwdPreview) lines.push(`  cwd: ${a.cwdPreview}`);
          for (const w of a.warnings) lines.push(`  warn: ${w}`);
        }
      }
      if (res.issues.length) {
        lines.push("");
        lines.push("Issues:");
        for (const i of res.issues) lines.push(`- ${i.level} ${i.path}: ${i.message}`);
      }
      setSimulateText(lines.join("\n"));
      setSimulateOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const trustShared = async () => {
    setError(null);
    try {
      await window.ade.projectConfig.confirmTrust({ sharedHash: configSharedHash ?? undefined });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full min-h-0 gap-3">
      <section className="flex min-h-0 w-[44%] flex-col rounded shadow-card bg-card/60">
        <div className="flex items-center justify-between border-b border-border/15 px-3 py-2">
          <div>
            <div className="text-sm font-semibold">Automations</div>
            <div className="text-xs text-muted-fg">{loading ? "Loading…" : `${filtered.length} rules`}</div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
              <Plus size={16} weight="regular" />
              Create
            </Button>
            <Button variant="ghost" size="sm" onClick={() => refresh().catch(() => {})}>
              <RefreshCw size={16} weight="regular" className={cn(loading && "animate-spin")} />
            </Button>
          </div>
        </div>

        <div className="p-3">
          <input
            className="h-8 w-full rounded-lg bg-muted/30 px-2 text-xs"
            placeholder="Search rules…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {filtered.length === 0 ? (
            <EmptyState title="No automations configured" description="Describe a rule and ADE will run it for you." />
            ) : (
              <div className="space-y-2">
              {filtered.map((rule) => {
                const selected = rule.id === selectedRuleId;
                return (
                  <button
                    key={rule.id}
                    type="button"
                    onClick={() => setSelectedRuleId(rule.id)}
                    className={cn(
                      "w-full rounded p-2 text-left transition-all",
                      selected ? "shadow-card-hover bg-card/80" : "shadow-card bg-card/50 hover:shadow-card-hover hover:bg-card/70"
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="truncate text-xs font-semibold text-fg">{rule.name}</div>
                          <Chip className={cn("text-[11px]", statusTone(rule.running ? "running" : rule.lastRunStatus))}>
                            {rule.running ? "running" : rule.lastRunStatus ?? "never"}
                          </Chip>
                        </div>
                        {/* Trigger -> Condition -> Action flow */}
                        <div className="mt-2 flex items-center gap-0 text-[11px]">
                          <div className="rounded bg-orange-500/10 px-1.5 py-0.5 font-mono text-orange-600 leading-none">
                            {rule.trigger.type}{rule.trigger.type === "schedule" && rule.trigger.cron ? ` ${rule.trigger.cron}` : ""}
                          </div>
                          {rule.trigger.branch ? (
                            <>
                              <div className="w-3 border-t border-border/40" />
                              <div className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-amber-600 leading-none">
                                {rule.trigger.branch}
                              </div>
                            </>
                          ) : null}
                          <div className="w-3 border-t border-border/40" />
                          <div className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-emerald-600 leading-none truncate">
                            {summarizeActions(rule)}
                          </div>
                        </div>
                        <div className="mt-1.5 text-xs text-muted-fg truncate">last run: {formatWhen(rule.lastRunAt)}</div>
                      </div>
                      <div className="shrink-0 flex items-center gap-2">
                        <label className="flex items-center gap-1 text-xs text-muted-fg">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={(e) => {
                              const enabled = e.target.checked;
                              window.ade.automations
                                .toggle({ id: rule.id, enabled })
                                .then((next) => setRules(next))
                                .catch((err) => setError(err instanceof Error ? err.message : String(err)));
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                          enabled
                        </label>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col rounded shadow-card bg-card/60">
        <div className="flex items-center justify-between border-b border-border/15 px-3 py-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{selectedRule?.name ?? "Rule"}</div>
            <div className="text-xs text-muted-fg truncate">{selectedRule ? `id: ${selectedRule.id}` : "Select a rule"}</div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={!selectedRule || configTrustRequired} onClick={() => void runNow()}>
              <Play size={16} weight="regular" />
              Run now
            </Button>
            <Button size="sm" variant="outline" disabled={!selectedRule} onClick={() => setHistoryOpen(true)}>
              <HistoryIcon size={16} weight="regular" />
              History
            </Button>
            <Button size="sm" variant="outline" disabled={!draft} onClick={() => void simulate()}>
              <FlaskConical size={16} weight="regular" />
              Simulate
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {configTrustRequired ? (
            <div className="mb-3 rounded bg-amber-500/10 px-3 py-2 text-xs text-amber-900">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2">
                  <ShieldCheck size={16} weight="regular" className="mt-0.5" />
                  <div>Shared config changed and is untrusted. Automation execution is blocked until you confirm.</div>
                </div>
                <Button size="sm" variant="outline" onClick={() => void trustShared()}>
                  Trust shared config
                </Button>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="mb-3 rounded-lg bg-red-950/20 p-2 text-xs text-red-300">{error}</div>
          ) : null}

          {draft ? (
            <>
              <IssueList issues={draftIssues} />
              <div className="mt-3">
                <RuleEditor
                  draft={draft}
                  setDraft={(next) => setDraft(next)}
                  suites={suites}
                  onSave={() => void save()}
                  saving={saving}
                  requiredConfirmations={requiredConfirmations}
                  acceptedConfirmations={acceptedConfirmations}
                  setAcceptedConfirmations={setAcceptedConfirmations}
                />
              </div>
            </>
          ) : (
            <EmptyState title="No rule selected" description="Pick a rule from the list, or create a new one." />
          )}
        </div>
      </section>

      <HistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} rule={selectedRule} onError={(msg) => setError(msg)} />

      <CreateWithNaturalLanguageDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          refresh().catch(() => {});
          setSelectedRuleId(id);
        }}
        suites={suites}
      />

      <Dialog.Root open={simulateOpen} onOpenChange={setSimulateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-[10%] z-50 w-[min(900px,calc(100vw-24px))] -translate-x-1/2 rounded bg-card border border-border/40 p-3 shadow-float focus:outline-none">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Dialog.Title className="text-sm font-semibold truncate">Simulation</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm">
                  Close
                </Button>
              </Dialog.Close>
            </div>
            <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/20 p-3 text-xs leading-relaxed">
              {simulateText || "(no simulation output)"}
            </pre>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
