import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, Broom, Cpu, Desktop, MagnifyingGlass, Trash } from "@phosphor-icons/react";
import {
  CLOUD_FREE_GITHUB_BANNER_ID,
  CLOUD_FREE_REFUSED_BANNER_ID,
  CLOUD_PLAN_LABELS,
  cloudAccountBanner,
  type CloudAccountBanner,
  cloudAccountComputers,
  cloudEarnedHoursOf,
  cloudExtraHourCentsOf,
  cloudFreePlanOf,
  cloudCatalogOf,
  cloudHoursLeftMilli,
  cloudPlanIdOf,
  cloudPlanLabelOf,
  cloudSmallHoursSentence,
  cloudSmallRateMilli,
  formatCloudCentsPerHour,
  formatCloudDate,
  formatCloudGb,
  formatCloudHours,
  percentOf,
  planCleanupDoneSentence,
  timedWakesCancelledSentence,
  type CloudAccountState,
  type CloudPlanCleanupPick,
} from "../../../../shared/adeCloud";
import type { CloudLaneMachine } from "../../../../shared/cloudLaneLaunch";
import { cloudTierHoursAt } from "../../../../shared/cloudTiers";
import { cloudUnitWords } from "../../../../shared/cloudUnitWords";
import { resolveSettingsHash } from "../../../../shared/settingsManifest";
import { useLocation } from "react-router-dom";
import { formatAgo, ipcErrorMessage } from "../../../lib/format";
import { isAdeAvailable } from "../../../lib/adeAvailability";
import { showToast } from "../../app/toast/toastStore";
import { ADE_CLOUD_NAME, CloudLogo, CloudMark, CloudSizeIcon } from "../../remoteTargets/cloudBrand";
import type { CloudMachinesState } from "../../remoteTargets/useCloudMachines";
import { MachineActionsMenu, type MachineAction } from "../../remoteTargets/MachineActionsMenu";
import { confirmDialog } from "../../ui/dialog";
import { Banner, type NoticeAction } from "../../ui/notice";
import { cloudFreeGithubHeroLine } from "./CloudFreeGithubNotice";
import { usageLeftLevel } from "../../usage/usageDesign";
import { CloudAgentLimitsCard } from "../CloudAgentLimitsCard";
import { isWebClientMode } from "../../../lib/webClientMode";
import { ADE_CLOUD_FREE_SPACE_ANCHOR, ADE_CLOUD_PLAN_ANCHOR, decodeSettingsHash } from "../settingsHash";
import { CloudCity, type CityItem } from "./CloudCity";
import { CloudSky, useStillWhenHidden } from "./CloudSky";
import { cloudPlanMomentWords, dismissCloudPlanMoment, useCloudPlanMomentState } from "./cloudPlanMoment";
import { CloudFreeUpSpace } from "./CloudFreeUpSpace";
import { CLOUD_EXTRA_ANCHOR, CloudPlans } from "./CloudPlans";
import { CloudPlanLimitsDialog, planCleanupPickSentence } from "./CloudPlanLimitsDialog";
import { CloudIdleCleanupNotices, idleRowTag } from "./CloudIdleCleanupNotice";
import { CloudSizes } from "./CloudSizes";
import { CloudSignIns } from "./CloudSignIns";
import { CloudInviteCard } from "./CloudInvite";
import { useHasOwnComputer, useOwnWebComputers } from "../../../state/ownComputers";
import { useWebMachines } from "../../../webclient/workspace/WebWorkspaceContext";
import {
  STATE_LABEL,
  dashLanes,
  heroBalanceParts,
  heroCreditsWorth,
  heroPeriodChip,
  hoursForecast,
  lastRunText,
  planName,
  removedReasonText,
  prefersReducedMotion,
  type DashLane,
} from "./cloudDashboardModel";
import { clearCloudLaneCaches, cloudLaneChangesAvailable, cloudLaneLifeAvailable } from "../../cloudLane/cloudLaneActions";
import { deleteCloudLaneWithCheck, freeCloudLaneWithConfirm, useCloudLaneDeletes, type CloudLaneDeletePhase } from "../../cloudLane/deleteCloudLane";
import { cloudLaneJobFor, cloudLaneJobVisible, refreshCloudLanesWithoutComputer, useCloudLaneJobs, useCloudLanesWithoutComputer } from "../../cloudLane/cloudLaneStores";
import { CloudLaneJobCard, cloudLaneJobPresentation } from "../../cloudLane/CloudLaneJobCard";
import type { CloudLaneJobSnapshot } from "../../../../shared/cloudLaneLife";
import { CloudLaneWithoutComputerNotice } from "../../cloudLane/CloudLaneWithoutComputer";
import { CloudSavedLaneWorkCard } from "../../cloudLane/CloudLaneSavedWork";
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
 * shows at once, nothing folds away: the credits and computers
 * against the plan, every computer the account pays for, the plans
 * side by side, the sizes, the sign-ins cloud computers use, and what agents
 * may do alone.
 *
 * Account level: everything goes through this app's main process with no pin,
 * except Clear caches, which runs on the lane's own computer through its
 * binding (`cloudLaneActions.ts`). It reads only what the computer list
 * already holds; nothing wakes a computer to look.
 */
