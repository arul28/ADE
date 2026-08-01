import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { COLORS, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import type { NewLaneBaseSource, RebaseSuggestionDisplay } from "../../../shared/types";
import {
  DEFAULT_REBASE_SUGGESTIONS,
  DEFAULT_REBASE_SUGGESTION_MIN_BEHIND,
} from "../../../shared/types/config";
import { DEFAULT_NEW_LANE_BASE_SOURCE, effectiveNewLaneBaseSource } from "../lanes/newLaneBaseSource";
import {
  SavedFlash,
  SettingsCard,
  SettingsGroup,
  SettingsNumber,
  SettingsSegmented,
  SettingsToggle,
  useSavedFlash,
} from "./primitives";

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
    const snapshot = await window.ade.projectConfig.get();
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
  }, []);

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
      const snapshot = await window.ade.projectConfig.get();
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
      });
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
  }, [autoRebase, newLaneBaseSource, rebaseSuggestions, minBehind, flash, fail, refresh]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <SettingsGroup title="Starting lanes">
        <SettingsCard
          anchor="new-lane-base"
          title="New lane base"
          description="Whether new root lanes and chat-created lanes start from the fetched remote branch or your local tip."
          control={
            <SettingsSegmented
              ariaLabel="New lane base"
              value={newLaneBaseSource}
              onChange={(next) => {
                setNewLaneBaseSource(next);
                void persist({ baseSource: next });
              }}
              options={[
                { value: "remote", label: "Remote", hint: "Fetched upstream" },
                { value: "local", label: "Local", hint: "Your branch tip" },
              ]}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Rebase & stacking">
        <SettingsCard
          anchor="auto-rebase"
          title="Auto-rebase child lanes"
          description="Rebase dependent lanes when a parent advances, keeping stacks aligned."
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <SavedFlash state={saveState} />
              <SettingsToggle
                label="Auto-rebase child lanes"
                checked={autoRebase}
                onChange={(next) => {
                  setAutoRebase(next);
                  void persist({ autoRebase: next });
                }}
              />
            </div>
          }
        />

        <SettingsCard
          anchor="rebase-suggestions"
          title="Rebase suggestions"
          description="How ADE tells you a lane has fallen behind. Off also skips the scan, so it costs nothing."
          control={
            <SettingsSegmented
              ariaLabel="Rebase suggestions"
              value={rebaseSuggestions}
              onChange={(next) => {
                setRebaseSuggestions(next);
                void persist({ suggestions: next });
              }}
              options={[
                { value: "off", label: "Off", hint: "Never mention it" },
                { value: "badge", label: "Badge", hint: "One quiet line" },
                { value: "banner", label: "Banner", hint: "Full strip" },
              ]}
            />
          }
        />

        <SettingsCard
          anchor="rebase-min-behind"
          title="Only suggest after"
          description="Ignore lanes that are behind by fewer commits than this."
          disabled={rebaseSuggestions === "off"}
          control={
            <SettingsNumber
              ariaLabel="Only suggest after this many commits"
              value={minBehind}
              min={1}
              suffix={minBehind === 1 ? "commit" : "commits"}
              disabled={rebaseSuggestions === "off"}
              onChange={(next) => {
                const clamped = Math.max(1, Math.floor(next));
                setMinBehind(clamped);
                void persist({ minBehind: clamped });
              }}
            />
          }
        />

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            style={{
              ...outlineButton({ height: 28, padding: "0 10px", fontSize: 11 }),
              fontFamily: SANS_FONT,
              color: COLORS.textSecondary,
            }}
            onClick={() => navigate("/prs?tab=workflows&workflow=rebase")}
          >
            Open Rebase/Merge tab
          </button>
        </div>
      </SettingsGroup>
    </div>
  );
}
