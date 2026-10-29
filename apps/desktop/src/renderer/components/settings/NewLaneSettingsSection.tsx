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
  WarningCircle,
  type Icon,
} from "@phosphor-icons/react";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { ModernSection, SavedFlash, useSavedFlash } from "./primitives";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { saveNewLaneDefaults, useNewLaneDefaults } from "../../lib/newLaneDefaultsCache";
import {
  LANE_START_BRING_HINT,
  LANE_START_BRING_LABEL,
  LANE_START_BRING_VALUES,
  describeLaneStart,
  plainLaneStartBranch,
  type LaneStart,
  type LaneStartBring,
  type LaneStartFrom,
} from "../../../shared/laneStart";
import type { LaneSummary, NewLaneSettingsScope } from "../../../shared/types";
import type { LaneBranchOption } from "../lanes/laneUtils";
import { ComposerPopover } from "../lanes/createLaneComposerChips";
import { LaneBranchList } from "../lanes/LaneBranchList";
import { laneHoldingBranch, startBranchItems, startSourceBranch } from "../lanes/laneStartOptions";
import "../lanes/createLaneComposer.css";
import "./machineSettings.css";

const FROM_OPTIONS: ReadonlyArray<{ value: LaneStartFrom; label: string }> = [
  { value: "default", label: "Default branch" },
  { value: "primary", label: "Primary lane's branch" },
  { value: "branch", label: "A specific branch" },
];

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
  const snapshot = useNewLaneDefaults({ projectRoot, pin });
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
      .catch(() => {});
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
      await saveNewLaneDefaults({ projectRoot, pin, defaults: { ...snapshot.defaults, start: next } });
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
      hint="Auto-create lane and ade lanes create start here. The New lane dialog starts here too, and you can change it there for one lane."
      actions={(
        <>
          <SavedFlash state={saveState} />
          {snapshot ? <ScopeChip scope={snapshot.scope} /> : null}
        </>
      )}
    >
      {!snapshot || !start ? (
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
              else hint = start.from === "branch" && start.branch ? plainLaneStartBranch(start.branch) : "Always the same one";
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
      className="ade-nl-scope"
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
      <div className="ade-nl-summary" data-tone="warn">
        <WarningCircle size={14} />
        <span>Pick the branch new lanes should start from.</span>
      </div>
    );
  }
  const nothingToCopy = start.bring === "uncommitted" && !holder;
  return (
    <div className="ade-nl-summary" data-tone={nothingToCopy ? "warn" : undefined}>
      {nothingToCopy ? <WarningCircle size={14} /> : <GitBranch size={14} />}
      <span>
        New lanes branch from <b>{describeLaneStart(start, sourceBranch)}</b>.
        {nothingToCopy && sourceBranch ? ` ${sourceBranch} isn't open in any lane right now, so there's nothing uncommitted to copy.` : null}
        {start.bring === "uncommitted" && holder
          ? ` Changes are copied from ${holder.laneType === "primary" ? "Primary" : holder.name}; it keeps its own copy.`
          : null}
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
  snapshot: NonNullable<ReturnType<typeof useNewLaneDefaults>>;
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
  const rows: Record<LaneStartFrom, number> = { default: 9, primary: 22, branch: 35 };
  const lit = rows[from];
  return (
    <svg width="148" height="46" viewBox="0 0 148 46" fill="none">
      {([9, 22, 35] as const).map((y) => (
        <g key={y} opacity={y === lit ? 0.95 : 0.22}>
          <path d={`M10 ${y} H${y === 9 ? 118 : y === 22 ? 96 : 74}`} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx={y === 9 ? 118 : y === 22 ? 96 : 74} cy={y} r="3" fill="currentColor" />
        </g>
      ))}
      {(() => {
        const x = lit === 9 ? 118 : lit === 22 ? 96 : 74;
        return (
          <path
            d={`M${x} ${lit} C${x + 10} ${lit} ${x + 12} ${lit + 8} ${x + 26} ${lit + 8}`}
            stroke="var(--color-accent)"
            strokeWidth="1.5"
            strokeDasharray="3 3"
            strokeLinecap="round"
          />
        );
      })()}
    </svg>
  );
}
