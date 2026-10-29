import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Check,
  CloudArrowDown,
  Desktop,
  FilePlus,
  GitBranch,
  HardDrive,
  House,
  UserCircle,
  type Icon,
} from "@phosphor-icons/react";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { SavedFlash, useSavedFlash } from "./primitives";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { getNewLaneDefaultsCached, saveNewLaneDefaults, useNewLaneDefaultsState } from "../../lib/newLaneDefaultsCache";
import { Banner } from "../ui/notice";
import { confirmDialog } from "../ui/dialog/confirm";
import {
  LANE_START_DEFAULT_FROM_VALUES,
  LANE_START_FROM_LABEL,
  LANE_START_ON_LABEL,
  LANE_START_ON_VALUES,
  laneStartSentence,
  type LaneStart,
  type LaneStartFrom,
  type LaneStartOn,
} from "../../../shared/laneStart";
import type { LaneSummary, NewLaneSettingsScope } from "../../../shared/types";
import { LaneBranchSwitcher } from "../lanes/detail/LaneBranchSwitcher";
import { laneHoldingBranch, startSourceBranch } from "../lanes/laneStartOptions";
import "./machineSettings.css";

const FROM_ICON: Record<LaneStartFrom, Icon> = {
  default: House,
  primary: GitBranch,
  branch: GitBranch,
};

const ON_ICON: Record<LaneStartOn, Icon> = {
  remote: CloudArrowDown,
  local: HardDrive,
  uncommitted: FilePlus,
};

const ON_HINT: Record<LaneStartOn, string> = {
  remote: "Fetches first, then uses what's on the remote.",
  local: "Your local copy, with commits you haven't pushed.",
  uncommitted: "Local, plus a copy of uncommitted work.",
};

/**
 * One step of the New lanes flow: a small heading, an optional line under it,
 * and the step's choices. The tab is the page's heading, so steps carry no
 * card header of their own.
 */
