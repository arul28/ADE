import { useCallback, useEffect, useState } from "react";
import { Desktop, UserCircle } from "@phosphor-icons/react";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { ModernRow, ModernRows, ModernSection, SavedFlash, SettingsSelect, SettingsTextField, useSavedFlash } from "./primitives";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { pinArg } from "../../state/laneMachineRouting";
import { saveNewLaneDefaults, useNewLaneDefaultsState } from "../../lib/newLaneDefaultsCache";
import { Banner } from "../ui/notice";
import { laneStartSentence, sameLaneStart, type LaneStart } from "../../../shared/laneStart";
import {
  DEFAULT_LANE_BRANCH_PATTERN,
  laneBranchPatternProblem,
  renderLaneBranchName,
  renderLaneBranchPrefix,
} from "../../../shared/laneBranchName";
import type { BranchPullRequest, LaneSummary, NewLaneDefaultsSnapshot, NewLaneSettingsScope } from "../../../shared/types";
import type { LaneBranchOption } from "../lanes/laneUtils";
import { startSourceBranch } from "../lanes/laneStartOptions";
import { LaneStartBranchField, LaneStartOnSwitch } from "../lanes/LaneStartPicker";
import "./machineSettings.css";

/** The patterns most projects want; anything else is "Custom". `{user}` needs a git user name to show. */
const CUSTOM_PATTERN = "__custom__";
function patternPresets(user: string | null): Array<{ value: string; label: string }> {
  return [
    { value: DEFAULT_LANE_BRANCH_PATTERN, label: "ade/ prefix" },
    ...(user ? [{ value: "{user}/{slug}", label: `Your name (${user}/)` }] : []),
    { value: "{slug}", label: "No prefix" },
    { value: CUSTOM_PATTERN, label: "Custom…" },
  ];
}

/**
 * Settings → Lanes → New lanes: where every new lane starts, and what its
 * branch is called.
 *
 * Used everywhere a lane is made without a pick of its own: Auto-create lane,
 * `ade lanes create`, the phone, and the New lane dialog's first selection.
 * Saved to the account for this repository, so every computer that opens it
 * agrees (a project without a remote keeps it on this computer, and the chip
 * says so).
 */
