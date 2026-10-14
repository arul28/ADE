/**
 * Muse Code's right-hand body: the page that coordinates the Muse Settings
 * sections (plugins and marketplaces, skills, hooks, computer use, feedback).
 *
 * Every call goes to the machine the Settings page is showing
 * (`useSettingsMachineScope().pin`) and runs on a Settings-owned `muse serve`
 * host there, one per page visit: `useMuseSettingsHost` mints the visit's
 * `handleId`, and closes that host when it unmounts or the page switches
 * machine. A chat's host is never touched. Muse's own errors are shown as Muse
 * words them; ADE does not paper over them.
 */
import React, { useCallback, useEffect, useState } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { MONO_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { useSettingsMachineScope } from "../../SettingsMachineScope";
import { useSettingsAction } from "../../useSettingsAction";
import type { MuseSettingsSnapshot } from "../../../../../shared/museSettings";
import type { OpenProjectBinding } from "../../../../../shared/types";
import type { ProvidersViewContext } from "../types";
import { ComputerUseSection } from "./museSettings/ComputerUseSection";
import { FeedbackSection } from "./museSettings/FeedbackSection";
import { HooksSection } from "./museSettings/HooksSection";
import { PluginsSection } from "./museSettings/PluginsSection";
import { SkillsSection } from "./museSettings/SkillsSection";
import { DIVIDER_STYLE, ErrorNotice, TEXT_MUTED } from "./museSettings/museSettingsShared";
import { useMuseSettingsHost } from "./museSettings/useMuseSettingsHost";

export function MuseBody({ ctx }: { ctx: ProvidersViewContext }) {
  const { pin } = useSettingsMachineScope();
  const connection = ctx.status?.providerConnections?.muse ?? null;
  const ready = Boolean(connection?.runtimeDetected);
  if (ctx.isInitialCheckInFlight) return <div style={TEXT_MUTED}>Checking Muse…</div>;
  if (!ready) {
    return (
      <div style={TEXT_MUTED}>
        Download Muse (left) to manage its plugins, skills, hooks, and computer use on this machine.
      </div>
    );
  }
  return <MuseSettingsPanels key={pin?.key ?? "local"} pin={pin} />;
}

function MuseSettingsPanels({ pin }: { pin: OpenProjectBinding | null }) {
  const { run } = useMuseSettingsHost(pin);
  const [snapshot, setSnapshot] = useState<MuseSettingsSnapshot | null>(null);
  const snapshotAction = useSettingsAction();
  const loading = snapshotAction.busy === "snapshot";

  const reload = useCallback(async () => {
    await snapshotAction.run("snapshot", async () => {
      setSnapshot(await run({ kind: "snapshot" }));
    });
  }, [run, snapshotAction.run]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={TEXT_MUTED}>
          Read from Muse on this machine{snapshot ? <> for <span style={{ fontFamily: MONO_FONT }}>{snapshot.workspaceRoot}</span></> : null}.
        </div>
        <button type="button" style={outlineButton({ height: 26, padding: "0 10px", fontSize: 12 })} disabled={loading} onClick={() => void reload()}>
          <ArrowsClockwise size={11} weight="bold" /> {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <ErrorNotice id="muse-snapshot-error" message={snapshotAction.error} />
      {snapshot == null && !snapshotAction.error ? <div style={TEXT_MUTED}>Starting Muse…</div> : null}
      {snapshot ? (
        <>
          <PluginsSection snapshot={snapshot} run={run} reload={reload} />
          <div style={DIVIDER_STYLE} />
          <SkillsSection snapshot={snapshot} run={run} reload={reload} />
          <div style={DIVIDER_STYLE} />
          <HooksSection snapshot={snapshot} />
        </>
      ) : null}
      <div style={DIVIDER_STYLE} />
      <ComputerUseSection run={run} />
      <div style={DIVIDER_STYLE} />
      <FeedbackSection run={run} />
    </div>
  );
}
