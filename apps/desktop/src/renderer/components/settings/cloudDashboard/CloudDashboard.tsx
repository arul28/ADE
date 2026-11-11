import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, Broom, CaretRight, CreditCard, Desktop, Gauge, MagnifyingGlass, Trash, UserCircle, Warning } from "@phosphor-icons/react";
import { cloudCatalogOf, formatCloudHours, type CloudAccountState } from "../../../../shared/adeCloud";
import type { CloudLaneMachine } from "../../../../shared/cloudLaneLaunch";
import type { CloudSignInStatus } from "../../../../shared/cloudSignIns";
import { cloudTiers, type CloudTierId } from "../../../../shared/cloudTiers";
import { ipcErrorMessage } from "../../../lib/format";
import { useRootAppStore } from "../../../state/appStore";
import { showToast } from "../../app/toast/toastStore";
import { ADE_CLOUD_NAME, CloudMark, CloudSizeIcon } from "../../remoteTargets/cloudBrand";
import type { CloudMachinesState } from "../../remoteTargets/useCloudMachines";
import { confirmDialog } from "../../ui/dialog";
import { usageLeftLevel } from "../../usage/usageDesign";
import { CloudAgentLimitsCard } from "../CloudAgentLimitsCard";
import { CloudPlanCard } from "../CloudPlanCard";
import { CloudCity, type CityItem } from "./CloudCity";
import { CloudFreeUpSpace } from "./CloudFreeUpSpace";
import {
  CLOUD_DISK_WARN_SHARE,
  STATE_LABEL,
  dashLanes,
  formatAgo,
  formatGb,
  formatShortDate,
  hoursForecast,
  lastRunText,
  percentOf,
  planName,
  type DashLane,
} from "./cloudDashboardModel";
import { clearCloudLaneCaches, cloudLaneLifeAvailable, freeCloudLane } from "../../cloudLane/cloudLaneActions";
import { deleteCloudLaneWithCheck } from "../../cloudLane/deleteCloudLane";
import { cloudLaneJobFor, cloudLaneJobVisible, refreshCloudLanesWithoutComputer, useCloudLaneJobs, useCloudLanesWithoutComputer } from "../../cloudLane/cloudLaneStores";
import { CloudLaneJobCard } from "../../cloudLane/CloudLaneJobCard";
import { CloudLaneWithoutComputerNotice } from "../../cloudLane/CloudLaneWithoutComputer";
import { CloudTierChangeDialog } from "../../cloudLane/CloudTierChangeDialog";
import "./cloudDashboard.css";

type View = "city" | "list";

/** The dashboard's element id: the integration header links to it. */
export const CLOUD_DASHBOARD_ID = "ade-cloud-dashboard";

const NO_MACHINES: CloudLaneMachine[] = [];

/** The Sign-ins row's value: how many sign-ins new computers get. */
export function cloudSignInsValue(status: CloudSignInStatus | null): string {
  if (!status || status.unknown) return "";
  const saved = status.saved.filter((entry) => entry.saved).length;
  return saved ? `${saved} kept for new computers` : "None kept yet";
}

/** Computers that hold no one lane: the "Other computers" row lists them in their older cards. */
export function cloudOtherComputersCount(machines: CloudMachinesState): number {
  const list = machines.result?.state === "ok" ? machines.result.machines as CloudLaneMachine[] : [];
  return list.filter((machine) => !machine.lane).length;
}
type RowId = "plan" | "signins" | "limits" | "size" | "other";

const errorText = (error: unknown) => ipcErrorMessage(error) || `${ADE_CLOUD_NAME} couldn't do that. Try again in a moment.`;

/**
 * Settings › ADE Cloud, the dashboard (one tab in place of the column of
 * cards): hours, disk and lanes against the plan, every cloud lane as a city
 * or a list, a look inside a lane's disk, "Free up space" at 80% of the
 * plan's disk, and the account's rows that open.
 *
 * Account level: everything here goes through this app's main process by
 * ADE Cloud id, with no pin, except Clear caches, which runs on the lane's
 * own computer through its binding (`cloudLaneActions.ts`). It reads only
 * what the computer list already holds; nothing wakes a computer to look.
 */
