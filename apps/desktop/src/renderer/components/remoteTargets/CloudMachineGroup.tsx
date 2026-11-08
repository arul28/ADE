import { useEffect, useRef, type ReactNode } from "react";
import { ArrowClockwise, CircleNotch, GitBranch, Sun, UserMinus } from "@phosphor-icons/react";
import {
  describeCloudMachineSize,
  describeCloudSleepPolicy,
  formatCloudHourlyPrice,
  formatCloudUsd,
  type CloudMachine,
  type CloudMachinesResult,
} from "../../../shared/adeCloud";
import { Banner } from "../ui/notice";
import type { NoticeAction } from "../ui/notice/NoticeParts";
import { CloudMark, ADE_CLOUD_NAME } from "./cloudBrand";
import {
  CLOUD_STATE_LABELS,
  cloudGroupTotals,
  cloudStateTone,
  describeCloudRate,
  describeCloudSpend,
  type CloudBoxWork,
} from "./cloudMachineModel";
import { MachineActionsMenu, type MachineAction } from "./MachineActionsMenu";
import { cloudPendingLabel, type CloudBoxActionError, type CloudBoxPending } from "./useCloudBoxActions";
import { connectButtonStyle, machineRowStyle, nameStyle, subTextStyle } from "./remoteTargetListStyles";

/** The tag on a ready machine that is not yet anyone's (a claimed one is an ordinary machine). */
const READY_STATE_LABELS = {
  preparing: "Being prepared",
  failed: "Prepare failed",
} as const;


