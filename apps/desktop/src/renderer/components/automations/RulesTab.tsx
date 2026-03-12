import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "react-router-dom";
import {
  ArrowClockwise as RefreshCw,
  Plus,
  ShieldCheck,
  Sparkle as Sparkles,
  FloppyDisk as Save,
  Robot,
  Wrench,
} from "@phosphor-icons/react";
import { motion } from "motion/react";
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
  LinearConnectionStatus,
  LinearSyncDashboard,
  TestSuiteDefinition,
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { formatDate, statusToneAutomation as statusTone } from "../../lib/format";
import { extractError, INPUT_CLS, INPUT_STYLE } from "./shared";
import { RuleCard } from "./components/RuleCard";
import { RuleEditorPanel } from "./components/RuleEditorPanel";

/* ── Helpers ── */

function toDraftFromRule(rule: AutomationRuleSummary): AutomationRuleDraft {
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description ?? "",
    enabled: rule.enabled,
    mode: rule.mode,
    triggers: rule.triggers,
    trigger: rule.trigger ?? rule.triggers[0],
    executor: rule.executor,
    templateId: rule.templateId,
    prompt: rule.prompt ?? "",
    reviewProfile: rule.reviewProfile,
    toolPalette: rule.toolPalette,
    contextSources: rule.contextSources,
    memory: rule.memory,
    guardrails: rule.guardrails,
    outputs: rule.outputs,
    verification: rule.verification,
    billingCode: rule.billingCode,
    queueStatus: rule.queueStatus,
    actions: (rule.legacy?.actions ?? rule.actions ?? []).map((a) => {
      const shared = {
        ...(a.condition ? { condition: a.condition } : {}),
        ...(a.continueOnFailure != null ? { continueOnFailure: a.continueOnFailure } : {}),
        ...(a.timeoutMs != null ? { timeoutMs: a.timeoutMs } : {}),
        ...(a.retry != null ? { retry: a.retry } : {}),
      };
      if (a.type === "run-tests") {
        return { type: a.type, suite: a.suiteId ?? "", ...shared };
      }
      if (a.type === "run-command") {
        return { type: a.type, command: a.command ?? "", ...(a.cwd ? { cwd: a.cwd } : {}), ...shared };
      }
      return { type: a.type, ...shared };
    }) as any,
    legacyActions: (rule.legacy?.actions ?? rule.actions ?? []).map((a) => {
      const shared = {
        ...(a.condition ? { condition: a.condition } : {}),
        ...(a.continueOnFailure != null ? { continueOnFailure: a.continueOnFailure } : {}),
        ...(a.timeoutMs != null ? { timeoutMs: a.timeoutMs } : {}),
        ...(a.retry != null ? { retry: a.retry } : {}),
      };
      if (a.type === "run-tests") {
        return { type: a.type, suite: a.suiteId ?? "", ...shared };
      }
      if (a.type === "run-command") {
        return { type: a.type, command: a.command ?? "", ...(a.cwd ? { cwd: a.cwd } : {}), ...shared };
      }
      return { type: a.type, ...shared };
    }) as any,
  };
}

function createBlankDraft(): AutomationRuleDraft {
  return {
    name: "",
    description: "",
    enabled: true,
    mode: "review",
    triggers: [{ type: "manual" }],
    trigger: { type: "manual" },
    executor: { mode: "automation-bot" },
    prompt: "",
    reviewProfile: "quick",
    toolPalette: ["repo", "memory", "mission"],
    contextSources: [{ type: "project-memory" }, { type: "procedures" }],
    memory: { mode: "automation-plus-project" },
    guardrails: {},
    outputs: { disposition: "comment-only", createArtifact: true },
    verification: { verifyBeforePublish: false, mode: "intervention" },
    billingCode: "auto:new-rule",
    actions: [],
    legacyActions: [],
  };
}

/* ── NL Create Dialog (preserved from original) ── */

