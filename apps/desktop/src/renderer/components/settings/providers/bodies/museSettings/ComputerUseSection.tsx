/** Muse's own computer-use setup on this machine: its macOS permissions and what it may control. */
import React, { useCallback, useEffect, useState } from "react";
import { COLORS, MONO_FONT, SANS_FONT, SECTION_LABEL_STYLE, primaryButton } from "../../../../lanes/laneDesignTokens";
import { usePolling } from "../../../../../hooks/usePolling";
import { useSettingsAction } from "../../../useSettingsAction";
import type {
  MuseComputerUseChoice,
  MuseComputerUseState,
  MuseSettingsRequest,
} from "../../../../../../shared/museSettings";
import type { MuseRun } from "./museSettingsShared";
import { ErrorNotice, FIELD, ROW, SMALL_BUTTON, SectionHeader, TEXT_MUTED, isOneOf } from "./museSettingsShared";

/** How often computer-use setup is re-read while Muse reports it in progress. */
const SETUP_POLL_MS = 2_000;

type ComputerUseRequest = Extract<
  MuseSettingsRequest,
  { kind: "computerUse" | "computerUseUpdate" | "computerUseSetupStart" | "computerUseSetupCheck" }
>;

const isComputerUseChoice = isOneOf<MuseComputerUseChoice>(["ask", "alwaysAllow"]);

const PERMISSIONS = [
  { key: "accessibility", label: "Accessibility" },
  { key: "screenRecording", label: "Screen Recording" },
  { key: "inputMonitoring", label: "Input Monitoring" },
] as const;

const SETUP_STATES = ["dormant", "inProgress", "restartRequired", "readyForTarget", "stopped"] as const;
type SetupState = (typeof SETUP_STATES)[number];
const isSetupState = isOneOf<SetupState>(SETUP_STATES);

const SETUP_LABEL: Record<SetupState, string> = {
  dormant: "Not set up",
  inProgress: "Setting up…",
  restartRequired: "Restart required",
  readyForTarget: "Ready",
  stopped: "Stopped",
};

