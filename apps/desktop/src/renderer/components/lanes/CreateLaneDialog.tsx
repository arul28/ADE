import React from "react";
import { CaretDown, CaretRight, CheckCircle, Circle, GitBranch, GitFork, Plus, SpinnerGap, StackSimple, Tag, X } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import type {
  BranchPullRequest,
  LaneLinearIssue,
  LaneSummary,
  LaneEnvInitProgress,
  LaneTemplate,
  NewLaneBaseSource,
} from "../../../shared/types";
import type { LaneBranchOption } from "./laneUtils";
import { LaneEnvInitProgressPanel } from "./LaneEnvInitProgress";
import { LaneDialogShell } from "./LaneDialogShell";
import { LaneColorPicker } from "./LaneColorPicker";
import { colorsInUse, nextAvailableColor } from "./laneColorPalette";
import { BranchPickerView } from "./BranchPickerView";
import { formatRelativeTime } from "./branchPickerSearch";
import { linearIssueBranchName, linearIssueLaneName } from "../../../shared/linearIssueBranch";
import { branchExistsForLinearIssue, issueProjectLabel } from "./linearIssueDisplay";
import { LinearMark, LinearPriorityIcon, LinearStateIcon, LINEAR_BRAND } from "./linearBrand";
import { LinearIssueSelectModal } from "../app/LinearIssueSelectModal";
import { listNewLaneBaseOptions } from "./newLaneBaseSource";
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
export type CreateLaneSetupStep = {
  label: string;
  detail: string;
  state: "pending" | "active" | "done";
};

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