export function CloudDashboard({ account, machines }: { account: CloudAccountState; machines: CloudMachinesState }) {
  // On the web, only a connected computer of the person's own answers for the
  // sign-ins; with all of them offline the account's cards show instead.
  const ownComputerOn = useOwnWebComputers().some((machine) => machine.status === "live");
  const ownComputer = useHasOwnComputer() && (!isWebClientMode() || ownComputerOn);
  // ADE Web with no computer of its own still reads and sets the agent limits
  // through a connected ADE Cloud computer, when one is connected.
  const connectedMachine = useWebMachines().some((machine) => machine.status === "live");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [insideKey, setInsideKey] = useState<string | null>(null);
  const { hash, search, key: navigationKey } = useLocation();
  // A lane link to a lane kept without a computer (`?lane=<id>`): its row opens once it lists.
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
  // The web app with none of the account's computers online: the plan is read, the computers are not.
  const computersUnread = result?.computersUnread === true;
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
  const deletes = useCloudLaneDeletes();

  // A lane whose delete went through leaves at once, before the next read of the list.
  const lanes = useMemo(
    () => dashLanes({ machines: list, account, without, now }).filter((lane) => !lane.instanceId || deletes.get(lane.instanceId) !== "deleted"),
    [list, account, without, now, deletes],
  );
  /** A lane's row says where its size change or its delete is, in place. */
  const rowStatus = useCallback((lane: DashLane): RowStatus | null => {
    const deleting = lane.instanceId ? deletes.get(lane.instanceId) : undefined;
    if (deleting) return deleteRowStatus(deleting);
    if (!lane.instanceId) return null;
    const job = cloudLaneJobFor(jobs, { instanceId: lane.instanceId, laneId: lane.machine?.lane?.laneId ?? null });
    return job ? jobRowStatus(job, account) : null;
  }, [account, deletes, jobs]);
  const selected = lanes.find((lane) => lane.key === selectedKey) ?? null;
  // The lanes the table lists show their own saved work; the saved-work card shows the rest.
  const shownLaneIds = useMemo(
    () => new Set(lanes.flatMap((lane) => [lane.machine?.lane?.laneId, lane.without?.laneId]).filter((id): id is string => Boolean(id))),
    [lanes],
  );
  const selectedJob = selected?.instanceId ? cloudLaneJobFor(jobs, { instanceId: selected.instanceId, laneId: selected.machine?.lane?.laneId ?? null }) : null;
  const otherJobs = useMemo(() => [...jobs.values()].filter((job) => cloudLaneJobVisible(job) && job.phase !== "online"
    && job.jobId !== selectedJob?.jobId), [jobs, selectedJob?.jobId]);
  const inside = insideKey ? lanes.find((lane) => lane.key === insideKey) ?? null : null;
  useEffect(() => {
    if (insideKey && !inside) setInsideKey(null);
  }, [insideKey, inside]);

  const tableRef = useRef<HTMLDivElement | null>(null);
  const selectRow = useCallback((key: string) => {
    setSelectedKey(key);
    tableRef.current?.querySelector<HTMLElement>(`[data-key="${cssId(key)}"]`)?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);
  const linkedLaneKey = useMemo(() => {
    const laneId = new URLSearchParams(search).get("lane")?.trim();
    return laneId ? `none:${laneId}` : null;
  }, [search]);
  const linkedLaneListed = linkedLaneKey != null && lanes.some((lane) => lane.key === linkedLaneKey);
  // Once per navigation: a later list refresh keeps the person's own pick,
  // and opening the same link again selects the row again.
  const linkedLaneOpened = useRef<string | null>(null);
  const linkedLaneRefreshed = useRef<string | null>(null);
  useEffect(() => {
    if (!linkedLaneKey) return;
    const visit = `${navigationKey}|${linkedLaneKey}`;
    if (linkedLaneOpened.current === visit) return;
    if (!linkedLaneListed) {
      // The lane may have lost its computer after the last read: read once more.
      if (linkedLaneRefreshed.current !== visit) {
        linkedLaneRefreshed.current = visit;
        refreshCloudLanesWithoutComputer();
      }
      return;
    }
    linkedLaneOpened.current = visit;
    setInsideKey(null);
    selectRow(linkedLaneKey);
  }, [linkedLaneKey, linkedLaneListed, navigationKey, selectRow]);
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
    setBusyKey(lane.key);
    try {
      await freeCloudLaneWithConfirm({ instanceId: lane.instanceId, laneName: lane.name, onDone: refresh });
    } finally {
      setBusyKey(null);
    }
  };

  // The free plan's GitHub hold: the hero's line and the plan card's notice say it, with what to do.
  const accountBanner = cloudAccountBanner(account);
  const banner = accountBanner?.id === CLOUD_FREE_GITHUB_BANNER_ID || accountBanner?.id === CLOUD_FREE_REFUSED_BANNER_ID ? null : accountBanner;
  // The plan's computer limit, asleep or not.
  const computers = cloudAccountComputers(account);
  // "You're on Plus", while this session shows it (cloudPlanMoment.ts).
  const moment = useCloudPlanMomentState();
  const openBillingPortal = async () => {
    try {
      await window.ade.cloud?.openBillingPortal?.();
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't open billing", message: errorText(error) });
    }
  };

  return (
    <div id={CLOUD_DASHBOARD_ID} className="adecd" aria-label={`${ADE_CLOUD_NAME} dashboard`}>
      <CloudHero
        account={account}
        now={now}
        celebrating={moment != null}
        moment={moment ? { key: moment.key, ...cloudPlanMomentWords(moment) } : null}
        status={banner}
        onUpdateCard={window.ade.cloud?.openBillingPortal ? () => void openBillingPortal() : null}
      />

      <PlanNotices account={account} onChanged={refresh} />
      <CloudIdleCleanupNotices account={account} now={now} onChanged={refresh} />

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
          <span className="adecd-head-note">{`${computers.total} of ${computers.limit} computers`} · {account.computers.awake} awake</span>
        </header>
        <div className="kit-card-body" data-flush="true" ref={tableRef}>
          {inside ? (
            <LookInside lane={inside} now={now} busy={busyKey === inside.key} onBack={() => setInsideKey(null)} onClear={() => void clearCaches(inside)} />
          ) : (
            <LaneTable
              lanes={lanes}
              computersUnread={computersUnread}
              now={now}
              selectedKey={selected?.key ?? null}
              onSelect={(key) => setSelectedKey((current) => (current === key ? null : key))}
              onOpen={openInside}
              rowStatus={rowStatus}
              renderActions={(lane) => (
                <LaneActions lane={lane} account={account} job={lane.key === selected?.key ? selectedJob : null} />
              )}
              menuActions={(lane) => {
                const job = lane.instanceId ? cloudLaneJobFor(jobs, { instanceId: lane.instanceId, laneId: lane.machine?.lane?.laneId ?? null }) : null;
                return laneMenuActions(lane, {
                  jobRunning: job != null && (job.phase === "waiting" || job.phase === "running"),
                  busy: busyKey === lane.key,
                  onLookInside: () => openInside(lane.key),
                  onSize: () => setSizing(lane),
                  onFree: () => void freeLane(lane),
                  onDelete: () => void deleteLane(lane),
                });
              }}
            />
          )}
        </div>
      </section>

      <CloudSavedLaneWorkCard shownLaneIds={shownLaneIds} />

      <CloudPlans account={account} onChanged={refresh} newPlanId={moment?.planId ?? null} />
      <CloudSizes account={account} />

      {/* Sign-ins on the left; the shorter agent limits and the invite card
          stack on the right, so the two columns end near one height (B14-2). */}
      {/* With no computer of the person's own (ADE Web), the sign-ins show as
          "Providers on ADE Cloud" below this page instead. The web app reads
          the agent limits from the account; on a server without that route
          they need a connected computer (an ADE Cloud one will do). */}
      {ownComputer ? (
        <div className="adecd-pair">
          <CloudSignIns />
          <div className="adecd-stack">
            <CloudAgentLimitsCard />
            <CloudInviteCard account={account} onChanged={refresh} />
          </div>
        </div>
      ) : (
        <div className="adecd-stack">
          {connectedMachine || isWebClientMode() ? <CloudAgentLimitsCard /> : null}
          <CloudInviteCard account={account} onChanged={refresh} />
        </div>
      )}

      {freeing ? (
        <CloudFreeUpSpace account={account} lanes={lanes} now={now} onClose={() => setFreeing(false)} onDone={refresh} />
      ) : null}
      {sizing?.instanceId ? <CloudTierChangeDialog instanceId={sizing.instanceId} laneName={sizing.name} onClose={() => { setSizing(null); refresh(); }} /> : null}
    </div>
  );
}

