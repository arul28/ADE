import { useEffect, useRef, type ReactNode } from "react";
import { ArrowClockwise, CircleNotch, GitBranch, Sun } from "@phosphor-icons/react";
import {
  AGENT37_API_KEYS_URL,
  AGENT37_BILLING_URL,
  agent37AtMachineLimit,
  agent37MachineLimitMessage,
  describeAgent37MachineSize,
  formatAgent37HourlyPrice,
  formatAgent37Usd,
  type Agent37Machine,
  type Agent37MachinesResult,
} from "../../../shared/agent37";
import { openExternalUrl } from "../../lib/openExternal";
import { Banner } from "../ui/notice";
import type { NoticeAction } from "../ui/notice/NoticeParts";
import { Agent37Mark, AGENT37_NAME } from "./agent37Brand";
import {
  AGENT37_STATE_LABELS,
  agent37GroupTotals,
  agent37StateTone,
  agent37WalletWarning,
  describeAgent37Rate,
  describeAgent37Spend,
  type Agent37BoxWork,
} from "./agent37MachineModel";
import { MachineActionsMenu, type MachineAction } from "./MachineActionsMenu";
import { agent37PendingLabel, type Agent37BoxActionError, type Agent37BoxPending } from "./useAgent37BoxActions";
import { connectButtonStyle, machineRowStyle, nameStyle, subTextStyle } from "./remoteTargetListStyles";

const TOP_UP: NoticeAction = { label: "Top up", href: AGENT37_BILLING_URL };

