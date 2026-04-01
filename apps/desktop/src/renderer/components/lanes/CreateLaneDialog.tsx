import { GitBranch, GitFork, Plus, StackSimple } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import type { LaneSummary, LaneEnvInitProgress, LaneTemplate } from "../../../shared/types";
import type { LaneBranchOption } from "./laneUtils";
import { LaneEnvInitProgressPanel } from "./LaneEnvInitProgress";
import { LaneDialogShell } from "./LaneDialogShell";
import { SECTION_CLASS_NAME, LABEL_CLASS_NAME, INPUT_CLASS_NAME, SELECT_CLASS_NAME } from "./laneDialogTokens";

export type CreateLaneMode = "primary" | "existing" | "child";

const MODE_META: Record<CreateLaneMode, { icon: typeof GitBranch; label: string }> = {
  primary:  { icon: GitBranch,    label: "From primary" },
  existing: { icon: GitFork,      label: "Existing branch" },
  child:    { icon: StackSimple,  label: "Child lane" },
};

function submitLabel(busy: boolean | undefined, mode: CreateLaneMode, baseBranch: string, laneCreated: boolean | undefined): string {
  if (busy) return "Setting up lane\u2026";
  if (laneCreated) return "Retry environment setup";
  if (mode === "child") return "Create child lane";
  if (mode === "existing") return "Import as lane";
  return `Create from ${baseBranch || "primary"}`;
}

