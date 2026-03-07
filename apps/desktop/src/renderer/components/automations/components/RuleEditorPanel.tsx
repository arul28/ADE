import {
  FloppyDisk as Save,
  X,
  Flask as FlaskConical,
} from "@phosphor-icons/react";
import type {
  AutomationDraftConfirmationRequirement,
  AutomationDraftIssue,
  AutomationRuleDraft,
  TestSuiteDefinition,
} from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { INPUT_CLS, INPUT_STYLE } from "../shared";

function IssueList({ issues }: { issues: AutomationDraftIssue[] }) {
  if (!issues.length) return null;
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  return (
    <div className="space-y-2">
      {errors.length ? (
        <div className="p-2 text-xs text-red-200" style={{ background: "rgba(239,68,68,0.10)" }}>
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
        <div className="p-2 text-xs text-amber-200" style={{ background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.30)" }}>
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
        {required.map((r) => (
          <label key={r.key} className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={accepted.has(r.key)}
              onChange={(e) => onToggle(r.key, e.target.checked)}
              className="accent-[#A78BFA] mt-0.5"
            />
            <div className="min-w-0">
              <div className={cn("font-semibold", r.severity === "danger" ? "text-red-200" : "text-amber-200")}>{r.title}</div>
              <div className="text-[#8B8B9A]">{r.message}</div>
            </div>
          </label>
        ))}
      </div>
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
  const updateAction = (idx: number, patch: Record<string, unknown>) => {
    const nextActions = [...draft.actions];
    nextActions[idx] = { ...(nextActions[idx] as any), ...patch } as any;
    setDraft({ ...draft, actions: nextActions });
  };

  const removeAction = (idx: number) => {
    setDraft({ ...draft, actions: draft.actions.filter((_a, i) => i !== idx) });
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
    <div
      className="flex flex-col h-full"
      style={{ background: "#14111D" }}
    >
      {/* Header */}
      <div
        className="shrink-0 flex items-center justify-between px-4 py-3"
        style={{ borderBottom: "1px solid #2D2840" }}
      >
        <div className="min-w-0">
          <div
            className="text-[13px] font-bold text-[#FAFAFA] tracking-[-0.3px]"
            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
          >
            {draft.id ? "Edit Rule" : "Create Rule"}
          </div>
          {draft.id && (
            <div className="mt-0.5 font-mono text-[9px] text-[#71717A]">{draft.id}</div>
          )}
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
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-[#71717A] hover:text-[#FAFAFA] transition-colors"
          >
            <X size={14} weight="regular" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        <IssueList issues={issues} />

        {/* Name + enabled */}
        <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
          <label className="space-y-1">
            <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Name</div>
            <input
              className={INPUT_CLS}
              style={INPUT_STYLE}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="My automation"
            />
          </label>
          <label className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-[1px] text-[#71717A] h-8">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              className="accent-[#A78BFA]"
            />
            enabled
          </label>
        </div>

        {/* Trigger */}
        <div className="p-3 space-y-2" style={{ background: "#181423", border: "1px solid #2D2840" }}>
          <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">Trigger</div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="space-y-1">
              <div className="font-mono text-[9px] text-[#71717A]">Type</div>
              <select
                className={INPUT_CLS}
                style={INPUT_STYLE}
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
                <div className="font-mono text-[9px] text-[#71717A]">Cron</div>
                <input
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={draft.trigger.cron ?? ""}
                  onChange={(e) => setDraft({ ...draft, trigger: { ...draft.trigger, cron: e.target.value } })}
                  placeholder="0 9 * * 1-5"
                />
              </label>
            ) : (
              <label className="space-y-1 md:col-span-2">
                <div className="font-mono text-[9px] text-[#71717A]">Branch (optional)</div>
                <input
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={draft.trigger.branch ?? ""}
                  onChange={(e) => setDraft({ ...draft, trigger: { ...draft.trigger, branch: e.target.value } })}
                  placeholder="main"
                />
              </label>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="p-3 space-y-2" style={{ background: "#181423", border: "1px solid #2D2840" }}>
          <div className="flex items-center justify-between gap-2">
            <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">Actions</div>
            <select
              className="h-7 px-2 font-mono text-[9px] text-[#FAFAFA]"
              style={INPUT_STYLE}
              value=""
              onChange={(e) => { if (e.target.value) addAction(e.target.value); e.target.value = ""; }}
            >
              <option value="">Add action...</option>
              <option value="update-packs">update-packs</option>
              <option value="predict-conflicts">predict-conflicts</option>
              <option value="run-tests">run-tests</option>
              <option value="run-command">run-command</option>
            </select>
          </div>

          {draft.actions.length === 0 ? (
            <div className="text-xs text-[#71717A]">No actions yet.</div>
          ) : (
            <div className="space-y-2">
              {draft.actions.map((action: any, idx: number) => (
                <div key={idx} className="p-3" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-[#FAFAFA]">{action.type}</div>
                      {action.type === "run-tests" && (
                        <div className="mt-2">
                          <select
                            className={cn(INPUT_CLS, "h-7")}
                            style={INPUT_STYLE}
                            value={action.suite ?? ""}
                            onChange={(e) => updateAction(idx, { suite: e.target.value })}
                          >
                            <option value="">Select suite</option>
                            {suites.map((s) => (
                              <option key={s.id} value={s.id}>{s.name || s.id}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      {action.type === "run-command" && (
                        <div className="mt-2 space-y-2">
                          <textarea
                            className="min-h-[72px] w-full p-2 text-xs font-mono text-[#FAFAFA] placeholder:text-[#71717A50]"
                            style={INPUT_STYLE}
                            value={action.command ?? ""}
                            onChange={(e) => updateAction(idx, { command: e.target.value })}
                            placeholder='codex exec "..."'
                          />
                          <input
                            className={cn(INPUT_CLS, "h-7")}
                            style={INPUT_STYLE}
                            value={action.cwd ?? ""}
                            onChange={(e) => updateAction(idx, { cwd: e.target.value })}
                            placeholder="cwd (optional)"
                          />
                        </div>
                      )}
                      <details className="mt-2">
                        <summary className="cursor-pointer font-mono text-[9px] text-[#71717A]">Advanced</summary>
                        <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                          <input
                            className={cn(INPUT_CLS, "h-7")}
                            style={INPUT_STYLE}
                            value={action.condition ?? ""}
                            onChange={(e) => updateAction(idx, { condition: e.target.value })}
                            placeholder="Condition"
                          />
                          <input
                            className={cn(INPUT_CLS, "h-7")}
                            style={INPUT_STYLE}
                            value={action.timeoutMs ?? ""}
                            onChange={(e) => updateAction(idx, { timeoutMs: e.target.value ? Number(e.target.value) : undefined })}
                            placeholder="Timeout (ms)"
                          />
                          <input
                            className={cn(INPUT_CLS, "h-7")}
                            style={INPUT_STYLE}
                            value={action.retry ?? ""}
                            onChange={(e) => updateAction(idx, { retry: e.target.value ? Number(e.target.value) : undefined })}
                            placeholder="Retry"
                          />
                          <label className="flex items-center gap-2 text-[9px] font-mono text-[#71717A]">
                            <input
                              type="checkbox"
                              checked={Boolean(action.continueOnFailure)}
                              onChange={(e) => updateAction(idx, { continueOnFailure: e.target.checked })}
                              className="accent-[#A78BFA]"
                            />
                            continue on failure
                          </label>
                        </div>
                      </details>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => removeAction(idx)}>Remove</Button>
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
      </div>
    </div>
  );
}
