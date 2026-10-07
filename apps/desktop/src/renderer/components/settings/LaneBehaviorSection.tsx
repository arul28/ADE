import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CloudArrowDown, Laptop, type Icon } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import type { NewLaneBaseSource, RebaseSuggestionDisplay } from "../../../shared/types";
import {
  DEFAULT_REBASE_SUGGESTIONS,
  DEFAULT_REBASE_SUGGESTION_MIN_BEHIND,
} from "../../../shared/types/config";
import { DEFAULT_NEW_LANE_BASE_SOURCE, effectiveNewLaneBaseSource } from "../lanes/newLaneBaseSource";
import {
  ModernRow,
  ModernRows,
  ModernSection,
  SavedFlash,
  SettingsNumber,
  SettingsToggle,
  useSavedFlash,
} from "./primitives";
import "./machineSettings.css";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * How lanes start and how they stay current.
 *
 * These write to `.ade/local.yaml` (machine-scoped, gitignored). No scope chip:
 * the whole group is local, and nothing about that surprises here.
 *
 * Every control persists on change — the Save button this section used to
 * carry is gone, along with its draft state.
 */
export function LaneBehaviorSection() {
  const navigate = useNavigate();
  // `.ade/local.yaml` on the machine the page shows: each machine's checkout
  // keeps its own lane behaviour.
  const { pin } = useSettingsMachineScope();
  const [autoRebase, setAutoRebase] = useState(false);
  const [rebaseSuggestions, setRebaseSuggestions] = useState<RebaseSuggestionDisplay>(DEFAULT_REBASE_SUGGESTIONS);
  const [minBehind, setMinBehind] = useState(DEFAULT_REBASE_SUGGESTION_MIN_BEHIND);
  const [newLaneBaseSource, setNewLaneBaseSource] = useState<NewLaneBaseSource>(DEFAULT_NEW_LANE_BASE_SOURCE);
  const { state: saveState, flash, fail } = useSavedFlash();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    const snapshot = await window.ade.projectConfig.get(pin);
    if (!mounted.current) return;
    const localAutoRebase = typeof snapshot.local.git?.autoRebaseOnHeadChange === "boolean"
      ? snapshot.local.git.autoRebaseOnHeadChange
      : null;
    const effectiveAutoRebase = typeof snapshot.effective.git?.autoRebaseOnHeadChange === "boolean"
      ? snapshot.effective.git.autoRebaseOnHeadChange
      : null;
    setAutoRebase(localAutoRebase ?? effectiveAutoRebase ?? false);
    setRebaseSuggestions(snapshot.effective.git?.rebaseSuggestions ?? DEFAULT_REBASE_SUGGESTIONS);
    setMinBehind(snapshot.effective.git?.rebaseSuggestionMinBehind ?? DEFAULT_REBASE_SUGGESTION_MIN_BEHIND);
    setNewLaneBaseSource(effectiveNewLaneBaseSource(snapshot));
  }, [pin]);

  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  /**
   * Persist an explicit next value rather than reading component state — an
   * instant-save control fires before its own state update has committed.
   */
  const persist = useCallback(async (next: {
    autoRebase?: boolean;
    baseSource?: NewLaneBaseSource;
    suggestions?: RebaseSuggestionDisplay;
    minBehind?: number;
  }) => {
    try {
      const snapshot = await window.ade.projectConfig.get(pin);
      const currentGit = isRecord(snapshot.local.git) ? snapshot.local.git : {};
      const nextAutoRebase = next.autoRebase ?? autoRebase;
      const nextSource = next.baseSource ?? newLaneBaseSource;

      const nextGit: Record<string, unknown> = {
        ...currentGit,
        autoRebaseOnHeadChange: nextAutoRebase,
      };

      const sharedGit = isRecord(snapshot.shared.git) ? snapshot.shared.git : {};

      /**
       * Write a local override only while the value differs from what the
       * shared config would give us, and drop it the moment it matches again.
       *
       * `effective` already has local merged in, so the comparison has to be
       * against `shared` — comparing to effective would always look equal and
       * never write anything. And since every control now saves on change,
       * writing all fields unconditionally would pin settings the user never
       * touched: harmless-looking until the team changes the shared config and
       * the stale local pin silently shadows it.
       */
      const pinIfDiverged = <T,>(key: string, nextValue: T, inherited: T): void => {
        if (nextValue === inherited) delete nextGit[key];
        else nextGit[key] = nextValue;
      };

      const sharedSource = sharedGit.newLaneBaseSource;
      pinIfDiverged<NewLaneBaseSource>(
        "newLaneBaseSource",
        nextSource,
        sharedSource === "local" || sharedSource === "remote" ? sharedSource : DEFAULT_NEW_LANE_BASE_SOURCE,
      );

      const sharedSuggestions = sharedGit.rebaseSuggestions;
      pinIfDiverged<RebaseSuggestionDisplay>(
        "rebaseSuggestions",
        next.suggestions ?? rebaseSuggestions,
        sharedSuggestions === "off" || sharedSuggestions === "badge" || sharedSuggestions === "banner"
          ? sharedSuggestions
          : DEFAULT_REBASE_SUGGESTIONS,
      );

      pinIfDiverged<number>(
        "rebaseSuggestionMinBehind",
        next.minBehind ?? minBehind,
        typeof sharedGit.rebaseSuggestionMinBehind === "number"
          ? sharedGit.rebaseSuggestionMinBehind
          : DEFAULT_REBASE_SUGGESTION_MIN_BEHIND,
      );

      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: { ...snapshot.local, git: nextGit },
      }, pin);
      if (!mounted.current) return;
      flash();
      await refresh();
    } catch (error) {
      if (!mounted.current) return;
      fail(error instanceof Error ? error.message : String(error));
      // Re-read so the control shows what is actually stored, not the
      // optimistic value the user just clicked.
      await refresh().catch(() => {});
    }
  }, [autoRebase, newLaneBaseSource, rebaseSuggestions, minBehind, flash, fail, pin, refresh]);

  const suggestionsOff = rebaseSuggestions === "off";

  return (
    <div className="ade-modern-sections">
      <ModernSection
        group="Starting lanes"
        anchor="new-lane-base"
        title="New lane base"
        hint="Whether new root lanes and chat-created lanes start from the fetched remote branch or your local tip."
      >
        <div role="radiogroup" aria-label="New lane base" className="ade-modern-choices">
          {BASE_OPTIONS.map((option) => {
            const active = newLaneBaseSource === option.value;
            const OptionIcon = option.icon;
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
                  setNewLaneBaseSource(option.value);
                  void persist({ baseSource: option.value });
                }}
              >
                <span className="ade-ms-art" aria-hidden>
                  <BaseArt source={option.value} />
                </span>
                <span className="ade-modern-choice-body">
                  <span className="ade-modern-choice-title">
                    <OptionIcon size={14} />
                    {option.label}
                    {active ? <Check size={12} weight="bold" className="ade-ap-check" /> : null}
                  </span>
                  <span className="ade-modern-choice-hint">{option.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </ModernSection>

      <ModernSection
        group="Rebase & stacking"
        title="Rebase & stacking"
        hint="Keep stacked lanes aligned with their parents."
        actions={(
          <>
            <SavedFlash state={saveState} />
            <button
              type="button"
              className="ade-modern-btn"
              data-variant="ghost"
              onClick={() => navigate("/prs?tab=workflows&workflow=rebase")}
            >
              Open Rebase/Merge tab
              <ArrowRight size={12} />
            </button>
          </>
        )}
      >
        <ModernRows>
          <ModernRow
            anchor="auto-rebase"
            title="Auto-rebase child lanes"
            hint="Rebase dependent lanes when a parent advances, keeping stacks aligned."
            control={
              <SettingsToggle
                label="Auto-rebase child lanes"
                checked={autoRebase}
                onChange={(next) => {
                  setAutoRebase(next);
                  void persist({ autoRebase: next });
                }}
              />
            }
          />
        </ModernRows>
      </ModernSection>

      <ModernSection
        group="Rebase & stacking"
        anchor="rebase-suggestions"
        title="Rebase suggestions"
        hint="How ADE tells you a lane has fallen behind. Off also skips the scan, so it costs nothing."
      >
        <div role="radiogroup" aria-label="Rebase suggestions" className="ade-ap-grid3">
          {SUGGESTION_OPTIONS.map((option) => {
            const active = rebaseSuggestions === option.value;
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
                  setRebaseSuggestions(option.value);
                  void persist({ suggestions: option.value });
                }}
              >
                <span className="ade-ms-art" aria-hidden>
                  <SuggestionArt display={option.value} />
                </span>
                <span className="ade-modern-choice-body">
                  <span className="ade-modern-choice-title">
                    {option.label}
                    {active ? <Check size={12} weight="bold" className="ade-ap-check" /> : null}
                  </span>
                  <span className="ade-modern-choice-hint">{option.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div style={{ opacity: suggestionsOff ? 0.55 : 1 }}>
          <ModernRows>
            <ModernRow
              anchor="rebase-min-behind"
              title="Only suggest after"
              hint="Ignore lanes that are behind by fewer commits than this."
              control={
                <SettingsNumber
                  ariaLabel="Only suggest after this many commits"
                  value={minBehind}
                  min={1}
                  suffix={minBehind === 1 ? "commit" : "commits"}
                  disabled={suggestionsOff}
                  onChange={(next) => {
                    const clamped = Math.max(1, Math.floor(next));
                    setMinBehind(clamped);
                    void persist({ minBehind: clamped });
                  }}
                />
              }
            />
          </ModernRows>
        </div>
      </ModernSection>
    </div>
  );
}

const BASE_OPTIONS: ReadonlyArray<{ value: NewLaneBaseSource; label: string; hint: string; icon: Icon }> = [
  { value: "remote", label: "Remote", hint: "Fetched upstream", icon: CloudArrowDown },
  { value: "local", label: "Local", hint: "Your branch tip", icon: Laptop },
];

const SUGGESTION_OPTIONS: ReadonlyArray<{ value: RebaseSuggestionDisplay; label: string; hint: string }> = [
  { value: "off", label: "Off", hint: "Never mention it" },
  { value: "badge", label: "Badge", hint: "One quiet line" },
  { value: "banner", label: "Banner", hint: "Full strip" },
];

/** Two branches: the new lane forks from the remote tip or the local one. */
function BaseArt({ source }: { source: NewLaneBaseSource }) {
  const fromRemote = source === "remote";
  return (
    <svg width="132" height="44" viewBox="0 0 132 44" fill="none">
      {/* origin line on top, local line below */}
      <path d="M8 12 H124" stroke="currentColor" strokeOpacity={fromRemote ? 0.9 : 0.3} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 32 H84" stroke="currentColor" strokeOpacity={fromRemote ? 0.3 : 0.9} strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="124" cy="12" r="3.5" fill="currentColor" fillOpacity={fromRemote ? 0.9 : 0.3} />
      <circle cx="84" cy="32" r="3.5" fill="currentColor" fillOpacity={fromRemote ? 0.3 : 0.9} />
      {fromRemote ? (
        <path d="M124 12 C124 26 112 38 100 40" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" strokeLinecap="round" />
      ) : (
        <path d="M84 32 C96 32 104 40 116 40" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** A tiny lane card with nothing, a badge, or a banner on it. */
function SuggestionArt({ display }: { display: RebaseSuggestionDisplay }) {
  return (
    <span className="ade-lb-mini">
      {display === "banner" ? <span className="ade-lb-mini-banner" /> : null}
      <span className="ade-lb-mini-row">
        <span className="ade-lb-mini-line" />
        {display === "badge" ? <span className="ade-lb-mini-badge">3 behind</span> : null}
      </span>
      <span className="ade-lb-mini-line ade-lb-mini-line--short" />
    </span>
  );
}
