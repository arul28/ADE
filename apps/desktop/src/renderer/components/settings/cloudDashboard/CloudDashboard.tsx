import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, Broom, Desktop, MagnifyingGlass, Trash } from "@phosphor-icons/react";
import {
  CLOUD_DISK_WARN_SHARE,
  cloudAccountBanner,
  cloudEarnedHoursOf,
  cloudFreePlanOf,
  formatCloudDate,
  formatCloudGb,
  formatCloudHours,
  percentOf,
  planCleanupDoneSentence,
  timedWakesCancelledSentence,
  type CloudAccountState,
} from "../../../../shared/adeCloud";
import type { CloudLaneMachine } from "../../../../shared/cloudLaneLaunch";
import { resolveSettingsHash } from "../../../../shared/settingsManifest";
import { useLocation } from "react-router-dom";
import { formatAgo, ipcErrorMessage } from "../../../lib/format";
import { showToast } from "../../app/toast/toastStore";
import { ADE_CLOUD_NAME, CloudMark, CloudSizeIcon } from "../../remoteTargets/cloudBrand";
import type { CloudMachinesState } from "../../remoteTargets/useCloudMachines";
import { confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { usageLeftLevel } from "../../usage/usageDesign";
import { CloudAgentLimitsCard } from "../CloudAgentLimitsCard";
import { ADE_CLOUD_FREE_SPACE_ANCHOR, ADE_CLOUD_PLAN_ANCHOR, decodeSettingsHash } from "../settingsHash";
import { CloudCity, type CityItem } from "./CloudCity";
import { CloudFreeUpSpace } from "./CloudFreeUpSpace";
import { CloudPlans } from "./CloudPlans";
import { CloudSizes } from "./CloudSizes";
import { CloudSignIns } from "./CloudSignIns";
import { CloudInviteCard } from "./CloudInvite";
import {
  STATE_LABEL,
  dashLanes,
  hoursForecast,
  lastRunText,
  planName,
  prefersReducedMotion,
  type DashLane,
} from "./cloudDashboardModel";
import { clearCloudLaneCaches, cloudLaneLifeAvailable, freeCloudLane } from "../../cloudLane/cloudLaneActions";
import { deleteCloudLaneWithCheck } from "../../cloudLane/deleteCloudLane";
import { cloudLaneJobFor, cloudLaneJobVisible, refreshCloudLanesWithoutComputer, useCloudLaneJobs, useCloudLanesWithoutComputer } from "../../cloudLane/cloudLaneStores";
import { CloudLaneJobCard } from "../../cloudLane/CloudLaneJobCard";
import { CloudLaneWithoutComputerNotice } from "../../cloudLane/CloudLaneWithoutComputer";
import { CloudTierChangeDialog } from "../../cloudLane/CloudTierChangeDialog";

/** The dashboard's element id. */
export const CLOUD_DASHBOARD_ID = "ade-cloud-dashboard";

const NO_MACHINES: CloudLaneMachine[] = [];

/** The settings anchors on this page: a deep link to one scrolls to its card. */
const CARD_ANCHORS = new Set(["cloud-invite", ADE_CLOUD_PLAN_ANCHOR, "cloud-plan", "cloud-sign-ins", "cloud-agent-limits", "cloud-sizes", "cloud-lanes", "cloud-machines", "cloud-ready", "cloud-connection"]);

/** The card anchor a hash names: its own text first, then a settings entry's. */
function anchorOfHash(hash: string): string | null {
  if (!hash) return null;
  const raw = decodeSettingsHash(hash).trim().toLowerCase();
  if (CARD_ANCHORS.has(raw) || raw === ADE_CLOUD_FREE_SPACE_ANCHOR) return raw;
  return resolveSettingsHash(raw)?.anchor ?? null;
}

/** Old anchors that now live inside another card. */
const ANCHOR_CARD: Record<string, string> = {
  [ADE_CLOUD_PLAN_ANCHOR]: "cloud-plan",
  "cloud-machines": "cloud-lanes",
  "cloud-ready": "cloud-lanes",
  "cloud-connection": CLOUD_DASHBOARD_ID,
};

const errorText = (error: unknown) => ipcErrorMessage(error) || `${ADE_CLOUD_NAME} couldn't do that. Try again in a moment.`;

/**
 * Settings › ADE Cloud: the one-stop page for the account's cloud. Everything
 * shows at once, nothing folds away: the hours, disk and computers against the
 * plan with the city of lanes, every computer the account pays for, the plans
 * side by side, the sizes, the sign-ins cloud computers use, and what agents
 * may do alone.
 *
 * Account level: everything goes through this app's main process with no pin,
 * except Clear caches, which runs on the lane's own computer through its
 * binding (`cloudLaneActions.ts`). It reads only what the computer list
 * already holds; nothing wakes a computer to look.
 */
export function CloudDashboard({ account, machines }: { account: CloudAccountState; machines: CloudMachinesState }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [insideKey, setInsideKey] = useState<string | null>(null);
  const { hash } = useLocation();
  const [freeing, setFreeing] = useState(() => anchorOfHash(hash) === ADE_CLOUD_FREE_SPACE_ANCHOR);
  useLayoutEffect(() => {
    const anchor = anchorOfHash(hash);
    if (anchor === ADE_CLOUD_FREE_SPACE_ANCHOR) setFreeing(true);
    const card = anchor ? ANCHOR_CARD[anchor] ?? anchor : null;
    if (!card) return;
    const element = document.getElementById(card);
    element?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [hash]);
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
  const without = useCloudLanesWithoutComputer(cloudLaneLifeAvailable()).lanes;
  const listKey = list.map((machine) => machine.instanceId).join(",");
  useEffect(() => {
    refreshCloudLanesWithoutComputer();
  }, [listKey]);
  const jobs = useCloudLaneJobs(cloudLaneLifeAvailable());

  const lanes = useMemo(() => dashLanes({ machines: list, account, without, now }), [list, account, without, now]);
  const selected = lanes.find((lane) => lane.key === selectedKey) ?? null;
  const selectedJob = selected?.instanceId ? cloudLaneJobFor(jobs, { instanceId: selected.instanceId, laneId: selected.machine?.lane?.laneId ?? null }) : null;
  const otherJobs = useMemo(() => [...jobs.values()].filter((job) => cloudLaneJobVisible(job) && job.phase !== "online"
    && job.jobId !== selectedJob?.jobId), [jobs, selectedJob?.jobId]);
  const inside = insideKey ? lanes.find((lane) => lane.key === insideKey) ?? null : null;
  useEffect(() => {
    if (insideKey && !inside) setInsideKey(null);
  }, [insideKey, inside]);

  const cityItems = useMemo<CityItem[]>(() => lanes.map((lane) => ({
    key: lane.key,
    name: lane.name,
    sub: lane.state === "none" ? "no computer now" : lane.noLane ? `${formatCloudGb(lane.diskGb)}, no lane` : formatCloudGb(lane.diskGb),
    aria: laneAria(lane, now),
    detail: laneDetail(lane, now),
    size: lane.diskGb,
    rank: lane.tierRank,
    awake: lane.state === "awake" || lane.state === "updating",
    old: lane.old,
    empty: lane.state === "none",
  })), [lanes, now]);

  const tableRef = useRef<HTMLDivElement | null>(null);
  const selectFromCity = useCallback((key: string) => {
    setSelectedKey(key);
    tableRef.current?.querySelector<HTMLElement>(`[data-key="${cssId(key)}"]`)?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);
  const openInside = useCallback((key: string) => {
    const lane = lanes.find((entry) => entry.key === key);
    if (!lane?.instanceId) return;
    setSelectedKey(key);
    setInsideKey(key);
  }, [lanes]);

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
      showToast({ tone: "success", title: `Cleared caches on ${lane.name}`, message: `Freed ${formatCloudGb(freedGb)}.` });
      refresh();
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't clear caches on ${lane.name}`, message: errorText(error) });
    } finally {
      setBusyKey(null);
    }
  };

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

  const banner = cloudAccountBanner(account);
  const diskLimit = account.disk.limitGb ?? 0;
  const diskShare = diskLimit > 0 ? account.disk.usedGb / diskLimit : 0;

  return (
    <div id={CLOUD_DASHBOARD_ID} className="adecd" aria-label={`${ADE_CLOUD_NAME} dashboard`}>
      <CloudHero
        account={account}
        lanes={lanes}
        cityItems={cityItems}
        selectedKey={selectedKey}
        onSelect={selectFromCity}
        onOpen={openInside}
        now={now}
      />

      {banner ? <Banner layout="inline" model={{ ...banner, report: false }} /> : null}
      <PlanNotices account={account} />
      {diskShare >= CLOUD_DISK_WARN_SHARE ? (
        <Banner
          layout="inline"
          model={{
            id: "cloud-disk-full",
            tone: "warning",
            title: `Your disk is ${Math.round(diskShare * 100)}% full`,
            detail: "Free some space before your lanes need more.",
            actions: [{ label: "Free up space", onClick: () => setFreeing(true) }],
            report: false,
          }}
        />
      ) : null}

      {otherJobs.length ? (
        <div className="adecd-jobs" aria-label="Size changes">
          {otherJobs.map((job) => <CloudLaneJobCard key={job.jobId} job={job} account={account} variant="panel" />)}
        </div>
      ) : null}

      <section id="cloud-lanes" className="kit-card adecd-card" aria-label="Lanes and computers">
        <header className="kit-card-head">
          <Desktop size={14} />
          Lanes and computers
          <span className="kit-card-head-count">{lanes.length}</span>
          <span className="adecd-head-note">{account.computers.total} of {account.computers.limit} computers · {account.computers.awake} awake</span>
        </header>
        <div className="kit-card-body" data-flush="true" ref={tableRef}>
          {inside ? (
            <LookInside lane={inside} now={now} busy={busyKey === inside.key} onBack={() => setInsideKey(null)} onClear={() => void clearCaches(inside)} />
          ) : (
            <LaneTable
              lanes={lanes}
              now={now}
              selectedKey={selected?.key ?? null}
              onSelect={(key) => setSelectedKey((current) => (current === key ? null : key))}
              onOpen={openInside}
              renderActions={(lane) => (
                <LaneActions
                  lane={lane}
                  account={account}
                  job={lane.key === selected?.key ? selectedJob : null}
                  busy={busyKey === lane.key}
                  onLookInside={() => openInside(lane.key)}
                  onSize={() => setSizing(lane)}
                  onFree={() => void freeLane(lane)}
                  onDelete={() => void deleteLane(lane)}
                />
              )}
            />
          )}
        </div>
      </section>

      <CloudPlans account={account} onChanged={refresh} />
      <CloudSizes account={account} />
      <CloudInviteCard account={account} onChanged={refresh} />

      <div className="adecd-pair">
        <CloudSignIns />
        <CloudAgentLimitsCard />
      </div>

      {freeing ? (
        <CloudFreeUpSpace account={account} lanes={lanes} now={now} onClose={() => setFreeing(false)} onDone={refresh} />
      ) : null}
      {sizing?.instanceId ? <CloudTierChangeDialog instanceId={sizing.instanceId} laneName={sizing.name} onClose={() => { setSizing(null); refresh(); }} /> : null}
    </div>
  );
}

/**
 * The night sky at the top: the plan, the three numbers that matter (hours,
 * disk, computers) and the city of the account's lanes. The numbers are said
 * once on the page; nothing below repeats them.
 */
function CloudHero({
  account,
  lanes,
  cityItems,
  selectedKey,
  onSelect,
  onOpen,
  now,
}: {
  account: CloudAccountState;
  lanes: readonly DashLane[];
  cityItems: CityItem[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onOpen: (key: string) => void;
  now: number;
}) {
  const hours = account.hours;
  const earned = cloudEarnedHoursOf(account).leftMilli;
  const hoursPct = hours.includedMilli > 0 ? (hours.leftMilli / hours.includedMilli) * 100 : 0;
  const forecast = hoursForecast(account, now);
  const diskUsed = account.disk.usedGb;
  const diskLimit = account.disk.limitGb ?? 0;
  // The free plan refused on this computer (another account used its free hours): one sentence from the server.
  const freePlan = cloudFreePlanOf(account);
  const blockedSentence = freePlan.state === "refused" ? freePlan.sentence ?? null : null;
  const resets = account.billing.cancelAtPeriodEnd
    ? `plan ends ${formatCloudDate(account.billing.periodEnd)}`
    : `resets ${formatCloudDate(account.billing.periodEnd)}`;
  const toPlans = () => document.getElementById("cloud-plan")?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  return (
    <section className="adecd-citycard adecd-hero" aria-label={`${ADE_CLOUD_NAME}, ${planName(account)}`}>
      <div className="adecd-hero-stars" aria-hidden="true" />
      <header className="adecd-hero-head">
        <CloudMark size={20} brand bold />
        <h2>{planName(account)}</h2>
        <span className="adecd-grow" />
        <button type="button" className="kit-btn" data-size="sm" onClick={toPlans}>
          {account.plan === "free" ? "Compare plans" : "Plan and billing"}
        </button>
      </header>
      <div className="adecd-hero-body">
        <div className="adecd-hero-stats">
          <div className="adecd-hours">
            <span className="adecd-label">Hours left this month</span>
            <div className="adecd-hours-num">
              <b className="kit-num" data-face="ui">{formatCloudHours(hours.leftMilli)}</b>
              <span>of {formatCloudHours(hours.includedMilli)} h, {resets}</span>
            </div>
            <div className="kit-meter adecd-meter" data-level={usageLeftLevel(hoursPct)}>
              <span style={{ width: `${Math.max(0, Math.min(100, hoursPct))}%` }} />
            </div>
            <ul className="adecd-hours-notes">
              {blockedSentence ? <li data-tone="warn">{blockedSentence}</li> : null}
              {earned > 0 ? <li><b>+{formatCloudHours(earned)} hours</b> earned from invites. They never expire.</li> : null}
              {account.extraHours.available ? (
                <li>{account.extraHours.enabled
                  ? `Extra hours are on${account.extraHours.usedMilli > 0 ? `: ${formatCloudHours(account.extraHours.usedMilli)} h used this month` : ""}.`
                  : "Extra hours are off. Work stops when your hours run out."}</li>
              ) : null}
              {forecast ? <li>{forecast} <em>(estimate)</em></li> : null}
            </ul>
          </div>
          <div className="adecd-minis">
            <MiniMeter label="Disk" value={formatCloudGb(diskUsed)} of={diskLimit > 0 ? `of ${formatCloudGb(diskLimit)}` : null} pct={percentOf(diskUsed, diskLimit)} note="All your computers together" />
            <MiniMeter
              label="Computers"
              value={String(account.computers.total)}
              of={`of ${account.computers.limit}`}
              pct={percentOf(account.computers.total, account.computers.limit)}
              note={`${account.computers.awake} awake now`}
            />
          </div>
        </div>
        <div className="adecd-hero-city">
          {lanes.length ? (
            <>
              <CloudCity
                items={cityItems}
                selectedKey={selectedKey}
                onSelect={onSelect}
                onOpen={onOpen}
                label="Your cloud lanes as a city. Arrow keys move, Enter looks inside."
                compact
                maxLabels={3}
              />
              <span className="adecd-city-cap">Height is disk. Lit windows are awake.</span>
            </>
          ) : (
            <div className="adecd-city-empty">
              <EmptyPlot />
              <b>No cloud lanes yet</b>
              <span>Pick {ADE_CLOUD_NAME} under Run on when you send a message. ADE makes a computer for the lane, and it shows here.</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function MiniMeter({ label, value, of, pct, note }: { label: string; value: string; of: string | null; pct: number; note: string }) {
  return (
    <div className="adecd-mini">
      <span className="adecd-label">{label}</span>
      <div className="adecd-mini-num"><b className="kit-num" data-face="ui">{value}</b>{of ? <span>{of}</span> : null}</div>
      <div className="kit-meter adecd-meter" data-level={usageLeftLevel(100 - pct)}><span style={{ width: `${pct}%` }} /></div>
      <span className="adecd-mini-note">{note}</span>
    </div>
  );
}

/** An empty plot on the ground, for a sky with no lanes yet. */
function EmptyPlot() {
  return (
    <svg className="adecd-plot" viewBox="0 0 160 70" aria-hidden="true">
      <polygon points="80,8 150,38 80,68 10,38" className="adecd-plot-ground" />
      <polygon points="80,22 118,38 80,54 42,38" className="adecd-plot-lot" />
    </svg>
  );
}

function laneAria(lane: DashLane, now: number): string {
  if (lane.state === "none") return `${lane.name}, no computer now`;
  return [lane.name, lane.noLane ? "no lane" : null, lane.tier?.label, formatCloudGb(lane.diskGb), STATE_LABEL[lane.state], lastRunText(lane, now), lane.old ? "not used for a long time" : null, lane.safe ? "safe to delete" : null]
    .filter(Boolean)
    .join(", ");
}

function laneDetail(lane: DashLane, now: number): string[] {
  if (lane.state === "none") return ["No computer. ADE makes one when you next send."];
  return [
    [lane.tier?.label, lane.rateLabel, formatCloudGb(lane.diskGb)].filter(Boolean).join(", "),
    `${STATE_LABEL[lane.state]}, ${lastRunText(lane, now).toLowerCase()}`,
    ...(lane.noLane ? ["No lane on this computer"] : []),
    ...(lane.old ? ["Not used for a long time"] : []),
  ];
}

/** Every lane and every computer the account pays for, one row each; the selected row opens its actions under it. */
function LaneTable({
  lanes,
  now,
  selectedKey,
  onSelect,
  onOpen,
  renderActions,
}: {
  lanes: readonly DashLane[];
  now: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onOpen: (key: string) => void;
  renderActions: (lane: DashLane) => ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!lanes.length) return;
    const at = Math.max(0, lanes.findIndex((lane) => lane.key === selectedKey));
    let next = at;
    if (event.key === "ArrowDown") next = selectedKey ? Math.min(lanes.length - 1, at + 1) : 0;
    else if (event.key === "ArrowUp") next = Math.max(0, at - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = lanes.length - 1;
    else if (event.key === "Enter" && selectedKey) {
      onOpen(selectedKey);
      event.preventDefault();
      return;
    } else return;
    event.preventDefault();
    if (lanes[next]!.key !== selectedKey) onSelect(lanes[next]!.key);
  };
  if (!lanes.length) {
    return <p className="adecd-empty">Nothing here yet. Each cloud lane gets its own computer, and every computer you pay for is listed here.</p>;
  }
  return (
    <div
      className="adecd-table"
      role="listbox"
      tabIndex={0}
      aria-label="Lanes and computers. Arrow keys move, Enter looks inside."
      aria-activedescendant={selectedKey ? `adecd-row-${cssId(selectedKey)}` : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="adecd-tr adecd-th" aria-hidden="true">
        <span>Lane</span><span>Size</span><span>Disk</span><span>State</span><span>Last run</span>
      </div>
      {lanes.map((lane) => {
        const open = lane.key === selectedKey;
        return (
          <div key={lane.key} className="adecd-row-wrap" data-open={open || undefined} data-key={cssId(lane.key)}>
            <div
              id={`adecd-row-${cssId(lane.key)}`}
              role="option"
              aria-selected={open}
              className="adecd-tr"
              onClick={() => onSelect(lane.key)}
              onDoubleClick={() => onOpen(lane.key)}
            >
              <span className="adecd-name">
                {lane.tier ? <CloudSizeIcon tier={lane.tier.id} size={16} /> : <CloudMark size={16} brand />}
                <span className="adecd-name-text">{lane.name}</span>
                {/* One mark at most, so the name keeps its room: no lane, then unused, then safe to delete. */}
                {lane.noLane ? <span className="kit-tag">No lane</span>
                  : lane.old ? <span className="kit-tag" data-tone="warn" title={lane.safe ? "Not used for a long time. Its pull request is merged and nothing is unpushed." : "Not used for a long time"}>Unused</span>
                  : lane.safe ? <span className="kit-tag" data-tone="ok" title="Its pull request is merged and nothing is unpushed">Safe to delete</span>
                  : null}
              </span>
              <span className="adecd-tsize">{lane.tier ? <>{lane.tier.label}<em className="kit-num">{lane.rateLabel}</em></> : "—"}</span>
              <span className="kit-num">{lane.state === "none" ? "—" : formatCloudGb(lane.diskGb)}</span>
              <span className="adecd-state" data-state={lane.state}><i />{STATE_LABEL[lane.state]}</span>
              <span className="adecd-when">{lastRunText(lane, now)}</span>
            </div>
            {open ? <div className="adecd-row-actions">{renderActions(lane)}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

function LaneActions({
  lane,
  account,
  job,
  busy,
  onLookInside,
  onSize,
  onFree,
  onDelete,
}: {
  lane: DashLane;
  account: CloudAccountState;
  job: ReturnType<typeof cloudLaneJobFor>;
  busy: boolean;
  onLookInside: () => void;
  onSize: () => void;
  onFree: () => void;
  onDelete: () => void;
}) {
  const life = cloudLaneLifeAvailable();
  const jobRunning = job != null && (job.phase === "waiting" || job.phase === "running");
  return (
    <>
      {job ? <CloudLaneJobCard job={job} account={account} variant="panel" /> : null}
      {lane.without ? <CloudLaneWithoutComputerNotice lane={lane.without} account={account} variant="row" /> : null}
      {lane.instanceId ? (
        <div className="adecd-actions">
          <button type="button" className="kit-btn" data-size="sm" onClick={onLookInside}><MagnifyingGlass size={12} />What uses the disk</button>
          {life && !lane.noLane ? (
            <>
              <button type="button" className="kit-btn" data-size="sm" disabled={busy || jobRunning} onClick={onSize}>Change size</button>
              <button type="button" className="kit-btn" data-size="sm" disabled={busy} onClick={onFree}>Keep lane, free its computer</button>
            </>
          ) : null}
          {life ? (
            <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" data-tone="crit" disabled={busy} onClick={onDelete}>
              <Trash size={12} />{lane.noLane ? "Delete computer" : "Delete lane"}
            </button>
          ) : null}
          {lane.noLane ? <span className="adecd-actions-note">Made before each lane had its own computer. It still counts toward your computers and disk.</span> : null}
        </div>
      ) : null}
    </>
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
    sub: `${formatCloudGb(part.gb)}${part.clearable ? ", can clear" : ""}`,
    aria: `${part.label}, ${formatCloudGb(part.gb)}${part.clearable ? ", safe to clear" : ""}`,
    detail: [formatCloudGb(part.gb), ...(part.clearable ? ["Safe to clear"] : [])],
    size: part.gb,
    rank: 1,
    awake: lane.state === "awake",
    old: false,
  })), [usage, lane.state]);
  const clearableGb = (usage?.items ?? []).filter((part) => part.clearable).reduce((total, part) => total + part.gb, 0);
  const total = usage?.totalGb ?? 0;
  const canClear = clearableGb > 0 && Boolean(window.ade.cloud?.clearCaches) && lane.state !== "failed";
  const backRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    backRef.current?.focus();
  }, []);
  return (
    <div className="adecd-inside" role="region" aria-label={`Inside ${lane.name}`}>
      <div className="adecd-inside-top">
        <button ref={backRef} type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={onBack}><ArrowLeft size={12} />All lanes</button>
        <b>{lane.name}</b>
        <span className="adecd-grow" />
        <span className="adecd-hint">{usage ? `Measured ${formatAgo(usage.measuredAt, now)}` : "Not measured yet"}</span>
        {canClear ? (
          <button type="button" className="kit-btn" data-size="sm" disabled={busy} onClick={onClear}><Broom size={12} />{busy ? "Clearing…" : `Clear ${formatCloudGb(clearableGb)} of caches`}</button>
        ) : null}
      </div>
      {usage && items.length ? (
        <div className="adecd-inside-body">
          <div className="adecd-citycard adecd-inside-city">
            <CloudCity items={items} selectedKey={selectedPart} onSelect={setSelectedPart} label={`What uses the disk of ${lane.name}`} compact stars={false} />
          </div>
          <ul className="adecd-parts">
            {usage.items.map((part, index) => (
              <li key={`${part.kind}:${index}`}>
                <span>{part.label}</span>
                <span className="kit-meter"><span style={{ width: `${percentOf(part.gb, total)}%` }} /></span>
                <span className="kit-num">{formatCloudGb(part.gb)}</span>
                {part.clearable ? <span className="kit-tag" data-tone="ok">Safe to clear</span> : <span />}
              </li>
            ))}
            <li className="adecd-parts-total">
              <span>{formatCloudGb(total)} used of {formatCloudGb(lane.diskGb)}</span>
              <span />
              <span />
              <span>{lane.state === "awake" ? "" : "Asleep: its last measure"}</span>
            </li>
          </ul>
        </div>
      ) : (
        <p className="adecd-empty">
          {lane.name}&apos;s computer measures its disk while it is awake and idle, at most every few hours. Its first measure shows here then. ADE doesn&apos;t wake it to look.
        </p>
      )}
    </div>
  );
}

/**
 * What a cheaper plan's limits will remove (and when), what the last cleanup
 * removed, and timed wakes that were cancelled: each one sentence from the
 * server's shared wording, so the app and the emails say the same thing.
 */
function PlanNotices({ account }: { account: CloudAccountState }) {
  const cleanup = account.planCleanup ?? null;
  const done = account.planCleanupDone ?? null;
  const wakes = account.timedWakesCancelled ?? null;
  if (!cleanup && !done && !wakes) return null;
  return (
    <>
      {cleanup ? (
        <Banner
          layout="inline"
          model={{
            id: "cloud-plan-cleanup",
            tone: "warning",
            title: cleanup.sentence,
            detail: cleanup.dueAt ? `This happens on ${formatCloudDate(cleanup.dueAt)}. To choose which go, delete computers yourself before then.` : undefined,
            extra: cleanup.computers.length ? (
              <ul className="adecd-cleanup-list">
                {cleanup.computers.map((computer) => (
                  <li key={computer.instanceId}>
                    <b>{computer.laneName ?? computer.name ?? computer.instanceId}</b>
                    <span>{computer.branch ? `work goes to ${computer.branch}` : "no lane"}, {formatCloudGb(computer.diskGb)}</span>
                  </li>
                ))}
              </ul>
            ) : undefined,
            report: false,
          }}
        />
      ) : null}
      {done ? <Banner layout="inline" model={{ id: `cloud-cleanup-done-${done.at}`, tone: "info", title: "ADE freed computers for your plan", detail: planCleanupDoneSentence(done), report: false }} /> : null}
      {wakes ? <Banner layout="inline" model={{ id: `cloud-wakes-${wakes.at}`, tone: "warning", title: "Timed wake-ups were cancelled", detail: timedWakesCancelledSentence(wakes), report: false }} /> : null}
    </>
  );
}