export function CreateLaneDialog({
  open,
  onOpenChange,
  createLaneName,
  setCreateLaneName,
  createMode,
  setCreateMode,
  createParentLaneId,
  setCreateParentLaneId,
  createBaseBranch,
  setCreateBaseBranch,
  createImportBranch,
  setCreateImportBranch,
  createBranches,
  lanes,
  onSubmit,
  busy,
  error,
  envInitProgress,
  laneCreated,
  templates,
  selectedTemplateId,
  setSelectedTemplateId,
  onNavigateToTemplates,
  importBranchWarning
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  createLaneName: string;
  setCreateLaneName: (v: string) => void;
  createMode: CreateLaneMode;
  setCreateMode: (v: CreateLaneMode) => void;
  createParentLaneId: string;
  setCreateParentLaneId: (v: string) => void;
  createBaseBranch: string;
  setCreateBaseBranch: (v: string) => void;
  createImportBranch: string;
  setCreateImportBranch: (v: string) => void;
  createBranches: LaneBranchOption[];
  lanes: LaneSummary[];
  onSubmit: () => void;
  busy?: boolean;
  error?: string | null;
  envInitProgress?: LaneEnvInitProgress | null;
  /** When true, the lane has already been created and the CTA only retries env setup. */
  laneCreated?: boolean;
  templates: LaneTemplate[];
  selectedTemplateId: string;
  setSelectedTemplateId: (id: string) => void;
  onNavigateToTemplates?: () => void;
  /** Warning shown below the import branch selector (e.g. uncommitted changes). */
  importBranchWarning?: string | null;
}) {
  const localBranches = createBranches.filter((b) => !b.isRemote);
  const allBranches = createBranches;
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;

  // When the lane already exists, the CTA only retries env setup — no form
  // validation needed beyond not being busy.
  const isSubmitDisabled = laneCreated
    ? !!busy
    : (busy
      || !createLaneName.trim()
      || (createMode === "child" && !createParentLaneId)
      || (createMode === "primary" && !createBaseBranch)
      || (createMode === "existing" && !createImportBranch));

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Create lane"
      icon={Plus}
      widthClassName="w-[min(560px,calc(100vw-24px))]"
      busy={busy}
    >
      <div className="space-y-3">
        {/* Lane name */}
        <section className={SECTION_CLASS_NAME}>
          <label className="block">
            <span className={LABEL_CLASS_NAME}>Lane name</span>
            <input
              value={createLaneName}
              onChange={(e) => setCreateLaneName(e.target.value)}
              placeholder="e.g. feature/auth-refresh"
              className={INPUT_CLASS_NAME}
              autoFocus
              disabled={busy || laneCreated}
            />
          </label>
        </section>

        {/* Starting point — mode picker + contextual field */}
        <section className={SECTION_CLASS_NAME}>
          <span className={LABEL_CLASS_NAME}>Starting point</span>

          {/* Compact pill tabs */}
          <div className="mt-2 inline-flex rounded-lg border border-white/[0.06] bg-white/[0.02] p-0.5">
            {(["primary", "existing", "child"] as const).map((mode) => {
              const meta = MODE_META[mode];
              const Icon = meta.icon;
              const active = createMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={active}
                  disabled={busy || laneCreated}
                  onClick={() => {
                    setCreateMode(mode);
                    if (mode !== "child") setCreateParentLaneId("");
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? "bg-accent/15 text-accent shadow-sm"
                      : "text-muted-fg hover:text-fg"
                  }`}
                >
                  <Icon size={12} />
                  {meta.label}
                </button>
              );
            })}
          </div>

          {/* Contextual field for selected mode */}
          <div className="mt-3">
            {createMode === "primary" ? (
              localBranches.length > 0 ? (
                <>
                  <select
                    value={createBaseBranch}
                    onChange={(e) => setCreateBaseBranch(e.target.value)}
                    className={SELECT_CLASS_NAME + " !mt-0"}
                    disabled={busy || laneCreated}
                    aria-label="Base branch"
                  >
                    {localBranches.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}{b.isCurrent ? " (current)" : ""}
                      </option>
                    ))}
                  </select>
                  {createBaseBranch ? (
                    <div className="mt-1.5 text-[11px] text-muted-fg/60">
                      Base: {createBaseBranch} — rebase suggestions will track this branch
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="rounded-lg border border-dashed border-white/[0.08] bg-black/10 px-3 py-2 text-xs text-muted-fg">
                  No local branches found.
                </div>
              )
            ) : null}

            {createMode === "existing" ? (
              allBranches.length > 0 ? (
                <>
                  <select
                    value={createImportBranch}
                    onChange={(e) => setCreateImportBranch(e.target.value)}
                    className={SELECT_CLASS_NAME + " !mt-0"}
                    disabled={busy || laneCreated}
                    aria-label="Import branch"
                    aria-describedby={importBranchWarning ? "import-branch-warning" : undefined}
                  >
                    <option value="">Select a branch\u2026</option>
                    {allBranches.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}{b.isRemote ? " (remote)" : ""}
                      </option>
                    ))}
                  </select>
                  {createImportBranch ? (
                    <div className="mt-1.5 text-[11px] text-muted-fg/60">
                      Base will be auto-detected from git history
                    </div>
                  ) : null}
                  {importBranchWarning ? (
                    <div
                      id="import-branch-warning"
                      role="alert"
                      aria-live="polite"
                      className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200"
                    >
                      <span className="mt-px shrink-0">⚠</span>
                      <span>{importBranchWarning}</span>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="rounded-lg border border-dashed border-white/[0.08] bg-black/10 px-3 py-2 text-xs text-muted-fg">
                  No branches found.
                </div>
              )
            ) : null}

            {createMode === "child" ? (
              <>
                <select
                  value={createParentLaneId}
                  onChange={(e) => setCreateParentLaneId(e.target.value)}
                  className={SELECT_CLASS_NAME + " !mt-0"}
                  disabled={busy || laneCreated}
                  aria-label="Parent lane"
                >
                  <option value="">Select parent lane\u2026</option>
                  {lanes.map((lane) => (
                    <option key={lane.id} value={lane.id}>
                      {lane.name} ({lane.branchRef})
                    </option>
                  ))}
                </select>
                {createParentLaneId ? (
                  <div className="mt-1.5 text-[11px] text-muted-fg/60">
                    Base: {lanes.find((l) => l.id === createParentLaneId)?.branchRef ?? "unknown"} — rebase suggestions will track parent lane
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </section>

        {/* Template — compact row, not a big section */}
        <section className={SECTION_CLASS_NAME}>
          <div className="flex items-center justify-between gap-3">
            <span className={LABEL_CLASS_NAME}>Template</span>
            {onNavigateToTemplates ? (
              <button
                type="button"
                className="text-[10px] font-medium text-muted-fg/60 transition-colors hover:text-accent"
                disabled={busy || laneCreated}
                onClick={() => { onOpenChange(false); onNavigateToTemplates(); }}
              >
                {templates.length > 0 ? "Manage" : "Create template"}
              </button>
            ) : null}
          </div>
          {templates.length > 0 ? (
            <>
              <select
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                className={SELECT_CLASS_NAME}
                disabled={busy || laneCreated}
                aria-label="Template"
              >
                <option value="">None</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}{t.description ? ` — ${t.description}` : ""}
                  </option>
                ))}
              </select>
              {selectedTemplate?.description ? (
                <div className="mt-1.5 text-[11px] text-muted-fg/60">{selectedTemplate.description}</div>
              ) : null}
            </>
          ) : (
            <div className="mt-2 text-xs text-muted-fg/50">
              No templates yet.
            </div>
          )}
        </section>

        {error ? (
          <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              onOpenChange(false);
              setCreateLaneName("");
              setCreateParentLaneId("");
              setCreateMode("primary");
              setCreateBaseBranch("");
              setCreateImportBranch("");
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" disabled={isSubmitDisabled} onClick={onSubmit}>
            {submitLabel(busy, createMode, createBaseBranch, laneCreated)}
          </Button>
        </div>

        {envInitProgress ? <LaneEnvInitProgressPanel progress={envInitProgress} /> : null}
      </div>
    </LaneDialogShell>
  );
}
