import React from "react";
import {
  ArrowSquareIn,
  Info,
  CaretUpDown,
  CheckCircle,
  Circle,
  GitBranch,
  Palette,
  SpinnerGap,
  StackSimple,
  X,
} from "@phosphor-icons/react";
import { Banner } from "../ui/notice/Banner";
import type {
  BranchPullRequest,
  LaneLinearIssue,
  LaneSummary,
  LaneEnvInitProgress,
  LaneTemplate,
  NewLaneBaseSource,
} from "../../../shared/types";
import { refOnlyBranch, stripRemotePrefix, type LaneBranchOption } from "./laneUtils";
import { LaneEnvInitProgressPanel } from "./LaneEnvInitProgress";
import { LaneDialogShell } from "./LaneDialogShell";
import { LaneColorPicker } from "./LaneColorPicker";
import { LaneEmojiPicker } from "./LaneEmojiPicker";
import { colorsInUse, laneColorName, nextAvailableColor } from "./laneColorPalette";
import { LaneBranchList, type LaneBranchListItem } from "./LaneBranchList";
import { SmartTooltip } from "../ui/SmartTooltip";
import { findBranchPullRequest, formatRelativeTime, indexPullRequestsByBranch } from "./branchPickerSearch";
import { linearIssueLaneName, resolveLinearIssueBranchName } from "../../../shared/linearIssueBranch";
import { branchExistsForLinearIssue } from "./linearIssueDisplay";
import { LinearMark } from "./linearBrand";
import { LinearIssueSelectModal } from "../app/LinearIssueSelectModal";
import { listNewLaneBaseOptions, selectDefaultNewLaneBaseRef } from "./newLaneBaseSource";
import { isMacPlatform, modifierKeyLabel } from "../../lib/platform";
import type { LaneMachineOption } from "./laneMachines";
import { ComposerPopover, LaneMachineChip, LaneTemplateChip } from "./createLaneComposerChips";
import "./createLaneComposer.css";
import { isImeComposing } from "../../lib/imeComposition";

export type CreateLaneMode = "primary" | "existing" | "child";
export type CreateLaneSetupStep = {
  label: string;
  detail: string;
  state: "pending" | "active" | "done";
};

const MODE_LABEL: Record<CreateLaneMode, string> = {
  primary: "As new branch",
  existing: "As existing branch",
  child: "As child lane",
};

const MODE_HELP: Record<CreateLaneMode, string> = {
  primary: "Creates a fresh branch for this lane, starting from any remote or local branch you pick.",
  existing: "Opens a branch that already exists as a lane. The lane works on that branch directly; no new branch is made.",
  child: "Creates a new branch stacked on another lane. The child rebases when its parent moves.",
};

const MODE_ICON: Record<CreateLaneMode, typeof GitBranch> = {
  primary: GitBranch,
  existing: ArrowSquareIn,
  child: StackSimple,
};

const MODE_TOUR: Record<CreateLaneMode, string> = {
  primary: "lanes.createDialog.primaryTab",
  existing: "lanes.createDialog.branchTab",
  child: "lanes.createDialog.childTab",
};

const MODE_ORDER: readonly CreateLaneMode[] = ["primary", "existing", "child"];

function defaultLaneNameForImportBranch(branchName: string, branches: LaneBranchOption[]): string {
  const branch = branches.find((candidate) => candidate.name === branchName);
  if (branch?.isRemote) return stripRemotePrefix(branch.name);
  return branchName;
}

