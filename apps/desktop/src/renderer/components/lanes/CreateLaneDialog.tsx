import React from "react";
import { CaretDown, CaretRight, GitBranch, GitFork, Plus, StackSimple, Tag } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import type { BranchPullRequest, LaneSummary, LaneEnvInitProgress, LaneTemplate } from "../../../shared/types";
import type { LaneBranchOption } from "./laneUtils";
import { LaneEnvInitProgressPanel } from "./LaneEnvInitProgress";
import { LaneDialogShell } from "./LaneDialogShell";
import { LaneColorPicker } from "./LaneColorPicker";
import { colorsInUse, nextAvailableColor } from "./laneColorPalette";
import { BranchPickerView } from "./BranchPickerView";
import { formatRelativeTime } from "./branchPickerSearch";
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
  if (busy) return "Setting up lane…";
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
  importBranchWarning,
  selectedColor,
  setSelectedColor,
  branchPullRequests,
  currentGitUserName,
  loadingBranches,
  loadingBranchPullRequests,
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
  selectedColor: string | null;
  setSelectedColor: (c: string | null) => void;
  /** Open PRs in the project's GitHub repo, keyed by head branch. */
  branchPullRequests?: BranchPullRequest[];
  /** Local git user.name — used by the picker to resolve `mine` / `author:me`. */
  currentGitUserName?: string;
  loadingBranches?: boolean;
  loadingBranchPullRequests?: boolean;
}) {
  const localBranches = createBranches.filter((b) => !b.isRemote);
  const allBranches = createBranches;
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;
  const usedColors = React.useMemo(() => colorsInUse(lanes), [lanes]);

  const [pickerOpen, setPickerOpen] = React.useState(false);

  React.useEffect(() => {
    if (!open) setPickerOpen(false);
  }, [open]);

  React.useEffect(() => {
    if (createMode !== "existing") setPickerOpen(false);
  }, [createMode]);

  const prByBranch = React.useMemo(() => {
    const map = new Map<string, BranchPullRequest>();
    for (const pr of branchPullRequests ?? []) map.set(pr.branch, pr);
    return map;
  }, [branchPullRequests]);

  const selectedBranchMeta = React.useMemo<{
    branch: LaneBranchOption | null;
    pr: BranchPullRequest | null;
  }>(() => {
    const branch = createBranches.find((b) => b.name === createImportBranch) ?? null;
    if (!branch) return { branch: null, pr: null };
    const localName = branch.isRemote ? branch.name.replace(/^[^/]+\//, "") : branch.name;
    const pr = prByBranch.get(branch.name) ?? prByBranch.get(localName) ?? null;
    return { branch, pr };
  }, [createBranches, createImportBranch, prByBranch]);

  let branchPickerPlaceholder: string;
  if (loadingBranches) branchPickerPlaceholder = "Loading branches…";
  else if (allBranches.length === 0) branchPickerPlaceholder = "No branches found";
  else branchPickerPlaceholder = "Pick a branch…";

  React.useEffect(() => {
    if (open && selectedColor === null) {
      const next = nextAvailableColor(lanes);
      if (next) setSelectedColor(next);
    }
  }, [open, lanes, selectedColor, setSelectedColor]);

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
      title={pickerOpen ? "Pick branch" : "Create lane"}
      description={pickerOpen
        ? "Search by name, PR, author, or staleness."
        : "Create a lane from Primary, an existing branch, or another lane."}
      icon={Plus}
      widthClassName="w-[min(560px,calc(100vw-24px))]"
      busy={busy}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        const target = document.querySelector<HTMLElement>(
          '[data-tour="lanes.laneTab"], [data-tour="lanes.newLane"]',
        );
        target?.focus?.();
      }}
    >
      {pickerOpen ? (
        <BranchPickerView
          branches={createBranches}
          pullRequests={branchPullRequests ?? []}
          currentUserName={currentGitUserName ?? ""}
          selectedBranch={createImportBranch}
          onSelect={(name) => setCreateImportBranch(name)}
          onConfirm={() => setPickerOpen(false)}
          onBack={() => setPickerOpen(false)}
          busy={busy || laneCreated}
          loadingBranches={loadingBranches}
          loadingPullRequests={loadingBranchPullRequests}
        />
      ) : (
      <div className="space-y-3" data-tour="lanes.createDialog">
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
              data-tour="lanes.createDialog.name"
            />
          </label>
          <div className="mt-3">
            <span className={LABEL_CLASS_NAME}>Color</span>
            <div className="mt-2">
              <LaneColorPicker
                value={selectedColor}
                onChange={setSelectedColor}
                usedColors={usedColors}
                swatchSize={20}
              />
            </div>
          </div>
        </section>

        {/* Start from — three-up source cards + contextual field */}
        <section className={SECTION_CLASS_NAME}>
          <span className={LABEL_CLASS_NAME}>Start from</span>

          <div className="mt-2 grid grid-cols-3 gap-2" data-tour="lanes.createDialog.tabs">
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
                  {...(mode === "primary"
                    ? { "data-tour": "lanes.createDialog.primaryTab" }
                    : mode === "existing"
                      ? { "data-tour": "lanes.createDialog.branchTab" }
                      : { "data-tour": "lanes.createDialog.childTab" })}
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
                    data-tour="lanes.createDialog.branchBase"
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
              <>
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  disabled={busy || laneCreated || (loadingBranches && allBranches.length === 0)}
                  className="flex w-full items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-left transition-colors hover:border-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
                  aria-label="Choose import branch"
                  aria-describedby={importBranchWarning ? "import-branch-warning" : undefined}
                  data-tour="lanes.createDialog.branchPickerOpen"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-400/15 text-sky-300">
                    <GitBranch size={14} weight="duotone" />
                  </span>
                  <span className="min-w-0 flex-1">
                    {selectedBranchMeta.branch ? (
                      <>
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-fg">
                            {selectedBranchMeta.branch.name}
                          </span>
                          {selectedBranchMeta.branch.isRemote ? (
                            <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-fg">
                              remote
                            </span>
                          ) : null}
                          {selectedBranchMeta.pr ? (
                            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-400/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                              <Tag size={10} weight="fill" />
                              #{selectedBranchMeta.pr.prNumber}
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-fg/70">
                          {[
                            selectedBranchMeta.branch.lastCommitAuthor,
                            formatRelativeTime(selectedBranchMeta.branch.lastCommitDate),
                          ]
                            .filter(Boolean)
                            .join(" · ") || "Imported as a root lane"}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="text-sm text-muted-fg">{branchPickerPlaceholder}</span>
                        <span className="mt-0.5 block text-[11px] text-muted-fg/60">
                          Search by name, PR, author, or staleness
                        </span>
                      </>
                    )}
                  </span>
                  <CaretRight size={14} className="shrink-0 text-muted-fg/50" />
                </button>
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
                  <option value="">Select parent lane…</option>
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
              setSelectedColor(null);
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" data-tour="lanes.createDialog.create" disabled={isSubmitDisabled} onClick={onSubmit}>
            {submitLabel(busy, createMode, createBaseBranch, laneCreated)}
          </Button>
        </div>

        {envInitProgress ? <LaneEnvInitProgressPanel progress={envInitProgress} /> : null}
      </div>
      )}
    </LaneDialogShell>
  );
}
