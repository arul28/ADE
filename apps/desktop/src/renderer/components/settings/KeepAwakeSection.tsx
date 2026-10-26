import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Coffee, Laptop, MoonStars, WarningCircle, type Icon } from "@phosphor-icons/react";
import type {
  KeepAwakeLevel,
  KeepAwakeSnapshot,
} from "../../../shared/types/keepAwake";
import {
  INERT_KEEP_AWAKE_SNAPSHOT,
  systemSleepStopsAgents,
} from "../../../shared/types/keepAwake";
import { isMacRuntimeTarget } from "../../lib/platform";
import { Banner } from "../ui/notice";
import { ModernSection } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import "./machineSettings.css";

/**
 * Whether ADE may hold this machine awake while agents work.
 *
 * Every level carries its own limit on one line, because the limits are what
 * people get wrong. The "While I'm away" line is the load-bearing one: a wake
 * lock stops idle sleep and does NOT survive a closed lid. That was measured,
 * not assumed — an assertion held for 35 days sat through two clamshell
 * sleeps — so nothing here may be softened into implying otherwise.
 *
 * Below the levels sits the thing ADE cannot fix from inside the app: the
 * platform's own sleep timer on wall power, which stops agents at whatever
 * level is selected. It is read from `pmset` / `powercfg` and offered a Fix.
 */

const LEVEL_COPY: Record<KeepAwakeLevel, { label: string; limit: string }> = {
  never: {
    label: "Never",
    limit: "Turns pause when this computer sleeps",
  },
  "while-away": {
    label: "While I'm away",
    limit: "Stops idle sleep. Not the lid.",
  },
  "lid-closed": {
    // `pmset -a disablesleep 1` covers every power source and is deliberately
    // left in place when ADE quits, so "once" was only half the story: a user
    // could turn this on, quit, and put the Mac in a bag still awake.
    label: "Even with the lid closed",
    limit: "Needs your password. Stays on after you quit.",
  },
};

/** The picture on each level's card. */
const LEVEL_ART: Record<KeepAwakeLevel, Icon> = {
  never: MoonStars,
  "while-away": Coffee,
  "lid-closed": Laptop,
};

/** The same three lines, said about a machine that is not a Mac. */
const WINDOWS_NEVER_LIMIT = "Turns pause when this PC sleeps";

const inertSnapshot = INERT_KEEP_AWAKE_SNAPSHOT;

/**
 * The levels a machine can honour. `lid-closed` is absent on Windows, not
 * disabled: there is no `pmset disablesleep` equivalent, and a greyed row would
 * imply one is coming.
 */
function availableLevels(snapshot: KeepAwakeSnapshot): KeepAwakeLevel[] {
  if (snapshot.platform === "other") return ["never"];
  if (snapshot.lidClosedSupported) return ["never", "while-away", "lid-closed"];
  return ["never", "while-away"];
}

/** The line under a level's title, said about the machine it applies to. */
function levelLimit(
  level: KeepAwakeLevel,
  machine: { platform: KeepAwakeSnapshot["platform"]; isThisMachine: boolean; mac: boolean },
): string {
  if (level === "lid-closed" && !machine.isThisMachine) {
    return "Needs approval on that Mac. Stays on after you quit.";
  }
  if (level !== "never") return LEVEL_COPY[level].limit;
  if (machine.platform === "windows") return WINDOWS_NEVER_LIMIT;
  if (machine.platform === "other") return "Turns pause when this computer sleeps";
  return machine.mac ? "Turns pause when this Mac sleeps" : WINDOWS_NEVER_LIMIT;
}

/**
 * The stored level says "lid closed" but the machine says it can still sleep.
 *
 * The two drift apart without ADE touching anything: `sudo pmset -a
 * disablesleep 0` from a terminal, or an OS update that resets it. Nothing
 * fails, so `levelError` stays null and the radio stays selected — which is
 * exactly the state where ADE would be promising a Mac stays awake for a turn
 * that the Mac is about to sleep through. `levelError` wins when it is set:
 * it explains the same disagreement in more detail.
 */