function defaultLaneNameForImportBranch(branchName: string, branches: LaneBranchOption[]): string {
  const branch = branches.find((candidate) => candidate.name === branchName);
  if (branch?.isRemote) return branch.name.replace(/^[^/]+\//, "");
  return branchName;
}

function submitLabel(
  busy: boolean | undefined,
  mode: CreateLaneMode,
  baseBranch: string,
  laneCreated: boolean | undefined,
): string {
  if (busy) return "Setting up lane…";
  if (laneCreated) return "Retry setup";
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
  createBaseSource,
  setCreateBaseSource,
  createBaseBranch,
  setCreateBaseBranch,
  createImportBranch,
  setCreateImportBranch,
  createChildBaseBranch,
  setCreateChildBaseBranch,
  projectRoot,
  createBranches,
  lanes,
  onSubmit,
  busy,
  error,
  envInitProgress,
  laneCreated,
  setupStatus,
  setupSteps = [],
  templates,
  selectedTemplateId,
  setSelectedTemplateId,
  onNavigateToTemplates,
  onOpenLinearSettings,
  importBranchWarning,
  selectedColor,
  setSelectedColor,
  selectedLinearIssue,
  setSelectedLinearIssue,
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
  createBaseSource: NewLaneBaseSource;
  setCreateBaseSource: (v: NewLaneBaseSource) => void;
  createBaseBranch: string;
  setCreateBaseBranch: (v: string) => void;
  createImportBranch: string;
  setCreateImportBranch: (v: string) => void;
  createChildBaseBranch: string;
  setCreateChildBaseBranch: (v: string) => void;
  /** Project scope for shared Linear issue browser cache/filter persistence. */
  projectRoot?: string | null;
  createBranches: LaneBranchOption[];
  lanes: LaneSummary[];
  onSubmit: () => void;
  busy?: boolean;
  error?: string | null;
  envInitProgress?: LaneEnvInitProgress | null;
  /** When true, the lane has already been created and the CTA only retries env setup. */
  laneCreated?: boolean;
  setupStatus?: string | null;
  setupSteps?: CreateLaneSetupStep[];
  templates: LaneTemplate[];
  selectedTemplateId: string;
  setSelectedTemplateId: (id: string) => void;
  onNavigateToTemplates?: () => void;
  onOpenLinearSettings?: () => void;
  /** Warning shown below the import branch selector (e.g. uncommitted changes). */
  importBranchWarning?: string | null;
  selectedColor: string | null;
  setSelectedColor: (c: string | null) => void;
  selectedLinearIssue: LaneLinearIssue | null;
  setSelectedLinearIssue: (issue: LaneLinearIssue | null) => void;
  /** Open PRs in the project's GitHub repo, keyed by head branch. */
  branchPullRequests?: BranchPullRequest[];
  /** Local git user.name — used by the picker to resolve `mine` / `author:me`. */
  currentGitUserName?: string;
  loadingBranches?: boolean;
  loadingBranchPullRequests?: boolean;
}) {
  const baseBranchOptions = React.useMemo(
    () => listNewLaneBaseOptions(createBranches, createBaseSource),
    [createBaseSource, createBranches],
  );
  const selectedBaseBranchValid = React.useMemo(
    () => !!createBaseBranch && baseBranchOptions.some((option) => option.ref === createBaseBranch),
    [baseBranchOptions, createBaseBranch],
  );
  const allBranches = createBranches;
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;
  const usedColors = React.useMemo(() => colorsInUse(lanes), [lanes]);
  const usedColorOwners = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const candidate of lanes) {
      if (candidate.archivedAt || !candidate.color) continue;
      map.set(candidate.color.toLowerCase(), candidate.name);
    }
    return map;
  }, [lanes]);

  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [issuePickerOpen, setIssuePickerOpen] = React.useState(false);
  const importBranchAutoNameRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setPickerOpen(false);
      setIssuePickerOpen(false);
      importBranchAutoNameRef.current = null;
    }
  }, [open]);

  React.useEffect(() => {
    if (createMode !== "existing") setPickerOpen(false);
  }, [createMode]);

  React.useEffect(() => {
    if (selectedLinearIssue && createMode === "existing") {
      setCreateMode("primary");
      setCreateImportBranch("");
    }
  }, [createMode, selectedLinearIssue, setCreateImportBranch, setCreateMode]);

  const handleSetCreateLaneName = React.useCallback((value: string) => {
    importBranchAutoNameRef.current = null;
    setCreateLaneName(value);
  }, [setCreateLaneName]);

  const handleSelectImportBranch = React.useCallback((branchName: string) => {
    setCreateImportBranch(branchName);

    const nextName = defaultLaneNameForImportBranch(branchName, createBranches);
    const previousAutoName = importBranchAutoNameRef.current;
    const trimmedCurrentName = createLaneName.trim();
    if (!trimmedCurrentName || (previousAutoName && trimmedCurrentName === previousAutoName)) {
      importBranchAutoNameRef.current = nextName;
      setCreateLaneName(nextName);
      return;
    }

    importBranchAutoNameRef.current = null;
  }, [createBranches, createLaneName, setCreateImportBranch, setCreateLaneName]);

  React.useEffect(() => {
    if (!selectedLinearIssue) return;
    const previousAutoName = importBranchAutoNameRef.current;
    if (previousAutoName && createLaneName.trim() === previousAutoName) {
      setCreateLaneName(linearIssueLaneName(selectedLinearIssue));
    }
    importBranchAutoNameRef.current = null;
  }, [createLaneName, selectedLinearIssue, setCreateLaneName]);

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

  const selectedLinearBranchName = selectedLinearIssue ? linearIssueBranchName(selectedLinearIssue) : "";
  const selectedLinearBranchConflict = selectedLinearIssue
    ? branchExistsForLinearIssue(selectedLinearBranchName, createBranches)
    : false;
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
      || (createMode === "primary" && (!selectedBaseBranchValid || loadingBranches))
      || (createMode === "existing" && !createImportBranch)
      || selectedLinearBranchConflict);

  return (
    <>
    <LaneDialogShell
      open={open && !issuePickerOpen}
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
      footer={pickerOpen ? undefined : (
        <div className="space-y-3">
          {error ? (
            <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button variant="primary" data-tour="lanes.createDialog.create" disabled={isSubmitDisabled} onClick={onSubmit}>
              {submitLabel(busy, createMode, createBaseBranch, laneCreated)}
            </Button>
          </div>
        </div>
      )}
    >
      {pickerOpen ? (
        <BranchPickerView
          branches={createBranches}
          pullRequests={branchPullRequests ?? []}
          currentUserName={currentGitUserName ?? ""}
          selectedBranch={createImportBranch}
          onSelect={handleSelectImportBranch}
          onConfirm={() => setPickerOpen(false)}
          onBack={() => setPickerOpen(false)}
          busy={busy || laneCreated}
          loadingBranches={loadingBranches}
          loadingPullRequests={loadingBranchPullRequests}
        />
      ) : (
      <div className="min-h-full space-y-3" data-tour="lanes.createDialog">
        {/* Lane name */}
        <section className={SECTION_CLASS_NAME}>
          <label className="block">
            <span className={LABEL_CLASS_NAME}>Lane name</span>
            <input
              value={createLaneName}
              onChange={(e) => handleSetCreateLaneName(e.target.value)}
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
                usedColorOwners={usedColorOwners}
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
              const disabledByLinearIssue = Boolean(selectedLinearIssue && mode === "existing");
              const disabled = Boolean(busy || laneCreated || disabledByLinearIssue);
              const cardClass = active
                ? `${CARD_CLASS_NAME} ${CARD_ACTIVE_CLASS_NAME}`
                : CARD_CLASS_NAME;
              let disabledTitle: string | undefined;
              let disabledDescription: string | null = null;
              if (disabledByLinearIssue) {
                disabledTitle = "Detach the Linear issue before importing an existing branch.";
                disabledDescription = "Unavailable while a Linear issue is connected";
              }
              const dataTourByMode: Record<CreateLaneMode, string> = {
                primary: "lanes.createDialog.primaryTab",
                existing: "lanes.createDialog.branchTab",
                child: "lanes.createDialog.childTab",
              };
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={active}
                  disabled={disabled}
                  title={disabledTitle}
                  data-tour={dataTourByMode[mode]}
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
                    {disabledDescription ?? meta.description}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Contextual field for selected mode */}
          <div className="mt-3">
            {createMode === "primary" ? (
              <>
                <div className="mb-2 grid grid-cols-2 gap-2">
                  {(["remote", "local"] as const).map((source) => {
                    const active = createBaseSource === source;
                    return (
                      <button
                        key={source}
                        type="button"
                        className={`${CARD_CLASS_NAME} ${active ? CARD_ACTIVE_CLASS_NAME : ""} !p-2 text-left`}
                        disabled={busy || laneCreated}
                        onClick={() => setCreateBaseSource(source)}
                      >
                        <div className="text-xs font-semibold text-fg">{source === "remote" ? "Remote" : "Local"}</div>
                        <div className="mt-0.5 text-[10px] text-muted-fg/70">
                          {source === "remote" ? "Use fetched upstream" : "Use your local branch tip"}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {baseBranchOptions.length > 0 ? (
                  <>
                    <select
                      value={createBaseBranch}
                      onChange={(e) => setCreateBaseBranch(e.target.value)}
                      className={SELECT_CLASS_NAME + " !mt-0"}
                      disabled={busy || laneCreated}
                      aria-label="Base branch"
                      data-tour="lanes.createDialog.branchBase"
                    >
                      {baseBranchOptions.map((option) => (
                        <option key={option.ref} value={option.ref}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {createBaseBranch ? (
                      <div className="mt-1.5 text-[11px] text-muted-fg/60">
                        Base: {createBaseBranch} — rebase suggestions will track this ref
                      </div>
                    ) : null}
                  </>
                ) : loadingBranches ? (
                  <div className="rounded-lg border border-dashed border-white/[0.08] bg-black/10 px-3 py-2 text-xs text-muted-fg">
                    Loading branches...
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-white/[0.08] bg-black/10 px-3 py-2 text-xs text-muted-fg">
                    No {createBaseSource === "remote" ? "remote-tracking refs" : "local branches"} found.
                  </div>
                )}
              </>
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

        {/* Advanced — Linear issue + template */}
        <details open className="group rounded-xl border border-white/[0.06] bg-white/[0.02] open:bg-white/[0.03]">
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
              <span className={LABEL_CLASS_NAME}>Linear issue</span>
              {selectedLinearIssue ? (
                <>
                  <SelectedLinearIssueCard
                    issue={selectedLinearIssue}
                    branchName={selectedLinearBranchName}
                    branchConflict={selectedLinearBranchConflict}
                    onClear={() => setSelectedLinearIssue(null)}
                  />
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      disabled={busy || laneCreated}
                      onClick={() => setIssuePickerOpen(true)}
                      className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors disabled:opacity-50"
                      style={{
                        borderColor: LINEAR_BRAND.borderSubtle,
                        background: LINEAR_BRAND.surface,
                        color: LINEAR_BRAND.text,
                      }}
                    >
                      <LinearMark size={11} />
                      Change issue
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setIssuePickerOpen(true)}
                  disabled={busy || laneCreated}
                  className="mt-2 flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  style={{
                    borderColor: LINEAR_BRAND.borderSubtle,
                    background: LINEAR_BRAND.surface,
                  }}
                >
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
                    style={{ background: LINEAR_BRAND.surfaceHover, color: LINEAR_BRAND.primaryBright }}
                  >
                    <LinearMark size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-fg">Connect a Linear issue</span>
                    <span className="mt-0.5 block text-[11px] text-muted-fg/65">
                      Auto-names the branch and links the lane to your ticket.
                    </span>
                  </span>
                  <CaretRight size={14} className="shrink-0" style={{ color: LINEAR_BRAND.textMuted }} />
                </button>
              )}
            </div>
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

        {setupStatus || setupSteps.length > 0 ? (
          <section
            className="rounded-xl border px-3 py-3"
            style={{
              background: "rgba(124, 92, 255, 0.08)",
              borderColor: "rgba(167, 139, 250, 0.22)",
            }}
          >
            {setupStatus ? (
              <div className="text-sm font-medium text-zinc-100">{setupStatus}</div>
            ) : null}
            {setupSteps.length > 0 ? (
              <div className="mt-2 space-y-2">
                {setupSteps.map((step) => {
                  const icon = step.state === "done"
                    ? <CheckCircle size={15} weight="fill" className="text-emerald-300" />
                    : step.state === "active"
                      ? <SpinnerGap size={15} className="animate-spin text-violet-200" />
                      : <Circle size={15} className="text-zinc-500" />;
                  return (
                    <div key={step.label} className="flex items-start gap-2 text-xs">
                      <span className="mt-0.5 shrink-0">{icon}</span>
                      <div className="min-w-0">
                        <div className={step.state === "pending" ? "text-zinc-400" : "text-zinc-100"}>{step.label}</div>
                        <div className="mt-0.5 text-[11px] text-zinc-500">{step.detail}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
        ) : null}

        {envInitProgress ? <LaneEnvInitProgressPanel progress={envInitProgress} /> : null}
      </div>
      )}
    </LaneDialogShell>
    <LinearIssueSelectModal
      open={issuePickerOpen}
      ariaLabel="Connect Linear issue"
      projectRoot={projectRoot}
      selectedIssue={selectedLinearIssue}
      actionLabel="Connect issue"
      actionBusyLabel="Connecting issue"
      actionDisabled={busy || laneCreated}
      onOpenChange={setIssuePickerOpen}
      onSelectIssue={setSelectedLinearIssue}
      onOpenLinearSettings={onOpenLinearSettings}
    />
    </>
  );
}

function SelectedLinearIssueCard({
  issue,
  branchName,
  branchConflict,
  onClear,
}: {
  issue: LaneLinearIssue;
  branchName: string;
  branchConflict: boolean;
  onClear: () => void;
}) {
  return (
    <div
      className="mt-2 rounded-lg border p-3"
      style={{ borderColor: LINEAR_BRAND.borderSubtle, background: LINEAR_BRAND.surface }}
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          style={{ background: LINEAR_BRAND.surfaceHover, color: LINEAR_BRAND.primaryBright }}
        >
          <LinearMark size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <LinearPriorityIcon priority={issue.priority} size={12} />
            <LinearStateIcon stateType={issue.stateType} size={12} />
            <span
              className="shrink-0 rounded font-mono text-[10.5px] font-semibold"
              style={{ color: LINEAR_BRAND.text, background: LINEAR_BRAND.surfaceHover, padding: "1.5px 5px" }}
            >
              {issue.identifier}
            </span>
            <span className="truncate text-sm font-semibold text-fg">{issue.title}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-fg/65">
            <span>{issueProjectLabel(issue)}</span>
            <span className="opacity-40">·</span>
            <span>{issue.stateName}</span>
            {issue.assigneeName ? (
              <>
                <span className="opacity-40">·</span>
                <span>{issue.assigneeName}</span>
              </>
            ) : null}
          </div>
          <div
            className="mt-2 flex min-w-0 items-center gap-1.5 font-mono text-[10.5px]"
            style={{ color: branchConflict ? "#FBBF24" : "rgba(148, 163, 184, 0.85)" }}
          >
            <span className="shrink-0 opacity-60">branch</span>
            <span className="truncate text-fg/85">{branchName}</span>
            {branchConflict ? <span className="shrink-0 opacity-80">already exists</span> : null}
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1 text-muted-fg/60 transition-colors hover:bg-white/[0.06] hover:text-fg"
          onClick={onClear}
          aria-label="Disconnect Linear issue"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