/** The group's head: the mark, how many boxes, and what they cost now and so far. */
export function Agent37GroupHead({
  boxes,
  result,
  loading,
}: {
  boxes: readonly Agent37Machine[];
  result: Agent37MachinesResult | null;
  loading: boolean;
}) {
  const totals = agent37GroupTotals(boxes);
  const facts = [
    boxes.length > 0 ? `${formatAgent37HourlyPrice(totals.hourlyUsd)} now` : null,
    totals.spentUsd != null && boxes.length > 0 ? `${formatAgent37Usd(totals.spentUsd)} so far` : null,
    result?.balanceUsd != null ? `${formatAgent37Usd(result.balanceUsd)} left` : null,
  ].filter(Boolean);
  return (
    <div className="ade-cx-section-head ade-cx-a37-head">
      <Agent37Mark size={12} strokeWidth={30} />
      {AGENT37_NAME}
      <span className="ade-cx-count">{boxes.length}</span>
      {loading ? <CircleNotch size={11} className="animate-spin" aria-label="Checking Agent 37" /> : null}
      {facts.length ? (
        <span className="ade-cx-a37-head-facts kit-num" title="Agent 37 settles what a box spent once an hour, so the newest minutes show later.">
          {facts.join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The workspace's state that stops or threatens every box: a refused key, a
 * suspended wallet, a wallet about to run out, the box limit. Each says what
 * it blocks and offers the next step.
 */
export function Agent37GroupBanners({
  result,
  loadError,
  boxes,
  onRetry,
  onOpenSettings,
}: {
  result: Agent37MachinesResult | null;
  loadError: string | null;
  boxes: readonly Agent37Machine[];
  onRetry: () => void;
  onOpenSettings?: (() => void) | null;
}) {
  const banners: ReactNode[] = [];
  if (loadError && !result) {
    banners.push(
      <Banner key="load" layout="inline" model={{ id: "agent37-machines-load", tone: "warning", icon: <Agent37Mark size={15} />, title: `ADE couldn't read your ${AGENT37_NAME} machines`, detail: loadError, actions: [{ label: "Retry", icon: <ArrowClockwise size={12} />, onClick: onRetry }] }} />,
    );
  }
  if (result?.state === "key_refused") {
    banners.push(
      <Banner
        key="key"
        layout="inline"
        model={{
          id: "agent37-key-refused",
          tone: "error",
          icon: <Agent37Mark size={15} />,
          title: `${AGENT37_NAME} no longer accepts the saved key`,
          detail: "It was probably revoked or rotated. Your boxes keep running and billing, but ADE can't show, wake or delete them until you connect a new key.",
          actions: [
            ...(onOpenSettings ? [{ label: "Connect a new key", onClick: onOpenSettings }] : []),
            { label: "Get a key", href: AGENT37_API_KEYS_URL, variant: "secondary" as const },
          ],
          report: false,
        }}
      />,
    );
  }
  if (result?.state === "unreachable") {
    banners.push(
      <Banner key="unreachable" layout="inline" model={{ id: "agent37-unreachable", tone: "warning", icon: <Agent37Mark size={15} />, title: `ADE couldn't reach ${AGENT37_NAME}`, detail: result.message ?? undefined, actions: [{ label: "Retry", icon: <ArrowClockwise size={12} />, onClick: onRetry }] }} />,
    );
  }
  if (result?.state === "ok" && result.pastDue) {
    banners.push(
      <Banner
        key="suspended"
        layout="inline"
        model={{
          id: "agent37-suspended",
          tone: "error",
          icon: <Agent37Mark size={15} />,
          title: `${AGENT37_NAME} suspended your machines`,
          detail: "Your wallet ran out, so Agent 37 put every box to sleep and stopped billing them. Top up to wake them. A box left suspended for 30 days is deleted.",
          actions: [TOP_UP],
          report: false,
        }}
      />,
    );
  } else if (result?.state === "ok") {
    // Every box in the workspace bills, also the ones the group does not show.
    const warning = agent37WalletWarning(result.balanceUsd, agent37GroupTotals(result.machines).hourlyUsd);
    if (warning) {
      banners.push(
        <Banner key="wallet" layout="inline" model={{ id: "agent37-wallet-low", tone: "warning", icon: <Agent37Mark size={15} />, title: result.balanceUsd != null && result.balanceUsd <= 0 ? "Your Agent 37 wallet is empty" : "Your Agent 37 wallet is running low", detail: warning, actions: [TOP_UP] }} />,
      );
    }
    if (agent37AtMachineLimit(result) && boxes.some((box) => box.state === "asleep" || box.state === "stopped")) {
      banners.push(
        <Banner key="limit" layout="inline" model={{ id: "agent37-limit", tone: "info", icon: <Agent37Mark size={15} />, title: "At your Agent 37 machine limit", detail: agent37MachineLimitMessage(result, "wake"), actions: result.tier === 0 ? [TOP_UP] : undefined }} />,
      );
    }
  }
  return banners.length ? <div style={{ display: "grid", gap: 8 }}>{banners}</div> : null;
}

/** What a failed action blocks on, as the buttons that clear it. */
function errorActions(error: Agent37BoxActionError, onOpenSettings?: (() => void) | null): NoticeAction[] | undefined {
  switch (error.blocker) {
    case "wallet":
    case "suspended":
      return [TOP_UP];
    case "limit":
      return [{ label: `Open ${AGENT37_NAME}`, href: AGENT37_BILLING_URL, variant: "secondary" }];
    case "key":
      return onOpenSettings ? [{ label: "Connect a new key", onClick: onOpenSettings }] : undefined;
    default:
      return undefined;
  }
}

/**
 * The Agent37 line on a machine's card: state, type and size, the price in
 * this state, what it has spent, and its lanes. A sleeping box gets Wake here,
 * where the row would otherwise offer nothing.
 */
export function Agent37BoxStrip({
  box,
  work,
  pending,
  error,
  onDismissError,
  onWake,
  onOpenSettings,
}: {
  box: Agent37Machine;
  work: Agent37BoxWork;
  pending: Agent37BoxPending | null;
  error: Agent37BoxActionError | null;
  onDismissError: () => void;
  /** Wake on the card itself; rows that put Wake in place of Connect pass null. */
  onWake?: (() => void) | null;
  onOpenSettings?: (() => void) | null;
}) {
  const tone = agent37StateTone(box);
  const stateLabel = box.pastDue ? "Suspended" : AGENT37_STATE_LABELS[box.state];
  const rate = describeAgent37Rate(box);
  const spend = describeAgent37Spend(box);
  const canWake = (box.state === "asleep" || box.state === "stopped") && !box.pastDue;
  const laneNames = work.lanes.map((lane) => (lane.projectName ? `${lane.name} (${lane.projectName})` : lane.name));
  // A refusal shows under the card, which can sit at the panel's bottom edge:
  // bring it into view so the answer to the click is never off screen.
  const errorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  return (
    <div className="ade-cx-a37-strip" data-agent37-instance={box.instanceId}>
      <div className="ade-cx-a37-facts-clip">
        <div className="ade-cx-a37-facts">
          <span className="kit-tag" data-tone={tone ?? undefined} title={`Agent 37 status: ${box.status}`}>
            {stateLabel}
          </span>
          {box.ready && box.ready.state !== "claimed" ? (
            <span
              className="kit-tag"
              data-tone={box.ready.state === "failed" ? "crit" : undefined}
              title={`ADE keeps this machine ready for ${box.ready.projectName}: the next chat there starts on it. Settings › Integrations › Agent 37.`}
            >
              {box.ready.state === "ready" ? `Ready for ${box.ready.projectName}` : box.ready.state === "preparing" ? "Being prepared" : "Prepare failed"}
            </span>
          ) : null}
          <span className="ade-cx-a37-fact">{describeAgent37MachineSize(box)}</span>
          {rate ? <span className="ade-cx-a37-fact kit-num">{rate}</span> : null}
          {spend ? (
            <span
              className="ade-cx-a37-fact kit-num"
              title={box.spentIsLifetime
                ? "Everything this box has cost, settled hourly by Agent 37."
                : "What this box cost in the last 90 days, the furthest back Agent 37 reports."}
            >
              {spend}
            </span>
          ) : null}
          {laneNames.length ? (
            <span className="ade-cx-a37-fact ade-cx-a37-lanes" title={laneNames.join("\n")}>
              <GitBranch size={11} weight="bold" />
              <span>{laneNames.length === 1 ? laneNames[0] : `${laneNames.length} lanes`}</span>
            </span>
          ) : null}
          {work.runningChats > 0 ? (
            <span className="ade-cx-a37-fact">{work.runningChats === 1 ? "1 chat running" : `${work.runningChats} chats running`}</span>
          ) : null}
          {canWake && onWake && !pending ? (
            <button type="button" className="ade-cx-a37-wake" onClick={onWake}>
              <Sun size={12} weight="bold" />
              {box.state === "stopped" ? "Start" : "Wake"}
            </button>
          ) : null}
        </div>
      </div>
      {pending ? (
        <div role="status" className="ade-cx-a37-pending">
          <CircleNotch size={12} className="animate-spin" />
          {agent37PendingLabel(pending)}
        </div>
      ) : null}
      {box.failure ? (
        <div className="ade-cx-a37-note">{AGENT37_NAME} couldn't run it: {box.failure}</div>
      ) : null}
      {error ? (
        <div ref={errorRef}>
          <Banner
            layout="inline"
            model={{
              id: `agent37-action-error-${box.instanceId}`,
              tone: error.blocker ? "warning" : "error",
              title: error.message,
              actions: errorActions(error, onOpenSettings),
              dismiss: { onDismiss: onDismissError },
              ...(error.blocker ? { report: false as const } : { report: { surface: "agent37_machine_action" } }),
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
export function Agent37BoxOnlyRow({
  box,
  accountKnown,
  actions,
  strip,
}: {
  box: Agent37Machine;
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
    ? `On ${AGENT37_NAME}`
    : joining
      ? "Setting up and signing in to your account…"
      : `Not in ADE. It bills on ${AGENT37_NAME} until you delete it.`;
  return (
    <div style={machineRowStyle} data-agent37-box-only={box.instanceId}>
      <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr) auto", gap: 12, alignItems: "center" }}>
        <span className="ade-cx-a37-avatar" aria-hidden>
          <Agent37Mark size={18} strokeWidth={24} />
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
export function agent37ParkedRow(
  box: Agent37Machine,
  name: string,
  pending: Agent37BoxPending | null,
  onWake: () => void,
): { label: string; action: ReactNode } | null {
  if (box.pastDue) {
    return {
      label: `Suspended on ${AGENT37_NAME}. Top up to wake it.`,
      action: (
        <button type="button" onClick={() => openExternalUrl(AGENT37_BILLING_URL)} style={{ ...connectButtonStyle, marginRight: 4 }}>
          Top up
        </button>
      ),
    };
  }
  if (box.state !== "asleep" && box.state !== "stopped") return null;
  const verb = box.state === "stopped" ? "Start" : "Wake";
  return {
    label: box.state === "stopped" ? `Stopped on ${AGENT37_NAME}` : `Asleep on ${AGENT37_NAME}`,
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
