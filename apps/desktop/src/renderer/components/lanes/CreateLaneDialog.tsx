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
  X,
} from "@phosphor-icons/react";
import { Banner } from "../ui/notice/Banner";
import type {
  BranchPullRequest,
  LaneLinearIssue,
  LaneSummary,
  LaneEnvInitProgress,
  LaneTemplate,
  NewLaneDefaultsSnapshot,
} from "../../../shared/types";
import {
  LANE_START_BRING_LABEL,
  LANE_START_BRING_VALUES,
  type LaneStart,
  type LaneStartBring,
} from "../../../shared/laneStart";
import { stripRemotePrefix, type LaneBranchOption } from "./laneUtils";
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
import {
  laneHoldingBranch,
  startBranchItems,
  startFromPickerRef,
  startPickerRef,
  startRefLabel,
  startSourceBranch,
} from "./laneStartOptions";
import { isMacPlatform, modifierKeyLabel } from "../../lib/platform";
import type { LaneMachineOption } from "./laneMachines";
import { ComposerPopover, LaneMachineChip, LaneTemplateChip } from "./createLaneComposerChips";
import "./createLaneComposer.css";
import { isImeComposing } from "../../lib/imeComposition";

export type CreateLaneMode = "new" | "existing";
export type CreateLaneSetupStep = {
  label: string;
  detail: string;
  state: "pending" | "active" | "done";
};

const MODE_LABEL: Record<CreateLaneMode, string> = {
  new: "New branch",
  existing: "Existing branch",
};

const MODE_HELP: Record<CreateLaneMode, string> = {
  new: "Makes a fresh branch for this lane, starting from the branch you pick.",
  existing: "The lane works directly on a branch that already exists. No new branch is made.",
};

const MODE_ICON: Record<CreateLaneMode, typeof GitBranch> = {
  new: GitBranch,
  existing: ArrowSquareIn,
};

const MODE_TOUR: Record<CreateLaneMode, string> = {
  new: "lanes.createDialog.primaryTab",
  existing: "lanes.createDialog.branchTab",
};

const MODE_ORDER: readonly CreateLaneMode[] = ["new", "existing"];

/** What each "Bring" choice means for the branch the lane starts from. */
function bringHint(bring: LaneStartBring, refLabel: string, holder: LaneSummary | null): string {
  if (bring === "pushed") {
    return refLabel ? `Fetches first, then branches from ${refLabel}.` : "Fetches first, then branches from the remote copy.";
  }
  if (bring === "local") {
    return refLabel
      ? `Branches from your local ${refLabel}, including commits you haven't pushed.`
      : "Branches from your local copy, including commits you haven't pushed.";
  }
  if (!holder) return "Copies uncommitted changes from the lane that has this branch open.";
  const where = holder.laneType === "primary" ? "Primary" : holder.name;
  return `Branches from your local ${refLabel} and copies the uncommitted changes in ${where}. ${where} keeps them too.`;
}

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
  return mode === "existing" ? "Create lane on this branch" : "Create lane";
}