/**
 * The night sky at the top: the plan and when it resets, then three parts in
 * a row (stacked when narrow): what is left of the plan's credits,
 * split by what used them; the cloud computers against the plan's limit; and
 * what happens past the plan. The numbers are said once on the page. Reads
 * only the account already in hand: no read, timer or call of its own.
 */
function CloudHero({
  account,
  now,
  celebrating,
  moment,
  status,
  onUpdateCard,
}: {
  account: CloudAccountState;
  now: number;
  /** A plan just landed: the plan's name glows once. */
  celebrating: boolean;
  /** "You're on Plus", once after a plan lands (`cloudPlanMoment.ts`): said inside the hero, dismissable. */
  moment: { key: string; title: string; detail: string } | null;
  /** Out of credits, nearly out, a failed payment: said inside the hero, in its own sky (`cloudAccountBanner`). */
  status: CloudAccountBanner | null;
  /** Opens the billing portal, for a failed payment; null where there is none. */
  onUpdateCard: (() => void) | null;
}) {
  const heroRef = useRef<HTMLElement | null>(null);
  useStillWhenHidden(heroRef);
  const words = cloudUnitWords(account);
  const catalog = cloudCatalogOf(account);
  const hours = account.hours;
  const earned = cloudEarnedHoursOf(account).leftMilli;
  const hoursPct = hours.includedMilli > 0 ? (hours.leftMilli / hours.includedMilli) * 100 : 0;
  const level = usageLeftLevel(hoursPct);
  // Small is free unless the account's catalog rates it (Free, sponsored cards off): then its time left shows too.
  const smallRateMilli = cloudSmallRateMilli(catalog);
  const forecast = hoursForecast(account, now, words);
  const worth = heroCreditsWorth(account, words);
  const parts = heroBalanceParts(account);
  const computers = cloudAccountComputers(account);
  // The free plan refused on this computer (another account used its free hours): one sentence from the server.
  const freePlan = cloudFreePlanOf(account);
  const blockedSentence = freePlan.state === "refused" ? freePlan.sentence ?? null : null;
  // The free plan's GitHub rules hold its hours: one line here, the plan card says what to do.
  const githubLine = account.rules === "free" && freePlan.github ? cloudFreeGithubHeroLine(freePlan.github) : null;
  const period = heroPeriodChip(account);
  const held = hours.includedMilli <= 0 && (githubLine || blockedSentence) && account.plan === "free";
  const scrollTo = (id: string) => {
    const element = document.getElementById(id);
    element?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    return element;
  };
  const toPlans = () => scrollTo("cloud-plan");
  // The extra switch lives on the plans card: go there and hand it focus.
  const toExtra = () => scrollTo(CLOUD_EXTRA_ANCHOR)?.querySelector<HTMLElement>("[role='switch'], input, button")?.focus({ preventScroll: true });
  const leftLabel = "Credits left";
  const planTotal = held ? cloudCatalogOf(account).plans.free.includedMilli : hours.includedMilli;
  const barParts = parts.filter((part) => part.milli > 0);
  const barTotal = Math.max(1, hours.includedMilli);
  const barAria = `${parts.map((part) => `${part.label} ${formatCloudHours(part.shownMilli)}`).join(", ")}, of ${formatCloudHours(hours.includedMilli)} ${words.noun}`;
  const extra = account.extraHours;
  const extraCents = cloudExtraHourCentsOf(cloudPlanIdOf(account), catalog) ?? catalog.extraHourCents;
  const keepsGoing = extra.available && extra.enabled;
  // Small never uses credits (unless the catalog rates it), so only the bigger sizes pause.
  // Free credits held (GitHub rules, or another account used them here) don't come back at the reset, and nothing runs.
  const pauseLine = held
    ? earned > 0
      ? "Your earned credits run your computers. Once they're used, cloud computers wait until the free plan's check clears, or you pick a paid plan."
      : "Cloud computers wait until the free plan's check clears, or you pick a paid plan."
    : smallRateMilli > 0
    ? `Cloud computers pause until ${formatCloudDate(account.billing.periodEnd)}.`
    : `Bigger computers pause until ${formatCloudDate(account.billing.periodEnd)}. Small keeps working.`;
  return (
    <section ref={heroRef} className="adecd-citycard adecd-hero" aria-label={`${ADE_CLOUD_NAME}, ${planName(account)}`}>
      <CloudSky />
      <header className="adecd-hero-head">
        <CloudLogo size={22} glow />
        <span className="adecd-hero-brand">{ADE_CLOUD_NAME}</span>
        <h2 className="adecd-hero-plan" data-celebrate={celebrating || undefined}>{cloudPlanLabelOf(account, catalog)}</h2>
        <span className="adecd-hero-period" data-tone={period.tone ?? undefined}>{period.text}</span>
        <span className="adecd-grow" />
        <button type="button" className={account.plan === "free" ? "adecd-cta" : "adecd-glassbtn"} onClick={toPlans}><span>Compare plans</span></button>
      </header>
      <div className="adecd-hero-parts">
        <div className="adecd-hero-part adecd-hero-balance" role="group" aria-label={leftLabel} data-level={level}>
          <span className="adecd-label" title={`${cloudSmallHoursSentence(catalog, words)} ${words.unitSentence}`}>{leftLabel}</span>
          <div className="adecd-hours-num">
            <b className="kit-num" data-face="ui">{formatCloudHours(hours.leftMilli)}</b>
            {/* Free hours held (GitHub rules, or another account used them here): the plan's own number, on hold, never "of 0". */}
            <span>{held ? `of ${formatCloudHours(planTotal)}, on hold` : `of ${formatCloudHours(planTotal)}`}</span>
          </div>
          <div className="adecd-bar" role="img" aria-label={barAria}>
            {barParts.map((part) => (
              <span key={part.key} data-part={part.key} style={{ flexGrow: part.milli / barTotal }} />
            ))}
          </div>
          <ul className="adecd-legend" aria-hidden="true">
            {parts.map((part) => (
              <li key={part.key} data-part={part.key}><i />{part.label} <b className="kit-num">{formatCloudHours(part.shownMilli)}</b></li>
            ))}
          </ul>
          <ul className="adecd-hours-notes">
            {blockedSentence ? <li data-tone="warn">{blockedSentence}</li> : null}
            {githubLine ? <li data-tone="warn">{githubLine} <button type="button" className="adecd-linkish" onClick={toPlans}>See how</button></li> : null}
            {worth || forecast ? <li>{[worth, forecast].filter(Boolean).join(" ")}</li> : null}
            {earned > 0 ? <li data-tone="lamp">{`${words.milli(earned)} earned from invites, used after your plan's. They never expire.`}</li> : null}
            {smallRateMilli > 0 ? (
              <li>
                {`${cloudSmallHoursSentence(catalog, words)} ${cloudTierHoursAt({ multiplierMilli: smallRateMilli }, cloudHoursLeftMilli(account))} left at that size.`}
                {account.sponsored?.smallNeedsCards ? " Sponsored cards make it unlimited." : ""}
              </li>
            ) : null}
          </ul>
        </div>
        <div className="adecd-hero-rail">
          <div className="adecd-hero-stat" role="group" aria-label="Cloud computers" title="Every cloud computer counts toward your plan, asleep or not.">
            <span className="adecd-label">Cloud computers</span>
            <div className="adecd-stat-row">
              <div className="adecd-part-num">
                <b className="kit-num" data-face="ui">{computers.total}</b>
                <span>of {computers.limit}</span>
              </div>
              <ComputerWindows total={computers.total} limit={computers.limit} awake={account.computers.awake} />
            </div>
            <span className="adecd-part-line">{account.computers.awake} awake now</span>
          </div>
          <div className="adecd-hero-stat" role="group" aria-label={WHEN_CREDITS_RUN_OUT}>
            <span className="adecd-label">{WHEN_CREDITS_RUN_OUT}</span>
            <div className="adecd-stat-row">
              <div className="adecd-part-state" data-on={keepsGoing || undefined}>
                <i aria-hidden="true" />
                <b>{keepsGoing ? "Keep going" : "Pause"}</b>
              </div>
              {extra.available ? (
                <button type="button" className="adecd-linkish adecd-part-link" onClick={toExtra}>{extra.enabled ? "Change" : "Turn on"}</button>
              ) : account.plan === "free" ? (
                <button type="button" className="adecd-linkish adecd-part-link" onClick={toPlans}>See paid plans</button>
              ) : null}
            </div>
            <span className="adecd-part-line">
              {keepsGoing
                ? `Extra credits at ${formatCloudCentsPerHour(extraCents)} each, billed after use.${extra.usedMilli > 0 ? ` ${words.milli(extra.usedMilli)} extra this month.` : ""}`
                : `${pauseLine}${account.plan === "free" && !held ? ` Paid plans can keep going for ${formatCloudCentsPerHour(catalog.extraHourCents)} ${words.perUnit}.` : ""}`}
            </span>
          </div>
        </div>
      </div>
      {moment ? (
        <Banner
          layout="inline"
          surface="night"
          style={{ position: "relative", marginTop: 12 }}
          model={{
            id: `cloud-plan-moment-${moment.key}`,
            tone: "success",
            icon: <CloudLogo size={14} glow />,
            title: moment.title,
            detail: moment.detail,
            actions: [{ label: "See your plan", onClick: toPlans }],
            dismiss: { onDismiss: dismissCloudPlanMoment },
            report: false,
          }}
        />
      ) : null}
      {status ? (
        <Banner
          layout="inline"
          surface="night"
          style={{ position: "relative", marginTop: 12 }}
          model={{ ...status, actions: statusActions(status, account, { onExtra: toExtra, onPlans: toPlans, onUpdateCard }), report: false }}
        />
      ) : null}
    </section>
  );
}