/** The group's head: the mark, how many boxes, and what they cost now and so far. */
export function CloudGroupHead({
  boxes,
  loading,
}: {
  boxes: readonly CloudMachine[];
  loading: boolean;
}) {
  const totals = cloudGroupTotals(boxes);
  const facts = [
    boxes.length > 0 ? `${formatCloudHourlyPrice(totals.hourlyUsd)} now` : null,
    totals.spentUsd != null && boxes.length > 0 ? `${formatCloudUsd(totals.spentUsd)} so far` : null,
    totals.savedUsd != null && totals.savedUsd >= 0.01 ? `${formatCloudUsd(totals.savedUsd)} saved asleep` : null,
  ].filter(Boolean);
  return (
    <div className="ade-cx-section-head ade-cx-cloud-head">
      <CloudMark size={12} bold />
      {ADE_CLOUD_NAME}
      <span className="ade-cx-count">{boxes.length}</span>
      {loading ? <CircleNotch size={11} className="animate-spin" aria-label="Checking ADE Cloud" /> : null}
      {facts.length ? (
        <span className="ade-cx-cloud-head-facts kit-num" title="ADE Cloud settles what a box spent once an hour, so the newest minutes show later.">
          {facts.join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

/**
 * What stops or threatens every box: ADE Cloud refusing this account, or the
 * monthly cap. Each says what it blocks and offers the next step.
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
  if (result?.state === "ok") {
    const { spending } = result;
    if (spending.monthlyCapUsd != null && spending.monthSpentUsd != null && (spending.capReached || spending.capNear)) {
      const capLine = `${formatCloudUsd(spending.monthSpentUsd)} of your ${formatCloudUsd(spending.monthlyCapUsd)} monthly cap`;
      banners.push(
        <Banner
          key="cap"
          layout="inline"
          model={{
            id: spending.capReached ? "cloud-cap-reached" : "cloud-cap-near",
            tone: spending.capReached ? "warning" : "info",
            icon: <CloudMark size={15} />,
            title: spending.capReached ? "You reached this month's ADE Cloud cap" : "Close to this month's ADE Cloud cap",
            detail: spending.capReached
              ? `${capLine}. ADE makes, wakes and resizes nothing until the 1st or until you raise it. Running work carries on.`
              : `${capLine}. At the cap ADE stops making and waking machines.`,
            actions: onOpenSettings ? [{ label: "Change the cap", onClick: onOpenSettings }] : undefined,
          }}
        />,
      );
    }
  }
  return banners.length ? <div style={{ display: "grid", gap: 8 }}>{banners}</div> : null;
}

/** What a failed action blocks on, as the buttons that clear it. */
function errorActions(error: CloudBoxActionError, onOpenSettings?: (() => void) | null): NoticeAction[] | undefined {
  switch (error.blocker) {
    case "cap":
      return onOpenSettings ? [{ label: "Change the cap", onClick: onOpenSettings }] : undefined;
    default:
      return undefined;
  }
}

/**
 * The provider line on a machine's card: state, type and size, the price in
 * this state, what it has spent, and its lanes. A sleeping box gets Wake here,
 * where the row would otherwise offer nothing.
 */
export function CloudBoxStrip({
  box,
  work,
  pending,
  error,
  onDismissError,
  onWake,
  onOpenSettings,
}: {
  box: CloudMachine;
  work: CloudBoxWork;
  pending: CloudBoxPending | null;
  error: CloudBoxActionError | null;
  onDismissError: () => void;
  /** Wake on the card itself; rows that put Wake in place of Connect pass null. */
  onWake?: (() => void) | null;
  onOpenSettings?: (() => void) | null;
}) {
  const tone = cloudStateTone(box);
  const stateLabel = box.pastDue ? "Suspended" : CLOUD_STATE_LABELS[box.state];
  const rate = describeCloudRate(box);
  const spend = describeCloudSpend(box);
  const canWake = (box.state === "asleep" || box.state === "stopped") && !box.pastDue;
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
          {box.ready && box.ready.state !== "claimed" ? (
            <span
              className="kit-tag"
              data-tone={box.ready.state === "failed" ? "crit" : undefined}
              title={`ADE keeps this machine ready for ${box.ready.projectName}: the next chat there starts on it. Settings › Integrations › ADE Cloud.`}
            >
              {box.ready.state === "ready" ? `Ready for ${box.ready.projectName}` : READY_STATE_LABELS[box.ready.state]}
            </span>
          ) : null}
          <span className="ade-cx-cloud-fact">{describeCloudMachineSize(box)}</span>
          {rate ? <span className="ade-cx-cloud-fact kit-num">{rate}</span> : null}
          {spend ? (
            <span
              className="ade-cx-cloud-fact kit-num"
              title={box.spentIsLifetime
                ? "Everything this box has cost, settled hourly by ADE Cloud."
                : "What this box cost in the last 90 days, the furthest back ADE Cloud reports."}
            >
              {spend}
            </span>
          ) : null}
          {box.madeByAde && box.sleep.state !== "auto" ? (
            <span
              className="ade-cx-cloud-fact"
              title={box.sleep.state === "never"
                ? "You turned sleep off for this box. Sleep when idle… in its menu turns it back on."
                : "The ADE on this box is older than sleeping on its own. It sleeps when idle once ADE on it updates."}
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
          {work.runningChats > 0 ? (
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
        </div>
      ) : null}
      {box.failure ? (
        <div className="ade-cx-cloud-note">{ADE_CLOUD_NAME} couldn't run it: {box.failure}</div>
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
 * A box with no ADE row: one that is still joining, was removed from ADE, or
 * never signed in. It still bills, so it stays in the list with its price and
 * Delete box.
 */
export function CloudBoxOnlyRow({
  box,
  accountKnown,
  actions,
  strip,
}: {
  box: CloudMachine;
  /** Whether the account's machine list was read; otherwise "not in ADE" is unknown. */
  accountKnown: boolean;
  actions: MachineAction[];
  strip: ReactNode;
}) {
  const name = box.name?.trim() || box.instanceId;
  // A box that carries its machine key has joined (the key is written at
  // join), so it is out of ADE, not still setting up, however new it is.
  const joining = !box.machineKey && box.createdAtMs != null && Date.now() - box.createdAtMs < 10 * 60_000;
  const line = !accountKnown
    ? `On ${ADE_CLOUD_NAME}`
    : joining
      ? "Setting up and signing in to your account…"
      : box.machineKey
        ? `Not in ADE. Reconnect it from ⋯. It bills on ${ADE_CLOUD_NAME} until you delete it.`
        : `Not in ADE. It bills on ${ADE_CLOUD_NAME} until you delete it.`;
  return (
    <div style={machineRowStyle} data-cloud-box-only={box.instanceId}>
      <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr) auto", gap: 12, alignItems: "center" }}>
        <span className="ade-cx-cloud-avatar" aria-hidden>
          <CloudMark size={18} bold />
        </span>
        <div style={{ minWidth: 0, display: "grid", gap: 4 }}>
          <span style={nameStyle}>{name}</span>
          <span style={subTextStyle}>{line}</span>
        </div>
        <MachineActionsMenu label={`Actions for ${name}`} actions={actions} />
      </div>
      {strip}
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
