import { useCallback, useEffect, useRef, useState } from "react";
import { CaretUpDown, Desktop, GitBranch, UserCircle } from "@phosphor-icons/react";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { ModernRow, ModernRows, ModernSection, SavedFlash, SettingsTextField, useSavedFlash } from "./primitives";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { saveNewLaneDefaults, useNewLaneDefaultsState } from "../../lib/newLaneDefaultsCache";
import { Banner } from "../ui/notice";
import { laneStartSentence, sameLaneStart, type LaneStart } from "../../../shared/laneStart";
import {
  DEFAULT_LANE_BRANCH_PATTERN,
  laneBranchPatternProblem,
  renderLaneBranchName,
  renderLaneBranchPrefix,
} from "../../../shared/laneBranchName";
import type { NewLaneDefaultsSnapshot, NewLaneSettingsScope } from "../../../shared/types";
import { startSourceBranch } from "../lanes/laneStartOptions";
import { LaneStartBranchField, LaneStartOnSwitch } from "../lanes/LaneStartPicker";
import { ComposerPopover, PopItem } from "../lanes/createLaneComposerChips";
import { useLaneStartMenuData } from "../lanes/useLaneStartMenuData";
import { captureLaneSetupAnalytics } from "../../lib/laneSetupAnalytics";
import "./machineSettings.css";

/** Which kind of pattern a project chose, for analytics: never its text. */
function patternKind(pattern: string): "pattern_ade" | "pattern_user" | "pattern_none" | "pattern_custom" {
  if (pattern === DEFAULT_LANE_BRANCH_PATTERN) return "pattern_ade";
  if (pattern === "{user}/{slug}") return "pattern_user";
  if (pattern === "{slug}") return "pattern_none";
  return "pattern_custom";
}

/** The patterns most projects want; anything else is "Custom". `{user}` needs a git user name to show. */
function patternPresets(user: string | null): Array<{ value: string; label: string }> {
  return [
    { value: DEFAULT_LANE_BRANCH_PATTERN, label: "ade/ prefix" },
    ...(user ? [{ value: "{user}/{slug}", label: "Your name" }] : []),
    { value: "{slug}", label: "No prefix" },
  ];
}