/**
 * The plan's lit windows: one per computer the plan allows (up to 20), lit for
 * each computer the account has, glowing for each awake one, like the
 * buildings on the pricing page.
 */
function ComputerWindows({ total, limit, awake }: { total: number; limit: number; awake: number }) {
  const slots = Math.min(20, Math.max(limit, total));
  if (slots <= 0) return null;
  return (
    <span className="adecd-windows" aria-hidden="true" data-many={slots > 10 || undefined} style={{ "--adecd-window-cols": Math.min(slots, slots > 10 ? 10 : 5) } as CSSProperties}>
      {Array.from({ length: slots }, (_, index) => (
        <i key={index} data-state={index < awake ? "awake" : index < total ? "asleep" : undefined} />
      ))}
    </span>
  );
}

/** The one thing to do about the account's urgent line; none when there is nothing to do. */
function statusActions(
  status: CloudAccountBanner,
  account: CloudAccountState,
  to: { onExtra: () => void; onPlans: () => void; onUpdateCard: (() => void) | null },
): NoticeAction[] {
  if (status.id === "cloud-hours-past-due") return to.onUpdateCard ? [{ label: "Update card", variant: "primary", onClick: to.onUpdateCard }] : [];
  if (status.id === "cloud-hours-restored") return [];
  const extra = account.extraHours;
  if (!extra.available) return [{ label: "Compare plans", onClick: to.onPlans }];
  return extra.enabled ? [] : [{ label: `Turn on ${cloudUnitWords(account).extra.toLowerCase()}`, onClick: to.onExtra }];
}