export function NewLaneSettingsSection() {
  const { pin } = useSettingsMachineScope();
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const { snapshot, failed, retry } = useNewLaneDefaultsState({ projectRoot, pin, revalidate: true });
  const { state: saveState, flash, fail } = useSavedFlash();
  const [pending, setPending] = useState<LaneStart | null>(null);
  const start = pending ?? snapshot?.defaults.start ?? null;

  // The branch menu's data, read the way the New lane dialog reads it: that
  // machine's lanes (who has which branch open), its branches through the
  // primary lane, git's user name for "mine", and the repo's open PRs.
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [branches, setBranches] = useState<LaneBranchOption[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [pullRequests, setPullRequests] = useState<BranchPullRequest[]>([]);
  const [gitUserName, setGitUserName] = useState("");
  useEffect(() => {
    let cancelled = false;
    setBranchesLoading(true);
    void window.ade.lanes.list({ includeStatus: false }, pin)
      .then((next) => {
        if (cancelled) return;
        const list = Array.isArray(next) ? next : [];
        setLanes(list);
        const primary = list.find((lane) => lane.laneType === "primary");
        if (!primary) {
          setBranchesLoading(false);
          return;
        }
        void window.ade.git.listBranches({ laneId: primary.id }, ...pinArg(pin))
          .then((found) => {
            if (!cancelled) setBranches(found);
          })
          .catch(() => {})
          .finally(() => {
            if (!cancelled) setBranchesLoading(false);
          });
        void window.ade.git.getUserIdentity({ laneId: primary.id }, ...pinArg(pin))
          .then((identity) => {
            if (!cancelled) setGitUserName(identity?.name ?? "");
          })
          .catch(() => {});
      })
      .catch((error) => {
        console.warn("new_lane_settings.lanes_load_failed", error);
        if (!cancelled) setBranchesLoading(false);
      });
    // Repo-wide (GitHub): the tab's machine answers it for any target. Only
    // decoration for the menu, so a host without it never blocks the page.
    void Promise.resolve()
      .then(() => window.ade.prs.listOpenForRepo())
      .then((next) => {
        if (!cancelled) setPullRequests(next);
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

  const [menuOpen, setMenuOpen] = useState(false);
  const pick = (next: LaneStart) => {
    if (start && !sameLaneStart(next, start)) void save(next);
  };

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

  return (
    <>
      <div className="ade-nl-meta">
        <span>
          Auto-create lane and <code>ade lanes create</code> use these. You can change both when you make a lane.
        </span>
        <span className="ade-nl-meta-end">
          <SavedFlash state={saveState} />
          <ScopeChip scope={snapshot.scope} />
        </span>
      </div>

      <ModernSection size="step" group="New lanes" anchor="new-lane-start" title="Branch">
        <ModernRows>
          <ModernRow
            title="Start from"
            hint={sourceBranch
              ? laneStartSentence(start, sourceBranch, "New lanes")
              : <span className="ade-nl-warn">The primary lane has no branch checked out, so new lanes can't start from it.</span>}
            control={(
              <div className="ade-nl-start">
                <LaneStartBranchField
                  start={start}
                  onChange={pick}
                  snapshot={snapshot}
                  branches={branches}
                  lanes={lanes}
                  pullRequests={pullRequests}
                  currentUserName={gitUserName}
                  loading={branchesLoading}
                  disabled={pending !== null}
                  open={menuOpen}
                  onOpenChange={setMenuOpen}
                />
                <LaneStartOnSwitch start={start} onChange={pick} disabled={pending !== null} />
              </div>
            )}
          />
          <BranchPatternRow snapshot={snapshot} flash={flash} fail={fail} />
        </ModernRows>
      </ModernSection>
    </>
  );
}

/**
 * Settings → Lanes → New lanes → Branch names: the pattern every new branch
 * follows, picked from a few common ones or typed as a custom pattern.
 */
function BranchPatternRow({
  snapshot,
  flash,
  fail,
}: {
  snapshot: NewLaneDefaultsSnapshot;
  flash: () => void;
  fail: (message: string) => void;
}) {
  const { pin } = useSettingsMachineScope();
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const user = snapshot.branchUser ?? null;
  const saved = snapshot.defaults.branchPattern ?? DEFAULT_LANE_BRANCH_PATTERN;
  const presets = patternPresets(user);
  const savedIsPreset = presets.some((preset) => preset.value === saved);
  const [custom, setCustom] = useState(!savedIsPreset);
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft(saved);
    setError(null);
  }, [saved]);

  const shown = custom ? draft.trim() : saved;
  const problem = laneBranchPatternProblem(shown);
  const example = problem ? null : renderLaneBranchName(renderLaneBranchPrefix(shown, user), "Fix login bug");

  const persist = async (pattern: string) => {
    if (pattern === saved || saving) return;
    const invalid = laneBranchPatternProblem(pattern);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    try {
      // The lane's machine also refuses a prefix that clashes with a branch it has.
      await saveNewLaneDefaults({ projectRoot, pin, defaults: { branchPattern: pattern } });
      setError(null);
      flash();
    } catch (err) {
      const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(err);
      setError(message);
      fail(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModernRow
      anchor="new-lane-branch-pattern"
      title="Branch names"
      hint={error || (custom && problem)
        ? <span className="ade-nl-warn">{error ?? problem}</span>
        : <>“Fix login bug” becomes <code className="ade-nl-code">{example}</code></>}
      control={(
        <SettingsSelect
          ariaLabel="Branch names"
          value={custom ? CUSTOM_PATTERN : saved}
          options={presets}
          disabled={saving}
          style={{ width: 240 }}
          onChange={(value) => {
            setError(null);
            if (value === CUSTOM_PATTERN) {
              setDraft(saved);
              setCustom(true);
              return;
            }
            setCustom(false);
            void persist(value);
          }}
        />
      )}
    >
      {custom ? (
        <div className="ade-nl-custom">
          <SettingsTextField
            value={draft}
            onChange={(value) => {
              setDraft(value);
              setError(null);
            }}
            onBlur={() => void persist(draft.trim())}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void persist(draft.trim());
              }
              if (event.key === "Escape") {
                setDraft(saved);
                setError(null);
              }
            }}
            ariaLabel="Branch name pattern"
            placeholder={DEFAULT_LANE_BRANCH_PATTERN}
            mono
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={saving}
            style={{ maxWidth: 320 }}
          />
          <span>
            <code className="ade-nl-code">{"{slug}"}</code> is the lane name and goes last.{" "}
            <code className="ade-nl-code">{"{user}"}</code> is your git name.
          </span>
        </div>
      ) : null}
    </ModernRow>
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
