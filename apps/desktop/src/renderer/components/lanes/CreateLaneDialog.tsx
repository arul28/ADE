import { GitBranch, Plus, StackSimple } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import type { LaneSummary, LaneEnvInitProgress, LaneTemplate } from "../../../shared/types";
import type { LaneBranchOption } from "./laneUtils";
import { LaneEnvInitProgressPanel } from "./LaneEnvInitProgress";
import { LaneDialogShell } from "./LaneDialogShell";
import { SECTION_CLASS_NAME, LABEL_CLASS_NAME, INPUT_CLASS_NAME, SELECT_CLASS_NAME } from "./laneDialogTokens";

function buttonLabel(busy: boolean | undefined, createAsChild: boolean, parentLaneId: string, baseBranch: string): string {
  if (busy) return "Setting up lane...";
  if (createAsChild && parentLaneId) return "Create child lane";
  return `Create from ${baseBranch || "primary"}`;
}

export function CreateLaneDialog({
  open,
  onOpenChange,
  createLaneName,
  setCreateLaneName,
  createAsChild,
  setCreateAsChild,
  createParentLaneId,
  setCreateParentLaneId,
  createBaseBranch,
  setCreateBaseBranch,
  createBranches,
  lanes,
  onSubmit,
  busy,
  error,
  envInitProgress,
  templates,
  selectedTemplateId,
  setSelectedTemplateId,
  onNavigateToTemplates
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  createLaneName: string;
  setCreateLaneName: (v: string) => void;
  createAsChild: boolean;
  setCreateAsChild: (v: boolean) => void;
  createParentLaneId: string;
  setCreateParentLaneId: (v: string) => void;
  createBaseBranch: string;
  setCreateBaseBranch: (v: string) => void;
  createBranches: LaneBranchOption[];
  lanes: LaneSummary[];
  onSubmit: () => void;
  busy?: boolean;
  error?: string | null;
  envInitProgress?: LaneEnvInitProgress | null;
  templates: LaneTemplate[];
  selectedTemplateId: string;
  setSelectedTemplateId: (id: string) => void;
  onNavigateToTemplates?: () => void;
}) {
  const localBranches = createBranches.filter((branch) => !branch.isRemote);
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? null;

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Create lane"
      description="Start a fresh lane from primary or branch from an existing lane. Templates can install deps, copy files, and preconfigure the lane."
      icon={Plus}
      widthClassName="w-[min(720px,calc(100vw-24px))]"
      busy={busy}
    >
      <div className="space-y-4">
        <section className={SECTION_CLASS_NAME}>
          <label className="block">
            <span className={LABEL_CLASS_NAME}>Lane name</span>
            <input
              value={createLaneName}
              onChange={(event) => setCreateLaneName(event.target.value)}
              placeholder="e.g. feature/auth-refresh"
              className={INPUT_CLASS_NAME}
              autoFocus
              disabled={busy}
            />
          </label>
        </section>

        <section className={SECTION_CLASS_NAME}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className={LABEL_CLASS_NAME}>Template</div>
              <div className="mt-1 text-sm text-muted-fg">
                Optional automation for dependency install, file copy, and lane setup.
              </div>
            </div>
            {onNavigateToTemplates ? (
              <button
                type="button"
                className="inline-flex h-8 items-center rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 text-[11px] font-medium text-fg transition-colors hover:border-accent/30 hover:text-accent"
                disabled={busy}
                onClick={() => {
                  onOpenChange(false);
                  onNavigateToTemplates();
                }}
              >
                {templates.length > 0 ? "Manage templates" : "Create template"}
              </button>
            ) : null}
          </div>
          {templates.length > 0 ? (
            <>
              <select
                value={selectedTemplateId}
                onChange={(event) => setSelectedTemplateId(event.target.value)}
                className={SELECT_CLASS_NAME}
                disabled={busy}
              >
                <option value="">No template</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                    {template.description ? ` — ${template.description}` : ""}
                  </option>
                ))}
              </select>
              <div className="mt-2 text-xs text-muted-fg/80">
                {selectedTemplate?.description ?? "Create a lane with the default environment setup."}
              </div>
            </>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-white/[0.08] bg-black/10 px-3 py-3 text-sm text-muted-fg">
              No templates yet. Create one to copy folders, install dependencies, and configure lanes automatically.
            </div>
          )}
        </section>

        <section className={SECTION_CLASS_NAME}>
          <div className="flex items-start gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03] text-accent">
              {createAsChild ? <StackSimple size={16} /> : <GitBranch size={16} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className={LABEL_CLASS_NAME}>Starting point</div>
              <div className="mt-1 text-sm text-muted-fg">
                Choose whether the new lane starts from primary or from another lane in the stack.
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    !createAsChild
                      ? "border-accent/35 bg-accent/10 text-fg"
                      : "border-white/[0.06] bg-white/[0.02] text-muted-fg hover:text-fg"
                  }`}
                  disabled={busy}
                  onClick={() => {
                    setCreateAsChild(false);
                    setCreateParentLaneId("");
                  }}
                >
                  <div className="font-medium">From primary</div>
                  <div className="mt-1 text-xs text-muted-fg">Branch from the primary lane and pick a base branch.</div>
                </button>
                <button
                  type="button"
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    createAsChild
                      ? "border-accent/35 bg-accent/10 text-fg"
                      : "border-white/[0.06] bg-white/[0.02] text-muted-fg hover:text-fg"
                  }`}
                  disabled={busy}
                  onClick={() => setCreateAsChild(true)}
                >
                  <div className="font-medium">Child lane</div>
                  <div className="mt-1 text-xs text-muted-fg">Stack the lane under an existing lane and inherit its branch.</div>
                </button>
              </div>

              {createAsChild ? (
                <label className="mt-4 block">
                  <span className={LABEL_CLASS_NAME}>Parent lane</span>
                  <select
                    value={createParentLaneId}
                    onChange={(event) => setCreateParentLaneId(event.target.value)}
                    className={SELECT_CLASS_NAME}
                    disabled={busy}
                  >
                    <option value="">Select a parent lane...</option>
                    {lanes.map((lane) => (
                      <option key={lane.id} value={lane.id}>
                        {lane.name} ({lane.branchRef})
                      </option>
                    ))}
                  </select>
                  <div className="mt-2 text-xs text-muted-fg/80">
                    The new lane will be created as a child of the selected lane.
                  </div>
                </label>
              ) : (
                <label className="mt-4 block">
                  <span className={LABEL_CLASS_NAME}>Base branch on primary</span>
                  <select
                    value={createBaseBranch}
                    onChange={(event) => setCreateBaseBranch(event.target.value)}
                    className={SELECT_CLASS_NAME}
                    disabled={busy}
                  >
                    {localBranches.map((branch) => (
                      <option key={branch.name} value={branch.name}>
                        {branch.name}
                        {branch.isCurrent ? " (current)" : ""}
                      </option>
                    ))}
                  </select>
                  <div className="mt-2 text-xs text-muted-fg/80">
                    Lane will be created from primary/{createBaseBranch || "..."}.
                  </div>
                </label>
              )}
            </div>
          </div>
        </section>

        {error ? (
          <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              onOpenChange(false);
              setCreateLaneName("");
              setCreateParentLaneId("");
              setCreateAsChild(false);
              setCreateBaseBranch("");
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !createLaneName.trim() || (createAsChild && !createParentLaneId)}
            onClick={onSubmit}
          >
            {buttonLabel(busy, createAsChild, createParentLaneId, createBaseBranch)}
          </Button>
        </div>

        {envInitProgress ? <LaneEnvInitProgressPanel progress={envInitProgress} /> : null}
      </div>
    </LaneDialogShell>
  );
}
