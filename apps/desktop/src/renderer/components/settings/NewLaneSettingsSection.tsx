import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CaretUpDown,
  Check,
  CloudArrowDown,
  Desktop,
  FilePlus,
  GitBranch,
  GitCommit,
  UserCircle,
  type Icon,
} from "@phosphor-icons/react";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { ModernSection, SavedFlash, useSavedFlash } from "./primitives";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { saveNewLaneDefaults, useNewLaneDefaultsState } from "../../lib/newLaneDefaultsCache";
import { Banner } from "../ui/notice";
import {
  LANE_START_BRING_HINT,
  LANE_START_BRING_LABEL,
  LANE_START_BRING_VALUES,
  LANE_START_FROM_LABEL,
  LANE_START_FROM_VALUES,
  plainLaneStartBranch,
  type LaneStart,
  type LaneStartBring,
  type LaneStartFrom,
} from "../../../shared/laneStart";
import type { LaneSummary, NewLaneDefaultsSnapshot, NewLaneSettingsScope } from "../../../shared/types";
import type { LaneBranchOption } from "../lanes/laneUtils";
import { ComposerPopover } from "../lanes/createLaneComposerChips";
import { LaneBranchList } from "../lanes/LaneBranchList";
import { laneHoldingBranch, startBranchItems, startSourceBranch } from "../lanes/laneStartOptions";
import "../lanes/createLaneComposer.css";
import "./machineSettings.css";

const FROM_OPTIONS: ReadonlyArray<{ value: LaneStartFrom; label: string }> = LANE_START_FROM_VALUES.map((value) => ({
  value,
  label: LANE_START_FROM_LABEL[value],
}));

const BRING_ICON: Record<LaneStartBring, Icon> = {
  pushed: CloudArrowDown,
  local: GitCommit,
  uncommitted: FilePlus,
};

/**
 * Settings → Lanes → New lanes: where every new lane starts.
 *
 * One choice, used everywhere a lane is made without a pick of its own:
 * Auto-create lane, `ade lanes create`, the phone, and the New lane dialog's
 * first selection. Saved to the account for this repository, so every
 * computer that opens it agrees (a project without a remote keeps it on this
 * computer, and the chip says so).
 */
