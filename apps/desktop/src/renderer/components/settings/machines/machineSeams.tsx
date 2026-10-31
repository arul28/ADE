/**
 * What the personal-mesh work (lane `8fbb5263` and its stack) adds to a
 * machine's page: its load and what it can run (`machine_stats.get`, read by
 * that machine's own brain through the page's pin), how often new work should
 * go to it (the placement preference, kept in the account). Each renders
 * nothing until a real source answers — no placeholders, no invented values.
 * The copies of other machines' work it holds are `MachineWorkCopies.tsx`.
 */
import { useState, type ReactNode } from "react";
import {
  AppleLogo,
  ArrowClockwise,
  BatteryHigh,
  Coffee,
  GitBranch,
  Key,
  Scales,
} from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import type { MachinePlacementPreference, MachineStats } from "../../../../shared/types/machineStats";
import { THIS_MACHINE_ID } from "../../../../shared/machineIdentity";
import { relativeWhen } from "../../../lib/format";
import { useMachinePlacementPreferences } from "../../../state/machinePlacement";
import { useMachineStatsMap } from "../../../state/machineStats";
import { showToast } from "../../app/toast/toastStore";
import { SettingsSelect } from "../primitives";
import { formatBytes, freeSpaceLevel } from "../storage/storageView";

/** What a machine can run and how busy it is, as its brain reports it. */
export type MachineCapabilities = MachineStats;

/** How often other machines should send work here. */
export type MachinePreference = MachinePlacementPreference;

/** Amber at 20% left, red at 5%: the one headroom rule every meter uses. */
export function headroomLevel(percentLeft: number): "warn" | "crit" | undefined {
  if (percentLeft <= 5) return "crit";
  if (percentLeft <= 20) return "warn";
  return undefined;
}

export function Meter({ percent, level, label }: { percent: number; level: "warn" | "crit" | undefined; label: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="kit-meter" data-level={level} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)}>
      <span style={{ width: `${clamped}%` }} />
    </div>
  );
}

function Tile({ label, value, sub, meter }: { label: string; value: ReactNode; sub?: ReactNode; meter?: ReactNode }) {
  return (
    <div className="ade-mx-stat">
      <span className="kit-eyebrow">{label}</span>
      <span className="ade-mx-stat-value kit-num">{value}</span>
      {meter ?? <span className="ade-mx-stat-gap" aria-hidden />}
      {sub ? <span className="ade-mx-stat-sub">{sub}</span> : null}
    </div>
  );
}

function StatRow({ icon, title, value, control }: { icon: ReactNode; title: string; value?: ReactNode; control?: ReactNode }) {
  return (
    <div className="ade-mx-srow">
      <span className="ade-mx-srow-icon" aria-hidden>{icon}</span>
      <span className="ade-mx-srow-text">
        <span className="ade-mx-srow-title">{title}</span>
        {value != null && value !== "" ? <span className="ade-mx-srow-value">{value}</span> : null}
      </span>
      <span className="ade-mx-srow-control">{control}</span>
    </div>
  );
}

/** "On power", "On battery · 54%", "Plugged in · 100%"; null when unknown. */
export function powerWords(power: MachineStats["power"]): string | null {
  if (!power) return null;
  if (!power.hasBattery) return "Always on power";
  const percent = power.batteryPercent != null ? ` · ${power.batteryPercent}%` : "";
  return power.onBattery ? `On battery${percent}` : `Plugged in${percent}`;
}

/**
 * "Right now" and "What it can run" on a machine's page: CPU over a short
 * sample, memory free, disk, builds running, power and sleep; Xcode and its
 * simulators, the CLIs signed in there (never a token), and the work copies
 * it keeps. Read when the page opens and on Refresh; nothing polls.
 */
