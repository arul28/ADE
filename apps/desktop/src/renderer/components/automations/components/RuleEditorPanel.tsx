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

  const updateTrigger = (patch: Partial<typeof trigger>) => {
    const nextTrigger = { ...trigger, ...patch };
    setDraft({ ...draft, trigger: nextTrigger, triggers: [nextTrigger] });
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
                onChange={(e) => setDraft({ ...draft, executor: { ...draft.executor, mode: e.target.value as AutomationRuleDraft["executor"]["mode"] } })}
              >
                <option value="automation-bot">automation-bot</option>
                <option value="employee">employee</option>
                <option value="cto-route">cto-route</option>
                <option value="night-shift">night-shift</option>
              </select>
            </label>
          </div>
        ))}

        {section("Trigger", (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="space-y-1">
              <div className="font-mono text-[9px] text-[#71717A]">Type</div>
              <select className={INPUT_CLS} style={INPUT_STYLE} value={trigger.type} onChange={(e) => updateTrigger({ type: e.target.value as any })}>
                <option value="manual">manual</option>
                <option value="session-end">session-end</option>
                <option value="commit">commit</option>
                <option value="schedule">schedule</option>
                <option value="github-webhook">github-webhook</option>
                <option value="webhook">webhook</option>
              </select>
            </label>
            <label className="space-y-1 md:col-span-2">
              <div className="font-mono text-[9px] text-[#71717A]">{trigger.type === "schedule" ? "Cron" : "Branch / Event filter"}</div>
              <input
                className={INPUT_CLS}
                style={INPUT_STYLE}
                value={trigger.type === "schedule" ? trigger.cron ?? "" : trigger.branch ?? trigger.event ?? ""}
                onChange={(e) => trigger.type === "schedule" ? updateTrigger({ cron: e.target.value }) : updateTrigger({ branch: e.target.value, event: e.target.value })}
                placeholder={trigger.type === "schedule" ? "0 9 * * 1-5" : "main or pull_request"}
              />
            </label>
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