function lidClosedOutOfForce(snapshot: KeepAwakeSnapshot): boolean {
  return snapshot.preferences.level === "lid-closed"
    && snapshot.lidClosedSupported
    && !snapshot.lidClosedActive
    && !snapshot.levelError;
}


export function KeepAwakeControls() {
  const { pin, isThisMachine, machineName } = useSettingsMachineScope();
  const pinKey = pin?.key ?? null;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const [snapshot, setSnapshot] = useState<KeepAwakeSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [levelActionError, setLevelActionError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  const loadRequest = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const activePin = pinRef.current;
      const next = activePin
        ? await window.ade.keepAwakeGet(activePin)
        : await window.ade.keepAwakeGet();
      if (mounted.current && request === loadRequest.current) {
        setSnapshot(next);
        setLoadError(null);
      }
    } catch {
      if (mounted.current && request === loadRequest.current) {
        setSnapshot(null);
        setLoadError("Couldn't load this machine's keep-awake setting.");
      }
    }
  }, [pinKey]);

  useEffect(() => {
    setSnapshot(null);
    setLoadError(null);
    setLevelActionError(null);
    void load();
  }, [load, attempt, pinKey]);

  const current = snapshot ?? inertSnapshot;
  const mac = snapshot?.platform ? snapshot.platform === "mac" : isMacRuntimeTarget();

  const choose = useCallback(
    async (level: KeepAwakeLevel) => {
      if (busy) return;
      setBusy(true);
      setFixError(null);
      setLevelActionError(null);
      try {
        const activePin = pinRef.current;
        if (level === "lid-closed" && !isThisMachine) {
          setLevelActionError(`Open Settings on ${machineName} to authorize lid-closed mode.`);
          return;
        }
        if (isThisMachine && current.platform === "mac") {
          const shouldEnableLid = level === "lid-closed" && !current.lidClosedActive;
          const shouldDisableLid = current.preferences.level === "lid-closed"
            && level !== "lid-closed"
            && current.lidClosedActive;
          if (shouldEnableLid || shouldDisableLid) {
            // This Mac's own admin prompt: plain IPC, never pinned, even when
            // the page reaches this computer through a pinned binding.
            const result = await window.ade.keepAwakeApplyLidClosed(shouldEnableLid);
            if (!result.ok) {
              setLevelActionError(result.error ?? "macOS couldn't change lid-closed mode.");
              return;
            }
          }
        }
        const next = activePin
          ? await window.ade.keepAwakeSetLevel(level, activePin)
          : await window.ade.keepAwakeSetLevel(level);
        if (mounted.current) {
          setSnapshot(next);
          // A save that worked disproves whatever the last failure said. Left
          // up, "ADE couldn't save that." sits beside a control that just did.
          // This is the renderer's own transient error only — `levelError`
          // belongs to the snapshot and reports a level that is stored but not
          // in force, which a successful save does not disprove.
          setLoadError(null);
        }
      } catch {
        if (mounted.current) setLevelActionError("ADE couldn't save that.");
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [busy, current, isThisMachine, machineName, pinKey],
  );

  const fix = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setFixError(null);
    try {
      if (!isThisMachine && current.platform === "mac") {
        setFixError(`Open Settings on ${machineName} to change its macOS sleep timer.`);
        return;
      }
      const activePin = pinRef.current;
      const result = activePin
        ? await window.ade.keepAwakeFixSystemSleep(activePin)
        : await window.ade.keepAwakeFixSystemSleep();
      if (!mounted.current) return;
      if (result.snapshot) {
        setSnapshot((previous) => previous
          ? { ...previous, systemSleep: result.snapshot.systemSleep }
          : result.snapshot);
      }
      if (!result.ok) setFixError(result.error ?? "That didn't work.");
    } catch {
      if (mounted.current) setFixError("That didn't work.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy, current.platform, isThisMachine, machineName, pinKey]);

  const levels = availableLevels(current);

  const systemSleep = current.systemSleep;
  const warn = systemSleepStopsAgents(systemSleep);

  // A machine that can only ever "never" has nothing to pick: one quiet row
  // says so, instead of a lone selected card that looks like a broken picker.
  if (levels.length === 1 && levels[0] === "never" && current.preferences.level === "never") {
    return (
      <div className="ade-modern-note" style={{ alignItems: "center" }}>
        <MoonStars size={14} />
        <span>ADE can't keep {isThisMachine ? "this computer" : machineName} awake here, so turns pause when it sleeps.</span>
      </div>
    );
  }

  return (
    <div className="ade-modern-stack">
      <div
        role="radiogroup"
        aria-label={isThisMachine && mac
          ? "Keep this Mac awake while agents work"
          : isThisMachine
            ? "Keep this PC awake while agents work"
            : `Keep ${machineName} awake while agents work`}
        className="ade-ap-grid3"
        style={levels.length === 2 ? { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } : undefined}
      >
        {levels.map((level) => {
          const selected = current.preferences.level === level;
          const copy = LEVEL_COPY[level];
          const limit = levelLimit(level, { platform: current.platform, isThisMachine, mac });
          const Art = LEVEL_ART[level];
          return (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={busy || !snapshot}
              onClick={() => void choose(level)}
              className="ade-ap-choice"
              data-active={selected}
            >
              <span className="ade-ms-art" aria-hidden>
                <Art size={26} weight={selected ? "duotone" : "light"} />
              </span>
              <span className="ade-modern-choice-body">
                <span className="ade-modern-choice-title">
                  {copy.label}
                  {selected ? <Check size={12} weight="bold" className="ade-ap-check" /> : null}
                </span>
                <span className="ade-modern-choice-hint">{limit}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/*
        Rendered from what the machine reports, not from what ADE stored. The
        button re-runs the ordinary set path, which is what puts the switch
        back (and asks for the password again).
      */}
      {lidClosedOutOfForce(current) ? (
        <div className="ade-modern-note" data-tone="warn" style={{ alignItems: "center" }}>
          <WarningCircle size={14} weight="fill" style={{ marginTop: 0 }} />
          {/*
            The live region is the SENTENCE, not the row. `role="alert"` around
            the button too would put a focusable control inside a live region,
            which screen readers re-announce on every re-render of the row and
            announce out of order with the focus itself.
          */}
          <span role="alert" style={{ flex: 1 }}>This Mac can still sleep.</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void choose("lid-closed")}
            className="ade-modern-btn"
            data-size="sm"
          >
            Turn on again
          </button>
        </div>
      ) : null}

      {current.levelError ? (
        <p role="alert" className="ade-modern-warn">{current.levelError}</p>
      ) : null}

      {levelActionError ? (
        <p role="alert" className="ade-modern-error">{levelActionError}</p>
      ) : null}

      {loadError ? (
        <Banner
          layout="inline"
          model={{
            id: "keep-awake-load-error",
            tone: "warning",
            title: loadError,
            actions: [{ label: "Try again", onClick: () => setAttempt((value) => value + 1) }],
          }}
        />
      ) : null}

      {warn && systemSleep ? (
        <div className="ade-modern-note" data-tone="warn">
          <WarningCircle size={14} weight="fill" />
          <div className="ade-modern-note-body">
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span style={{ flex: "1 1 220px" }}>
                {mac
                  ? "macOS sleeps this Mac on power when the display is off. Agents will stop anyway."
                  : "Windows sleeps this PC on power when it's idle. Agents will stop anyway."}
              </span>
              {systemSleep.fixable ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void fix()}
                  className="ade-modern-btn"
                  data-size="sm"
                >
                  {/* The password cost is stated on the button, not discovered
                      after the click. */}
                  {systemSleep.fixNeedsPassword ? "Fix — needs your password" : "Fix"}
                </button>
              ) : null}
            </div>
            {fixError ? (
              <span role="alert" className="ade-modern-error">{fixError}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function KeepAwakeSection() {
  const { isThisMachine, machineName } = useSettingsMachineScope();
  const mac = isMacRuntimeTarget();
  return (
    <ModernSection
      group="Sleep"
      anchor="keep-awake"
      title={!isThisMachine
        ? `Keep ${machineName} awake while agents work`
        : mac
          ? "Keep this Mac awake while agents work"
          : "Keep this PC awake while agents work"}
      hint="A sleeping computer pauses every agent turn."
    >
      <KeepAwakeControls />
    </ModernSection>
  );
}
