import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, ArrowRight, CircleNotch, Desktop, UserCircle, Wrench } from "@phosphor-icons/react";
import type { AppInfo } from "../../../../shared/types";
import { updateTrackLabel } from "../../../../shared/updateTrack";
import { THIS_MACHINE_NAME } from "../../../../shared/machineIdentity";
import { useAppStore } from "../../../state/appStore";
import { accountSessionShortLabel, accountSessionState, useAccountStatus } from "../../../lib/account";
import { formatTokens } from "../../../lib/format";
import { AccountAvatar } from "../../account/AccountAvatar";
import { useAutoUpdateSnapshot } from "../../app/useAutoUpdateSnapshot";
import { requestDownloadedUpdateInstall } from "../../app/autoUpdateInstallAction";
import { updateRestartAction } from "../../app/updateRestartAction";
import { UpdateTrackChip } from "../../app/ChannelBadge";
import { MachineAvatar, machineFormFactor } from "../../remoteTargets/MachineIdentity";
import { UsageSparkline } from "../../usage/UsageSparks";
import { FreeSpaceMeter } from "../health/healthCharts";
import { formatBytes, freeSpaceLevel } from "../storage/storageView";
import { UpdateTrackControls } from "../UpdateTrackControls";
import { AutoUpdatesControls } from "../AutoUpdatesSection";
import { useNeedsAttention } from "../overview/useNeedsAttention";
import { useMachineFacts } from "../machines/machineFacts";
import { useSettingsMachines } from "../machines/settingsMachinesContext";
import { MachineUpdateRows } from "./MachineUpdateRows";
import { NeedsAttentionStrip } from "./NeedsAttentionStrip";
import "./general.css";

/** "macOS", "Windows", "Linux" for a Node platform. */
export function osLabel(platform: string | null | undefined): string | null {
  if (!platform) return null;
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

function formatCheckTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Settings → General, where Settings opens. What needs attention as one row,
 * then who you are and the machine you are on, then ADE: its version, its
 * update track, and the update state of every machine, one row each.
 *
 * Reads nothing new: the attention hook's one read on open (the same one
 * Overview made), the auto-update snapshot and the machine list Settings
 * already has. Nothing here polls.
 */
export function GeneralPage() {
  const project = useAppStore((state) => state.project);
  const hasProject = Boolean(project?.rootPath);
  const attention = useNeedsAttention({ hasProject });
  const { sources } = attention;
  const { openTab, openMachine } = useSettingsMachines();
  const projectRoot = sources.report?.projectRoot ?? project?.rootPath ?? null;

  return (
    <div className="ade-gen">
      <NeedsAttentionStrip attention={attention} hasProject={hasProject} projectRoot={projectRoot} />

      <div className="ade-gen-pair" id="at-a-glance" data-settings-anchor="at-a-glance">
        <YouCard sources={sources} onOpen={() => openTab("account")} />
        <ThisMachineCard info={sources.info} pressure={sources.pressure} onOpen={() => openMachine("this-mac")} />
      </div>

      <AdeCard info={sources.info} onOpenAdvanced={() => openTab("advanced")} />
    </div>
  );
}

type Sources = ReturnType<typeof useNeedsAttention>["sources"];

function CardHead({ icon, title, action, onAction }: { icon: React.ReactNode; title: string; action: string; onAction: () => void }) {
  return (
    <header className="kit-card-head">
      {icon}
      {title}
      <button type="button" className="kit-card-head-action" onClick={onAction}>
        {action}
        <ArrowRight size={11} />
      </button>
    </header>
  );
}

