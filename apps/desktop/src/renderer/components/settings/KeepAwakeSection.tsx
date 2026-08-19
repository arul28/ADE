import { useCallback, useEffect, useRef, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import type {
  KeepAwakeLevel,
  KeepAwakeSnapshot,
} from "../../../shared/types/keepAwake";
import {
  INERT_KEEP_AWAKE_SNAPSHOT,
  systemSleepStopsAgents,
} from "../../../shared/types/keepAwake";
import { COLORS, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { isMacRuntimeTarget } from "../../lib/platform";
import { SettingsCard, SettingsGroup } from "./primitives";

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
    limit: "Turns pause when this Mac sleeps",
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

/** The same three lines, said about a machine that is not a Mac. */
const WINDOWS_NEVER_LIMIT = "Turns pause when this PC sleeps";

const inertSnapshot = INERT_KEEP_AWAKE_SNAPSHOT;

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
  const [snapshot, setSnapshot] = useState<KeepAwakeSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await window.ade.keepAwakeGet();
      if (mounted.current) {
        setSnapshot(next);
        setLoadError(null);
      }
    } catch {
      if (mounted.current) setLoadError("This setting isn't available right now.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = snapshot ?? inertSnapshot;
  const mac = isMacRuntimeTarget();

  const choose = useCallback(
    async (level: KeepAwakeLevel) => {
      if (busy) return;
      setBusy(true);
      setFixError(null);
      try {
        const next = await window.ade.keepAwakeSetLevel(level);
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
        if (mounted.current) setLoadError("ADE couldn't save that.");
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [busy],
  );

  const fix = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setFixError(null);
    try {
      const result = await window.ade.keepAwakeFixSystemSleep();
      if (!mounted.current) return;
      setSnapshot(result.snapshot);
      if (!result.ok) setFixError(result.error ?? "That didn't work.");
    } catch {
      if (mounted.current) setFixError("That didn't work.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy]);

  // `lid-closed` is absent on Windows, not disabled: there is no `pmset
  // disablesleep` equivalent, and a greyed row would imply one is coming.
  const levels: KeepAwakeLevel[] = current.lidClosedSupported
    ? ["never", "while-away", "lid-closed"]
    : ["never", "while-away"];

  const systemSleep = current.systemSleep;
  const warn = systemSleepStopsAgents(systemSleep);

  return (
    <div
      role="radiogroup"
      aria-label={mac
        ? "Keep this Mac awake while agents work"
        : "Keep this PC awake while agents work"}
      style={{ display: "flex", flexDirection: "column", gap: 2 }}
    >
      {levels.map((level) => {
        const selected = current.preferences.level === level;
        const copy = LEVEL_COPY[level];
        const limit = level === "never" && !mac ? WINDOWS_NEVER_LIMIT : copy.limit;
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={busy || !snapshot}
            onClick={() => void choose(level)}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "9px 8px",
              border: "none",
              borderRadius: 8,
              background: selected
                ? "color-mix(in srgb, var(--color-accent) 10%, transparent)"
                : "transparent",
              cursor: busy || !snapshot ? "not-allowed" : "pointer",
              textAlign: "left",
              width: "100%",
            }}
          >
            <span
              aria-hidden
              style={{
                marginTop: 2,
                width: 13,
                height: 13,
                flexShrink: 0,
                borderRadius: "50%",
                border: `1px solid ${selected ? COLORS.accent : COLORS.outlineBorder}`,
                background: selected ? COLORS.accent : "transparent",
                boxShadow: selected ? "inset 0 0 0 2.5px var(--color-bg)" : undefined,
              }}
            />
            <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
              <span
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 13,
                  fontWeight: selected ? 600 : 500,
                  color: COLORS.textPrimary,
                }}
              >
                {copy.label}
              </span>
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
                {limit}
              </span>
            </span>
          </button>
        );
      })}

      {/*
        Rendered from what the machine reports, not from what ADE stored. The
        button re-runs the ordinary set path, which is what puts the switch
        back (and asks for the password again).
      */}
      {lidClosedOutOfForce(current) ? (
        <div
          style={{
            marginTop: 6,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          {/*
            The live region is the SENTENCE, not the row. `role="alert"` around
            the button too would put a focusable control inside a live region,
            which screen readers re-announce on every re-render of the row and
            announce out of order with the focus itself.
          */}
          <span
            role="alert"
            style={{
              fontFamily: SANS_FONT,
              fontSize: 11,
              lineHeight: 1.5,
              color: COLORS.warning,
            }}
          >
            This Mac can still sleep.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void choose("lid-closed")}
            style={outlineButton({ height: 24, padding: "0 9px", fontSize: 11 })}
          >
            Turn on again
          </button>
        </div>
      ) : null}

      {current.levelError ? (
        <div
          role="alert"
          style={{
            marginTop: 6,
            fontFamily: SANS_FONT,
            fontSize: 11,
            lineHeight: 1.5,
            color: COLORS.warning,
          }}
        >
          {current.levelError}
        </div>
      ) : null}

      {loadError ? (
        <div
          role="alert"
          style={{ marginTop: 6, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.danger }}
        >
          {loadError}
        </div>
      ) : null}

      {warn && systemSleep ? (
        <div
          style={{
            marginTop: 10,
            padding: "10px 11px",
            borderRadius: 8,
            border: `1px solid ${COLORS.warning}44`,
            background: `${COLORS.warning}10`,
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <WarningCircle
              size={14}
              weight="fill"
              color={COLORS.warning}
              style={{ flexShrink: 0, marginTop: 1 }}
            />
            <span
              style={{
                fontFamily: SANS_FONT,
                fontSize: 11.5,
                lineHeight: 1.5,
                color: COLORS.textSecondary,
              }}
            >
              {mac
                ? "macOS sleeps this Mac on power when the display is off. Agents will stop anyway."
                : "Windows sleeps this PC on power when it's idle. Agents will stop anyway."}
            </span>
          </div>
          {systemSleep.fixable ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void fix()}
              style={{
                ...outlineButton({ height: 26, padding: "0 10px", fontSize: 11 }),
                justifySelf: "end",
              }}
            >
              {/* The password cost is stated on the button, not discovered
                  after the click. */}
              {systemSleep.fixNeedsPassword ? "Fix — needs your password" : "Fix"}
            </button>
          ) : null}
          {fixError ? (
            <div
              role="alert"
              style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.danger }}
            >
              {fixError}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function KeepAwakeSection() {
  const mac = isMacRuntimeTarget();
  return (
    <SettingsGroup title="Sleep">
      <SettingsCard
        anchor="keep-awake"
        title={mac
          ? "Keep this Mac awake while agents work"
          : "Keep this PC awake while agents work"}
        stacked
      >
        <KeepAwakeControls />
      </SettingsCard>
    </SettingsGroup>
  );
}
