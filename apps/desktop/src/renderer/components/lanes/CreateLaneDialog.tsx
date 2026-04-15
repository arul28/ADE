import { CaretDown, GitBranch, GitFork, Plus, StackSimple } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import type { LaneSummary, LaneEnvInitProgress, LaneTemplate } from "../../../shared/types";
import type { LaneBranchOption } from "./laneUtils";
import { LaneEnvInitProgressPanel } from "./LaneEnvInitProgress";
import { LaneDialogShell } from "./LaneDialogShell";
import {
  SECTION_CLASS_NAME,
  LABEL_CLASS_NAME,
  INPUT_CLASS_NAME,
  SELECT_CLASS_NAME,
  CARD_CLASS_NAME,
  CARD_ACTIVE_CLASS_NAME,
  CHIP_PRIMARY,
  CHIP_BRANCH,
  CHIP_CHILD,
} from "./laneDialogTokens";

export type CreateLaneMode = "primary" | "existing" | "child";

type ModeMeta = {
  icon: typeof GitBranch;
  label: string;
  description: string;
  chip: string;
};

const MODE_META: Record<CreateLaneMode, ModeMeta> = {
  primary: {
    icon: GitBranch,
    label: "Primary",
    description: "Brand new lane based off main on the primary lane",
    chip: CHIP_PRIMARY,
  },
  existing: {
    icon: GitFork,
    label: "Branch",
    description: "New lane based off a branch on local or remote",
    chip: CHIP_BRANCH,
  },
  child: {
    icon: StackSimple,
    label: "Child",
    description: "Create a child lane based on another existing lane",
    chip: CHIP_CHILD,
  },
};

const MODE_ORDER: readonly CreateLaneMode[] = ["primary", "existing", "child"];

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
  createChildBaseBranch,
  setCreateChildBaseBranch,
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
  createChildBaseBranch: string;
  setCreateChildBaseBranch: (v: string) => void;
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

  const isSubmitDisabled = laneCreated
    ? !!busy
    : (busy
      || !createLaneName.trim()
      || (createMode === "child" && !createParentLaneId)
      || (createMode === "primary" && !createBaseBranch)
      || (createMode === "existing" && !createImportBranch));

  const hasAdvanced = templates.length > 0 || !!onNavigateToTemplates;

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

        {/* Start from — three-up source cards + contextual field */}
        <section className={SECTION_CLASS_NAME}>
          <span className={LABEL_CLASS_NAME}>Start from</span>

          <div className="mt-2 grid grid-cols-3 gap-2">
            {MODE_ORDER.map((mode) => {
              const meta = MODE_META[mode];
              const Icon = meta.icon;
              const active = createMode === mode;
              const cardClass = active
                ? `${CARD_CLASS_NAME} ${CARD_ACTIVE_CLASS_NAME}`
                : CARD_CLASS_NAME;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={active}
                  disabled={busy || laneCreated}
                  onClick={() => {
                    setCreateMode(mode);
                    if (mode !== "child") {
                      setCreateParentLaneId("");
                      setCreateChildBaseBranch("");
                    }
                  }}
                  className={cardClass}
                >
                  <div className="flex items-start gap-2">
                    <span className={meta.chip} aria-hidden="true">
                      <Icon size={16} weight="duotone" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-fg">{meta.label}</div>
                    </div>
                  </div>
                  <div className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-muted-fg/70">
                    {meta.description}
                  </div>
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
                      Imported as a root lane
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

                {allBranches.length > 0 ? (
                  <div className="mt-3">
                    <span className={LABEL_CLASS_NAME}>Base branch (optional)</span>
                    <select
                      value={createChildBaseBranch}
                      onChange={(e) => setCreateChildBaseBranch(e.target.value)}
                      className={SELECT_CLASS_NAME}
                      disabled={busy || laneCreated}
                      aria-label="Child base branch override"
                    >
                      <option value="">Parent lane's branch (default)</option>
                      {allBranches.map((b) => (
                        <option key={b.name} value={b.name}>
                          {b.name}{b.isRemote ? " (remote)" : ""}
                        </option>
                      ))}
                    </select>
                    <div className="mt-1.5 text-[11px] text-muted-fg/60">
                      Override to base this child on any branch, including origin/* remote refs.
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </section>

        {/* Advanced — template (collapsed by default) */}
        {hasAdvanced ? (
          <details className="group rounded-xl border border-white/[0.06] bg-white/[0.02] open:bg-white/[0.03]">
            <summary className="flex cursor-pointer select-none items-center justify-between gap-3 rounded-xl px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-fg/70 transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-2">
                <CaretDown size={10} weight="bold" className="transition-transform group-open:rotate-0 -rotate-90" />
                Advanced
              </span>
              {onNavigateToTemplates ? (
                <button
                  type="button"
                  className="text-[10px] font-medium normal-case tracking-normal text-muted-fg/60 transition-colors hover:text-accent"
                  disabled={busy || laneCreated}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenChange(false);
                    onNavigateToTemplates();
                  }}
                >
                  {templates.length > 0 ? "Manage templates" : "Create template"}
                </button>
              ) : null}
            </summary>
            <div className="space-y-3 px-4 pb-4 pt-1">
              <div>
                <span className={LABEL_CLASS_NAME}>Template</span>
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
              </div>
            </div>
          </details>
        ) : null}

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
              setCreateChildBaseBranch("");
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