/** The branch a pattern gives "Fix login bug", or null when the pattern can't be used. */
function examplePatternBranch(pattern: string, user: string | null): string | null {
  return laneBranchPatternProblem(pattern) ? null : renderLaneBranchName(renderLaneBranchPrefix(pattern, user), "Fix login bug");
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

  // The branch menu's data, read the way the New lane dialog reads it.
  const { lanes, branches, branchesLoading, pullRequests, gitUserName } = useLaneStartMenuData(pin);

  const save = useCallback(async (next: LaneStart) => {
    if (!snapshot) return;
    setPending(next);
    try {
      // Only the start: the brain merges, so a template picked since this
      // snapshot was read is kept.
      await saveNewLaneDefaults({ projectRoot, pin, defaults: { start: next } });
      captureLaneSetupAnalytics({ action: "start_default_changed", outcome: `start_${next.from}` });
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
            hint={sourceBranch ? laneStartSentence(start, sourceBranch, "New lanes") : undefined}
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
          >
            {sourceBranch ? null : (
              <Banner
                layout="inline"
                model={{
                  id: "new-lane-start-no-branch",
                  tone: "warning",
                  title: "The primary lane has no branch checked out.",
                  detail: "New lanes can't start from it until it's on a branch.",
                }}
              />
            )}
          </ModernRow>
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
  // An older brain answers without `branchPrefix` and ignores a saved
  // pattern while reporting success, so the row can't be edited there.
  const supported = snapshot.branchPrefix !== undefined;
  const savedIsPreset = presets.some((preset) => preset.value === saved);
  const [custom, setCustom] = useState(!savedIsPreset);
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Enter saves, and the blur that follows would save again before `saving`
  // renders: one save at a time.
  const savingRef = useRef(false);
  useEffect(() => {
    setDraft(saved);
    setError(null);
  }, [saved]);

  const shown = custom ? draft.trim() : saved;
  const problem = laneBranchPatternProblem(shown);
  const example = problem ? null : examplePatternBranch(shown, user);
  const selectedPreset = custom ? null : presets.find((preset) => preset.value === saved) ?? null;
  const savedCustomExample = savedIsPreset ? null : examplePatternBranch(saved, user);

  const persist = async (pattern: string) => {
    if (!supported || pattern === saved || savingRef.current) return;
    const invalid = laneBranchPatternProblem(pattern);
    if (invalid) {
      setError(invalid);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      // The lane's machine also refuses a prefix that clashes with a branch it has.
      await saveNewLaneDefaults({ projectRoot, pin, defaults: { branchPattern: pattern } });
      captureLaneSetupAnalytics({ action: "branch_pattern_changed", outcome: patternKind(pattern) });
      setError(null);
      flash();
    } catch (err) {
      if (!savedIsPreset) setCustom(true);
      const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(err);
      setError(message);
      fail(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <ModernRow
      anchor="new-lane-branch-pattern"
      title="Branch names"
      hint={!supported
        ? "The machine that owns this project needs a newer ADE to change branch names."
        : error || (custom && problem)
        ? <span className="ade-nl-warn">{error ?? problem}</span>
        : <>“Fix login bug” becomes <code className="ade-nl-code">{example}</code></>}
      control={(
        <div className="ade-nl-pattern">
          <ComposerPopover
            open={menuOpen}
            restoreFocus
            mode="new"
            onOpenChange={(next) => setMenuOpen(next && !saving && supported)}
            trigger={(
              <button
                type="button"
                className="cl-field"
                data-mode="new"
                disabled={saving || !supported}
                aria-label="Branch names"
              >
                <span className="cl-tile" data-tone="mode"><GitBranch size={13} weight="bold" /></span>
                <span className="cl-field-text">{selectedPreset?.label ?? "Custom"}</span>
                <span className="cl-field-meta ade-nl-mono">{custom ? draft.trim() || saved : saved}</span>
                <CaretUpDown size={12} className="cl-field-caret" />
              </button>
            )}
          >
            <div role="radiogroup" aria-label="Branch names" onKeyDown={(event) => {
              let direction = 0;
              if (["ArrowDown", "ArrowRight"].includes(event.key)) direction = 1;
              if (["ArrowUp", "ArrowLeft"].includes(event.key)) direction = -1;
              if (!direction && event.key !== "Home" && event.key !== "End") return;
              const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)'));
              if (!(event.target instanceof HTMLButtonElement)) return;
              const current = options.indexOf(event.target);
              if (current < 0 || !options.length) return;
              event.preventDefault();
              let index = (current + direction + options.length) % options.length;
              if (event.key === "Home") index = 0;
              if (event.key === "End") index = options.length - 1;
              options[index].focus();
              options[index].click();
            }}>
              {presets.map((preset) => (
                <PopItem
                  key={preset.value}
                  radio
                  title={preset.label}
                  sub={<span className="ade-nl-mono">{examplePatternBranch(preset.value, user)}</span>}
                  selected={!custom && preset.value === saved}
                  onSelect={() => {
                    setMenuOpen(false);
                    setError(null);
                    setCustom(false);
                    void persist(preset.value);
                  }}
                />
              ))}
              <div className="cl-pop-rule" />
              <PopItem
                radio
                title="Custom…"
                sub={savedCustomExample
                  ? <span className="ade-nl-mono">{savedCustomExample}</span>
                  : "Your own pattern, ending in {slug}"}
                selected={custom}
                onSelect={() => {
                  setMenuOpen(false);
                  setError(null);
                  setDraft(saved);
                  setCustom(true);
                }}
              />
            </div>
          </ComposerPopover>
        </div>
      )}
    >
      {custom && supported ? (
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