export function NewLaneSettingsSection() {
  const { pin } = useSettingsMachineScope();
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const { snapshot, failed, retry } = useNewLaneDefaultsState({ projectRoot, pin });
  const { state: saveState, flash, fail } = useSavedFlash();
  const [pending, setPending] = useState<LaneStart | null>(null);
  const start = pending ?? snapshot?.defaults.start ?? null;

  // The machine's lanes: who has which branch open (for "uncommitted"), and
  // its Primary, whose checkout lists the branches.
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (pin ? window.ade.lanes.list({ includeStatus: false }, pin) : window.ade.lanes.list({ includeStatus: false }))
      .then((next) => {
        if (!cancelled) setLanes(Array.isArray(next) ? next : []);
      })
      .catch((error) => {
        console.warn("new_lane_settings.lanes_load_failed", error);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the pin's identity, not the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.key]);

  const save = useCallback(async (next: LaneStart) => {
    if (!snapshot) return;
    setPending(next);
    try {
      // Only the start: the brain merges, so a template picked elsewhere since
      // this snapshot was read is kept.
      await saveNewLaneDefaults({ projectRoot, pin, defaults: { start: next } });
      flash();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  }, [fail, flash, pin, projectRoot, snapshot]);

  const sourceBranch = start ? startSourceBranch(start, snapshot) : "";
  const holder = laneHoldingBranch(sourceBranch, lanes);

  return (
    <ModernSection
      group="New lanes"
      anchor="new-lane-start"
      title="Where new lanes start"
      hint={<>Auto-create lane and <code>ade lanes create</code> use this. The New lane dialog starts here too.</>}
      actions={(
        <>
          <SavedFlash state={saveState} />
          {snapshot ? <ScopeChip scope={snapshot.scope} /> : null}
        </>
      )}
    >
      {failed && !snapshot ? (
        <Banner
          layout="inline"
          model={{
            id: "new-lane-defaults-error",
            tone: "error",
            title: "ADE couldn't read this project's new-lane settings",
            detail: "The machine that owns this project may need a newer ADE.",
            actions: [{ label: "Try again", onClick: retry }],
          }}
        />
      ) : !snapshot || !start ? (
        <div className="ade-nl-loading" aria-busy="true">
          <span className="ade-st-shimmer" />
          <span className="ade-st-shimmer" />
        </div>
      ) : (
        <div className="ade-nl">
          <div className="kit-eyebrow ade-nl-eyebrow">Start from</div>
          <div role="radiogroup" aria-label="Start from" className="ade-ap-grid3">
            {FROM_OPTIONS.map((option) => {
              const active = start.from === option.value;
              let hint: string;
              if (option.value === "default") hint = snapshot.defaultBranch || "The repository's main branch";
              else if (option.value === "primary") hint = snapshot.primaryBranch ? `${snapshot.primaryBranch} right now` : "No branch checked out";
              else hint = start.from === "branch" && start.branch ? plainLaneStartBranch(start.branch) : "Pick one, like develop";
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className="ade-ap-choice"
                  data-active={active}
                  onClick={() => {
                    if (active) return;
                    if (option.value === "branch") {
                      // Keep the choice open until a branch is picked below.
                      setPending({ from: "branch", branch: "", bring: start.bring });
                      return;
                    }
                    void save({ from: option.value, bring: start.bring });
                  }}
                >
                  <span className="ade-ms-art" aria-hidden>
                    <StartArt from={option.value} />
                  </span>
                  <span className="ade-modern-choice-body">
                    <span className="ade-modern-choice-title">
                      {option.label}
                      {active ? <Check size={12} weight="bold" className="ade-ap-check" /> : null}
                    </span>
                    <span className="ade-modern-choice-hint ade-nl-mono">{hint}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {start.from === "branch" ? (
            <BranchPickerRow
              pin={pin}
              lanes={lanes}
              snapshot={snapshot}
              value={plainLaneStartBranch(start.branch)}
              onPick={(branch) => void save({ from: "branch", branch, bring: start.bring })}
            />
          ) : null}

          <div className="kit-eyebrow ade-nl-eyebrow">Bring</div>
          <div role="radiogroup" aria-label="Bring" className="ade-ap-grid3">
            {LANE_START_BRING_VALUES.map((bring) => {
              const active = start.bring === bring;
              const BringIcon = BRING_ICON[bring];
              return (
                <button
                  key={bring}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className="ade-ap-choice"
                  data-active={active}
                  onClick={() => {
                    if (!active && (start.from !== "branch" || start.branch)) void save({ ...start, bring });
                    else if (!active) setPending({ ...start, bring });
                  }}
                >
                  <span className="ade-modern-choice-body">
                    <span className="ade-modern-choice-title">
                      <BringIcon size={14} />
                      {LANE_START_BRING_LABEL[bring]}
                      {active ? <Check size={12} weight="bold" className="ade-ap-check" /> : null}
                    </span>
                    <span className="ade-modern-choice-hint">{LANE_START_BRING_HINT[bring]}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <StartSummary start={start} sourceBranch={sourceBranch} holder={holder} />
        </div>
      )}
    </ModernSection>
  );
}

/** Who the setting follows: the account (per repository) or only this computer. */
function ScopeChip({ scope }: { scope: NewLaneSettingsScope }) {
  const account = scope.kind === "account-repo";
  return (
    <span
      className="kit-tag"
      style={{ gap: 5 }}
      title={account
        ? `Saved to your ADE account for ${scope.repo}. Every computer and phone that opens this repository uses it.`
        : "This project has no remote, so these settings are saved on this computer only."}
    >
      {account ? <UserCircle size={12} weight="duotone" /> : <Desktop size={12} weight="duotone" />}
      {account ? "Your account" : "This computer"}
      {account && scope.repo ? <span className="ade-nl-scope-repo">{scope.repo.replace(/^github\.com\//, "")}</span> : null}
    </span>
  );
}

/** The one-line answer: "New lanes branch from origin/main, fetched first." */
function StartSummary({ start, sourceBranch, holder }: { start: LaneStart; sourceBranch: string; holder: LaneSummary | null }) {
  if (start.from === "branch" && !sourceBranch) {
    return (
      <Banner
        layout="inline"
        model={{ id: "new-lane-start-branch", tone: "warning", title: "Pick the branch new lanes should start from." }}
      />
    );
  }
  const ref = start.bring === "pushed" ? `origin/${sourceBranch}` : sourceBranch;
  if (start.bring === "uncommitted" && !holder) {
    return (
      <Banner
        layout="inline"
        model={{
          id: "new-lane-start-nothing-to-copy",
          tone: "warning",
          title: <>New lanes branch from <b>{ref}</b>, but nothing uncommitted will be copied.</>,
          ariaLabel: `New lanes branch from ${ref}, but nothing uncommitted will be copied.`,
          detail: `${sourceBranch} isn't open in any lane right now, so there's nothing uncommitted to copy.`,
        }}
      />
    );
  }
  const holderName = holder ? (holder.laneType === "primary" ? "Primary" : holder.name) : "";
  let tail: string;
  if (start.bring === "pushed") tail = ", after fetching the latest from the remote.";
  else if (start.bring === "local") tail = ", your local copy, including commits you haven't pushed.";
  else tail = `, plus a copy of the uncommitted changes in ${holderName}. ${holderName} keeps its own.`;
  return (
    <div className="ade-nl-summary">
      <GitBranch size={14} />
      <span>
        New lanes branch from <b>{ref}</b>{tail}
        {start.from === "primary" ? " It follows whatever Primary has checked out when the lane is made." : null}
      </span>
    </div>
  );
}

/** "A specific branch": the branch, picked from the machine's branches. */
function BranchPickerRow({
  pin,
  lanes,
  snapshot,
  value,
  onPick,
}: {
  pin: ReturnType<typeof useSettingsMachineScope>["pin"];
  lanes: LaneSummary[];
  snapshot: NewLaneDefaultsSnapshot;
  value: string;
  onPick: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<LaneBranchOption[]>([]);
  const [loading, setLoading] = useState(false);
  const primaryId = lanes.find((lane) => lane.laneType === "primary")?.id ?? null;
  // Branches are read when the picker first opens, not with the page.
  useEffect(() => {
    if (!open || !primaryId || branches.length > 0) return;
    setLoading(true);
    void (pin ? window.ade.git.listBranches({ laneId: primaryId }, pin) : window.ade.git.listBranches({ laneId: primaryId }))
      .then(setBranches)
      .catch(() => setBranches([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, primaryId, pin?.key]);
  const items = useMemo(
    // The two moving targets have their own cards above; this list is branches only.
    () => startBranchItems({ branches, lanes, snapshot }).filter((item) => !item.pinned),
    [branches, lanes, snapshot],
  );
  return (
    <div className="ade-nl-branch">
      <span className="ade-nl-branch-label">Branch</span>
      <ComposerPopover
        open={open}
        onOpenChange={setOpen}
        mode="new"
        trigger={(
          <button type="button" className="cl-field" data-empty={value ? undefined : "true"} aria-label="Branch new lanes start from">
            <span className="cl-tile" data-tone="mode"><GitBranch size={13} weight="bold" /></span>
            <span className="cl-field-text">{value || "Pick a branch…"}</span>
            <CaretUpDown size={12} className="cl-field-caret" />
          </button>
        )}
      >
        <LaneBranchList
          items={items}
          selectedRef={value}
          loading={loading}
          emptyLabel="No branches found in this repo."
          ariaLabel="Branch"
          onSelect={(ref) => {
            setOpen(false);
            onPick(ref);
          }}
        />
      </ComposerPopover>
    </div>
  );
}

/**
 * Three branches; the new lane (dashed) forks off the one the choice names:
 * the default branch on top, the primary lane's checkout, or another branch.
 */
function StartArt({ from }: { from: LaneStartFrom }) {
  const rows: ReadonlyArray<{ from: LaneStartFrom; y: number; end: number; label: string }> = [
    { from: "default", y: 10, end: 122, label: "main" },
    { from: "primary", y: 24, end: 100, label: "primary" },
    { from: "branch", y: 38, end: 80, label: "other" },
  ];
  const lit = rows.find((row) => row.from === from)!;
  return (
    <svg width="168" height="48" viewBox="0 0 168 48" fill="none">
      {rows.map((row) => (
        <g key={row.from} opacity={row.from === from ? 0.95 : 0.22}>
          <text x="0" y={row.y + 3} fontSize="8" fontFamily="var(--font-mono)" fill="currentColor">{row.label}</text>
          <path d={`M40 ${row.y} H${row.end}`} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx={row.end} cy={row.y} r="3" fill="currentColor" />
        </g>
      ))}
      <path
        d={`M${lit.end} ${lit.y} C${lit.end + 10} ${lit.y} ${lit.end + 12} ${lit.y + 7} ${lit.end + 30} ${lit.y + 7}`}
        stroke="var(--color-accent)"
        strokeWidth="1.5"
        strokeDasharray="3 3"
        strokeLinecap="round"
      />
      <circle cx={lit.end + 32} cy={lit.y + 7} r="2.5" fill="var(--color-accent)" />
    </svg>
  );
}
