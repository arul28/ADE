import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { GitPullRequest, Stack as Layers, GitMerge } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import type { LaneSummary, MergeMethod, PrSummary, RiskMatrixEntry } from "../../../shared/types";

type CreateMode = "normal" | "queue" | "integration";
type WizardStep = "select-type" | "configure" | "execute";

const MERGE_METHODS: { id: MergeMethod; label: string; desc: string }[] = [
  { id: "squash", label: "Squash", desc: "Combine all commits into one. Clean, linear history." },
  { id: "merge", label: "Merge", desc: "Create a merge commit. Preserves individual commits and branch topology." },
  { id: "rebase", label: "Rebase", desc: "Replay commits on top of base. Linear history, keeps each commit." },
];

const MODES: { id: CreateMode; label: string; icon: React.ElementType; desc: string }[] = [
  { id: "normal", label: "Normal PR", icon: GitPullRequest, desc: "Single lane creates one PR." },
  { id: "queue", label: "Queue PRs", icon: Layers, desc: "Multiple lanes targeting the same branch, landed sequentially." },
  { id: "integration", label: "Integration PR", icon: GitMerge, desc: "Merge lanes into integration branch, then PR." },
];

export function CreatePrModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}) {
  const lanes = useAppStore((s) => s.lanes);
  const primaryLane = React.useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);

  const [step, setStep] = React.useState<WizardStep>("select-type");
  const [mode, setMode] = React.useState<CreateMode>("normal");

  // Shared
  const [mergeMethod, setMergeMethod] = React.useState<MergeMethod>("squash");

  // Normal PR
  const [normalLaneId, setNormalLaneId] = React.useState<string>("");
  const [normalTitle, setNormalTitle] = React.useState("");
  const [normalDraft, setNormalDraft] = React.useState(false);

  // Queue PRs
  const [queueLaneIds, setQueueLaneIds] = React.useState<string[]>([]);
  const [queueDraft, setQueueDraft] = React.useState(false);

  // Integration PR
  const [integrationSources, setIntegrationSources] = React.useState<string[]>([]);
  const [integrationName, setIntegrationName] = React.useState("integration");
  const [integrationTitle, setIntegrationTitle] = React.useState("");
  const [integrationDraft, setIntegrationDraft] = React.useState(false);

  // Body & AI draft
  const [normalBody, setNormalBody] = React.useState("");
  const [integrationBody, setIntegrationBody] = React.useState("");
  const [draftModel, setDraftModel] = React.useState("haiku");
  const [drafting, setDrafting] = React.useState(false);

  const handleDraftAI = async (laneId: string) => {
    setDrafting(true);
    try {
      const result = await window.ade.prs.draftDescription(laneId, draftModel);
      if (mode === "normal") {
        setNormalTitle(result.title);
        setNormalBody(result.body);
      } else if (mode === "integration") {
        setIntegrationTitle(result.title);
        setIntegrationBody(result.body);
      }
    } catch (err: unknown) {
      setExecError(err instanceof Error ? err.message : String(err));
    } finally {
      setDrafting(false);
    }
  };

  // Execute
  const [busy, setBusy] = React.useState(false);
  const [execError, setExecError] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<PrSummary[] | null>(null);
  const [integrationMergeResults, setIntegrationMergeResults] = React.useState<Array<{ laneId: string; success: boolean; error?: string }>>([]);
  const [integrationRiskRows, setIntegrationRiskRows] = React.useState<Array<{ laneAId: string; laneBId: string; riskLevel: RiskMatrixEntry["riskLevel"] | "unknown" }>>([]);

  // Reset on close
  React.useEffect(() => {
    if (open) return;
    const id = setTimeout(() => {
      setStep("select-type");
      setMode("normal");
      setMergeMethod("squash");
      setNormalLaneId("");
      setNormalTitle("");
      setNormalDraft(false);
      setQueueLaneIds([]);
      setQueueDraft(false);
      setIntegrationSources([]);
      setIntegrationName("integration");
      setIntegrationTitle("");
      setIntegrationDraft(false);
      setBusy(false);
      setExecError(null);
      setResults(null);
      setIntegrationMergeResults([]);
      setIntegrationRiskRows([]);
      setNormalBody("");
      setIntegrationBody("");
      setDraftModel("haiku");
      setDrafting(false);
    }, 200);
    return () => clearTimeout(id);
  }, [open]);

  const pairKey = (laneAId: string, laneBId: string): string =>
    laneAId < laneBId ? `${laneAId}::${laneBId}` : `${laneBId}::${laneAId}`;

  const buildIntegrationPlan = async () => {
    const uniqueSources = Array.from(new Set(integrationSources));
    setBusy(true);
    setExecError(null);
    setResults(null);
    setIntegrationMergeResults([]);
    try {
      const assessment = await window.ade.conflicts.getBatchAssessment().catch(() => null);
      const matrix = assessment?.matrix ?? [];
      const matrixByPair = new Map(matrix.map((entry) => [pairKey(entry.laneAId, entry.laneBId), entry]));
      const rows: Array<{ laneAId: string; laneBId: string; riskLevel: RiskMatrixEntry["riskLevel"] | "unknown" }> = [];
      for (let i = 0; i < uniqueSources.length; i++) {
        for (let j = i + 1; j < uniqueSources.length; j++) {
          const laneAId = uniqueSources[i]!;
          const laneBId = uniqueSources[j]!;
          const match = matrixByPair.get(pairKey(laneAId, laneBId));
          rows.push({ laneAId, laneBId, riskLevel: match?.riskLevel ?? "unknown" });
        }
      }
      setIntegrationRiskRows(rows);
      setStep("execute");
    } catch (err: unknown) {
      setExecError(err instanceof Error ? err.message : String(err));
      setStep("execute");
    } finally {
      setBusy(false);
    }
  };

  const createIntegrationPrNow = async () => {
    setBusy(true);
    setExecError(null);
    try {
      const baseBranch = primaryLane?.branchRef ?? "main";
      const result = await window.ade.prs.createIntegration({
        sourceLaneIds: integrationSources,
        integrationLaneName: integrationName,
        baseBranch,
        title: integrationTitle || `Integration: ${integrationName}`,
        body: integrationBody,
        draft: integrationDraft,
      });
      const failedMerges = result.mergeResults.filter((r) => !r.success);
      if (failedMerges.length > 0) {
        setExecError(failedMerges.map((r) => `${r.laneId}: ${r.error ?? "failed"}`).join("\n"));
      }
      setIntegrationMergeResults(result.mergeResults);
      setResults([result.pr]);
    } catch (err: unknown) {
      setExecError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    if (mode === "integration") {
      await buildIntegrationPlan();
      return;
    }
    setBusy(true);
    setExecError(null);
    try {
      if (mode === "normal") {
        const lane = lanes.find((l) => l.id === normalLaneId);
        const pr = await window.ade.prs.createFromLane({
          laneId: normalLaneId,
          title: normalTitle || lane?.name || "PR",
          body: normalBody,
          draft: normalDraft,
        });
        setResults([pr]);
      } else if (mode === "queue") {
        const baseBranch = primaryLane?.branchRef ?? "main";
        const result = await window.ade.prs.createQueue({
          laneIds: queueLaneIds,
          targetBranch: baseBranch,
          draft: queueDraft,
        });
        if (result.errors.length > 0) {
          setExecError(result.errors.map((e) => `${e.laneId}: ${e.error}`).join("\n"));
        }
        setResults(result.prs);
      }
      setStep("execute");
    } catch (err: unknown) {
      setExecError(err instanceof Error ? err.message : String(err));
      setStep("execute");
    } finally {
      setBusy(false);
    }
  };

  const nonPrimaryLanes = React.useMemo(() => lanes.filter((l) => l.laneType !== "primary"), [lanes]);

  const toggleQueueLane = (laneId: string) => {
    setQueueLaneIds((prev) =>
      prev.includes(laneId) ? prev.filter((id) => id !== laneId) : [...prev, laneId]
    );
  };

  const toggleIntegrationSource = (laneId: string) => {
    setIntegrationSources((prev) =>
      prev.includes(laneId) ? prev.filter((id) => id !== laneId) : [...prev, laneId]
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-[8%] z-50 w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded bg-card border border-border/40 p-3 shadow-float focus:outline-none max-h-[84vh] overflow-y-auto">
          <Dialog.Title className="text-sm font-semibold text-fg">Create Pull Request</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-fg">
            {step === "select-type" && "Choose a PR creation mode."}
            {step === "configure" && `Configure your ${mode} PR.`}
            {step === "execute" && (mode === "integration" && !results ? "Review integration proposal before creating the PR." : "Results")}
          </Dialog.Description>

          {/* Step 1: Select type */}
          {step === "select-type" && (
            <div className="mt-4 space-y-2">
              {MODES.map((m) => {
                const Icon = m.icon;
                return (
                  <button
                    key={m.id}
                    onClick={() => {
                      setMode(m.id);
                      setStep("configure");
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 rounded border px-4 py-3 text-left transition-colors",
                      "border-border bg-card/50 hover:bg-card/80 hover:border-accent/30"
                    )}
                  >
                    <Icon size={20} weight="regular" className="text-accent shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-fg">{m.label}</div>
                      <div className="text-xs text-muted-fg">{m.desc}</div>
                    </div>
                  </button>
                );
              })}
              <div className="flex justify-end pt-2">
                <Dialog.Close asChild>
                  <Button size="sm" variant="outline">Cancel</Button>
                </Dialog.Close>
              </div>
            </div>
          )}

          {/* Step 2: Configure */}
          {step === "configure" && (
            <div className="mt-4 space-y-4">
              {mode === "normal" && (
                <>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-fg">Lane</label>
                    <select
                      value={normalLaneId}
                      onChange={(e) => setNormalLaneId(e.target.value)}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
                    >
                      <option value="" disabled>Select lane...</option>
                      {nonPrimaryLanes.map((lane) => (
                        <option key={lane.id} value={lane.id}>{lane.name} ({lane.branchRef})</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-fg">Title (optional)</label>
                    <input
                      type="text"
                      value={normalTitle}
                      onChange={(e) => setNormalTitle(e.target.value)}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
                      placeholder="Auto-generated from lane name"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-fg">Body (markdown)</label>
                    <textarea
                      value={normalBody}
                      onChange={(e) => setNormalBody(e.target.value)}
                      rows={5}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none resize-none"
                      placeholder="PR description..."
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={draftModel}
                      onChange={(e) => setDraftModel(e.target.value)}
                      className="rounded-lg border border-border bg-card px-2 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
                    >
                      <option value="haiku">Haiku</option>
                      <option value="sonnet">Sonnet</option>
                      <option value="opus">Opus</option>
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!normalLaneId || drafting}
                      onClick={() => void handleDraftAI(normalLaneId)}
                    >
                      {drafting ? "Drafting..." : "Draft with AI"}
                    </Button>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-fg">
                    <input type="checkbox" checked={normalDraft} onChange={(e) => setNormalDraft(e.target.checked)} />
                    Create as draft
                  </label>
                </>
              )}

              {mode === "queue" && (
                <>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-fg">
                      Select lanes (in queue order)
                    </label>
                    <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-card/50 p-2 space-y-1">
                      {nonPrimaryLanes.map((lane) => (
                        <label
                          key={lane.id}
                          className={cn(
                            "flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs cursor-pointer",
                            queueLaneIds.includes(lane.id) ? "bg-accent/10" : "hover:bg-muted/30"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={queueLaneIds.includes(lane.id)}
                            onChange={() => toggleQueueLane(lane.id)}
                          />
                          <span className="truncate font-medium text-fg">{lane.name}</span>
                          <span className="ml-auto text-[11px] text-muted-fg">{lane.branchRef}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-fg">
                    <input type="checkbox" checked={queueDraft} onChange={(e) => setQueueDraft(e.target.checked)} />
                    Create as drafts
                  </label>
                </>
              )}

              {mode === "integration" && (
                <>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-fg">Source Lanes</label>
                    <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-card/50 p-2 space-y-1">
                      {nonPrimaryLanes.map((lane) => (
                        <label
                          key={lane.id}
                          className={cn(
                            "flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs cursor-pointer",
                            integrationSources.includes(lane.id) ? "bg-accent/10" : "hover:bg-muted/30"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={integrationSources.includes(lane.id)}
                            onChange={() => toggleIntegrationSource(lane.id)}
                          />
                          <span className="truncate font-medium text-fg">{lane.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-fg">Integration Lane Name</label>
                    <input
                      type="text"
                      value={integrationName}
                      onChange={(e) => setIntegrationName(e.target.value)}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-fg">PR Title</label>
                    <input
                      type="text"
                      value={integrationTitle}
                      onChange={(e) => setIntegrationTitle(e.target.value)}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
                      placeholder={`Integration: ${integrationName}`}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-fg">Body (markdown)</label>
                    <textarea
                      value={integrationBody}
                      onChange={(e) => setIntegrationBody(e.target.value)}
                      rows={5}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none resize-none"
                      placeholder="PR description..."
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={draftModel}
                      onChange={(e) => setDraftModel(e.target.value)}
                      className="rounded-lg border border-border bg-card px-2 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
                    >
                      <option value="haiku">Haiku</option>
                      <option value="sonnet">Sonnet</option>
                      <option value="opus">Opus</option>
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={integrationSources.length === 0 || drafting}
                      onClick={() => void handleDraftAI(integrationSources[0]!)}
                    >
                      {drafting ? "Drafting..." : "Draft with AI"}
                    </Button>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-fg">
                    <input type="checkbox" checked={integrationDraft} onChange={(e) => setIntegrationDraft(e.target.checked)} />
                    Create as draft
                  </label>
                </>
              )}

              {/* Merge method */}
              <div>
                <label className="mb-1 block text-xs font-medium text-fg">Merge Method (on land)</label>
                <div className="space-y-1">
                  {MERGE_METHODS.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setMergeMethod(m.id)}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                        mergeMethod === m.id
                          ? "border-accent bg-accent/10 ring-1 ring-accent/30"
                          : "border-border bg-card/50 hover:bg-card/70"
                      )}
                    >
                      <div className={cn(
                        "mt-0.5 h-3 w-3 shrink-0 rounded-full border-2",
                        mergeMethod === m.id ? "border-accent bg-accent" : "border-muted-fg/40"
                      )} />
                      <div>
                        <div className="font-medium text-fg">{m.label}</div>
                        <div className="mt-0.5 text-[11px] text-muted-fg">{m.desc}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex justify-between pt-2">
                <Button size="sm" variant="outline" onClick={() => setStep("select-type")}>
                  Back
                </Button>
                <div className="flex gap-2">
                  <Dialog.Close asChild>
                    <Button size="sm" variant="outline">Cancel</Button>
                  </Dialog.Close>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={
                      busy ||
                      (mode === "normal" && !normalLaneId) ||
                      (mode === "queue" && queueLaneIds.length === 0) ||
                      (mode === "integration" && (integrationSources.length === 0 || !integrationName.trim()))
                    }
                    onClick={() => void handleCreate()}
                  >
                    {busy ? (mode === "integration" ? "Building plan..." : "Creating...") : (mode === "integration" ? "Review Plan" : "Create PR")}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Execute / results */}
          {step === "execute" && (
            <div className="mt-4 space-y-3">
              {mode === "integration" && !results ? (
                <div className="space-y-3 rounded-lg border border-border bg-card/40 p-3">
                  <div className="text-xs font-semibold text-fg">Integration Proposal</div>
                  <div className="text-xs text-muted-fg">
                    No GitHub PR has been created yet. Review conflicts first, then create the integration PR.
                  </div>
                  <div className="rounded border border-border/50 bg-card/40 px-2.5 py-2 text-xs space-y-1">
                    <div className="text-muted-fg">Integration lane: <span className="text-fg">{integrationName.trim() || "integration"}</span></div>
                    <div className="text-muted-fg">Source lanes:</div>
                    <div className="flex flex-wrap gap-1.5">
                      {integrationSources.map((laneId) => {
                        const lane = nonPrimaryLanes.find((value) => value.id === laneId);
                        return (
                          <span key={laneId} className="rounded border border-border/40 bg-card/40 px-2 py-0.5 text-[11px] text-fg">
                            {lane?.name ?? laneId}
                          </span>
                        );
                      })}
                    </div>
                  </div>

                  {integrationRiskRows.length > 0 ? (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-fg">Predicted Pair Risk</div>
                      {integrationRiskRows.map((row) => {
                        const laneA = nonPrimaryLanes.find((value) => value.id === row.laneAId);
                        const laneB = nonPrimaryLanes.find((value) => value.id === row.laneBId);
                        const riskClass =
                          row.riskLevel === "high"
                            ? "text-red-300"
                            : row.riskLevel === "medium"
                              ? "text-amber-300"
                              : row.riskLevel === "low"
                                ? "text-emerald-300"
                                : "text-muted-fg";
                        return (
                          <div key={`${row.laneAId}:${row.laneBId}`} className="rounded border border-border/30 bg-card/30 px-2 py-1.5 text-xs">
                            <span className="text-fg">{laneA?.name ?? row.laneAId}</span>
                            <span className="px-1 text-muted-fg">{"<->"}</span>
                            <span className="text-fg">{laneB?.name ?? row.laneBId}</span>
                            <span className={`ml-2 capitalize ${riskClass}`}>{row.riskLevel}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded border border-border/30 bg-card/30 px-2.5 py-2 text-xs text-muted-fg">
                      No pairwise risk data was available. You can still proceed and resolve conflicts in the PR workflow.
                    </div>
                  )}

                  <div className="flex justify-between gap-2 pt-1">
                    <Button size="sm" variant="outline" onClick={() => setStep("configure")} disabled={busy}>
                      Back
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => void createIntegrationPrNow()} disabled={busy}>
                      {busy ? "Creating..." : "Create Integration PR"}
                    </Button>
                  </div>
                </div>
              ) : null}

              {results && results.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-emerald-600">
                    Created {results.length} PR(s)
                  </div>
                  {results.map((pr) => (
                    <div key={pr.id} className="flex items-center justify-between rounded-lg border border-border bg-card/50 px-3 py-2 text-xs">
                      <div>
                        <span className="font-medium text-fg">#{pr.githubPrNumber}</span>{" "}
                        <span className="text-muted-fg">{pr.title}</span>
                      </div>
                      <button
                        className="text-accent hover:underline"
                        onClick={() => void window.ade.app.openExternal(pr.githubUrl)}
                      >
                        View
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {mode === "integration" && integrationMergeResults.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-fg">Lane merge status</div>
                  {integrationMergeResults.map((item) => (
                    <div key={item.laneId} className="rounded border border-border/30 bg-card/30 px-2.5 py-1.5 text-xs flex items-center justify-between gap-2">
                      <span className="text-fg">{nonPrimaryLanes.find((lane) => lane.id === item.laneId)?.name ?? item.laneId}</span>
                      <span className={item.success ? "text-emerald-300" : "text-red-300"}>
                        {item.success ? "merged" : "failed"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              {execError && (
                <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700 whitespace-pre-wrap">
                  {execError}
                </div>
              )}

              {results ? (
                <div className="flex justify-end">
                  <Dialog.Close asChild>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => onCreated?.()}
                    >
                      Done
                    </Button>
                  </Dialog.Close>
                </div>
              ) : null}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
