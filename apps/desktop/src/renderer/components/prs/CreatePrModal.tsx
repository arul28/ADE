import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { GitPullRequest, Layers, GitMerge } from "lucide-react";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import type { LaneSummary, MergeMethod, PrSummary } from "../../../shared/types";

type CreateMode = "normal" | "stacked" | "integration";
type WizardStep = "select-type" | "configure" | "execute";

const MERGE_METHODS: { id: MergeMethod; label: string; desc: string }[] = [
  { id: "squash", label: "Squash", desc: "Combine all commits into one. Clean, linear history." },
  { id: "merge", label: "Merge", desc: "Create a merge commit. Preserves individual commits and branch topology." },
  { id: "rebase", label: "Rebase", desc: "Replay commits on top of base. Linear history, keeps each commit." },
];

const MODES: { id: CreateMode; label: string; icon: React.ElementType; desc: string }[] = [
  { id: "normal", label: "Normal PR", icon: GitPullRequest, desc: "Single lane creates one PR." },
  { id: "stacked", label: "Stacked PRs", icon: Layers, desc: "Multiple lanes, each targets the previous." },
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

  // Stacked PRs
  const [stackedLaneIds, setStackedLaneIds] = React.useState<string[]>([]);
  const [stackedDraft, setStackedDraft] = React.useState(false);

  // Integration PR
  const [integrationSources, setIntegrationSources] = React.useState<string[]>([]);
  const [integrationName, setIntegrationName] = React.useState("integration");
  const [integrationTitle, setIntegrationTitle] = React.useState("");
  const [integrationDraft, setIntegrationDraft] = React.useState(false);

  // Execute
  const [busy, setBusy] = React.useState(false);
  const [execError, setExecError] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<PrSummary[] | null>(null);

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
      setStackedLaneIds([]);
      setStackedDraft(false);
      setIntegrationSources([]);
      setIntegrationName("integration");
      setIntegrationTitle("");
      setIntegrationDraft(false);
      setBusy(false);
      setExecError(null);
      setResults(null);
    }, 200);
    return () => clearTimeout(id);
  }, [open]);

  const handleCreate = async () => {
    setBusy(true);
    setExecError(null);
    try {
      if (mode === "normal") {
        const lane = lanes.find((l) => l.id === normalLaneId);
        const pr = await window.ade.prs.createFromLane({
          laneId: normalLaneId,
          title: normalTitle || lane?.name || "PR",
          body: "",
          draft: normalDraft,
        });
        setResults([pr]);
      } else if (mode === "stacked") {
        const baseBranch = primaryLane?.branchRef ?? "main";
        const result = await window.ade.prs.createStacked({
          laneIds: stackedLaneIds,
          targetBranch: baseBranch,
          draft: stackedDraft,
        });
        if (result.errors.length > 0) {
          setExecError(result.errors.map((e) => `${e.laneId}: ${e.error}`).join("\n"));
        }
        setResults(result.prs);
      } else {
        const baseBranch = primaryLane?.branchRef ?? "main";
        const result = await window.ade.prs.createIntegration({
          sourceLaneIds: integrationSources,
          integrationLaneName: integrationName,
          baseBranch,
          title: integrationTitle || `Integration: ${integrationName}`,
          draft: integrationDraft,
        });
        const failedMerges = result.mergeResults.filter((r) => !r.success);
        if (failedMerges.length > 0) {
          setExecError(failedMerges.map((r) => `${r.laneId}: ${r.error ?? "failed"}`).join("\n"));
        }
        setResults([result.pr]);
      }
      setStep("execute");
    } catch (err: any) {
      setExecError(err?.message ?? String(err));
      setStep("execute");
    } finally {
      setBusy(false);
    }
  };

  const nonPrimaryLanes = React.useMemo(() => lanes.filter((l) => l.laneType !== "primary"), [lanes]);

  const toggleStackedLane = (laneId: string) => {
    setStackedLaneIds((prev) =>
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
            {step === "execute" && "Results"}
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
                    <Icon className="h-5 w-5 text-accent shrink-0" />
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
                  <label className="flex items-center gap-2 text-xs text-fg">
                    <input type="checkbox" checked={normalDraft} onChange={(e) => setNormalDraft(e.target.checked)} />
                    Create as draft
                  </label>
                </>
              )}

              {mode === "stacked" && (
                <>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-fg">
                      Select lanes (in stack order)
                    </label>
                    <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-card/50 p-2 space-y-1">
                      {nonPrimaryLanes.map((lane) => (
                        <label
                          key={lane.id}
                          className={cn(
                            "flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs cursor-pointer",
                            stackedLaneIds.includes(lane.id) ? "bg-accent/10" : "hover:bg-muted/30"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={stackedLaneIds.includes(lane.id)}
                            onChange={() => toggleStackedLane(lane.id)}
                          />
                          <span className="truncate font-medium text-fg">{lane.name}</span>
                          <span className="ml-auto text-[10px] text-muted-fg">{lane.branchRef}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-fg">
                    <input type="checkbox" checked={stackedDraft} onChange={(e) => setStackedDraft(e.target.checked)} />
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
                        <div className="mt-0.5 text-[10px] text-muted-fg">{m.desc}</div>
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
                      (mode === "stacked" && stackedLaneIds.length === 0) ||
                      (mode === "integration" && (integrationSources.length === 0 || !integrationName.trim()))
                    }
                    onClick={() => void handleCreate()}
                  >
                    {busy ? "Creating..." : "Create PR"}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Execute / results */}
          {step === "execute" && (
            <div className="mt-4 space-y-3">
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

              {execError && (
                <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700 whitespace-pre-wrap">
                  {execError}
                </div>
              )}

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
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