export function MachineCapabilitiesArea({
  pin,
  reach,
  isThisMachine,
}: {
  pin: OpenProjectBinding | null;
  reach: boolean;
  isThisMachine: boolean;
}): ReactNode {
  const requests = reach ? [{ id: "machine", pin }] : [];
  const { stats, refresh } = useMachineStatsMap(requests, reach);
  const value = stats.get("machine");
  if (!reach || !value) return null;
  const busy = value.cpu.busyPercent;
  const memoryFreePct = value.memory.totalBytes > 0 ? (value.memory.availableBytes / value.memory.totalBytes) * 100 : 0;
  const builds = value.builds ?? [];
  const buildCount = builds.reduce((sum, build) => sum + build.count, 0);
  const signedIn = value.clis?.filter((cli) => cli.signedIn) ?? null;
  const power = powerWords(value.power);
  const where = isThisMachine ? "this machine" : "that machine";

  return (
    <>
      <section className="ade-mx-group">
        <div className="ade-mx-group-head">
          <h2 className="kit-eyebrow ade-mx-group-title">Right now</h2>
          <button type="button" className="ade-mx-group-action" onClick={refresh} title="Read again">
            <ArrowClockwise size={11} weight="bold" aria-hidden />
            {`Read ${relativeWhen(new Date(value.at).toISOString())}`}
          </button>
        </div>
        <div className="ade-mx-group-rows">
          <div className="ade-mx-stats">
            <Tile
              label="CPU"
              value={busy == null ? "—" : `${busy}%`}
              meter={busy == null ? undefined : <Meter percent={busy} level={headroomLevel(100 - busy)} label="CPU busy" />}
              sub={[`${value.cpu.cores} cores`, value.cpu.model].filter(Boolean).join(" · ")}
            />
            <Tile
              label="Memory free"
              value={formatBytes(value.memory.availableBytes)}
              meter={<Meter percent={memoryFreePct} level={headroomLevel(memoryFreePct)} label="Memory free" />}
              sub={`of ${formatBytes(value.memory.totalBytes)}`}
            />
            {/* This computer's page already has its Disk row. */}
            {value.disk && !isThisMachine ? (
              <Tile
                label="Disk free"
                value={formatBytes(value.disk.freeBytes)}
                meter={<Meter percent={(value.disk.freeBytes / value.disk.totalBytes) * 100} level={freeSpaceLevel(value.disk.freeBytes, value.disk.totalBytes)} label="Disk free" />}
                sub={`of ${formatBytes(value.disk.totalBytes)}`}
              />
            ) : null}
            <Tile
              label="Builds"
              value={value.builds == null ? "—" : String(buildCount)}
              sub={value.builds == null ? "Checking…" : buildCount === 0 ? "None running" : builds.map((build) => (build.count > 1 ? `${build.tool} ×${build.count}` : build.tool)).join(", ")}
            />
          </div>
          {power ? (
            <StatRow icon={<BatteryHigh size={14} />} title="Power" value={power} />
          ) : null}
          {value.sleep ? (
            <StatRow
              icon={<Coffee size={14} />}
              title="Sleep"
              value={value.sleep.lidClosedAwake
                ? "Kept awake by ADE, even with the lid closed"
                : value.sleep.keptAwake
                  ? "Kept awake by ADE while you're away"
                  : value.power?.hasBattery ? "Can sleep — work there stops when it does" : "Can sleep when idle"}
            />
          ) : null}
        </div>
      </section>

      <section className="ade-mx-group">
        <h2 className="kit-eyebrow ade-mx-group-title">What it can run</h2>
        <div className="ade-mx-group-rows">
          {value.platform === "darwin" ? (
            <StatRow
              icon={<AppleLogo size={14} />}
              title="Xcode"
              value={value.slowAt == null
                ? "Checking…"
                : value.xcode
                  ? `Xcode ${value.xcode.version} · ${value.xcode.simulators === 1 ? "1 simulator" : `${value.xcode.simulators} simulators`}${value.xcode.bootedSimulators > 0 ? ` · ${value.xcode.bootedSimulators} running` : ""}`
                  : `Not installed on ${where}`}
            />
          ) : null}
          <StatRow
            icon={<Key size={14} />}
            title="Signed in"
            value={signedIn == null
              ? "Checking…"
              : signedIn.length === 0
                ? "No developer CLIs signed in"
                : <span className="ade-mx-chips">{signedIn.map((cli) => <span key={cli.id} className="kit-tag" title={`${cli.id} is signed in on ${where}`}>{cli.label}</span>)}</span>}
          />
          <StatRow
            icon={<GitBranch size={14} />}
            title="Work copies"
            value={value.workCopies == null
              ? "Checking…"
              : value.workCopies.count === 0
                ? "None"
                : `${value.workCopies.count === 1 ? "1 copy" : `${value.workCopies.count} copies`}${value.workCopies.sizeBytes != null ? ` · ${formatBytes(value.workCopies.sizeBytes)}` : ""}`}
          />
        </div>
      </section>
    </>
  );
}

const PREFERENCE_OPTIONS: ReadonlyArray<{ value: MachinePlacementPreference; label: string; hint: string }> = [
  { value: "prefer", label: "Prefer", hint: "Gets new work first" },
  { value: "normal", label: "Normal", hint: "Shares new work by load" },
  { value: "less-often", label: "Less often", hint: "Gets new work when others are busy" },
  { value: "manual", label: "Manual only", hint: "Only when you pick it" },
];

/**
 * "New work": how often "Least loaded" sends new lanes and chats here.
 * Kept in the account under the machine's key, so every machine and the
 * phone read the same answer; changeable from any machine, online or not.
 */
export function MachinePreferenceRow({ machineKey, name }: { machineKey: string | null; name: string }): ReactNode {
  const { preferenceOf, setPreference } = useMachinePlacementPreferences();
  const [saving, setSaving] = useState(false);
  // This computer's key is read once at start; until then there is nothing to file it under.
  const known = Boolean(machineKey && machineKey !== THIS_MACHINE_ID);
  const preference = preferenceOf(known ? machineKey : null);
  const hint = PREFERENCE_OPTIONS.find((option) => option.value === preference)?.hint ?? null;
  return (
    <StatRow
      icon={<Scales size={14} />}
      title="New work"
      value={known ? hint : "Still identifying this computer…"}
      control={(
        <SettingsSelect
          ariaLabel={`How often new work goes to ${name}`}
          value={preference}
          options={PREFERENCE_OPTIONS.map(({ value, label }) => ({ value, label }))}
          disabled={!known || saving}
          onChange={(next) => {
            if (!machineKey) return;
            setSaving(true);
            void setPreference(machineKey, next)
              .catch((error: unknown) => showToast({ tone: "error", title: "Couldn't save the setting", message: error instanceof Error ? error.message : String(error) }))
              .finally(() => setSaving(false));
          }}
        />
      )}
    />
  );
}