export function ComputerUseSection({ run }: { run: MuseRun }) {
  const [state, setState] = useState<MuseComputerUseState | null>(null);
  const [blockApp, setBlockApp] = useState("");
  const [pollError, setPollError] = useState<string | null>(null);
  const action = useSettingsAction();
  const busy = action.busy;

  const act = useCallback(async (key: string, request: ComputerUseRequest) => {
    setPollError(null);
    const next = await action.run(key, () => run(request));
    if (next) setState(next);
  }, [action.run, run]);

  useEffect(() => {
    void act("read", { kind: "computerUse" });
  }, [act]);

  // Re-read only while Muse says setup is running. A failed read stops the poll
  // and shows its error; the next action (or Refresh) clears it and polls again.
  const inProgress = state?.available === true && state.setup?.setup === "inProgress";
  const settingUp = inProgress && pollError == null;
  usePolling(async () => {
    try {
      setState(await run({ kind: "computerUse" }));
    } catch (err) {
      setPollError(err instanceof Error ? err.message : String(err));
    }
  }, SETUP_POLL_MS, settingUp);

  let startLabel = "Set up computer use";
  if (state?.available === true && state.setup?.setup === "readyForTarget") startLabel = "Run setup again";
  if (busy === "start" || settingUp) startLabel = "Setting up…";

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHeader title="Computer use" onRefresh={() => void act("read", { kind: "computerUse" })} busy={busy === "read"} />
      <div style={TEXT_MUTED}>Muse's own computer-use setup on this machine: its macOS permissions and what it may control.</div>
      {state == null && !action.error ? <div style={TEXT_MUTED}>Loading…</div> : null}
      {state && !state.available ? (
        <div style={TEXT_MUTED}>
          Muse does not offer computer use on this machine yet. Muse said: <span style={{ fontFamily: MONO_FONT }}>{state.reason}</span>
        </div>
      ) : null}
      {state?.available ? (
        <>
          {state.setup ? (
            <>
              <div style={ROW}>
                <span>Setup</span>
                <span style={{ color: COLORS.textMuted }}>{isSetupState(state.setup.setup) ? SETUP_LABEL[state.setup.setup] : state.setup.setup}</span>
              </div>
              {PERMISSIONS.map(({ key, label }) => (
                <div key={key} style={ROW}>
                  <span>{label}</span>
                  <span style={{ color: state.setup?.[key] === "granted" ? COLORS.success : COLORS.textMuted }}>{state.setup?.[key]}</span>
                </div>
              ))}
              {state.setup.message ? <div style={TEXT_MUTED}>{state.setup.message}</div> : null}
              <ErrorNotice
                id="muse-computer-use-refused"
                message={state.setup.refused ? `Muse refused setup: ${state.setup.refused}` : null}
              />
            </>
          ) : null}
          <ErrorNotice id="muse-computer-use-setup-error" message={state.setupError} />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              style={primaryButton({ height: 26, padding: "0 10px", fontSize: 12 })}
              disabled={busy != null || settingUp}
              onClick={() => void act("start", { kind: "computerUseSetupStart" })}
            >
              {startLabel}
            </button>
            {state.hostSetup ? (
              <button type="button" style={SMALL_BUTTON} disabled={busy != null} onClick={() => void act("check", { kind: "computerUseSetupCheck" })}>
                {busy === "check" ? "Checking…" : "Check permissions"}
              </button>
            ) : null}
          </div>
          {state.settings ? (
            <>
              {(["computerControl", "screenshots"] as const).map((key) => (
                <div key={key} style={ROW}>
                  <span>{key === "computerControl" ? "Computer control" : "Screenshots"}</span>
                  <select
                    aria-label={key === "computerControl" ? "Computer control" : "Screenshots"}
                    value={state.settings?.[key] ?? "ask"}
                    disabled={busy != null}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (isComputerUseChoice(next)) void act(`set:${key}`, { kind: "computerUseUpdate", patch: { [key]: next } });
                    }}
                    style={{ ...FIELD, fontFamily: SANS_FONT }}
                  >
                    <option value="ask">Ask each time</option>
                    <option value="alwaysAllow">Always allow</option>
                  </select>
                </div>
              ))}
              <div style={{ ...SECTION_LABEL_STYLE, marginTop: 4 }}>Blocked apps</div>
              {state.settings.blockedApps.length === 0 ? <div style={TEXT_MUTED}>No apps blocked.</div> : null}
              {state.settings.blockedApps.map((app) => (
                <div key={app.bundleId} style={ROW}>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 11, overflowWrap: "anywhere" }}>
                    {app.bundleId}{app.prefix ? "*" : ""}
                  </span>
                  {app.locked ? (
                    <span style={{ color: COLORS.textDim }}>built in</span>
                  ) : (
                    <button
                      type="button"
                      style={SMALL_BUTTON}
                      disabled={busy != null}
                      onClick={() => void act(`unblock:${app.bundleId}`, { kind: "computerUseUpdate", patch: { unblockApps: [app.bundleId] } })}
                    >
                      Unblock
                    </button>
                  )}
                </div>
              ))}
              <div style={{ display: "flex", gap: 6 }}>
                <input aria-label="App bundle id to block" value={blockApp} onChange={(event) => setBlockApp(event.target.value)} placeholder="com.example.App" style={{ ...FIELD, flex: "1 1 200px" }} />
                <button
                  type="button"
                  style={SMALL_BUTTON}
                  disabled={busy != null || !blockApp.trim()}
                  onClick={() => {
                    const bundleId = blockApp.trim();
                    setBlockApp("");
                    void act("block", { kind: "computerUseUpdate", patch: { blockApps: [bundleId] } });
                  }}
                >
                  Block app
                </button>
              </div>
            </>
          ) : null}
          <ErrorNotice id="muse-computer-use-settings-error" message={state.settingsError} />
        </>
      ) : null}
      <ErrorNotice id="muse-computer-use-poll-error" message={pollError} />
      <ErrorNotice id="muse-computer-use-action-error" message={action.error} />
    </section>
  );
}