function CreateWithNaturalLanguageDialog({
  open,
  onOpenChange,
  onCreated,
  suites,
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
    codex: { sandbox: "read-only", askForApproval: "never", webSearch: false, additionalWritableDirs: [] },
  });
  const [plannerClaude, setPlannerClaude] = useState<AutomationPlannerConfig & { provider: "claude" }>({
    provider: "claude",
    claude: { permissionMode: "dontAsk", dangerouslySkipPermissions: false, allowedTools: [], additionalAllowedDirs: [] },
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
      setIntent(""); setParseResult(null); setDraft(null); setIssues([]);
      setRequiredConfirmations([]); setAcceptedConfirmations(new Set()); setDangerAck(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.ade.agentTools.detect().then(setTools).catch(() => {});
  }, [open]);

  useEffect(() => { setDangerAck(false); }, [provider, plannerClaude.claude.dangerouslySkipPermissions, plannerClaude.claude.permissionMode, plannerCodex.codex.sandbox]);

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
    setBusy(true); setIssues([]); setParseResult(null); setDraft(null);
    try {
      const res = await window.ade.automations.parseNaturalLanguage({ intent: trimmed, planner });
      setParseResult(res); setIssues(res.issues); setDraft(res.draft);
    } catch (err) {
      setIssues([{ level: "error", path: "planner", message: extractError(err) }]);
    } finally { setBusy(false); }
  };

  const validateAndSave = async () => {
    if (!draft) return;
    setSaveBusy(true);
    try {
      const v = await window.ade.automations.validateDraft({ draft, confirmations: [...acceptedConfirmations] });
      setRequiredConfirmations(v.requiredConfirmations); setIssues(v.issues);
      if (!v.ok) return;
      const saved = await window.ade.automations.saveDraft({ draft, confirmations: [...acceptedConfirmations] });
      onOpenChange(false); onCreated(saved.rule.id);
    } catch (err) {
      setIssues([{ level: "error", path: "save", message: extractError(err) }]);
    } finally { setSaveBusy(false); }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-[6%] z-50 w-[min(1040px,calc(100vw-24px))] -translate-x-1/2 p-4 focus:outline-none" style={{ background: "#181423", border: "1px solid #2D284060", boxShadow: "0 8px 32px -8px rgba(0,0,0,0.8)" }}>
          <div className="mb-3 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-[#FAFAFA]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Create Automation</Dialog.Title>
              <div className="mt-0.5 text-xs text-[#71717A]">
                Describe what you want, and the AI Planner will generate a rule draft.
              </div>
            </div>
            <Dialog.Close asChild><Button variant="ghost" size="sm">Close</Button></Dialog.Close>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[420px_1fr]">
            {/* Left: intent + planner config */}
            <div className="space-y-3">
              <div className="p-3" style={{ background: "#14111D", border: "1px solid #2D2840" }}>
                <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">Intent</div>
                <textarea
                  className="mt-2 min-h-[100px] w-full p-3 text-xs text-[#FAFAFA] placeholder:text-[#71717A50]"
                  style={INPUT_STYLE}
                  value={intent}
                  onChange={(e) => setIntent(e.target.value)}
                  placeholder="e.g. When I end a session, refresh packs and run unit tests on main."
                />
                <div className="mt-2 flex items-center justify-end">
                  <Button size="sm" variant="primary" disabled={!canGenerate} onClick={() => void generate()}>
                    <Sparkles size={12} weight="regular" className={cn(busy && "animate-spin")} />
                    Generate draft
                  </Button>
                </div>
              </div>

              <div className="p-3" style={{ background: "#14111D", border: "1px solid #2D2840" }}>
                <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">AI Planner</div>
                <select
                  className={cn(INPUT_CLS, "mt-2")}
                  style={INPUT_STYLE}
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as AutomationPlannerConfig["provider"])}
                >
                  <option value="codex" disabled={!codexTool?.installed}>AI Planner (Codex) {!codexTool?.installed ? "(not installed)" : ""}</option>
                  <option value="claude" disabled={!claudeTool?.installed}>AI Planner (Claude) {!claudeTool?.installed ? "(not installed)" : ""}</option>
                </select>

                <div className="mt-2 p-2 font-mono text-[9px] text-[#71717A]" style={{ background: "#0B0A0F", border: "1px solid #1E1B26" }}>
                  {provider === "codex" ? (
                    <>Codex: {codexTool?.installed ? `${codexTool.detectedVersion ?? "installed"} (${codexTool.detectedPath ?? "in PATH"})` : "not installed"}</>
                  ) : (
                    <>Claude: {claudeTool?.installed ? `${claudeTool.detectedVersion ?? "installed"} (${claudeTool.detectedPath ?? "in PATH"})` : "not installed"}</>
                  )}
                </div>

                {provider === "codex" ? (
                  <div className="mt-3 space-y-2">
                    <select className={INPUT_CLS} style={INPUT_STYLE} value={plannerCodex.codex.sandbox}
                      onChange={(e) => setPlannerCodex({ ...plannerCodex, codex: { ...plannerCodex.codex, sandbox: e.target.value as any } })}>
                      <option value="read-only">read-only</option>
                      <option value="workspace-write">workspace-write</option>
                      <option value="danger-full-access">danger-full-access</option>
                    </select>
                    <select className={INPUT_CLS} style={INPUT_STYLE} value={plannerCodex.codex.askForApproval}
                      onChange={(e) => setPlannerCodex({ ...plannerCodex, codex: { ...plannerCodex.codex, askForApproval: e.target.value as any } })}>
                      <option value="untrusted">untrusted</option>
                      <option value="on-failure">on-failure</option>
                      <option value="on-request">on-request</option>
                      <option value="never">never</option>
                    </select>
                    {plannerCodex.codex.sandbox === "danger-full-access" && (
                      <div className="p-2 text-xs text-red-200" style={{ background: "rgba(239,68,68,0.10)" }}>
                        <label className="flex items-start gap-2">
                          <input type="checkbox" checked={dangerAck} onChange={(e) => setDangerAck(e.target.checked)} className="accent-red-400 mt-0.5" />
                          <span>I understand danger-full-access grants full disk access.</span>
                        </label>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-3 space-y-2">
                    <select className={INPUT_CLS} style={INPUT_STYLE} value={plannerClaude.claude.permissionMode}
                      onChange={(e) => setPlannerClaude({ ...plannerClaude, claude: { ...plannerClaude.claude, permissionMode: e.target.value as any } })}>
                      <option value="dontAsk">dontAsk</option>
                      <option value="default">default</option>
                      <option value="plan">plan</option>
                      <option value="acceptEdits">acceptEdits</option>
                      <option value="delegate">delegate</option>
                      <option value="bypassPermissions">bypassPermissions</option>
                    </select>
                    <label className="flex items-center gap-2 text-xs text-[#71717A]">
                      <input type="checkbox" checked={plannerClaude.claude.dangerouslySkipPermissions}
                        onChange={(e) => setPlannerClaude({ ...plannerClaude, claude: { ...plannerClaude.claude, dangerouslySkipPermissions: e.target.checked } })}
                        className="accent-red-400"
                      />
                      <span className={plannerClaude.claude.dangerouslySkipPermissions ? "text-red-200" : undefined}>
                        --dangerously-skip-permissions
                      </span>
                    </label>
                    {(plannerClaude.claude.dangerouslySkipPermissions || plannerClaude.claude.permissionMode === "bypassPermissions") && (
                      <div className="p-2 text-xs text-red-200" style={{ background: "rgba(239,68,68,0.10)" }}>
                        <label className="flex items-start gap-2">
                          <input type="checkbox" checked={dangerAck} onChange={(e) => setDangerAck(e.target.checked)} className="accent-red-400 mt-0.5" />
                          <span>I understand and want to bypass permission checks.</span>
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {parseResult?.plannerCommandPreview && (
                <div className="p-3" style={{ background: "#14111D", border: "1px solid #2D2840" }}>
                  <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">Command Preview</div>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap p-2 text-xs text-[#FAFAFA80] leading-relaxed" style={{ background: "#0B0A0F", border: "1px solid #1E1B26" }}>
                    {parseResult.plannerCommandPreview}
                  </pre>
                </div>
              )}

              {issues.length > 0 && (
                <div className="space-y-2">
                  {issues.filter(i => i.level === "error").length > 0 && (
                    <div className="p-2 text-xs text-red-200" style={{ background: "rgba(239,68,68,0.10)" }}>
                      {issues.filter(i => i.level === "error").map((e, idx) => (
                        <div key={idx}><span className="font-mono">{e.path}</span>: {e.message}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="outline" disabled={!draft || saveBusy} onClick={() => void validateAndSave()}>
                  <Save size={12} weight="regular" className={cn(saveBusy && "animate-spin")} />
                  Save automation
                </Button>
              </div>
            </div>

            {/* Right: draft preview */}
            <div className="min-h-0">
              {!draft ? (
                <div className="h-full p-4" style={{ background: "#14111D", border: "1px solid #2D2840" }}>
                  <div className="text-xs text-[#71717A]">Generate a draft to review the structured rule.</div>
                </div>
              ) : (
                <div className="max-h-[76vh] overflow-auto p-3" style={{ background: "#14111D", border: "1px solid #2D2840" }}>
                  <div className="text-xs font-semibold text-[#FAFAFA]">Draft</div>
                  {parseResult && (
                    <div className="mt-0.5 font-mono text-[9px] text-[#71717A]">
                      confidence: {parseResult.confidence.toFixed(2)}
                    </div>
                  )}
                  <pre className="mt-2 whitespace-pre-wrap text-[10px] font-mono text-[#A1A1AA] leading-relaxed">
                    {JSON.stringify(draft, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ── Simulation Dialog ── */

function SimulateDialog({
  open,
  onOpenChange,
  text,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  text: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-[10%] z-50 w-[min(900px,calc(100vw-24px))] -translate-x-1/2 p-4 focus:outline-none" style={{ background: "#181423", border: "1px solid #2D284060", boxShadow: "0 8px 32px -8px rgba(0,0,0,0.8)" }}>
          <div className="mb-3 flex items-center justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold text-[#FAFAFA]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Simulation</Dialog.Title>
            <Dialog.Close asChild><Button variant="ghost" size="sm">Close</Button></Dialog.Close>
          </div>
          <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap p-3 text-xs text-[#FAFAFA80] leading-relaxed" style={{ background: "#0B0A0F", border: "1px solid #2D284060" }}>
            {text || "(no simulation output)"}
          </pre>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ── History Dialog ── */

function HistoryDialog({
  open,
  onOpenChange,
  rule,
  onError,
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
    setBusy(true); setRuns([]); setSelectedRunId(null); setDetail(null);
    window.ade.automations
      .getHistory({ id: rule.id, limit: 160 })
      .then((next) => setRuns(next))
      .catch((err) => onError(extractError(err)))
      .finally(() => setBusy(false));
  }, [open, rule]);

  const loadDetail = (runId: string) => {
    setSelectedRunId(runId); setDetailBusy(true); setDetail(null);
    window.ade.automations
      .getRunDetail(runId)
      .then((next) => setDetail(next))
      .catch((err) => onError(extractError(err)))
      .finally(() => setDetailBusy(false));
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-[8%] z-50 w-[min(980px,calc(100vw-24px))] -translate-x-1/2 p-4 focus:outline-none" style={{ background: "#181423", border: "1px solid #2D284060", boxShadow: "0 8px 32px -8px rgba(0,0,0,0.8)" }}>
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-[#FAFAFA]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Automation History</Dialog.Title>
              {rule && <div className="mt-0.5 text-xs text-[#71717A] truncate">{rule.name} <span className="font-mono">{rule.id}</span></div>}
            </div>
            <Dialog.Close asChild><Button variant="ghost" size="sm">Close</Button></Dialog.Close>
          </div>

          {busy && <div className="p-3 text-xs text-[#71717A]">Loading runs...</div>}

          <div className="grid min-h-0 grid-cols-[360px_1fr] gap-3">
            <div className="max-h-[65vh] overflow-auto p-3" style={{ background: "#14111D", border: "1px solid #2D2840" }}>
              {runs.length === 0 ? (
                <div className="p-2 text-xs text-[#71717A]">No runs yet.</div>
              ) : (
                <div className="space-y-2">
                  {runs.map((run) => {
                    const selected = selectedRunId === run.id;
                    return (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => loadDetail(run.id)}
                        className={cn("w-full px-2 py-2 text-left", selected ? "bg-[#1E1A2C]" : "hover:bg-[#14111D]")}
                        style={{ border: `1px solid ${selected ? "rgba(167,139,250,0.25)" : "#2D2840"}` }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="truncate text-xs font-semibold text-[#FAFAFA]">{run.triggerType}</div>
                          <Chip className={cn("text-[9px]", statusTone(run.status))}>{run.status}</Chip>
                        </div>
                        <div className="mt-1 text-xs text-[#71717A]">{formatDate(run.startedAt)}</div>
                        <div className="mt-1 text-xs text-[#71717A]">
                          {run.actionsCompleted}/{run.actionsTotal} actions
                          {run.errorMessage ? ` -- ${run.errorMessage}` : ""}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="max-h-[65vh] overflow-auto p-3" style={{ background: "#14111D", border: "1px solid #2D2840" }}>
              {detailBusy ? (
                <div className="text-xs text-[#71717A]">Loading run detail...</div>
              ) : !detail ? (
                <div className="text-xs text-[#71717A]">Select a run to view action results.</div>
              ) : (
                <div className="space-y-2">
                  <div className="font-mono text-[9px] text-[#71717A]">run: {detail.run.id}</div>
                  {detail.actions.map((action) => (
                    <div key={action.id} className="p-3" style={{ background: "#181423", border: "1px solid #2D2840" }}>
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <div className="font-semibold text-[#FAFAFA]">#{action.actionIndex + 1} {action.actionType}</div>
                        <Chip className={cn("text-[9px]", statusTone(action.status))}>{action.status}</Chip>
                      </div>
                      {action.errorMessage && <div className="mt-1 text-xs text-red-300">{action.errorMessage}</div>}
                      {action.output && (
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap p-2 text-xs leading-relaxed text-[#FAFAFA]" style={{ background: "#0B0A0F", border: "1px solid #2D284060" }}>
                          {action.output}
                        </pre>
                      )}
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

/* ── RulesTab ── */

export function RulesTab({
  pendingDraft,
  onDraftConsumed,
}: {
  pendingDraft?: AutomationRuleDraft | null;
  onDraftConsumed?: () => void;
}) {
  const navigate = useNavigate();
  const [rules, setRules] = useState<AutomationRuleSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [simulateText, setSimulateText] = useState("");
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  const [configTrustRequired, setConfigTrustRequired] = useState(false);
  const [configSharedHash, setConfigSharedHash] = useState<string | null>(null);

  const [draft, setDraft] = useState<AutomationRuleDraft | null>(null);
  const [draftIssues, setDraftIssues] = useState<AutomationDraftIssue[]>([]);
  const [requiredConfirmations, setRequiredConfirmations] = useState<AutomationDraftConfirmationRequirement[]>([]);
  const [acceptedConfirmations, setAcceptedConfirmations] = useState<Set<string>>(new Set());

  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createBtnRef = useRef<HTMLDivElement>(null);

  // Close create menu on outside click
  useEffect(() => {
    if (!createMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (createBtnRef.current && !createBtnRef.current.contains(e.target as Node)) {
        setCreateMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [createMenuOpen]);

  const [suites, setSuites] = useState<TestSuiteDefinition[]>([]);
  const [linearConnection, setLinearConnection] = useState<LinearConnectionStatus | null>(null);
  const [linearDashboard, setLinearDashboard] = useState<LinearSyncDashboard | null>(null);
  const [linearPolicyEnabled, setLinearPolicyEnabled] = useState(false);
  const [linearBusy, setLinearBusy] = useState(false);
  const [linearCardError, setLinearCardError] = useState<string | null>(null);

  const refreshLinearIntakeCard = useCallback(async () => {
    if (!window.ade?.cto) return;
    setLinearBusy(true); setLinearCardError(null);
    try {
      const [connection, dashboard, policy] = await Promise.all([
        window.ade.cto.getLinearConnectionStatus(),
        window.ade.cto.getLinearSyncDashboard(),
        window.ade.cto.getFlowPolicy(),
      ]);
      setLinearConnection(connection); setLinearDashboard(dashboard); setLinearPolicyEnabled(policy.workflows.some((workflow) => workflow.enabled));
    } catch (err) {
      setLinearCardError(extractError(err));
    } finally { setLinearBusy(false); }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [nextRules, cfg, nextSuites] = await Promise.all([
        window.ade.automations.list(),
        window.ade.projectConfig.get(),
        window.ade.tests.listSuites(),
      ]);
      setRules(nextRules); setSuites(nextSuites);
      setConfigTrustRequired(Boolean(cfg.trust.requiresSharedTrust));
      setConfigSharedHash(cfg.trust.sharedHash ?? null);
      if (!selectedRuleId && nextRules.length) setSelectedRuleId(nextRules[0]!.id);
      if (selectedRuleId && !nextRules.some((r) => r.id === selectedRuleId)) setSelectedRuleId(nextRules[0]?.id ?? null);
      await refreshLinearIntakeCard();
    } catch (err) {
      setError(extractError(err));
    } finally { setLoading(false); }
  }, [selectedRuleId, refreshLinearIntakeCard]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    refreshRef.current().catch(() => {});
    const unsub = window.ade.automations.onEvent(() => { refreshRef.current().catch(() => {}); });
    return () => { try { unsub(); } catch { /* ignore */ } };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter((r) =>
      r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) ||
      r.mode.toLowerCase().includes(q) ||
      r.reviewProfile.toLowerCase().includes(q) ||
      r.triggers.map((trigger) => trigger.type).join(", ").toLowerCase().includes(q)
    );
  }, [rules, search]);

  const selectedRule = useMemo(() => rules.find((r) => r.id === selectedRuleId) ?? null, [rules, selectedRuleId]);
  const linearQueuePending = useMemo(() => {
    if (!linearDashboard) return 0;
    return linearDashboard.queue.queued + linearDashboard.queue.retryWaiting + linearDashboard.queue.escalated + linearDashboard.queue.dispatched;
  }, [linearDashboard]);

  useEffect(() => {
    if (!selectedRule) { setDraft(null); return; }
    setDraft(toDraftFromRule(selectedRule));
    setDraftIssues([]); setRequiredConfirmations([]); setAcceptedConfirmations(new Set());
  }, [selectedRuleId]);

  // Handle pending draft from templates or manual create
  useEffect(() => {
    if (!pendingDraft) return;
    setSelectedRuleId(null);
    setDraft(pendingDraft);
    setDraftIssues([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
    setEditorOpen(true);
    onDraftConsumed?.();
  }, [pendingDraft]);

  const openManualCreate = () => {
    setSelectedRuleId(null);
    setDraft(createBlankDraft());
    setDraftIssues([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
    setEditorOpen(true);
    setCreateMenuOpen(false);
  };

  const runNow = async (ruleId?: string) => {
    const id = ruleId ?? selectedRule?.id;
    if (!id) return;
    setError(null);
    try { await window.ade.automations.triggerManually({ id }); }
    catch (err) { setError(extractError(err)); }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true); setError(null);
    try {
      const v = await window.ade.automations.validateDraft({ draft, confirmations: [...acceptedConfirmations] });
      setRequiredConfirmations(v.requiredConfirmations); setDraftIssues(v.issues);
      if (!v.ok) return;
      await window.ade.automations.saveDraft({ draft, confirmations: [...acceptedConfirmations] });
      setEditorOpen(false);
      await refresh();
    } catch (err) { setError(extractError(err)); }
    finally { setSaving(false); }
  };

  const simulate = async () => {
    if (!draft) return;
    setError(null);
    try {
      const res = await window.ade.automations.simulate({ draft });
      const lines: string[] = [];
      if (res.notes.length) { lines.push("Notes:"); for (const n of res.notes) lines.push(`- ${n}`); lines.push(""); }
      if (res.actions.length) {
        lines.push("Plan:");
        for (const a of res.actions) {
          lines.push(`- #${a.index + 1} ${a.type}: ${a.summary}`);
          if (a.commandPreview) lines.push(`  command: ${a.commandPreview}`);
          if (a.cwdPreview) lines.push(`  cwd: ${a.cwdPreview}`);
          for (const w of a.warnings) lines.push(`  warn: ${w}`);
        }
      }
      if (res.issues.length) { lines.push(""); lines.push("Issues:"); for (const i of res.issues) lines.push(`- ${i.level} ${i.path}: ${i.message}`); }
      setSimulateText(lines.join("\n")); setSimulateOpen(true);
    } catch (err) { setError(extractError(err)); }
  };

  const trustShared = async () => {
    setError(null);
    try { await window.ade.projectConfig.confirmTrust({ sharedHash: configSharedHash ?? undefined }); await refresh(); }
    catch (err) { setError(extractError(err)); }
  };

  const runLinearSyncNow = async () => {
    if (!window.ade?.cto) return;
    setLinearBusy(true); setLinearCardError(null);
    try {
      const dashboard = await window.ade.cto.runLinearSyncNow();
      setLinearDashboard(dashboard);
      const connection = await window.ade.cto.getLinearConnectionStatus();
      setLinearConnection(connection);
    } catch (err) {
      setLinearCardError(extractError(err));
    } finally { setLinearBusy(false); }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="flex h-full min-h-0 gap-px"
    >
      {/* Left: rule list */}
      <section className="flex min-h-0 w-[40%] flex-col" style={{ background: "#14111D", borderRight: "1px solid #2D2840" }}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid #2D284060" }}>
          <div>
            <div className="text-[13px] font-bold text-[#FAFAFA] tracking-[-0.3px]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Rules</div>
            <div className="font-mono text-[9px] text-[#71717A]">{loading ? "Loading..." : `${filtered.length} rules`}</div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative" ref={createBtnRef}>
              <Button size="sm" variant="primary" onClick={() => setCreateMenuOpen((v) => !v)}>
                <Plus size={12} weight="regular" />
                Create
              </Button>
              {createMenuOpen && (
                <div
                  className="absolute right-0 top-full z-20 mt-1 min-w-[180px] py-1"
                  style={{ background: "#181423", border: "1px solid #2D2840", boxShadow: "0 4px 16px -4px rgba(0,0,0,0.6)" }}
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[#FAFAFA] hover:bg-[#1E1A2C] transition-colors"
                    onClick={openManualCreate}
                  >
                    <Wrench size={12} weight="regular" className="text-[#A78BFA]" />
                    Manual
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[#FAFAFA] hover:bg-[#1E1A2C] transition-colors"
                    onClick={() => { setCreateOpen(true); setCreateMenuOpen(false); }}
                  >
                    <Robot size={12} weight="regular" className="text-[#A78BFA]" />
                    AI Planner
                  </button>
                </div>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={() => refresh().catch(() => {})}>
              <RefreshCw size={12} weight="regular" className={cn(loading && "animate-spin")} />
            </Button>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 py-2">
          <input
            className="h-7 w-full px-3 font-mono text-[10px] text-[#FAFAFA] placeholder:text-[#71717A50]"
            style={{ background: "#0B0A0F", border: "1px solid #2D284080" }}
            placeholder="Search rules..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* List */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {filtered.length === 0 ? (
            <EmptyState title="No automations configured" description="Describe a rule and ADE will run it for you." />
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map((rule) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  selected={rule.id === selectedRuleId}
                  onSelect={() => { setSelectedRuleId(rule.id); setEditorOpen(true); }}
                  onToggle={(enabled) => {
                    window.ade.automations.toggle({ id: rule.id, enabled })
                      .then((next) => setRules(next))
                      .catch((err) => setError(extractError(err)));
                  }}
                  onRunNow={() => { setSelectedRuleId(rule.id); void runNow(rule.id); }}
                  onEdit={() => { setSelectedRuleId(rule.id); setEditorOpen(true); }}
                  onHistory={() => { setSelectedRuleId(rule.id); setHistoryOpen(true); }}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Right: editor panel or detail */}
      <section className="flex min-h-0 flex-1 flex-col" style={{ background: "#0F0D14" }}>
        {/* Linear intake card */}
        <div className="px-4 py-3" style={{ borderBottom: "1px solid #2D284060" }} data-testid="linear-intake-policy-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[#FAFAFA]">Linear Intake Policy</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Chip className={cn("text-[9px]", linearConnection?.connected ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300")}>
                  {linearConnection?.connected ? "Connected" : "Disconnected"}
                </Chip>
                <Chip className={cn("text-[9px]", linearPolicyEnabled ? "bg-emerald-500/15 text-emerald-300" : "text-[#71717A]")}>
                  {linearPolicyEnabled ? "Policy Enabled" : "Policy Disabled"}
                </Chip>
                <Chip className="text-[9px]">Queue: {linearQueuePending}</Chip>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => navigate("/cto#linear-sync")}>Open in CTO</Button>
              <Button size="sm" variant="outline" disabled={linearBusy || !(linearPolicyEnabled && linearConnection?.tokenStored)} onClick={() => void runLinearSyncNow()}>
                <RefreshCw size={12} weight="regular" className={cn(linearBusy && "animate-spin")} />
                Run Sync Now
              </Button>
            </div>
          </div>
          {linearDashboard && (
            <div className="mt-1 font-mono text-[9px] text-[#71717A]">
              Last success: {formatDate(linearDashboard.lastSuccessAt)} | Polling: {linearDashboard.pollingIntervalSec}s
            </div>
          )}
          {linearCardError && <div className="mt-1 text-xs text-red-300">{linearCardError}</div>}
        </div>

        {configTrustRequired && (
          <div className="mx-4 my-2 flex items-center justify-between gap-3 p-2 text-xs text-amber-200" style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.20)" }}>
            <div className="flex items-start gap-2">
              <ShieldCheck size={14} weight="regular" className="mt-0.5 shrink-0" />
              <span>Shared config changed. Execution blocked until confirmed.</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => void trustShared()}>Trust</Button>
          </div>
        )}

        {error && <div className="mx-4 my-2 p-2 text-xs text-red-300" style={{ background: "rgba(239,68,68,0.08)" }}>{error}</div>}

        {/* Editor or empty */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {editorOpen && draft ? (
            <RuleEditorPanel
              draft={draft}
              setDraft={setDraft}
              suites={suites}
              issues={draftIssues}
              requiredConfirmations={requiredConfirmations}
              acceptedConfirmations={acceptedConfirmations}
              setAcceptedConfirmations={setAcceptedConfirmations}
              saving={saving}
              onSave={() => void save()}
              onSimulate={() => void simulate()}
              onClose={() => setEditorOpen(false)}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <EmptyState title="No rule selected" description="Pick a rule from the list, or create a new one." />
            </div>
          )}
        </div>
      </section>

      {/* Dialogs */}
      <HistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} rule={selectedRule} onError={(msg) => setError(msg)} />
      <CreateWithNaturalLanguageDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(id) => { refresh().catch(() => {}); setSelectedRuleId(id); setEditorOpen(true); }} suites={suites} />
      <SimulateDialog open={simulateOpen} onOpenChange={setSimulateOpen} text={simulateText} />
    </motion.div>
  );
}
