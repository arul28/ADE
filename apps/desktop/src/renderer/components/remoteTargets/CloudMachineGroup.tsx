import { useEffect, useRef, type ReactNode } from "react";
import { ArrowClockwise, CircleNotch, GitBranch, Sun, UserCirclePlus, UserMinus } from "@phosphor-icons/react";
import {
  cloudAccountBanner,
  cloudHoursLeftMilli,
  type CloudAccountState,
  cloudMachineSelfUpdating,
  cloudOutOfHours,
  describeCloudMachineSize,
  describeCloudSleepPolicy,
  formatCloudHoursRate,
  type CloudCatalog,
  type CloudMachine,
  type CloudMachinesResult,
} from "../../../shared/adeCloud";
import { Banner } from "../ui/notice";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import type { CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import { cloudUnitWords, type CloudUnitWords } from "../../../shared/cloudUnitWords";
import { CloudLaneSavedWork } from "../cloudLane/CloudLaneSavedWork";
import { openCloudComputerLimitCard } from "../cloudLane/CloudComputerLimitCard";
import type { NoticeAction } from "../ui/notice/NoticeParts";
import { CloudMark, ADE_CLOUD_NAME } from "./cloudBrand";
import {
  CLOUD_STATE_LABELS,
  cloudGroupTotals,
  cloudStateTone,
  describeCloudRate,
  type CloudBoxWork,
} from "./cloudMachineModel";
import { CloudUpdateLine } from "./CloudUpdateLine";
import { cloudPendingLabel, type CloudBoxActionError, type CloudBoxPending } from "./useCloudBoxActions";
import { connectButtonStyle, machineRowStyle, nameStyle, subTextStyle } from "./remoteTargetListStyles";


/** The group's head: the mark, how many computers, and how fast they use hours now. */
export function CloudGroupHead({
  boxes,
  loading,
  account = null,
}: {
  boxes: readonly CloudMachine[];
  loading: boolean;
  /** The account, for its words (hours or credits); null before it is read. */
  account?: CloudAccountState | null;
}) {
  const totals = cloudGroupTotals(boxes);
  const words = cloudUnitWords(account);
  return (
    <div className="ade-cx-section-head ade-cx-cloud-head">
      <CloudMark size={12} bold />
      {ADE_CLOUD_NAME}
      {loading ? <CircleNotch size={11} className="animate-spin" aria-label="Checking ADE Cloud" /> : null}
      {totals.hoursRate > 0 ? (
        <span className="ade-cx-cloud-head-facts kit-num" title={`How fast the computers awake now use your ${words.noun}. ${words.unitSentence}`}>
          Now: {formatCloudHoursRate(totals.hoursRate, words)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * What stops or threatens every box: ADE Cloud refusing this account, or
 * running out of hours. Each says what it blocks and offers the next step.
 */
export function CloudGroupBanners({
  result,
  loadError,
  onRetry,
  onOpenSettings,
}: {
  result: CloudMachinesResult | null;
  loadError: string | null;
  onRetry: () => void;
  onOpenSettings?: (() => void) | null;
}) {
  const banners: ReactNode[] = [];
  if (loadError && !result) {
    banners.push(
      <Banner key="load" layout="inline" model={{ id: "cloud-machines-load", tone: "warning", icon: <CloudMark size={15} />, title: `ADE couldn't read your ${ADE_CLOUD_NAME} machines`, detail: loadError, actions: [{ label: "Retry", icon: <ArrowClockwise size={12} />, onClick: onRetry }] }} />,
    );
  }
  if (result?.state === "access_refused") {
    banners.push(
      <Banner key="refused" layout="inline" model={{ id: "cloud-access-refused", tone: "error", icon: <CloudMark size={15} />, title: `${ADE_CLOUD_NAME} refused this account`, detail: result.message ?? "ADE can't show, wake or delete your machines right now. They keep running.", report: false }} />,
    );
  }
  if (result?.state === "unreachable") {
    banners.push(
      <Banner key="unreachable" layout="inline" model={{ id: "cloud-unreachable", tone: "warning", icon: <CloudMark size={15} />, title: `ADE couldn't reach ${ADE_CLOUD_NAME}`, detail: result.message ?? undefined, actions: [{ label: "Retry", icon: <ArrowClockwise size={12} />, onClick: onRetry }] }} />,
    );
  }
  const accountBanner = result?.state === "ok" && result.account ? cloudAccountBanner(result.account) : null;
  if (accountBanner) {
    if (cloudOutOfHours(result?.account) && result?.machines.length) {
      banners.push(
        <div key="saved-work" className="ade-ig-mini-rows">
          {result.machines.flatMap((box) => {
            // At 0 hours no computer wakes; each lane's saved work reads with no wake.
            const lane = (box as CloudLaneMachine).lane;
            return lane?.laneId ? [
              <div key={box.instanceId} className="ade-ig-mini-row">
                <span className="ade-ig-mini-title">{lane.laneName ?? "Lane"}</span>
                <CloudLaneSavedWork laneId={lane.laneId} laneName={lane.laneName} />
              </div>,
            ] : [];
          })}
        </div>,
      );
    }
    banners.push(
      <Banner
        key="hours"
        layout="inline"
        model={{
          ...accountBanner,
          icon: <CloudMark size={15} />,
          actions: onOpenSettings ? [{ label: `Plans and ${cloudUnitWords(result?.state === "ok" ? result.account : null).noun}`, onClick: onOpenSettings }] : undefined,
          report: false,
        }}
      />,
    );
  }
  return banners.length ? <div style={{ display: "grid", gap: 8 }}>{banners}</div> : null;
}

/** What a failed action blocks on, as the buttons that clear it. */
function errorActions(error: CloudBoxActionError, onOpenSettings?: (() => void) | null): NoticeAction[] | undefined {
  // At the computer limit: the card with its three ways out (free up, delete, move up).
  if (error.blocker === "computer_limit") return [{ label: "See your options", onClick: () => openCloudComputerLimitCard(error.computerLimit ?? null) }];
  const needsPlan = error.blocker === "out_of_hours" || error.blocker === "over_plan_limits";
  return needsPlan && onOpenSettings ? [{ label: "Plans and hours", onClick: onOpenSettings }] : undefined;
}

/**
 * The provider line on a machine's card: state, type and size, how fast it
 * uses hours in this state, and its lanes. A sleeping box gets Wake here,
 * where the row would otherwise offer nothing.
 */
export function CloudBoxStrip({
  box,
  catalog,
  words,
  work,
  pending,
  approvalUrl,
  error,
  onDismissError,
  onWake,
  onRetryUpdate,
  onOpenSettings,
}: {
  box: CloudMachine;
  /** The account's sizes, so the box's size reads as the pickers name it. */
  catalog: CloudCatalog;
  /** The account's words (hours or credits) for the box's rate. */
  words?: CloudUnitWords;
  work: CloudBoxWork;
  pending: CloudBoxPending | null;
  /** A copy's or move's sign-in link while its new computer waits for the person. */
  approvalUrl?: string | null;
  error: CloudBoxActionError | null;
  onDismissError: () => void;
  /** Wake on the card itself; rows that put Wake in place of Connect pass null. */
  onWake?: (() => void) | null;
  /** The person's own update, offered when the last one failed. */
  onRetryUpdate?: (() => void) | null;
  onOpenSettings?: (() => void) | null;
}) {
  const tone = cloudStateTone(box);
  const stateLabel = box.pastDue ? "Suspended" : CLOUD_STATE_LABELS[box.state];
  const rate = describeCloudRate(box, words);
  const atRest = box.state === "asleep" || box.state === "stopped";
  const canWake = atRest && !box.pastDue;
  const laneNames = work.lanes.map((lane) => (lane.projectName ? `${lane.name} (${lane.projectName})` : lane.name));
  // A refusal shows under the card, which can sit at the panel's bottom edge:
  // bring it into view so the answer to the click is never off screen.
  const errorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  return (
    <div className="ade-cx-cloud-strip" data-cloud-instance={box.instanceId}>
      <div className="ade-cx-cloud-facts-clip">
        <div className="ade-cx-cloud-facts">
          <span className="kit-tag" data-tone={tone ?? undefined} title={`ADE Cloud status: ${box.status}`}>
            {stateLabel}
          </span>
          <span className="ade-cx-cloud-fact">{describeCloudMachineSize(box, catalog)}</span>
          {rate ? <span className="ade-cx-cloud-fact kit-num">{rate}</span> : null}
          {box.sleep.state !== "auto" ? (
            <span
              className="ade-cx-cloud-fact"
              title="The ADE on this computer is older than sleeping on its own. It sleeps when idle once ADE on it updates."
            >
              {describeCloudSleepPolicy(box.sleep)}
            </span>
          ) : null}
          {laneNames.length ? (
            <span className="ade-cx-cloud-fact ade-cx-cloud-lanes" title={laneNames.join("\n")}>
              <GitBranch size={11} weight="bold" />
              <span>{laneNames.length === 1 ? laneNames[0] : `${laneNames.length} lanes`}</span>
            </span>
          ) : null}
          {/* It updates itself: the line takes the place of an Update button. A failure gets its own row below. */}
          {cloudMachineSelfUpdating(box) && box.update?.state !== "failed" ? <CloudUpdateLine update={box.update} /> : null}
          {work.runningChats > 0 && !atRest ? (
            <span className="ade-cx-cloud-fact">{work.runningChats === 1 ? "1 chat running" : `${work.runningChats} chats running`}</span>
          ) : null}
          {canWake && onWake && !pending ? (
            <button type="button" className="ade-cx-cloud-wake" onClick={onWake}>
              <Sun size={12} weight="bold" />
              {box.state === "stopped" ? "Start" : "Wake"}
            </button>
          ) : null}
        </div>
      </div>
      {pending ? (
        <div role="status" className="ade-cx-cloud-pending">
          <CircleNotch size={12} className="animate-spin" />
          {cloudPendingLabel(pending)}
          {approvalUrl ? (
            // The approval is the account's: this computer's ADE browser (or this browser), where the person is signed in.
            <button type="button" className="ade-cx-cloud-wake" onClick={() => openUrlInAdeBrowser(approvalUrl)}>
              <UserCirclePlus size={12} weight="bold" />
              Approve
            </button>
          ) : null}
        </div>
      ) : null}
      {cloudMachineSelfUpdating(box) && box.update?.state === "failed" ? (
        <div>
          <CloudUpdateLine update={box.update} onRetry={box.pastDue ? null : onRetryUpdate} retrying={pending === "update"} />
        </div>
      ) : null}
      {box.failure ? (
        <div className="ade-cx-cloud-note">{ADE_CLOUD_NAME} couldn't run it: {box.failure}</div>
      ) : null}
      {box.diskFull ? (
        <Banner
          layout="inline"
          model={{
            id: `cloud-disk-full-${box.instanceId}`,
            tone: "warning",
            title: box.diskFull,
            // A bigger size and the plans live in Settings.
            actions: onOpenSettings ? [{ label: "Plans and hours", onClick: onOpenSettings }] : undefined,
            report: false,
          }}
        />
      ) : null}
      {error ? (
        <div ref={errorRef}>
          <Banner
            layout="inline"
            model={{
              id: `cloud-action-error-${box.instanceId}`,
              tone: error.blocker ? "warning" : "error",
              title: error.message,
              actions: errorActions(error, onOpenSettings),
              dismiss: { onDismiss: onDismissError },
              ...(error.blocker ? { report: false as const } : { report: { surface: "cloud_machine_action" } }),
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * ADE Cloud as one machine in the machine list: how many lanes it has, how
 * many are awake, and the hours left. Each lane's computer is ADE's
 * business; Settings › ADE Cloud lists the lanes by name, with their sizes and
 * actions. Never a computer's own name or id.
 */
export function AdeCloudMachineRow({
  boxes,
  account,
  known,
  onOpenSettings,
}: {
  boxes: readonly CloudMachine[];
  account: CloudAccountState | null;
  /** The account's computers were read; before that the row claims nothing. */
  known: boolean;
  onOpenSettings?: (() => void) | null;
}) {
  const lanes = boxes.filter((box) => (box as CloudLaneMachine).lane).length;
  const awake = cloudGroupTotals(boxes).running;
  const words = cloudUnitWords(account);
  const hoursLeft = account ? words.short(cloudHoursLeftMilli(account)) : null;
  // Parts of one line, each its own phrase: a sentence never gets the hours
  // joined onto it with a comma ("…start one., 0 h left").
  const line = !known
    ? "Your account's cloud machine"
    : lanes === 0
      ? "No lanes yet: pick ADE Cloud in Run on to start one"
      : `${lanes} ${lanes === 1 ? "lane" : "lanes"}, ${awake === 0 ? "all asleep" : `${awake} awake`}`;
  return (
    <div style={machineRowStyle} data-ade-cloud-machine="">
      <div className="ade-cx-row-grid">
        <span className="ade-cx-cloud-avatar" aria-hidden>
          <CloudMark size={18} bold />
        </span>
        <div style={{ minWidth: 0, display: "grid", gap: 4 }}>
          <span style={nameStyle}>{ADE_CLOUD_NAME}</span>
          <span style={subTextStyle}>
            {line}
            {hoursLeft != null ? <span className="kit-num">{` · ${hoursLeft} left`}</span> : null}
          </span>
        </div>
        {onOpenSettings ? (
          <div className="ade-cx-row-actions">
            <button type="button" onClick={onOpenSettings} style={{ ...connectButtonStyle, marginRight: 4 }}>
              Open
            </button>
          </div>
        ) : <span />}
      </div>
    </div>
  );
}

/**
 * What a row shows for a box that can't take a connection: the line in place
 * of its presence and the button in place of Connect. Null for a box that is
 * up (or moving), where the row's own Connect stays.
 */
export function cloudParkedRow(
  box: CloudMachine,
  name: string,
  pending: CloudBoxPending | null,
  onWake: () => void,
): { label: string; action: ReactNode } | null {
  if (box.pastDue) {
    return {
      label: `Suspended on ${ADE_CLOUD_NAME}.`,
      action: null,
    };
  }
  if (box.state !== "asleep" && box.state !== "stopped") return null;
  const verb = box.state === "stopped" ? "Start" : "Wake";
  return {
    label: box.state === "stopped" ? `Stopped on ${ADE_CLOUD_NAME}` : `Asleep on ${ADE_CLOUD_NAME}`,
    action: (
      <button
        type="button"
        aria-label={`${verb} ${name}`}
        disabled={pending != null}
        onClick={onWake}
        style={{ ...connectButtonStyle, marginRight: 4, opacity: pending ? 0.5 : 1, cursor: pending ? "not-allowed" : "pointer" }}
      >
        {pending ? <CircleNotch size={13} className="animate-spin" /> : <Sun size={13} weight="bold" />}
        {verb}
      </button>
    ),
  };
}

/** The row of a box deleted on the provider site: what happened, and Remove in place of Connect. */
export function cloudDeletedRow(name: string, onRemove: () => void): { label: string; action: ReactNode } {
  return {
    label: `Deleted on ${ADE_CLOUD_NAME}. It no longer exists.`,
    action: (
      <button type="button" aria-label={`Remove ${name} from ADE`} onClick={onRemove} style={{ ...connectButtonStyle, marginRight: 4 }}>
        <UserMinus size={13} />
        Remove
      </button>
    ),
  };
}