export function CloudDashboard({
  account,
  machines,
  signIns,
  signInsValue,
  otherComputers,
  otherComputersCount,
}: {
  account: CloudAccountState;
  /** The account's computers, from the section's one shared read. */
  machines: CloudMachinesState;
  /** The Sign-ins row's panel (see the mount point in `CloudSection`). */
  signIns: ReactNode;
  signInsValue: string;
  /** The computers that hold no one lane (and ready machines), in their older cards until Cloud 4's PR merges. */
  otherComputers: ReactNode;
  otherComputersCount: number;
}) {
  const [view, setView] = useState<View>("city");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [insideKey, setInsideKey] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<RowId | null>(null);
  const [freeing, setFreeing] = useState(false);
  const [sizing, setSizing] = useState<DashLane | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // One clock per read: "ran 3 h ago" moves when the list is read again, not on a timer.
  const [now, setNow] = useState(() => Date.now());
  const result = machines.result?.state === "ok" ? machines.result : null;
  const list = (result?.machines ?? NO_MACHINES) as CloudLaneMachine[];
  const refresh = machines.refresh;

  useEffect(() => {
    setNow(Date.now());
  }, [machines.result]);
  // The lanes kept without a computer: the shared read (on open, focus and a change of the computers).
  const without = useCloudLanesWithoutComputer(cloudLaneLifeAvailable()).lanes;
  const listKey = list.map((machine) => machine.instanceId).join(",");
  useEffect(() => {
    refreshCloudLanesWithoutComputer();
  }, [listKey]);
  const jobs = useCloudLaneJobs(cloudLaneLifeAvailable());

  const lanes = useMemo(() => dashLanes({ machines: list, account, without, now }), [list, account, without, now]);
  const selected = lanes.find((lane) => lane.key === selectedKey) ?? lanes[0] ?? null;
  const selectedJob = selected?.instanceId ? cloudLaneJobFor(jobs, { instanceId: selected.instanceId, laneId: selected.machine?.lane?.laneId ?? null }) : null;
  // Changes on lanes that aren't selected still show their steps (and Retry) here.
  const otherJobs = useMemo(() => [...jobs.values()].filter((job) => cloudLaneJobVisible(job) && job.phase !== "online"
    && job.jobId !== selectedJob?.jobId), [jobs, selectedJob?.jobId]);
  const inside = insideKey ? lanes.find((lane) => lane.key === insideKey) ?? null : null;
  useEffect(() => {
    if (insideKey && !inside) setInsideKey(null);
  }, [insideKey, inside]);

  const diskUsed = account.disk.usedGb;
  const diskLimit = account.disk.limitGb ?? 0;
  const diskShare = diskLimit > 0 ? diskUsed / diskLimit : 0;
  const hoursLeftPct = account.hours.includedMilli > 0 ? (account.hours.leftMilli / account.hours.includedMilli) * 100 : 0;
  const forecast = hoursForecast(account, now);

  const cityItems = useMemo<CityItem[]>(() => lanes.map((lane) => ({
    key: lane.key,
    name: lane.name,
    sub: lane.state === "none" ? "no computer now" : `${formatGb(lane.diskGb)}${lane.old && lane.lastActiveAt ? `, ${formatAgo(lane.lastActiveAt, now)}` : ""}`,
    aria: laneAria(lane, now),
    detail: laneDetail(lane, now),
    size: lane.diskGb,
    rank: lane.tierRank,
    awake: lane.state === "awake" || lane.state === "updating",
    old: lane.old,
    empty: lane.state === "none",
  })), [lanes, now]);

  // Look inside moves focus into the inside view; Back returns it to what opened it
  // (the city or list, on the same lane, or the Look inside button).
  const sectionRef = useRef<HTMLElement | null>(null);
  const lookInsideButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<"view" | "button" | null>(null);
  const openInside = useCallback((key: string, from: "view" | "button" = "view") => {
    const lane = lanes.find((entry) => entry.key === key);
    if (!lane?.instanceId) return;
    returnFocusRef.current = from;
    setSelectedKey(key);
    setInsideKey(key);
  }, [lanes]);
  const closeInside = useCallback(() => setInsideKey(null), []);
  const insideOpen = inside != null;
  useLayoutEffect(() => {
    if (insideOpen) return;
    const from = returnFocusRef.current;
    returnFocusRef.current = null;
    if (from === "button") lookInsideButtonRef.current?.focus();
    else if (from === "view") sectionRef.current?.querySelector<HTMLElement>(".adecd-city, .adecd-list")?.focus();
  }, [insideOpen]);
  const showView = (next: View) => {
    // The toggle closes the inside view; focus stays on the toggle.
    returnFocusRef.current = null;
    setInsideKey(null);
    setView(next);
  };

  const clearCaches = async (lane: DashLane) => {
    const asleep = lane.state !== "awake";
    const ok = await confirmDialog({
      title: `Clear caches on ${lane.name}?`,
      message: `${asleep ? "ADE wakes the computer, then deletes" : "ADE deletes"} package and build caches and measures the disk again. Repositories, dependencies, images and emulators stay.`,
      confirmLabel: "Clear caches",
    });
    if (!ok) return;
    setBusyKey(lane.key);
    try {
      const { freedGb } = await clearCloudLaneCaches(lane);
      showToast({ tone: "success", title: `Cleared caches on ${lane.name}`, message: `Freed ${formatGb(freedGb)}.` });
      refresh();
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't clear caches on ${lane.name}`, message: errorText(error) });
    } finally {
      setBusyKey(null);
    }
  };

  // Warns only when work isn't on GitHub; a clean lane gets one plain question here (no other confirm).
  const deleteLane = async (lane: DashLane) => {
    if (!lane.instanceId) return;
    setBusyKey(lane.key);
    try {
      await deleteCloudLaneWithCheck({ instanceId: lane.instanceId, laneName: lane.name, askFirst: true, onDeleted: refresh });
    } finally {
      setBusyKey(null);
    }
  };

  const freeLane = async (lane: DashLane) => {
    if (!lane.instanceId) return;
    const ok = await confirmDialog({
      title: `Free the computer of ${lane.name}?`,
      message: "ADE pushes its work to GitHub, then removes the computer. The lane and its chats stay. Your next message makes a new computer.",
      confirmLabel: "Free the computer",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    setBusyKey(lane.key);
    try {
      const done = await freeCloudLane(lane.instanceId);
      showToast({ tone: done.ok ? "success" : "error", title: done.ok ? `Freed ${lane.name}'s computer` : `Kept ${lane.name}'s computer`, message: done.message });
      refresh();
      refreshCloudLanesWithoutComputer();
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't free ${lane.name}'s computer`, message: errorText(error) });
    } finally {
      setBusyKey(null);
    }
  };

  const upgrade = () => {
    void window.ade.cloud?.openCheckout?.().catch((error: unknown) => showToast({ tone: "error", title: "Couldn't open checkout", message: errorText(error) }));
  };

  return (
    <section ref={sectionRef} id={CLOUD_DASHBOARD_ID} tabIndex={-1} className="adecd" aria-label={`${ADE_CLOUD_NAME} dashboard`}>
      <header className="adecd-head">
        <CloudMark size={20} brand bold />
        <h3>{ADE_CLOUD_NAME}</h3>
        <span className="adecd-plan">{planName(account)}</span>
        {account.plan === "free" && window.ade.cloud?.openCheckout ? (
          <button type="button" className="kit-btn adecd-upgrade" data-size="xs" onClick={upgrade}>Upgrade</button>
        ) : null}
        <span className="adecd-grow" />
        <span className="kit-seg" data-case="sentence" role="group" aria-label="View">
          <button type="button" aria-pressed={!insideOpen && view === "city"} onClick={() => showView("city")}>City</button>
          <button type="button" aria-pressed={!insideOpen && view === "list"} onClick={() => showView("list")}>List</button>
        </span>
      </header>

      <div className="adecd-stats">
        <div className="adecd-stat">
          <span className="kit-eyebrow">Hours left</span>
          <div className="adecd-stat-val">
            <b className="kit-num">{formatCloudHours(account.hours.leftMilli)} h</b>
            <span>of {formatCloudHours(account.hours.includedMilli)} h, resets {formatShortDate(account.billing.periodEnd)}</span>
          </div>
          <div className="kit-meter" data-level={usageLeftLevel(hoursLeftPct)}><span style={{ width: `${Math.max(0, Math.min(100, hoursLeftPct))}%` }} /></div>
          {forecast ? <span className="adecd-fore">{forecast} <em>(estimate)</em></span> : null}
        </div>
        <div className="adecd-stat">
          <span className="kit-eyebrow">Disk</span>
          <div className="adecd-stat-val"><b className="kit-num">{formatGb(diskUsed)}</b>{diskLimit > 0 ? <span>of {formatGb(diskLimit)}</span> : null}</div>
          <div className="kit-meter" data-level={usageLeftLevel(100 - percentOf(diskUsed, diskLimit))}><span style={{ width: `${percentOf(diskUsed, diskLimit)}%` }} /></div>
        </div>
        <div className="adecd-stat">
          <span className="kit-eyebrow">Lanes</span>
          <div className="adecd-stat-val"><b className="kit-num">{account.computers.total} of {account.computers.limit}</b><span>{account.computers.awake} awake</span></div>
          <div className="kit-meter" data-level={usageLeftLevel(100 - percentOf(account.computers.total, account.computers.limit))}><span style={{ width: `${percentOf(account.computers.total, account.computers.limit)}%` }} /></div>
        </div>
      </div>

      {diskShare >= CLOUD_DISK_WARN_SHARE ? (
        <div className="adecd-warn" role="status">
          <Warning size={14} weight="fill" />
          <span>Your disk is {Math.round(diskShare * 100)}% full.</span>
          <button type="button" className="kit-btn" data-size="xs" onClick={() => setFreeing(true)}>Free up space</button>
        </div>
      ) : null}

      {otherJobs.length ? (
        <div className="adecd-jobs" aria-label="Size changes">
          {otherJobs.map((job) => <CloudLaneJobCard key={job.jobId} job={job} account={account} variant="panel" />)}
        </div>
      ) : null}

      {inside ? (
        <LookInside lane={inside} now={now} busy={busyKey === inside.key} onBack={closeInside} onClear={() => void clearCaches(inside)} />
      ) : view === "city" ? (
        <div className="adecd-citycard">
          <div className="adecd-citytop">
            <b>Your cloud lanes</b>
            <span className="adecd-grow" />
            {lanes.length ? <span className="adecd-hint">Double-click a building to look inside</span> : null}
          </div>
          {lanes.length ? (
            <CloudCity
              items={cityItems}
              selectedKey={selected?.key ?? null}
              onSelect={setSelectedKey}
              onOpen={openInside}
              label="Cloud lanes as a city. Arrow keys move, Enter looks inside."
            />
          ) : (
            <p className="adecd-empty">No cloud lanes yet. Pick {ADE_CLOUD_NAME} under Run on when you start a chat.</p>
          )}
          <div className="adecd-cap"><span>Height is disk. Lit windows mean awake.</span></div>
        </div>
      ) : (
        <LaneList lanes={lanes} now={now} selectedKey={selected?.key ?? null} onSelect={setSelectedKey} onOpen={openInside} />
      )}

      {selected && !inside ? (
        <div className="kit-panel adecd-lanesel">
          <div className="adecd-lanesel-text">
            {selected.tier ? <CloudSizeIcon tier={selected.tier.id} size={16} /> : <CloudMark size={16} brand />}
            <b>{selected.name}</b>
            <span>{[selected.tier?.label, selected.rateLabel, selected.state === "none" ? null : formatGb(selected.diskGb)].filter(Boolean).join(", ")}</span>
            <span className="adecd-state" data-state={selected.state}><i />{STATE_LABEL[selected.state]}</span>
            <span>{lastRunText(selected, now)}</span>
            {selected.old ? <span className="adecd-old">Not used for a long time</span> : null}
            {selected.safe ? <span className="kit-tag" data-tone="ok">Safe to delete</span> : null}
          </div>
          {selectedJob ? <CloudLaneJobCard job={selectedJob} account={account} variant="panel" /> : null}
          {selected.without ? <CloudLaneWithoutComputerNotice lane={selected.without} account={account} variant="row" /> : null}
          {selected.instanceId ? (
            <div className="adecd-lanesel-actions">
              <button ref={lookInsideButtonRef} type="button" className="kit-btn" data-size="sm" onClick={() => openInside(selected.key, "button")}><MagnifyingGlass size={12} />Look inside</button>
              {cloudLaneLifeAvailable() ? (
                <>
                  <button type="button" className="kit-btn" data-size="sm" disabled={busyKey === selected.key || (selectedJob != null && (selectedJob.phase === "waiting" || selectedJob.phase === "running"))} onClick={() => setSizing(selected)}>Change size</button>
                  <button type="button" className="kit-btn" data-size="sm" disabled={busyKey === selected.key} onClick={() => void freeLane(selected)}>Keep lane, free its computer</button>
                  <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" data-tone="crit" disabled={busyKey === selected.key} onClick={() => void deleteLane(selected)}><Trash size={12} />Delete lane</button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="adecd-rows">
        <Row id="plan" open={openRow} onToggle={setOpenRow} icon={<CreditCard size={15} />} title="Plan and billing" value={planName(account)}>
          <CloudPlanCard account={account} onChanged={refresh} />
        </Row>
        <Row id="signins" open={openRow} onToggle={setOpenRow} icon={<UserCircle size={15} />} title="Sign-ins" value={signInsValue}>
          {signIns}
        </Row>
        <Row id="limits" open={openRow} onToggle={setOpenRow} icon={<Gauge size={15} />} title="Agent limits" value="What agents may start">
          <CloudAgentLimitsCard />
        </Row>
        <DefaultSizeRow account={account} open={openRow} onToggle={setOpenRow} />
        <Row id="other" open={openRow} onToggle={setOpenRow} icon={<Desktop size={15} />} title="Other computers and ready machines" value={otherComputersCount ? `${otherComputersCount}` : "None"}>
          {otherComputers}
        </Row>
      </div>

      {freeing ? (
        <CloudFreeUpSpace
          account={account}
          lanes={lanes}
          now={now}
          onClose={() => setFreeing(false)}
          onDone={refresh}
        />
      ) : null}
      {sizing?.instanceId ? <CloudTierChangeDialog instanceId={sizing.instanceId} laneName={sizing.name} onClose={() => { setSizing(null); refresh(); }} /> : null}
    </section>
  );
}

function laneAria(lane: DashLane, now: number): string {
  if (lane.state === "none") return `${lane.name}, no computer now`;
  return [lane.name, lane.tier?.label, formatGb(lane.diskGb), STATE_LABEL[lane.state], lastRunText(lane, now), lane.old ? "not used for a long time" : null, lane.safe ? "safe to delete" : null]
    .filter(Boolean)
    .join(", ");
}

function laneDetail(lane: DashLane, now: number): string[] {
  if (lane.state === "none") return ["No computer. ADE makes one when you next send."];
  return [
    [lane.tier?.label, lane.rateLabel, formatGb(lane.diskGb)].filter(Boolean).join(", "),
    `${STATE_LABEL[lane.state]}, ${lastRunText(lane, now).toLowerCase()}`,
    ...(lane.old ? ["Not used for a long time"] : []),
  ];
}

function Row({
  id,
  open,
  onToggle,
  icon,
  title,
  value,
  children,
}: {
  id: RowId;
  open: RowId | null;
  onToggle: (id: RowId | null) => void;
  icon: ReactNode;
  title: string;
  value: ReactNode;
  children: ReactNode;
}) {
  const expanded = open === id;
  return (
    <div className="adecd-row">
      <button type="button" className="adecd-row-btn" aria-expanded={expanded} onClick={() => onToggle(expanded ? null : id)}>
        <span className="adecd-row-ic">{icon}</span>
        <b>{title}</b>
        <span className="adecd-row-val">{value}<CaretRight size={12} /></span>
      </button>
      {expanded ? <div className="adecd-row-body">{children}</div> : null}
    </div>
  );
}

function DefaultSizeRow({ account, open, onToggle }: { account: CloudAccountState; open: RowId | null; onToggle: (id: RowId | null) => void }) {
  const tiers = useMemo(() => cloudTiers(cloudCatalogOf(account)), [account]);
  const defaultTier = useRootAppStore((state) => state.cloudDefaultTier);
  const setDefaultTier = useRootAppStore((state) => state.setCloudDefaultTier);
  const current = tiers.find((tier) => tier.id === defaultTier) ?? tiers[0] ?? null;
  return (
    <Row
      id="size"
      open={open}
      onToggle={onToggle}
      icon={current ? <CloudSizeIcon tier={current.id} size={15} /> : <CloudMark size={15} />}
      title="Size for new cloud lanes"
      value={current?.label ?? "Small"}
    >
      <div className="adecd-sizes" role="radiogroup" aria-label="Size for new cloud lanes">
        {tiers.map((tier) => (
          <button
            key={tier.id}
            type="button"
            role="radio"
            aria-checked={tier.id === current?.id}
            className="adecd-size"
            onClick={() => setDefaultTier(tier.id as CloudTierId)}
          >
            <CloudSizeIcon tier={tier.id} size={22} />
            <b>{tier.label}</b>
            <span>{tier.cpu} CPU, {tier.memoryGb} GB memory</span>
            <span className="kit-num">{tier.multiplierMilli / 1000}× hours</span>
          </button>
        ))}
      </div>
    </Row>
  );
}

function LaneList({
  lanes,
  now,
  selectedKey,
  onSelect,
  onOpen,
}: {
  lanes: readonly DashLane[];
  now: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onOpen: (key: string) => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!lanes.length) return;
    const at = Math.max(0, lanes.findIndex((lane) => lane.key === selectedKey));
    let next = at;
    if (event.key === "ArrowDown") next = Math.min(lanes.length - 1, at + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, at - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = lanes.length - 1;
    else if (event.key === "Enter" && selectedKey) {
      onOpen(selectedKey);
      event.preventDefault();
      return;
    } else return;
    event.preventDefault();
    onSelect(lanes[next]!.key);
  };
  if (!lanes.length) return <p className="kit-panel adecd-empty">No cloud lanes yet. Pick {ADE_CLOUD_NAME} under Run on when you start a chat.</p>;
  return (
    <div
      className="kit-panel adecd-list"
      role="listbox"
      tabIndex={0}
      aria-label="Cloud lanes. Arrow keys move, Enter looks inside."
      aria-activedescendant={selectedKey ? `adecd-row-${cssId(selectedKey)}` : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="adecd-list-head" aria-hidden="true">
        <span>Lane</span><span>Size</span><span>Rate</span><span>Disk</span><span>State</span><span>Last run</span>
      </div>
      {lanes.map((lane) => (
        <div
          key={lane.key}
          id={`adecd-row-${cssId(lane.key)}`}
          role="option"
          aria-selected={lane.key === selectedKey}
          className="adecd-list-row"
          onClick={() => onSelect(lane.key)}
          onDoubleClick={() => onOpen(lane.key)}
        >
          <span className="adecd-list-name">
            {lane.tier ? <CloudSizeIcon tier={lane.tier.id} size={16} /> : <CloudMark size={16} brand />}
            {lane.name}
            {lane.old ? <span className="adecd-old">old</span> : null}
            {lane.safe ? <span className="kit-tag" data-tone="ok">Safe to delete</span> : null}
          </span>
          <span>{lane.tier?.label ?? "—"}</span>
          <span className="kit-num">{lane.rateLabel ?? "—"}</span>
          <span className="kit-num">{lane.state === "none" ? "—" : formatGb(lane.diskGb)}</span>
          <span className="adecd-state" data-state={lane.state}><i />{STATE_LABEL[lane.state]}</span>
          <span>{lastRunText(lane, now)}</span>
        </div>
      ))}
    </div>
  );
}

const cssId = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, "_");

/** What uses a lane's disk, as its computer last measured itself while awake. */
function LookInside({ lane, now, busy, onBack, onClear }: { lane: DashLane; now: number; busy: boolean; onBack: () => void; onClear: () => void }) {
  const usage = lane.usage;
  const [selectedPart, setSelectedPart] = useState<string | null>(null);
  const items = useMemo<CityItem[]>(() => (usage?.items ?? []).map((part, index) => ({
    key: `${part.kind}:${index}`,
    name: part.label,
    sub: `${formatGb(part.gb)}${part.clearable ? ", can clear" : ""}`,
    aria: `${part.label}, ${formatGb(part.gb)}${part.clearable ? ", safe to clear" : ""}`,
    detail: [formatGb(part.gb), ...(part.clearable ? ["Safe to clear"] : [])],
    size: part.gb,
    rank: 1,
    awake: lane.state === "awake",
    old: false,
  })), [usage, lane.state]);
  const clearableGb = (usage?.items ?? []).filter((part) => part.clearable).reduce((total, part) => total + part.gb, 0);
  const total = usage?.totalGb ?? 0;
  const canClear = clearableGb > 0 && Boolean(window.ade.cloud?.clearCaches) && lane.state !== "failed";
  // Focus moves into the inside view when it opens, onto its way back.
  const backRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    backRef.current?.focus();
  }, []);
  return (
    <div className="adecd-citycard" data-inside="true" role="region" aria-label={`Inside ${lane.name}`}>
      <div className="adecd-citytop">
        <button ref={backRef} type="button" className="kit-btn kit-btn-ghost" data-size="xs" onClick={onBack}><ArrowLeft size={11} />Your cloud lanes</button>
        <b>{lane.name}</b>
        <span className="adecd-grow" />
        <span className="adecd-hint">{usage ? `Measured ${formatAgo(usage.measuredAt, now)}` : "Not measured yet"}</span>
        {canClear ? (
          <button type="button" className="kit-btn" data-size="xs" disabled={busy} onClick={onClear}><Broom size={11} />{busy ? "Clearing…" : "Clear caches"}</button>
        ) : null}
      </div>
      {usage && items.length ? (
        <>
          <CloudCity items={items} selectedKey={selectedPart} onSelect={setSelectedPart} label={`What uses the disk of ${lane.name}`} compact stars={false} />
          <ul className="adecd-parts">
            {usage.items.map((part, index) => (
              <li key={`${part.kind}:${index}`}>
                <span>{part.label}</span>
                <span className="kit-meter"><span style={{ width: `${percentOf(part.gb, total)}%` }} /></span>
                <span className="kit-num">{formatGb(part.gb)}</span>
                {part.clearable ? <span className="kit-tag" data-tone="ok">Safe to clear</span> : <span />}
              </li>
            ))}
          </ul>
          <div className="adecd-cap">
            <span>{formatGb(total)} used of {formatGb(lane.diskGb)}. {lane.state === "awake" ? "" : "The computer sleeps; this is its last measure."}</span>
          </div>
        </>
      ) : (
        <p className="adecd-empty">
          {lane.name}&apos;s computer measures its disk while it is awake and idle, at most every few hours. Its first measure shows here then. ADE doesn&apos;t wake it to look.
        </p>
      )}
    </div>
  );
}