const WHEN_CREDITS_RUN_OUT = "When credits run out";

/** Every lane and every computer the account pays for, one row each; the selected row opens its actions under it. */
function LaneTable({
  lanes,
  computersUnread = false,
  now,
  selectedKey,
  onSelect,
  onOpen,
  rowStatus,
  renderActions,
  menuActions,
}: {
  lanes: readonly DashLane[];
  /** The computers weren't read (the web app with none online): say so, not "nothing here". */
  computersUnread?: boolean;
  now: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onOpen: (key: string) => void;
  /** A size change or delete under way, shown in the row's State cell in place of the computer's state. */
  rowStatus: (lane: DashLane) => RowStatus | null;
  /** What shows under the open row: its job card and notices, or null. */
  renderActions: (lane: DashLane) => ReactNode;
  /** The row's actions, behind its ⋯ button at the right end (B14-22). */
  menuActions: (lane: DashLane) => MachineAction[];
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The listbox keeps focus itself (`aria-activedescendant`): keys from a
    // row's ⋯ button or its open menu (a portal, so they bubble here) are theirs.
    if (event.target !== event.currentTarget) return;
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
  if (!lanes.length && computersUnread) {
    return <p className="adecd-empty">None of your computers is online, so ADE can't list your cloud lanes and computers here. They show when one is.</p>;
  }
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
        <span>Lane</span><span>Size</span><span>State</span><span>Last run</span><span />
      </div>
      {lanes.map((lane) => {
        const open = lane.key === selectedKey;
        const status = rowStatus(lane);
        const actions = menuActions(lane);
        const below = open ? renderActions(lane) : null;
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
                {/* One mark at most, so the name keeps its room: the idle cleanup's warning, no lane, then unused, then safe to delete. */}
                {lane.idle ? <IdleTag lane={lane} now={now} />
                  : lane.noLane ? <span className="kit-tag">No lane</span>
                  : lane.old ? <span className="kit-tag" data-tone="warn" title={lane.safe ? "Not used for a long time. Its pull request is merged and nothing is unpushed." : "Not used for a long time"}>Unused</span>
                  : lane.safe ? <span className="kit-tag" data-tone="ok" title="Its pull request is merged and nothing is unpushed">Safe to delete</span>
                  : null}
              </span>
              <span className="adecd-tsize">{lane.tier ? <>{lane.tier.label}<em className="kit-num">{lane.rateLabel}</em></> : "—"}</span>
              {status ? (
                <span className="adecd-state" data-state={status.state} title={status.title ?? undefined}><i />{status.label}</span>
              ) : (
                <span className="adecd-state" data-state={lane.state}><i />{STATE_LABEL[lane.state]}</span>
              )}
              <span className="adecd-when" title={removedReasonText(lane) ?? undefined}>{lastRunText(lane, now)}</span>
              {/* The ⋯ menu's column; the menu itself sits beside the option, never inside it. */}
              <span aria-hidden="true" />
            </div>
            {actions.length ? (
              <span className="adecd-row-menu">
                <MachineActionsMenu label={`Actions for ${lane.name}`} actions={actions} />
              </span>
            ) : null}
            {open && below ? <div className="adecd-row-actions">{below}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

/** What shows under an open row: the lane's size-change job and the notices about it. Its actions are in the row's ⋯ menu. */
function LaneActions({
  lane,
  account,
  job,
}: {
  lane: DashLane;
  account: CloudAccountState;
  job: ReturnType<typeof cloudLaneJobFor>;
}) {
  if (!job && !lane.without && !lane.noLane) return null;
  return (
    <>
      {job ? <CloudLaneJobCard job={job} account={account} variant="panel" /> : null}
      {lane.without ? <CloudLaneWithoutComputerNotice lane={lane.without} account={account} /> : null}
      {lane.noLane ? <span className="adecd-actions-note">Made before each lane had its own computer. It still counts as one of your plan's computers.</span> : null}
    </>
  );
}

/** A lane row's actions for its ⋯ menu; the delete sits last, after a rule. */
function laneMenuActions(lane: DashLane, args: {
  jobRunning: boolean;
  busy: boolean;
  onLookInside: () => void;
  onSize: () => void;
  onFree: () => void;
  onDelete: () => void;
}): MachineAction[] {
  if (!lane.instanceId) return [];
  const life = cloudLaneChangesAvailable();
  const actions: MachineAction[] = [
    { key: "disk", label: "What uses the disk", icon: <MagnifyingGlass size={13} />, onSelect: args.onLookInside },
  ];
  if (life && !lane.noLane) {
    actions.push(
      { key: "size", label: "Change size", icon: <Cpu size={13} />, onSelect: args.onSize, disabled: args.busy || args.jobRunning },
      { key: "free", label: "Keep the lane, free its computer", icon: <Desktop size={13} />, onSelect: args.onFree, disabled: args.busy },
    );
  }
  if (life) {
    actions.push({ key: "delete", label: lane.noLane ? "Delete computer" : "Delete lane", icon: <Trash size={13} />, onSelect: args.onDelete, disabled: args.busy, danger: true });
  }
  return actions;
}

const cssId = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, "_");

/** The idle cleanup's mark on a lane row: when it is deleted, or that ADE kept it after a failed save. */
function IdleTag({ lane, now }: { lane: DashLane; now: number }) {
  if (!lane.idle) return null;
  const tag = idleRowTag(lane.idle, now);
  return <span className="kit-tag" data-tone="warn" title={tag.title}>{tag.label}</span>;
}

/** What a row's State cell says while its lane changes size or is deleted. */
type RowStatus = { state: "starting" | "failed" | "awake"; label: string; title: string | null };

function deleteRowStatus(phase: CloudLaneDeletePhase): RowStatus {
  return phase === "checking"
    ? { state: "starting", label: "Checking work", title: "ADE checks that its work is on GitHub before it deletes the lane." }
    : { state: "starting", label: "Deleting", title: null };
}

function jobRowStatus(job: CloudLaneJobSnapshot, account: CloudAccountState | null): RowStatus | null {
  const { row, stepLine } = cloudLaneJobPresentation(job, account);
  return row ? { ...row, title: stepLine } : null;
}

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
  const canClear = clearableGb > 0 && isAdeAvailable(window.ade.cloud?.clearCaches) && lane.state !== "failed";
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
          {usage
            ? `${lane.name}'s files use ${formatCloudGb(total)}, too little to break down. Its computer measures again while it is awake and idle; ADE doesn't wake it to look.`
            : `${lane.name}'s computer measures its disk while it is awake and idle, at most every few hours. Its first measure shows here then. ADE doesn't wake it to look.`}
        </p>
      )}
    </div>
  );
}

/**
 * A cheaper plan's limits, what the last pick freed, and timed wakes that
 * were cancelled: each from the server's shared wording, so the app and the
 * emails say the same thing. Over a cheaper plan (in force, or a cancel made
 * in the billing portal waiting), the notice opens the same question as a
 * downgrade (CloudPlanLimitsDialog); while ADE frees a pick it says so.
 */
function PlanNotices({ account, onChanged }: { account: CloudAccountState; onChanged: () => void }) {
  const cleanup = account.planCleanup ?? null;
  const done = account.planCleanupDone ?? null;
  const wakes = account.timedWakesCancelled ?? null;
  const [asking, setAsking] = useState(false);
  if (!cleanup && !done && !wakes) return null;
  const plan = cleanup ? CLOUD_PLAN_LABELS[cleanup.planId] : "";
  const freeing = cleanup?.freeing ?? null;
  const freeingCount = freeing?.instanceIds.length ?? 0;
  const pickFor = async (pick: CloudPlanCleanupPick) => {
    if (!cleanup) return;
    const bridge = window.ade.cloud?.pickPlanCleanup;
    if (!bridge) throw new Error("This version of ADE can't do that here.");
    await bridge({ planId: cleanup.planId, ...pick });
    showToast({ tone: "success", title: planCleanupPickSentence(pick.push, pick.instanceIds.length) });
    onChanged();
  };
  return (
    <>
      {cleanup && freeing ? (
        <Banner
          layout="inline"
          model={{
            id: `cloud-plan-freeing-${freeing.at}`,
            tone: "info",
            busy: true,
            title: `ADE is freeing ${freeingCount === 1 ? "1 computer" : `${freeingCount} computers`} to fit ${plan}`,
            detail: freeing.push
              ? "Each goes once its lanes' work is saved in ADE Cloud. Nothing is pushed. Their lanes and chats stay."
              : "Their lanes and chats stay.",
            report: false,
          }}
        />
      ) : cleanup ? (
        <Banner
          layout="inline"
          model={{
            id: "cloud-plan-cleanup",
            tone: "warning",
            title: `You have more cloud computers than ${plan} allows`,
            detail: `${cleanup.sentence} ${cleanup.startsAt != null
              ? `You move to ${plan} on ${formatCloudDate(cleanup.startsAt)}. ADE deletes nothing on its own.`
              : "ADE can't make a new computer until you have fewer. It deletes nothing on its own."}`,
            actions: [{ label: "Choose what goes", variant: "primary", onClick: () => setAsking(true) }],
            report: false,
          }}
        />
      ) : null}
      {asking && cleanup && !freeing ? (
        <CloudPlanLimitsDialog
          cleanup={cleanup}
          mode="resolve"
          currentPlanLabel={cloudPlanLabelOf(account, cloudCatalogOf(account))}
          onClose={() => setAsking(false)}
          onPick={pickFor}
        />
      ) : null}
      {done ? <Banner layout="inline" model={{ id: `cloud-cleanup-done-${done.at}`, tone: "info", title: "ADE freed computers for your plan", detail: planCleanupDoneSentence(done), report: false }} /> : null}
      {wakes ? <Banner layout="inline" model={{ id: `cloud-wakes-${wakes.at}`, tone: "warning", title: "Timed wake-ups were cancelled", detail: timedWakesCancelledSentence(wakes), report: false }} /> : null}
    </>
  );
}