export function CreateLaneDialog({
  open,
  onOpenChange,
  createLaneName,
  setCreateLaneName,
  createMode,
  setCreateMode,
  createStart,
  setCreateStart,
  newLaneDefaults,
  createImportBranch,
  setCreateImportBranch,
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
  /** New branch: where it starts and what it brings. */
  createStart: LaneStart;
  setCreateStart: (start: LaneStart) => void;
  /** The project's saved new-lane defaults on the lane's machine; null while loading. */
  newLaneDefaults: NewLaneDefaultsSnapshot | null;
  createImportBranch: string;
  setCreateImportBranch: (v: string) => void;
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
      setCreateMode("new");
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

  // New branch: where it starts.
  const startItems = React.useMemo(
    () => startBranchItems({ branches: createBranches, lanes, snapshot: newLaneDefaults }),
    [createBranches, lanes, newLaneDefaults],
  );
  const startSource = startSourceBranch(createStart, newLaneDefaults);
  const startRef = startRefLabel(createStart, newLaneDefaults);
  // The folder whose uncommitted changes "Local + uncommitted" copies.
  const startHolder = laneHoldingBranch(startSource, lanes);
  const startMissing = createStart.from === "primary" && newLaneDefaults !== null && !newLaneDefaults.primaryBranch;
  const uncommittedBlocked = !startHolder;
  let startTitle: string;
  if (createStart.from === "default") startTitle = "Default branch";
  else if (createStart.from === "primary") startTitle = "Primary lane's branch";
  else startTitle = startSource || "Pick a branch…";

  // Existing branch: a branch already open in a lane is that lane.
  const importHolder = createMode === "existing" && createImportBranch
    ? laneHoldingBranch(createImportBranch.replace(/^origin\//, ""), lanes)
    : null;

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
      || (createMode === "new" && (!startSource || startMissing || (createStart.bring === "uncommitted" && uncommittedBlocked)))
      || (createMode === "existing" && (!createImportBranch || Boolean(importHolder)))
      || selectedLinearBranchConflict);

  const locked = Boolean(busy || laneCreated);
  const [openChip, setOpenChip] = React.useState<null | "color" | "machine" | "source" | "template">(null);
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

  const chooseMode = (mode: CreateLaneMode) => setCreateMode(mode);

  // Existing branches: the checked-out one first, then most recently touched.
  const importListItems = React.useMemo<LaneBranchListItem[]>(() => {
    const time = (branch: LaneBranchOption) => (branch.lastCommitDate ? Date.parse(branch.lastCommitDate) || 0 : 0);
    return [...createBranches]
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || time(b) - time(a))
      .map((branch) => ({ ref: branch.name, branch }));
  }, [createBranches]);

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
          {/* New branch: where it starts, and what it brings along */}
          {createMode === "new" ? (
            <>
              <span className="cl-label">Start from</span>
              <div className="cl-cell">
                <ComposerPopover
                  {...chipProps("source")}
                  trigger={(
                    <button
                      type="button"
                      className="cl-field"
                      disabled={locked}
                      data-empty={startSource ? undefined : "true"}
                      aria-label="Start from"
                      data-tour="lanes.createDialog.branchBase"
                    >
                      <span className="cl-tile" data-tone="mode"><ModeIcon size={13} weight="bold" /></span>
                      <span className="cl-field-text">{startTitle}</span>
                      {createStart.from !== "branch" && startSource ? <span className="cl-tag" data-tone="mode">{startSource}</span> : null}
                      {startMissing ? <span className="cl-field-meta">no branch checked out</span> : null}
                      <CaretUpDown size={12} className="cl-field-caret" />
                    </button>
                  )}
                >
                  <LaneBranchList
                    items={startItems}
                    pullRequests={branchPullRequests}
                    currentUserName={currentGitUserName}
                    selectedRef={startPickerRef(createStart)}
                    loading={loadingBranches}
                    emptyLabel="No branches found in this repo."
                    ariaLabel="Start from"
                    onSelect={(ref) => {
                      setCreateStart(startFromPickerRef(ref, createStart.bring));
                      setOpenChip(null);
                    }}
                  />
                </ComposerPopover>
              </div>

              <span className="cl-label">Bring</span>
              <div className="cl-cell">
                <div className="kit-seg cl-bring" data-case="sentence" role="radiogroup" aria-label="Bring">
                  {LANE_START_BRING_VALUES.map((bring) => {
                    const blocked = bring === "uncommitted" && uncommittedBlocked;
                    return (
                      <button
                        key={bring}
                        type="button"
                        role="radio"
                        aria-checked={createStart.bring === bring}
                        disabled={locked || blocked}
                        title={blocked
                          ? `${startSource || "This branch"} isn't open in any lane, so there are no uncommitted changes to copy.`
                          : undefined}
                        onClick={() => setCreateStart({ ...createStart, bring })}
                      >
                        {LANE_START_BRING_LABEL[bring]}
                      </button>
                    );
                  })}
                </div>
                <span className="cl-hint" data-tone={createStart.bring === "uncommitted" && uncommittedBlocked ? "warn" : undefined}>
                  {createStart.bring === "uncommitted" && uncommittedBlocked
                    ? `${startSource || "This branch"} isn't open in any lane, so there are no uncommitted changes to copy.`
                    : bringHint(createStart.bring, startRef, startHolder)}
                </span>
              </div>
            </>
          ) : null}

          {/* Existing branch: the lane works on that branch itself */}
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
                      aria-label="Existing branch"
                      data-tone={importHolder ? "warn" : undefined}
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
                {importHolder ? (
                  <span className="cl-hint" data-tone="warn">
                    <b>{createImportBranch}</b> is already open in {importHolder.laneType === "primary" ? "Primary" : <b>{importHolder.name}</b>}.
                    {" "}A branch can only be open in one lane at a time.
                  </span>
                ) : createImportBranch ? (
                  <span className="cl-hint">
                    No new branch is made. The lane's commits go onto <b>{createImportBranch.replace(/^origin\//, "")}</b>.
                  </span>
                ) : (
                  <span className="cl-hint">The lane works directly on the branch you pick.</span>
                )}
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
