import { useEffect, useState } from "react";
import { ArrowSquareOut, CheckCircle, Clock, Cloud, Cpu, ListChecks, Moon, Pulse, SunHorizon, Trash, Warning } from "@phosphor-icons/react";
import { idleCleanupWhen, type CloudIdleCleanupEntry } from "../../../shared/adeCloud";
import type { CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import { cloudLaneJobIsLive } from "../../../shared/cloudLaneLife";
import { useCloudAccount } from "../../state/cloudAccountStore";
import { navigateToAppTarget } from "../../lib/openExternal";
import { showToast } from "../app/toast/toastStore";
import { useCloudLaneComputer, type AdeCloudLaneComputer } from "../../state/adeCloudLaneIndex";
import { useChatMachineWake } from "../chat/useChatMachineWake";
import { useChatRuntimeScope } from "../chat/ChatRuntimeScope";
import { useAnchoredActionMenu, type AnchoredActionMenu } from "../remoteTargets/MachineActionsMenu";
import { callCloudMachineAction, confirmCloudSleep } from "../remoteTargets/useCloudBoxActions";
import { refreshCloudMachines, useCloudMachines } from "../remoteTargets/useCloudMachines";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { Z_LAYERS } from "../ui/zLayers";
import { WORK_HEADER_ICON_BUTTON_CLASS } from "../work/WorkHeaderPaneToggles";
import { CloudTierChangeDialog } from "./CloudTierChangeDialog";
import { cloudLaneJobPresentation } from "./CloudLaneJobCard";
import { cloudLaneChangesAvailable, cloudLaneMovesAvailable } from "./cloudLaneActions";
import { cloudLaneJobFor, openCloudLaneJobBar, useCloudLaneJobs } from "./cloudLaneStores";
import { CLOUD_LANE_POWER_TEXT, cloudLanePower, cloudLaneStatusModel, type CloudLanePower } from "./cloudLaneStatus";
import { deleteCloudLaneWithCheck } from "./deleteCloudLane";
import { forgetCloudComputerStatus, useCloudComputerStatus } from "./useCloudComputerStatus";
import "../remoteTargets/cloudBrand.css";
import "../remoteTargets/connections.css";
import "./cloudLaneStatus.css";

/**
 * A cloud lane's chat header: one cloud button for the lane's computer. Its
 * mark says asleep, waking or awake (the chat has no "asleep" banner; a
 * message still wakes it), with a warning dot while the idle cleanup plans to
 * delete it. Its menu opens on the computer's status (how long it is up, its
 * size, disk and the account's hours, its work, what runs, trouble only when
 * there is some) and then what can be done: wake it, keep it, change its
 * size, sleep it, the ADE Cloud page, delete the lane (B14-21).
 *
 * Account level, by the computer's ADE Cloud id, like the ADE Cloud page: no
 * pin. Reading never wakes the computer; the status is read once when the
 * menu opens (`useCloudComputerStatus`, and the account's list). Only Wake,
 * Sleep and Delete act on it. Wake is the chat's own wake (it also connects
 * the chat) when the chat's machine is this computer asleep, else the
 * account's wake by id. Nothing for a lane that isn't on ADE Cloud.
 *
 * `turnRunning`: this chat's turn is running, so Sleep asks first (sleep
 * freezes the computer, and the turn may fail), as Sleep does everywhere.
 */
export function CloudLaneHeaderButton({ laneId, turnRunning }: { laneId: string | null; turnRunning: boolean }) {
  const computer = useCloudLaneComputer(laneId);
  const account = useCloudAccount();
  const machine = useChatMachineWake();
  const scope = useChatRuntimeScope();
  const menu = useAnchoredActionMenu();
  const [sizing, setSizing] = useState(false);
  if (!computer) return null;
  const name = computer.laneName || "this lane";
  const idle = account?.dueForDeletion?.find((entry) => entry.instanceId === computer.instanceId) ?? null;
  const power = cloudLanePower({
    state: computer.state,
    waking: machine.waking,
    resting: machine.resting,
    online: scope.isRemote && scope.online,
  });
  const title = [
    `ADE Cloud computer · ${CLOUD_LANE_POWER_TEXT[power]}`,
    idle ? (idle.held ? "It wasn't deleted: ADE couldn't save its work" : `It will be ${idleCleanupWhen(idle.deletesAt, Date.now())} because it isn't used`) : null,
  ].filter(Boolean).join(". ");

  const wakeNow = async () => {
    forgetCloudComputerStatus(computer.instanceId);
    // The chat's own wake connects it too, and its failure shows in the chat (with Try again).
    if (machine.resting) {
      await machine.wake();
      return;
    }
    const result = await callCloudMachineAction({ instanceId: computer.instanceId, action: "wake" });
    if (!result?.ok) {
      showToast({
        tone: "warning",
        title: `Couldn't wake ${name}'s computer`,
        message: result?.message || "This window can't reach ADE Cloud. Try it from the ADE desktop app.",
      });
    }
    refreshCloudMachines();
  };

  return (
    <>
      <button
        {...menu.triggerProps}
        type="button"
        className={WORK_HEADER_ICON_BUTTON_CLASS}
        aria-label={`ADE Cloud computer of ${name}: ${CLOUD_LANE_POWER_TEXT[power]}`}
        title={title}
      >
        <span className="adecl-power">
          <Cloud size={16} weight="bold" />
          <i aria-hidden="true" data-power={power} />
          {idle ? <i aria-hidden="true" data-due="true" /> : null}
        </span>
      </button>
      {menu.open ? (
        <CloudLaneStatusMenu
          menu={menu}
          computer={computer}
          name={name}
          power={power}
          idle={idle}
          turnRunning={turnRunning}
          onWake={() => void wakeNow()}
          onSize={() => setSizing(true)}
        />
      ) : null}
      {sizing ? <CloudTierChangeDialog instanceId={computer.instanceId} laneName={name} onClose={() => setSizing(false)} /> : null}
    </>
  );
}

/** How often the menu's relative times ("up 42m", "sleeps in ~2 min") move while it is open. */
const MENU_TICK_MS = 30_000;

/**
 * The open menu. Mounted only while open, so its reads (the account's list,
 * the status) and its clock run only then. Focus, Escape and focus return are
 * the shared action menu's (`useAnchoredActionMenu`).
 */
function CloudLaneStatusMenu({
  menu,
  computer,
  name,
  power,
  idle,
  turnRunning,
  onWake,
  onSize,
}: {
  menu: AnchoredActionMenu;
  computer: AdeCloudLaneComputer;
  name: string;
  power: CloudLanePower;
  idle: CloudIdleCleanupEntry | null;
  turnRunning: boolean;
  onWake: () => void;
  onSize: () => void;
}) {
  const account = useCloudAccount();
  // The account's list once on open (no settle polling): the size, disk, work and up-since.
  const { result } = useCloudMachines(true, { settle: false });
  const box = (result?.state === "ok" ? result.machines.find((entry) => entry.instanceId === computer.instanceId) ?? null : null) as CloudLaneMachine | null;
  const { status, loading, failed: statusFailed, retry: retryStatus } = useCloudComputerStatus(computer.instanceId);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MENU_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  // A size change or move of this lane: its step now, a way to its steps, and no sleep countdown.
  const jobs = useCloudLaneJobs();
  const job = cloudLaneJobFor(jobs, { instanceId: computer.instanceId, laneId: computer.laneId });
  const jobLive = job != null && cloudLaneJobIsLive(job);
  const jobText = job && (jobLive || job.phase === "failed") ? cloudLaneJobPresentation(job, account) : null;
  const model = cloudLaneStatusModel({ power, box, status, account, now, changing: jobLive });
  const life = cloudLaneChangesAvailable();

  const { run } = menu;

  const sleepNow = () => {
    forgetCloudComputerStatus(computer.instanceId);
    void sleepLaneComputer(computer.instanceId, name, turnRunning ? 1 : 0);
  };

  return (
    <AnchoredMenu
      open
      anchorRef={menu.anchorRef}
      onClose={menu.close}
      placement="bottom-end"
      role="menu"
      aria-label={`ADE Cloud computer of ${name}`}
      className="ade-cx-menu adecl-status-menu"
      zIndex={Z_LAYERS.contextMenu}
      onKeyDown={menu.closeOnEscape}
      remeasureKey={`${box ? 1 : 0}${loading ? 1 : 0}${statusFailed ? 1 : 0}${model.lines.length}${jobText ? 1 : 0}`}
    >
      <div ref={menu.menuRef} style={{ display: "contents" }}>
        {power === "asleep" ? (
          <button type="button" role="menuitem" className="ade-cx-menu-item" onClick={run(onWake)}>
            <span className="ade-cx-menu-icon"><SunHorizon size={13} /></span>
            Asleep · Wake now
          </button>
        ) : null}
        <div className="adecl-status-head" role="presentation">
          <div className="adecl-status-title">
            <b title={name}>{name}</b>
            {power !== "asleep" ? (
              <span className="adecl-status-state" data-power={power}>
                <i aria-hidden="true" />
                <span className="kit-num" data-face="ui">{model.stateText}</span>
              </span>
            ) : null}
          </div>
          {jobText ? (
            <div className="adecl-status-line" data-tone={job?.phase === "failed" ? "warn" : undefined} title={jobText.stepLine ?? undefined}>
              <span className="adecl-status-ic" aria-hidden="true">
                {job?.phase === "failed" ? <Warning size={12} weight="fill" /> : <Cloud size={12} weight="bold" />}
              </span>
              <span>
                {jobText.title}
                {jobText.stepLine ? <small className="adecl-status-job-step"> · {jobText.stepLine}</small> : null}
              </span>
            </div>
          ) : null}
          {model.sizeText ? <div className="adecl-status-row"><span>{jobLive ? `Now ${model.sizeText}` : model.sizeText}</span></div> : null}
          {model.disk || model.hours ? (
            <div className="adecl-status-row">
              {model.disk ? <span className="kit-num" data-face="ui" data-tone={model.disk.tone ?? undefined}>{model.disk.text}</span> : null}
              {model.hours ? <span className="kit-num" data-face="ui" data-tone={model.hours.tone ?? undefined}>{model.hours.text}</span> : null}
            </div>
          ) : null}
          {model.lines.map((line) => (
            <div key={line.key} className="adecl-status-line" data-tone={line.tone ?? undefined} title={line.hint}>
              <span className="adecl-status-ic" aria-hidden="true">
                {line.key === "work" && line.tone === "ok" ? <CheckCircle size={12} weight="fill" />
                  : line.tone === "warn" || line.tone === "crit" ? <Warning size={12} weight="fill" />
                  : <Pulse size={12} />}
              </span>
              <span>{line.text}</span>
            </div>
          ))}
          {loading && !box ? <div className="adecl-status-line"><small>Reading its status…</small></div> : null}
          {statusFailed && !loading ? (
            <div className="adecl-status-line">
              <small>Couldn&apos;t load this computer&apos;s status</small>
              <small aria-hidden="true">·</small>
              <button type="button" role="menuitem" className="adecl-status-retry" onClick={retryStatus}>Try again</button>
            </div>
          ) : null}
        </div>
        <div className="ade-cx-menu-rule" />
        {power === "waking" ? (
          <button type="button" role="menuitem" className="ade-cx-menu-item" disabled>
            <span className="ade-cx-menu-icon"><SunHorizon size={13} /></span>
            Waking…
          </button>
        ) : null}
        {idle && window.ade.cloud?.keepIdleComputer ? (
          <button
            type="button"
            role="menuitem"
            className="ade-cx-menu-item"
            aria-label={idle.held ? "Keep this computer. ADE couldn't save its work, so it wasn't deleted." : `Keep this computer. Otherwise it is ${idleCleanupWhen(idle.deletesAt, Date.now())}.`}
            onClick={run(() => void keepLaneComputer(computer.instanceId, name))}
          >
            <span className="ade-cx-menu-icon"><Clock size={13} /></span>
            Keep this computer
          </button>
        ) : null}
        <div className="adecl-status-actions">
          {job && jobText ? (
            <button
              type="button"
              role="menuitem"
              className="ade-cx-menu-item"
              // The chat's bar above the prompt box opens on its steps; with none on screen, the ADE Cloud page shows them.
              onClick={run(() => {
                if (!openCloudLaneJobBar(job.jobId)) navigateToAppTarget({ kind: "settings", tab: "ade-cloud", anchor: "cloud-lanes" });
              })}
            >
              <span className="ade-cx-menu-icon"><ListChecks size={13} /></span>
              {job.kind === "move" ? "Show the move's steps" : "Show the change's steps"}
            </button>
          ) : null}
          {(life || cloudLaneMovesAvailable()) && !jobLive ? (
            <button type="button" role="menuitem" className="ade-cx-menu-item" onClick={run(onSize)}>
              <span className="ade-cx-menu-icon"><Cpu size={13} /></span>
              Change size
            </button>
          ) : null}
          {power === "awake" && !jobLive ? (
            <button type="button" role="menuitem" className="ade-cx-menu-item" onClick={run(sleepNow)}>
              <span className="ade-cx-menu-icon"><Moon size={13} /></span>
              Sleep now
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="ade-cx-menu-item"
            aria-label="Disk, credits and more on the ADE Cloud page"
            onClick={run(() => navigateToAppTarget({ kind: "settings", tab: "ade-cloud", anchor: "cloud-lanes" }))}
          >
            <span className="ade-cx-menu-icon"><ArrowSquareOut size={13} /></span>
            ADE Cloud page
          </button>
        </div>
        {life ? (
          <>
            <div className="ade-cx-menu-rule" />
            <button
              type="button"
              role="menuitem"
              className="ade-cx-menu-item"
              data-tone="danger"
              onClick={run(() => void deleteCloudLaneWithCheck({ instanceId: computer.instanceId, laneName: name, askFirst: true }))}
            >
              <span className="ade-cx-menu-icon"><Trash size={13} /></span>
              Delete lane
            </button>
          </>
        ) : null}
      </div>
    </AnchoredMenu>
  );
}

/** "Keep it" (the chat header, Manage lane): the server restarts the computer's idle clock with no wake. */
export async function keepLaneComputer(instanceId: string, name: string): Promise<void> {
  const result = await window.ade.cloud?.keepIdleComputer?.(instanceId).catch((error: unknown) => {
    console.warn("[cloud] keeping a lane's computer failed", error);
    return { ok: false, message: error instanceof Error ? error.message : undefined };
  });
  if (result?.ok) showToast({ tone: "success", title: `Kept ${name}'s computer`, message: "ADE Cloud won't delete it. Its unused days count again from now." });
  else showToast({ tone: "warning", title: `Couldn't keep ${name}'s computer`, message: result?.message || "Send a message in the lane to keep it." });
  refreshCloudMachines();
}

/**
 * Sleep (the chat header, Manage lane): the shared confirm, which asks when
 * chats run there, the IPC call, a toast either way, then the list read again.
 */
export async function sleepLaneComputer(instanceId: string, name: string, runningChats: number): Promise<void> {
  if (!(await confirmCloudSleep(`${name}'s computer`, runningChats))) return;
  const result = await callCloudMachineAction({ instanceId, action: "sleep" });
  if (result?.ok) {
    showToast({ tone: "info", title: `${name}'s computer is going to sleep.` });
  } else {
    showToast({
      tone: "warning",
      title: `Couldn't put ${name}'s computer to sleep`,
      message: result?.message || "This window can't reach ADE Cloud. Try it from the ADE desktop app.",
    });
  }
  refreshCloudMachines();
}