function submitLabel(
  busy: boolean | undefined,
  mode: CreateLaneMode,
  laneCreated: boolean | undefined,
): string {
  if (busy) return "Setting up…";
  if (laneCreated) return "Retry setup";
  if (mode === "existing") return "Import branch";
  if (mode === "child") return "Create child lane";
  return "Create lane";
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
  onCancelBusy,
  error,
  envInitProgress,
  laneCreated,
  setupStatus,
  setupSteps = [],
  submitLabelOverride,
  templates,
  selectedTemplateId,
  setSelectedTemplateId,
  onNavigateToTemplates,
  onOpenLinearSettings,
  importBranchWarning,
  selectedColor,
  setSelectedColor,
  selectedEmoji,
  setSelectedEmoji,
  suggestedEmoji,
  onAcceptSuggestedEmoji,
  showEmojiControl = true,
  selectedLinearIssue,
  setSelectedLinearIssue,
  branchPullRequests,
  currentGitUserName,
  loadingBranches,
  machines,
  selectedMachineId,
  onSelectMachine,
  onConnectMachine,
  machineRequired = false,
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
  /** Set while busy work can be stopped; the Cancel button then stops it instead of staying disabled. */
  onCancelBusy?: () => void;
  error?: string | null;
  envInitProgress?: LaneEnvInitProgress | null;
  /** When true, the lane has already been created and the CTA only retries env setup. */
  laneCreated?: boolean;
  setupStatus?: string | null;
  setupSteps?: CreateLaneSetupStep[];
  /** Overrides the primary CTA label (e.g. "Use this setup" when configuring a draft). */
  submitLabelOverride?: string | null;
  templates: LaneTemplate[];
  selectedTemplateId: string;
  setSelectedTemplateId: (id: string) => void;
  onNavigateToTemplates?: () => void;
  onOpenLinearSettings?: () => void;
  /** Warning shown below the import branch selector (e.g. uncommitted changes). */
  importBranchWarning?: string | null;
  selectedColor: string | null;
  setSelectedColor: (c: string | null) => void;
  selectedEmoji: string | null;
  setSelectedEmoji: (emoji: string | null) => void;
  suggestedEmoji?: string | null;
  onAcceptSuggestedEmoji?: () => void;
  showEmojiControl?: boolean;
  selectedLinearIssue: LaneLinearIssue | null;
  setSelectedLinearIssue: (issue: LaneLinearIssue | null) => void;
  /** Open PRs in the project's GitHub repo, keyed by head branch. */
  branchPullRequests?: BranchPullRequest[];
  /** Local git user.name — used by the picker to resolve `mine` / `author:me`. */
  currentGitUserName?: string;
  loadingBranches?: boolean;
  /**
   * Connected machines a lane can be created on. A lane owns its machine, so
   * this is the only place one is picked. Rendered only when there is more than
   * one machine to choose from; a single-machine setup shows no selector.
   */
  machines?: LaneMachineOption[];
  /** "" (or omitted) while no machine is chosen. Never defaulted here. */
  selectedMachineId?: string;
  onSelectMachine?: (machineId: string) => void;
  onConnectMachine?: () => void;
  /**
   * The lane is really created, so the machine must be chosen before submit.
   * The host pre-selects the only eligible machine; otherwise the user picks.
   */
  machineRequired?: boolean;
}) {
  const baseBranchOptions = React.useMemo(
    () => listNewLaneBaseOptions(createBranches, createBaseSource),
    [createBaseSource, createBranches],
  );
  const selectedBaseBranchValid = React.useMemo(
    () => !!createBaseBranch && baseBranchOptions.some((option) => option.ref === createBaseBranch),
    [baseBranchOptions, createBaseBranch],
  );
  const usedColors = React.useMemo(() => colorsInUse(lanes), [lanes]);
  const usedColorOwners = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const candidate of lanes) {
      if (candidate.archivedAt || !candidate.color) continue;
      map.set(candidate.color.toLowerCase(), candidate.name);
    }
    return map;
  }, [lanes]);

  // One machine: no selector, no extra chrome.
  const machineOptions = machines ?? [];
  const showMachineSelector = machineOptions.length > 1 && !!onSelectMachine;

  const [issuePickerOpen, setIssuePickerOpen] = React.useState(false);
  const importBranchAutoNameRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setIssuePickerOpen(false);
      importBranchAutoNameRef.current = null;
    }
  }, [open]);

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

  const prByBranch = React.useMemo(() => indexPullRequestsByBranch(branchPullRequests), [branchPullRequests]);

  const selectedBranchMeta = React.useMemo<{
    branch: LaneBranchOption | null;
    pr: BranchPullRequest | null;
  }>(() => {
    const branch = createBranches.find((b) => b.name === createImportBranch) ?? null;
    if (!branch) return { branch: null, pr: null };
    return { branch, pr: findBranchPullRequest(prByBranch, branch) };
  }, [createBranches, createImportBranch, prByBranch]);

  let branchPickerPlaceholder: string;
  if (loadingBranches) branchPickerPlaceholder = "Loading branches…";
  else if (createBranches.length === 0) branchPickerPlaceholder = "No branches found";
  else branchPickerPlaceholder = "Pick a branch…";

  const selectedLinearBranchName = selectedLinearIssue ? resolveLinearIssueBranchName(selectedLinearIssue) : "";
  const selectedLinearBranchConflict = selectedLinearIssue
    ? branchExistsForLinearIssue(selectedLinearBranchName, createBranches)
    : false;
  React.useEffect(() => {
    if (open && selectedColor === null) setSelectedColor(nextAvailableColor(lanes));
  }, [open, lanes, selectedColor, setSelectedColor]);

  const machineMissing = Boolean(machineRequired) && !laneCreated && !selectedMachineId;
  const machineHint = !machineMissing
    ? null
    : showMachineSelector
      ? "Choose the machine this lane will live on."
      : "No connected machine has this repository open.";
  const isSubmitDisabled = laneCreated
    ? !!busy
    : (busy
      || machineMissing
      || !createLaneName.trim()
      || (createMode === "child" && !createParentLaneId)
      || (createMode === "primary" && (!selectedBaseBranchValid || loadingBranches))
      || (createMode === "existing" && !createImportBranch)
      || selectedLinearBranchConflict);

  const locked = Boolean(busy || laneCreated);
  const [openChip, setOpenChip] = React.useState<null | "color" | "machine" | "source" | "childBase" | "template">(null);
  const chipProps = (chip: NonNullable<typeof openChip>) => ({
    open: openChip === chip,
    mode: createMode,
    onOpenChange: (next: boolean) => setOpenChip(next && !locked ? chip : null),
  });
  React.useEffect(() => {
    if (!open) setOpenChip(null);
  }, [open]);

  const submit = React.useCallback(() => {
    if (!isSubmitDisabled) onSubmit();
  }, [isSubmitDisabled, onSubmit]);

  const chooseMode = (mode: CreateLaneMode) => {
    setCreateMode(mode);
    if (mode !== "child") {
      setCreateParentLaneId("");
      setCreateChildBaseBranch("");
    }
  };

  // ── Base branch list: the project's default base pinned first, then search ─
  const primaryLane = React.useMemo(() => lanes.find((lane) => lane.laneType === "primary") ?? null, [lanes]);
  const defaultBaseRef = React.useMemo(
    () => selectDefaultNewLaneBaseRef({ branches: createBranches, source: createBaseSource, primaryBaseRef: primaryLane?.baseRef }),
    [createBaseSource, createBranches, primaryLane?.baseRef],
  );
  const branchByName = React.useMemo(() => new Map(createBranches.map((branch) => [branch.name, branch])), [createBranches]);
  // A ref missing from the branch list (a pruned upstream, a lane's branch on
  // another checkout) still searches and finds its PR by name.
  const branchFor = React.useCallback(
    (name: string, isRemote: boolean): LaneBranchOption =>
      branchByName.get(name) ?? refOnlyBranch(name, isRemote),
    [branchByName],
  );
  const baseListItems = React.useMemo<LaneBranchListItem[]>(
    () => baseBranchOptions.map((option) => ({
      ref: option.ref,
      branch: branchFor(option.ref, option.source === "remote"),
      pinned: option.ref === defaultBaseRef,
      tag: option.ref === defaultBaseRef ? "default" : undefined,
    })),
    [baseBranchOptions, branchFor, defaultBaseRef],
  );
  // A child lane's parent: every lane, with its branch's last commit.
  const parentListItems = React.useMemo<LaneBranchListItem[]>(
    () => lanes.map((lane) => ({
      ref: lane.id,
      label: lane.name,
      branch: branchFor(lane.branchRef, false),
      swatch: lane.color ?? null,
    })),
    [branchFor, lanes],
  );
  // A child lane's base: the parent's branch by default, or any branch.
  const childBaseListItems = React.useMemo<LaneBranchListItem[]>(() => {
    const parent = lanes.find((lane) => lane.id === createParentLaneId) ?? null;
    const items: LaneBranchListItem[] = parent
      ? [{
        ref: "",
        label: parent.branchRef,
        branch: branchFor(parent.branchRef, false),
        pinned: true,
        tag: "parent",
      }]
      : [];
    for (const branch of createBranches) items.push({ ref: branch.name, branch });
    return items;
  }, [branchFor, createBranches, createParentLaneId, lanes]);
  // Existing branches: the checked-out one first, then most recently touched.
  const importListItems = React.useMemo<LaneBranchListItem[]>(() => {
    const time = (branch: LaneBranchOption) => (branch.lastCommitDate ? Date.parse(branch.lastCommitDate) || 0 : 0);
    return [...createBranches]
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || time(b) - time(a))
      .map((branch) => ({ ref: branch.name, branch }));
  }, [createBranches]);

  const parentLane = lanes.find((lane) => lane.id === createParentLaneId) ?? null;
  const ModeIcon = MODE_ICON[createMode];

  return (
    <>
    <LaneDialogShell
      open={open && !issuePickerOpen}
      onOpenChange={onOpenChange}
      title="New lane"
      width="min(580px, calc(100vw - 24px))"
      busy={busy}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        const target = document.querySelector<HTMLElement>(
          '[data-tour="lanes.laneTab"], [data-tour="lanes.newLane"]',
        );
        target?.focus?.();
      }}
      footer={(
        <div className="flex w-full flex-col gap-3">
          {error ? (
            <Banner model={{ id: "create-lane-error", tone: "error", title: error }} layout="inline" />
          ) : null}
          <div className="cl-foot">
            {machineHint ? (
              <span className="cl-foot-hint" data-tone="warn" data-testid="create-lane-machine-hint" title={machineHint}>
                {showMachineSelector ? "Pick a machine first" : "No machine has this repo open"}
              </span>
            ) : (
              <span className="cl-foot-hint"><kbd>{isMacPlatform() ? "⌘" : modifierKeyLabel}</kbd><kbd>↵</kbd>&nbsp;to create</span>
            )}
            <div className="cl-foot-actions">
              <button
                type="button"
                className="kit-btn kit-btn-ghost"
                disabled={busy && !onCancelBusy}
                onClick={busy && onCancelBusy ? onCancelBusy : () => onOpenChange(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cl-create"
                data-tour="lanes.createDialog.create"
                disabled={isSubmitDisabled}
                onClick={submit}
              >
                {submitLabelOverride ?? submitLabel(busy, createMode, laneCreated)}
              </button>
            </div>
          </div>
        </div>
      )}
    >
      <div
        className="cl-composer"
        data-mode={createMode}
        data-tour="lanes.createDialog"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      >
        {/* Emoji slot and lane colour control sit inside the name field. */}
        <div
          className="cl-name"
          data-colored={selectedColor ? "true" : undefined}
          style={selectedColor ? ({ "--cl-lane": selectedColor } as React.CSSProperties) : undefined}
        >
          {showEmojiControl ? (
            <LaneEmojiPicker
              value={selectedEmoji}
              onChange={setSelectedEmoji}
              disabled={locked}
              label="Lane emoji"
              trigger={(
                <button
                  type="button"
                  className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-base transition hover:bg-fg/[0.08] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:opacity-45 ${suggestedEmoji && !selectedEmoji ? "text-fg/40" : "text-fg"}`}
                  aria-label={selectedEmoji ? `Change lane emoji, current ${selectedEmoji}` : suggestedEmoji ? `Accept Jev's suggested emoji ${suggestedEmoji} and open picker` : "Choose lane emoji"}
                  title={suggestedEmoji && !selectedEmoji ? "Suggested by Jev · click to accept and choose" : "Choose lane emoji"}
                  disabled={locked}
                  onClick={() => {
                    if (suggestedEmoji && !selectedEmoji) onAcceptSuggestedEmoji?.();
                  }}
                >
                  {selectedEmoji || suggestedEmoji || <span className="text-sm text-muted-fg">＋</span>}
                </button>
              )}
            />
          ) : null}
          <input
            value={createLaneName}
            onChange={(e) => handleSetCreateLaneName(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Tab" && suggestedEmoji && !selectedEmoji) {
                event.preventDefault();
                onAcceptSuggestedEmoji?.();
                return;
              }
              if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !isImeComposing(event)) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Name this lane"
            aria-label="Lane name"
            spellCheck={false}
            autoFocus
            disabled={locked}
            data-tour="lanes.createDialog.name"
          />
          <ComposerPopover
            {...chipProps("color")}
            fit="content"
            trigger={(
              <button
                type="button"
                className="cl-dot"
                disabled={locked}
                aria-label={selectedColor ? `Lane colour: ${laneColorName(selectedColor) ?? selectedColor}` : "Lane colour: none"}
                title="Lane colour"
              >
                {selectedColor
                  ? <i style={{ background: selectedColor }} />
                  : <Palette size={15} className="text-muted-fg" />}
              </button>
            )}
          >
            <div className="cl-colors">
              <LaneColorPicker
                value={selectedColor}
                onChange={(color) => {
                  setSelectedColor(color);
                  setOpenChip(null);
                }}
                usedColors={usedColors}
                usedColorOwners={usedColorOwners}
              />
            </div>
          </ComposerPopover>
        </div>

        {/* How the lane starts */}
        <div className="cl-modes" role="radiogroup" aria-label="Start from" data-tour="lanes.createDialog.tabs">
          {MODE_ORDER.map((mode) => {
            const Icon = MODE_ICON[mode];
            const blockedByIssue = Boolean(selectedLinearIssue && mode === "existing");
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                className="cl-mode"
                data-mode={mode}
                aria-checked={createMode === mode}
                disabled={locked || blockedByIssue}
                title={blockedByIssue ? "Detach the Linear issue before using an existing branch." : undefined}
                data-tour={MODE_TOUR[mode]}
                onClick={() => chooseMode(mode)}
              >
                <Icon size={14} weight="bold" />
                {MODE_LABEL[mode]}
                <SmartTooltip content={{ label: MODE_LABEL[mode], description: MODE_HELP[mode] }} forceEnabled side="bottom">
                  <span className="cl-mode-info" aria-label={MODE_HELP[mode]}>
                    <Info size={12} weight="bold" />
                  </span>
                </SmartTooltip>
              </button>
            );
          })}
        </div>

        <div className="cl-rows">
          {/* New branch: the base it branches off */}
          {createMode === "primary" ? (
            <>
              <span className="cl-label">Based on</span>
              <div className="cl-cell">
                <ComposerPopover
                  {...chipProps("source")}
                  trigger={(
                    <button
                      type="button"
                      className="cl-field"
                      disabled={locked}
                      data-empty={selectedBaseBranchValid ? undefined : "true"}
                      aria-label="Base branch"
                      data-tour="lanes.createDialog.branchBase"
                    >
                      <span className="cl-tile" data-tone="mode"><ModeIcon size={13} weight="bold" /></span>
                      <span className="cl-field-text">
                        {selectedBaseBranchValid ? createBaseBranch : loadingBranches ? "Loading branches…" : "Pick a base branch…"}
                      </span>
                      {selectedBaseBranchValid && createBaseBranch === defaultBaseRef ? <span className="cl-tag" data-tone="mode">default</span> : null}
                      <span className="cl-field-meta">{createBaseSource === "remote" ? "Remote" : "Local"}</span>
                      <CaretUpDown size={12} className="cl-field-caret" />
                    </button>
                  )}
                >
                  <LaneBranchList
                    items={baseListItems}
                    pullRequests={branchPullRequests}
                    currentUserName={currentGitUserName}
                    selectedRef={createBaseBranch}
                    loading={loadingBranches}
                    emptyLabel={`No ${createBaseSource === "remote" ? "remote-tracking refs" : "local branches"} found.`}
                    ariaLabel="Base branch"
                    onSelect={(ref) => {
                      setCreateBaseBranch(ref);
                      setOpenChip(null);
                    }}
                    headerExtra={(
                      <div className="kit-seg" data-case="sentence" role="radiogroup" aria-label="Base source">
                        {(["remote", "local"] as const).map((source) => (
                          <button
                            key={source}
                            type="button"
                            role="radio"
                            aria-checked={createBaseSource === source}
                            title={source === "remote" ? "Branch off the fetched upstream" : "Branch off your local branch tip"}
                            onClick={() => setCreateBaseSource(source)}
                          >
                            {source === "remote" ? "Remote" : "Local"}
                          </button>
                        ))}
                      </div>
                    )}
                  />
                </ComposerPopover>
              </div>
            </>
          ) : null}

          {/* Import branch: the lane works on that branch itself */}
          {createMode === "existing" ? (
            <>
              <span className="cl-label">Branch</span>
              <div className="cl-cell">
                <ComposerPopover
                  {...chipProps("source")}
                  trigger={(
                    <button
                      type="button"
                      className="cl-field"
                      disabled={locked || (loadingBranches && createBranches.length === 0)}
                      data-empty={selectedBranchMeta.branch ? undefined : "true"}
                      aria-label="Choose import branch"
                      aria-describedby={importBranchWarning ? "import-branch-warning" : undefined}
                      data-tour="lanes.createDialog.branchPickerOpen"
                    >
                      <span className="cl-tile" data-tone="mode"><ModeIcon size={13} weight="bold" /></span>
                      <span className="cl-field-text">{selectedBranchMeta.branch?.name ?? branchPickerPlaceholder}</span>
                      {selectedBranchMeta.pr ? <span className="cl-tag" data-tone="ok">#{selectedBranchMeta.pr.prNumber}</span> : null}
                      {selectedBranchMeta.branch ? (
                        <span className="cl-field-meta">
                          {[selectedBranchMeta.branch.isRemote ? "Remote" : "Local", formatRelativeTime(selectedBranchMeta.branch.lastCommitDate)]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      ) : null}
                      <CaretUpDown size={12} className="cl-field-caret" />
                    </button>
                  )}
                >
                  <LaneBranchList
                    items={importListItems}
                    pullRequests={branchPullRequests}
                    currentUserName={currentGitUserName}
                    selectedRef={createImportBranch}
                    loading={loadingBranches}
                    emptyLabel="No branches found in this repo."
                    ariaLabel="Existing branch"
                    onSelect={(ref) => {
                      handleSelectImportBranch(ref);
                      setOpenChip(null);
                    }}
                  />
                </ComposerPopover>
              </div>
            </>
          ) : null}

          {/* Child lane: stacked on another lane */}
          {createMode === "child" ? (
            <>
              <span className="cl-label">Parent</span>
              <div className="cl-cell">
                <ComposerPopover
                  {...chipProps("source")}
                  trigger={(
                    <button
                      type="button"
                      className="cl-field"
                      disabled={locked}
                      data-empty={parentLane ? undefined : "true"}
                      aria-label="Parent lane"
                    >
                      <span className="cl-tile" data-tone={parentLane ? "muted" : "mode"}>
                        {parentLane
                          ? <span className="cl-swatch" style={{ margin: 0, background: parentLane.color ?? "var(--cl-child)" }} />
                          : <ModeIcon size={13} weight="bold" />}
                      </span>
                      <span className="cl-field-text">{parentLane?.name ?? "Pick a parent lane…"}</span>
                      {parentLane ? <span className="cl-field-meta">{parentLane.branchRef}</span> : null}
                      <CaretUpDown size={12} className="cl-field-caret" />
                    </button>
                  )}
                >
                  <LaneBranchList
                    items={parentListItems}
                    pullRequests={branchPullRequests}
                    currentUserName={currentGitUserName}
                    selectedRef={createParentLaneId}
                    emptyLabel="No lanes yet."
                    ariaLabel="Parent lane"
                    onSelect={(laneId) => {
                      setCreateParentLaneId(laneId);
                      setOpenChip(null);
                    }}
                  />
                </ComposerPopover>
              </div>

              <span className="cl-label">Based on</span>
              <div className="cl-cell">
                <ComposerPopover
                  {...chipProps("childBase")}
                  trigger={(
                    <button
                      type="button"
                      className="cl-field"
                      disabled={locked || !parentLane}
                      data-empty={parentLane ? undefined : "true"}
                      aria-label="Child base branch override"
                    >
                      <span className="cl-tile" data-tone="mode"><GitBranch size={13} weight="bold" /></span>
                      <span className="cl-field-text">
                        {parentLane ? (createChildBaseBranch || parentLane.branchRef) : "Pick a parent first"}
                      </span>
                      {parentLane && !createChildBaseBranch ? <span className="cl-tag" data-tone="mode">parent</span> : null}
                      <CaretUpDown size={12} className="cl-field-caret" />
                    </button>
                  )}
                >
                  <LaneBranchList
                    items={childBaseListItems}
                    pullRequests={branchPullRequests}
                    currentUserName={currentGitUserName}
                    selectedRef={createChildBaseBranch}
                    loading={loadingBranches}
                    emptyLabel="No branches found in this repo."
                    ariaLabel="Child base branch"
                    onSelect={(ref) => {
                      setCreateChildBaseBranch(ref);
                      setOpenChip(null);
                    }}
                  />
                </ComposerPopover>
                {parentLane ? <span className="cl-hint">Rebases follow <b>{parentLane.name}</b>.</span> : null}
              </div>
            </>
          ) : null}

          {/* Machine — only when there is more than one to choose from */}
          {showMachineSelector && onSelectMachine ? (
            <>
              <span className="cl-label">Machine</span>
              <div className="cl-cell">
                <LaneMachineChip
                  popover={chipProps("machine")}
                  machines={machineOptions}
                  selectedMachineId={selectedMachineId ?? ""}
                  onSelectMachine={onSelectMachine}
                  onConnectMachine={onConnectMachine}
                  disabled={locked}
                />
              </div>
            </>
          ) : null}
        </div>

        {createMode === "existing" && importBranchWarning ? (
          <Banner
            model={{ id: "import-branch-warning", tone: "warning", title: importBranchWarning }}
            layout="inline"
          />
        ) : null}

        {/* Extras: attach a Linear issue, use a template */}
        <div className="cl-extras">
          {selectedLinearIssue ? (
            <div className="cl-extra" data-set="true" data-wide="true" title={selectedLinearIssue.title}>
              <span className="cl-tile" data-tone="linear"><LinearMark size={12} /></span>
              <button
                type="button"
                className="cl-extra-text"
                disabled={locked}
                onClick={() => setIssuePickerOpen(true)}
                aria-label="Change Linear issue"
              >
                <span className="cl-extra-title">
                  <span className="cl-extra-id">{selectedLinearIssue.identifier}</span>&nbsp; {selectedLinearIssue.title}
                </span>
                <span className="cl-extra-sub" style={selectedLinearBranchConflict ? { color: "var(--kit-warn)" } : undefined}>
                  {selectedLinearBranchConflict
                    ? `Branch ${selectedLinearBranchName} already exists`
                    : `Branch ${selectedLinearBranchName}`}
                </span>
              </button>
              <button
                type="button"
                className="cl-x"
                disabled={locked}
                onClick={() => setSelectedLinearIssue(null)}
                aria-label="Detach Linear issue"
                title="Detach Linear issue"
              >
                <X size={11} weight="bold" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="cl-extra"
              disabled={locked}
              onClick={() => setIssuePickerOpen(true)}
              title="Names the branch after the issue and links the lane to it"
            >
              <span className="cl-tile" data-tone="linear"><LinearMark size={12} /></span>
              <span className="cl-extra-text">
                <span className="cl-extra-title">Attach Linear issue</span>
              </span>
            </button>
          )}

          {templates.length > 0 || onNavigateToTemplates ? (
            <LaneTemplateChip
              popover={chipProps("template")}
              templates={templates}
              selectedTemplateId={selectedTemplateId}
              onSelectTemplate={setSelectedTemplateId}
              onManageTemplates={onNavigateToTemplates
                ? () => {
                  onOpenChange(false);
                  onNavigateToTemplates();
                }
                : undefined}
              disabled={locked}
            />
          ) : null}
        </div>

        {setupStatus || setupSteps.length > 0 ? (
          <section className="cl-setup">
            {setupStatus ? <div className="cl-setup-title">{setupStatus}</div> : null}
            {setupSteps.map((step) => {
              const icon = step.state === "done"
                ? <CheckCircle size={14} weight="fill" style={{ color: "var(--kit-ok)" }} />
                : step.state === "active"
                  ? <SpinnerGap size={14} className="animate-spin" style={{ color: "var(--color-accent)" }} />
                  : <Circle size={14} />;
              return (
                <div key={step.label} className="cl-step" data-state={step.state}>
                  {icon}
                  <div className="min-w-0">
                    <div>{step.label}</div>
                    <div className="cl-step-detail">{step.detail}</div>
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}

        {envInitProgress ? <LaneEnvInitProgressPanel progress={envInitProgress} /> : null}
      </div>
    </LaneDialogShell>
    <LinearIssueSelectModal
      open={issuePickerOpen}
      ariaLabel="Attach Linear issue"
      projectRoot={projectRoot}
      selectedIssue={selectedLinearIssue}
      actionLabel="Attach issue"
      actionBusyLabel="Attaching issue"
      actionDisabled={busy || laneCreated}
      onOpenChange={setIssuePickerOpen}
      onSelectIssue={setSelectedLinearIssue}
      onOpenLinearSettings={onOpenLinearSettings}
    />
    </>
  );
}