function YouCard({ sources, onOpen }: { sources: Sources; onOpen: () => void }) {
  const { status } = useAccountStatus();
  const name = status.signedIn ? status.name?.trim() || null : null;
  const email = status.signedIn ? status.email?.trim() || null : null;
  const primary = status.signedIn ? name || email || "Your ADE account" : accountSessionShortLabel(accountSessionState(status));
  const daily = sources.usage?.dailyUsage7d ?? null;
  const week = useMemo(() => {
    if (!daily) return null;
    const rows = Object.values(daily).filter((values): values is number[] => Array.isArray(values));
    if (rows.length === 0) return null;
    const length = Math.max(...rows.map((values) => values.length));
    const totals = Array.from({ length }, (_, index) => rows.reduce((sum, values) => sum + (values[index] ?? 0), 0));
    return { totals, sum: totals.reduce((sum, value) => sum + value, 0) };
  }, [daily]);
  const detected = sources.providers.filter((provider) => provider.runtimeDetected);
  const signedIn = detected.filter((provider) => provider.runtimeAvailable).length;
  const needSignIn = detected.length - signedIn;
  return (
    <section className="kit-card ade-gen-card">
      <CardHead icon={<UserCircle size={14} />} title="You" action="Account" onAction={onOpen} />
      <div className="kit-card-body ade-gen-card-body">
        <div className="ade-gen-ident">
          <AccountAvatar status={status} githubLogin={null} githubConnected={false} size={40} />
          <div className="ade-gen-ident-text">
            <div className="ade-gen-ident-name">{primary}</div>
            {name && email ? <div className="ade-gen-ident-sub">{email}</div> : null}
          </div>
        </div>
        <div className="ade-gen-line">
          <span className="kit-dot" data-state={needSignIn > 0 ? "warn" : detected.length > 0 ? "ok" : undefined} aria-hidden />
          <span>
            {detected.length === 0
              ? "No AI provider found here"
              : needSignIn > 0
                ? `${signedIn} signed in — ${needSignIn} need${needSignIn === 1 ? "s" : ""} sign-in`
                : `${signedIn} ${signedIn === 1 ? "provider" : "providers"} signed in`}
          </span>
        </div>
        <div className="ade-gen-meter">
          <div className="ade-gen-meter-label">
            <span>This week</span>
            <span className="kit-num">{week ? `${formatTokens(week.sum)} tokens` : "—"}</span>
          </div>
          {week && week.totals.length >= 2 ? (
            <UsageSparkline values={week.totals} height={26} label={`Tokens per day this week, ${formatTokens(week.sum)} in all`} />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ThisMachineCard({
  info,
  pressure,
  onOpen,
}: {
  info: AppInfo | null;
  pressure: Sources["pressure"];
  onOpen: () => void;
}) {
  const { machines } = useSettingsMachines();
  const update = useAutoUpdateSnapshot();
  const thisMachine = machines.find((machine) => machine.isThisMachine) ?? null;
  const facts = useMachineFacts(thisMachine ? [thisMachine] : [], update.currentVersion || null);
  const { thisMachineName } = useSettingsMachines();
  const name = thisMachineName ?? THIS_MACHINE_NAME;
  const runtime = info?.localRuntime ?? null;
  const serviceOk = runtime ? runtime.connectionState === "connected" && runtime.runtimeMode === "primary" : null;
  const level = pressure ? freeSpaceLevel(pressure.freeBytes, pressure.totalBytes) : undefined;
  const fact = thisMachine ? facts.get(thisMachine.machineId) : undefined;
  return (
    <section className="kit-card ade-gen-card">
      <CardHead icon={<Desktop size={14} />} title="This machine" action="Machines" onAction={onOpen} />
      <div className="kit-card-body ade-gen-card-body">
        <div className="ade-gen-ident">
          <MachineAvatar
            colorKey={fact?.colorKey ?? "this-mac"}
            name={name}
            platform={fact?.platform ?? "unknown"}
            formFactor={machineFormFactor({ name })}
            size={40}
          />
          <div className="ade-gen-ident-text">
            <div className="ade-gen-ident-name">{name}</div>
            <div className="ade-gen-ident-sub">
              {[osLabel(info?.platform), info?.arch].filter(Boolean).join(" · ") || "—"}
            </div>
          </div>
        </div>
        <div className="ade-gen-line">
          <span className="kit-dot" data-state={serviceOk == null ? undefined : serviceOk ? "ok" : "crit"} aria-hidden />
          <span>{serviceOk == null ? "Background service" : serviceOk ? "Service running" : "Service not running"}</span>
        </div>
        {pressure && pressure.totalBytes > 0 ? (
          <div className="ade-gen-meter">
            <div className="ade-gen-meter-label">
              <span>Disk</span>
              <span className="kit-num">{formatBytes(pressure.freeBytes)} free</span>
            </div>
            <FreeSpaceMeter freeBytes={pressure.freeBytes} totalBytes={pressure.totalBytes} level={level} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * ADE itself: the build on this computer and its state, with the one action
 * that state needs, then how updates arrive (track, automatic install) and
 * every machine's update, one row each.
 */
function AdeCard({ info, onOpenAdvanced }: { info: AppInfo | null; onOpenAdvanced: () => void }) {
  const snapshot = useAutoUpdateSnapshot();
  const [checking, setChecking] = useState(false);
  const [restartRequested, setRestartRequested] = useState(false);
  const isDev = info ? !info.isPackaged : false;
  const running = snapshot.currentVersion || info?.appVersion || "";
  const action = updateRestartAction(snapshot);
  const ready = snapshot.status === "ready" && Boolean(snapshot.version) && snapshot.version !== running;
  const runningTrack = snapshot.track?.running ?? null;

  useEffect(() => {
    if (snapshot.status !== "ready") setRestartRequested(false);
  }, [snapshot.status, snapshot.version]);

  const check = useCallback(() => {
    setChecking(true);
    void window.ade.updateCheckForUpdates().catch(() => undefined).finally(() => setChecking(false));
  }, []);
  const restart = useCallback(() => {
    void requestDownloadedUpdateInstall(snapshot, () => setRestartRequested(true)).then((started) => {
      if (!started) setRestartRequested(false);
    });
  }, [snapshot]);

  let state: React.ReactNode;
  if (isDev) state = "Dev build — updates are off";
  else if (ready) {
    state = action.switchTo
      ? `${updateTrackLabel(action.switchTo)} ${snapshot.version} is downloaded`
      : `${snapshot.version} is downloaded`;
  } else if (snapshot.status === "downloading") {
    state = `Downloading ${snapshot.version ?? "the update"}${snapshot.progressPercent != null ? ` — ${Math.round(snapshot.progressPercent)}%` : ""}`;
  } else if (snapshot.status === "checking" || checking) state = "Checking for updates…";
  else if (snapshot.status === "error") state = "Can't check for updates right now";
  else if (snapshot.lastCheckedAt) state = `Up to date — checked ${formatCheckTime(snapshot.lastCheckedAt)}`;
  else state = "Up to date";

  return (
    <section className="ade-gen-ade" id="about" data-settings-anchor="about">
      <div className="ade-gen-hero" data-state={ready ? "ready" : snapshot.status}>
        <div className="ade-gen-hero-wash" aria-hidden />
        <div className="ade-gen-hero-row">
          <div className="ade-gen-hero-mark">
            <img src={`${import.meta.env.BASE_URL}logo.png`} alt="ADE" draggable={false} />
          </div>
          <div className="ade-gen-hero-id">
            <div className="ade-gen-hero-version">
              <span className="kit-num">{running || "—"}</span>
              {runningTrack ? <UpdateTrackChip track={runningTrack} /> : null}
            </div>
            <div className="ade-gen-hero-state">{state}</div>
          </div>
          <div className="ade-gen-hero-action">
            {isDev ? null : ready ? (
              <button type="button" className="ade-gen-hero-btn" data-tone="primary" disabled={restartRequested} onClick={restart}>
                {restartRequested ? <CircleNotch size={13} className="animate-spin" /> : <ArrowClockwise size={13} weight="bold" />}
                {restartRequested ? "Restarting…" : action.label}
              </button>
            ) : (
              <button
                type="button"
                className="ade-gen-hero-btn"
                disabled={checking || snapshot.status === "checking" || snapshot.status === "downloading"}
                onClick={check}
              >
                <ArrowClockwise size={13} className={checking || snapshot.status === "checking" ? "animate-spin" : undefined} />
                Check for updates
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="ade-gen-ade-body">
        {/* Renders nothing for a build with no track (dev, Alpha). */}
        <UpdateTrackControls snapshot={snapshot} />
        <AutoUpdatesControls />
        <MachineUpdateRows />
        <button type="button" className="ade-gen-advanced" onClick={onOpenAdvanced}>
          <Wrench size={13} aria-hidden />
          <span>Advanced</span>
          <span className="ade-gen-advanced-hint">service, command line, reports</span>
          <ArrowRight size={12} aria-hidden />
        </button>
      </div>
    </section>
  );
}