export function NewLaneStep({
  anchor,
  title,
  hint,
  actions,
  children,
}: {
  anchor?: string;
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ade-nl-step" id={anchor} data-settings-anchor={anchor} data-settings-group="New lanes">
      <header className="ade-nl-step-head">
        <div className="min-w-0">
          <h3>{title}</h3>
          {hint ? <p>{hint}</p> : null}
        </div>
        {actions ? <div className="ade-nl-step-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

/**
 * Settings → Lanes → New lanes: where every new lane starts, and on which
 * copy of that branch.
 *
 * Used everywhere a lane is made without a pick of its own: Auto-create lane,
 * `ade lanes create`, the phone, and the New lane dialog's first selection.
 * Saved to the account for this repository, so every computer that opens it
 * agrees (a project without a remote keeps it on this computer, and the chip
 * says so). A named branch is not offered: whoever wants every lane to start
 * from `develop` checks it out in the primary lane, right here.
 */
export function NewLaneSettingsSection() {
  const { pin } = useSettingsMachineScope();
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const { snapshot, failed, retry } = useNewLaneDefaultsState({ projectRoot, pin, revalidate: true });
  const { state: saveState, flash, fail } = useSavedFlash();
  const [pending, setPending] = useState<LaneStart | null>(null);
  const start = pending ?? snapshot?.defaults.start ?? null;

  // The machine's lanes: who has which branch open (for "uncommitted"), and
  // its primary lane, whose branch the switcher changes.
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const loadLanes = useCallback(() => {
    void (pin ? window.ade.lanes.list({ includeStatus: false }, pin) : window.ade.lanes.list({ includeStatus: false }))
      .then((next) => setLanes(Array.isArray(next) ? next : []))
      .catch((error) => {
        console.warn("new_lane_settings.lanes_load_failed", error);
      });
    // Keyed on the pin's identity, not the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.key]);
  useEffect(() => {
    loadLanes();
  }, [loadLanes]);

  const save = useCallback(async (next: LaneStart) => {
    if (!snapshot) return;
    setPending(next);
    try {
      // Only the start: the brain merges, so a template picked since this
      // snapshot was read is kept.
      await saveNewLaneDefaults({ projectRoot, pin, defaults: { start: next } });
      flash();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  }, [fail, flash, pin, projectRoot, snapshot]);

  const primaryLane = lanes.find((lane) => lane.laneType === "primary") ?? null;
  const confirmPrimarySwitch = useCallback(({ from, to }: { from: string; to: string }) => confirmDialog({
    title: `Switch the primary lane to ${to}?`,
    message: (
      <>
        The primary lane's folder moves from <b>{from}</b> to <b>{to}</b>. New lanes that start from the primary
        lane's branch will start from <b>{to}</b>.
      </>
    ),
    confirmLabel: `Switch to ${to}`,
  }), []);
  const afterPrimarySwitch = useCallback(() => {
    loadLanes();
    void getNewLaneDefaultsCached({ projectRoot, pin, force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadLanes, pin?.key, projectRoot]);

  if (failed && !snapshot) {
    return (
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
    );
  }
  if (!snapshot || !start) {
    return (
      <div className="ade-nl-loading" aria-busy="true">
        <span className="ade-st-shimmer" />
        <span className="ade-st-shimmer" />
      </div>
    );
  }

  const sourceBranch = startSourceBranch(start, snapshot);
  const holder = laneHoldingBranch(sourceBranch, lanes);

  return (
    <>
      <div className="ade-nl-meta">
        <span>
          Auto-create lane and <code>ade lanes create</code> start new lanes this way. You can change it for one lane
          when you make it.
        </span>
        <span className="ade-nl-meta-end">
          <SavedFlash state={saveState} />
          <ScopeChip scope={snapshot.scope} />
        </span>
      </div>

      <NewLaneStep anchor="new-lane-start" title="Start from">
        <div role="radiogroup" aria-label="Start from" className="ade-nl-grid2">
          {LANE_START_DEFAULT_FROM_VALUES.map((from) => {
            const active = start.from === from;
            const FromIcon = FROM_ICON[from];
            const branch = from === "default" ? snapshot.defaultBranch : snapshot.primaryBranch;
            return (
              <button
                key={from}
                type="button"
                role="radio"
                aria-checked={active}
                className="ade-ap-choice"
                data-active={active}
                onClick={() => {
                  if (!active) void save({ from, on: start.on });
                }}
              >
                <span className="ade-modern-choice-body">
                  <span className="ade-modern-choice-title">
                    <FromIcon size={14} />
                    {LANE_START_FROM_LABEL[from]}
                    {active ? <Check size={12} weight="bold" className="ade-ap-check" /> : null}
                  </span>
                  <span className="ade-modern-choice-hint ade-nl-mono">
                    {branch || (from === "primary" ? "No branch checked out" : "The repository's main branch")}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {start.from === "primary" && primaryLane ? (
          <div className="ade-nl-primary">
            <span>The primary lane is on</span>
            <LaneBranchSwitcher
              lane={primaryLane}
              active
              pin={pin}
              confirmSwitch={confirmPrimarySwitch}
              onSwitched={afterPrimarySwitch}
            />
            <span className="ade-nl-primary-hint">Switch it to change where new lanes start.</span>
          </div>
        ) : null}
      </NewLaneStep>

      <NewLaneStep title="On">
        <div role="radiogroup" aria-label="On" className="ade-ap-grid3">
          {LANE_START_ON_VALUES.map((on) => {
            const active = start.on === on;
            const OnIcon = ON_ICON[on];
            return (
              <button
                key={on}
                type="button"
                role="radio"
                aria-checked={active}
                className="ade-ap-choice"
                data-active={active}
                onClick={() => {
                  if (!active) void save({ ...start, on });
                }}
              >
                <span className="ade-modern-choice-body">
                  <span className="ade-modern-choice-title">
                    <OnIcon size={14} />
                    {LANE_START_ON_LABEL[on]}
                    {active ? <Check size={12} weight="bold" className="ade-ap-check" /> : null}
                  </span>
                  <span className="ade-modern-choice-hint">{ON_HINT[on]}</span>
                </span>
              </button>
            );
          })}
        </div>
        <StartSummary start={start} sourceBranch={sourceBranch} holder={holder} />
      </NewLaneStep>
    </>
  );
}

/** Who the setting follows: the account (per repository) or only this computer. */
function ScopeChip({ scope }: { scope: NewLaneSettingsScope }) {
  const account = scope.kind === "account-repo";
  return (
    <span
      className="kit-tag gap-[5px]"
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

/** The one-line answer: "New lanes will be created from the latest main on the remote." */
function StartSummary({ start, sourceBranch, holder }: { start: LaneStart; sourceBranch: string; holder: LaneSummary | null }) {
  if (!sourceBranch) {
    return (
      <Banner
        layout="inline"
        model={{
          id: "new-lane-start-no-branch",
          tone: "warning",
          title: "The primary lane has no branch checked out.",
          detail: "New lanes can't start from it until it's on a branch.",
        }}
      />
    );
  }
  if (start.on === "uncommitted" && !holder) {
    return (
      <Banner
        layout="inline"
        model={{
          id: "new-lane-start-nothing-to-copy",
          tone: "warning",
          title: `${sourceBranch} isn't open in any lane, so there's no uncommitted work to copy.`,
          detail: `New lanes will be created from local ${sourceBranch}.`,
        }}
      />
    );
  }
  return (
    <div className="ade-nl-summary">
      <GitBranch size={14} />
      <span>{laneStartSentence(start, sourceBranch, "New lanes")}</span>
    </div>
  );
}
