import { useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowBendUpRight,
  ArrowSquareOut,
  Check,
  CloudArrowDown,
  CloudArrowUp,
  Desktop,
  Hourglass,
} from "@phosphor-icons/react";
import type {
  AgentChatCrossMachineHandoffCheckpoint,
  AgentChatCrossMachineHandoffRecord,
  AgentChatEventEnvelope,
  OpenProjectBinding,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { crossMachineContinuation } from "../../../shared/crossMachineHandoff";
import { stripElectronErrorWrapper } from "../../../shared/codedError";
import { navigateToAppTarget } from "../../lib/openExternal";
import { useBannerDismissals } from "../../lib/bannerDismiss";
import { showToast } from "../app/toast/toastStore";
import { Banner, type BannerModel } from "../ui/notice";
import { cn } from "../ui/cn";

/**
 * The state of a chat's move to another machine, above its composer. The
 * record is owned by the source brain (`crossMachineHandoffOrchestrator`); this
 * banner only reads it and calls the brain's actions. It renders nothing for a
 * cancelled move or no move.
 */

export type CrossMachineHandoffArrival = {
  handoffId: string;
  sourceMachineName: string;
  sourceSessionId: string;
  mode: "brief" | "fork";
  unpushedCommits: number;
  changedFiles: number;
};

const SEND_STEPS: Array<{ id: AgentChatCrossMachineHandoffCheckpoint; label: string }> = [
  { id: "checked", label: "Checked" },
  { id: "prepared", label: "Packed" },
  { id: "destination_ready", label: "Destination ready" },
  { id: "accepted", label: "Accepted" },
];
const CHECKPOINT_ORDER: AgentChatCrossMachineHandoffCheckpoint[] = [
  "checked",
  "prepared",
  "destination_ready",
  "accepted",
  "marked",
];

function modelLabel(modelId: string): string {
  return getModelById(modelId)?.displayName ?? modelId;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "3 commits, 2 file changes", or null when nothing travelled. */
export function describeTravellingChanges(unpushedCommits: number, changedFiles: number): string | null {
  const parts = [
    unpushedCommits > 0 ? plural(unpushedCommits, "commit") : null,
    changedFiles > 0 ? plural(changedFiles, "file change") : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** Open a chat that lives on another machine (the Work tab unions them). */
export function openChatOnOtherMachine(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  navigateToAppTarget({ kind: "work", sessionId });
}

function SendSteps({ checkpoint }: { checkpoint: AgentChatCrossMachineHandoffCheckpoint | null }) {
  const reached = checkpoint ? CHECKPOINT_ORDER.indexOf(checkpoint) : -1;
  return (
    <ol className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px]" aria-label="Move progress">
      {SEND_STEPS.map((step, index) => {
        const done = index <= reached;
        const current = index === reached + 1;
        return (
          <li
            key={step.id}
            className={cn(
              "inline-flex items-center gap-1",
              done ? "text-fg/62" : current ? "text-fg/80" : "text-fg/30",
            )}
            aria-current={current ? "step" : undefined}
          >
            {done ? (
              <Check size={10} weight="bold" aria-hidden />
            ) : (
              <span className="kit-dot" data-state={current ? "accent" : undefined} aria-hidden />
            )}
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

type BannerAction = "cancel" | "approve" | "deny" | "retry" | "workHere";

export function CrossMachineHandoffBanner({
  sessionId,
  record,
  runtimePin,
  onRecord,
  style,
}: {
  sessionId: string;
  record: AgentChatCrossMachineHandoffRecord | null | undefined;
  /** The machine the chat runs on; every call goes to that brain. */
  runtimePin: OpenProjectBinding | null;
  /** The brain's answer, applied before the live event arrives. */
  onRecord: (next: AgentChatCrossMachineHandoffRecord | null) => void;
  style?: CSSProperties;
}) {
  const [busy, setBusy] = useState<BannerAction | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const dismissals = useBannerDismissals();
  // Where the chat already continues outlives later attempts, so a second
  // move that is cancelled or fails still shows it.
  const continuation = crossMachineContinuation(record);
  if (!record || (record.state === "cancelled" && !continuation)) return null;

  const machine = record.targetMachineName;
  const run = async (action: BannerAction) => {
    if (busy) return;
    setBusy(action);
    try {
      const api = window.ade.agentChat;
      const next = action === "cancel"
        ? await api.cancelCrossMachineHandoff({ sourceSessionId: sessionId }, runtimePin)
        : action === "workHere"
          ? await api.acknowledgeCrossMachineHandoff(
            { sourceSessionId: sessionId, handoffId: continuation?.handoffId ?? record.handoffId },
            runtimePin,
          )
        : action === "retry"
          ? await api.retryCrossMachineHandoff({ sourceSessionId: sessionId }, runtimePin)
          : await api.resolveCrossMachineHandoffApproval(
            { sourceSessionId: sessionId, handoffId: record.handoffId, approve: action === "approve" },
            runtimePin,
          );
      onRecord(next);
    } catch (error) {
      showToast({
        tone: "warning",
        title: action === "retry" ? `Couldn't retry the move to ${machine}` : `Couldn't update the move to ${machine}`,
        message: stripElectronErrorWrapper(error instanceof Error ? error.message : String(error)),
      });
    } finally {
      setBusy(null);
    }
  };
  const openTarget = (name: string, targetSessionId: string | null | undefined) => targetSessionId
    ? {
      label: `Open on ${name}`,
      icon: <ArrowSquareOut size={12} />,
      variant: "secondary" as const,
      onClick: () => openChatOnOtherMachine(targetSessionId),
    }
    : null;
  const openAction = openTarget(machine, record.targetSessionId);
  const openContinuation = continuation
    ? openTarget(continuation.targetMachineName, continuation.targetSessionId)
    : null;
  // A move under way, or one that failed, on a chat that already continues
  // somewhere: say so in one line so the earlier move isn't forgotten.
  const alreadyContinues = continuation && continuation.handoffId !== record.handoffId
    ? `This chat already continues on ${continuation.targetMachineName}.`
    : null;
  const meta = [
    record.mode === "fork" ? "Full history" : "Brief",
    modelLabel(record.targetModelId),
    record.includeChanges ? "brings uncommitted work" : null,
  ].filter(Boolean).join(" · ");

  let model: BannerModel | null = null;
  switch (record.state) {
    case "pending":
      model = {
        id: "cross-machine-move",
        tone: "info",
        icon: <Hourglass size={13} weight="bold" />,
        title: `Moving to ${machine} when this turn ends`,
        detail: [`${meta}. A new message from you keeps it here.`, alreadyContinues].filter(Boolean).join(" "),
        actions: [{ label: "Keep it here", variant: "secondary", busy: busy === "cancel", onClick: () => void run("cancel") }],
      };
      break;
    case "awaiting_approval":
      model = {
        id: "cross-machine-move",
        tone: "accent",
        icon: <ArrowBendUpRight size={13} weight="bold" />,
        title: `The agent wants to continue on ${machine}`,
        detail: [meta, alreadyContinues].filter(Boolean).join(". "),
        actions: [
          { label: "Approve", variant: "solid", busy: busy === "approve", disabled: Boolean(busy), onClick: () => void run("approve") },
          { label: "Deny", variant: "secondary", busy: busy === "deny", disabled: Boolean(busy), onClick: () => void run("deny") },
        ],
      };
      break;
    case "sending":
      model = {
        id: "cross-machine-move",
        tone: "info",
        busy: true,
        title: `Sending to ${machine}`,
        extra: <SendSteps checkpoint={record.checkpoint} />,
      };
      break;
    case "continued":
    case "cancelled": {
      // Only reached with a continuation (a cancelled attempt without one
      // returned above).
      if (!continuation) return null;
      const where = continuation.targetMachineName;
      if (record.resumedHere) {
        const dismissKey = `cross-machine-move-also:${sessionId}`;
        if (dismissals.isDismissed(dismissKey, continuation.handoffId)) return null;
        model = {
          id: "cross-machine-move",
          tone: "neutral",
          icon: <Desktop size={13} />,
          title: `Working here · also continues on ${where}`,
          actions: openContinuation ? [{ ...openContinuation, variant: "link" }] : [],
          dismiss: { onDismiss: () => dismissals.dismiss(dismissKey, continuation.handoffId), label: "Dismiss" },
        };
      } else {
        model = {
          id: "cross-machine-move",
          tone: "info",
          icon: <CloudArrowUp size={13} weight="bold" />,
          title: `Continues on ${where}`,
          detail: `New messages go to the chat on ${where}.`,
          actions: [
            ...(openContinuation ? [{ ...openContinuation, variant: "primary" as const }] : []),
            {
              label: "Work here instead",
              variant: "secondary",
              busy: busy === "workHere",
              disabled: Boolean(busy),
              onClick: () => void run("workHere"),
            },
          ],
        };
      }
      break;
    }
    case "failed":
      model = {
        id: "cross-machine-move",
        // Amber, not red: the chat is fine here; only the move didn't happen.
        tone: "warning",
        title: `Couldn't move to ${machine}`,
        detail: detailsOpen && record.reason
          ? <span className="block whitespace-pre-wrap break-words">{record.reason}</span>
          : alreadyContinues ?? undefined,
        actions: [
          { label: "Retry", busy: busy === "retry", onClick: () => void run("retry") },
          ...(alreadyContinues && openContinuation ? [{ ...openContinuation, variant: "link" as const }] : []),
          ...(record.reason
            ? [{
              label: detailsOpen ? "Hide details" : "Details",
              variant: "link" as const,
              expanded: detailsOpen,
              onClick: () => setDetailsOpen((open) => !open),
            }]
            : []),
        ],
      };
      break;
    case "unknown":
      model = {
        id: "cross-machine-move",
        tone: "warning",
        title: `Lost confirmation from ${machine} — check it before retrying.`,
        detail: "The chat may already be there. Retrying is safe: it won't start a second one.",
        actions: [
          ...(openAction ? [{ ...openAction, variant: "primary" as const }] : []),
          { label: "Retry", variant: "secondary", busy: busy === "retry", onClick: () => void run("retry") },
        ],
      };
      break;
    default:
      return null;
  }
  return <Banner layout="inline" model={model} style={style} testId="cross-machine-move-banner" />;
}

function readArrival(envelope: AgentChatEventEnvelope): CrossMachineHandoffArrival | null {
  const event = envelope.event;
  if (event.type !== "system_notice" || event.status !== "cross_machine_handoff_arrived") return null;
  const detail = event.detail;
  if (!detail || typeof detail === "string") return null;
  const arrival = detail.crossMachineHandoffArrival;
  return arrival?.handoffId && arrival.sourceMachineName ? arrival : null;
}

/**
 * The arrival marker a destination chat carries, if any. Incremental: a
 * streaming turn appends events, and re-walking a long transcript on every
 * one of them would cost every chat (almost none of which arrived from
 * anywhere). It rescans only when the list is replaced from the front (a
 * history page, a different chat).
 */
export function useCrossMachineArrival(
  sessionId: string | null,
  events: readonly AgentChatEventEnvelope[],
): CrossMachineHandoffArrival | null {
  const cache = useRef<{
    sessionId: string | null;
    first: AgentChatEventEnvelope | undefined;
    scanned: number;
    arrival: CrossMachineHandoffArrival | null;
  } | null>(null);
  return useMemo(() => {
    const previous = cache.current;
    const extendsPrevious = previous
      && previous.sessionId === sessionId
      && previous.first === events[0]
      && events.length >= previous.scanned;
    let arrival = extendsPrevious ? previous.arrival : null;
    for (let index = extendsPrevious ? previous.scanned : 0; index < events.length; index += 1) {
      arrival = readArrival(events[index]!) ?? arrival;
    }
    cache.current = { sessionId, first: events[0], scanned: events.length, arrival };
    return arrival;
  }, [events, sessionId]);
}

export function CrossMachineArrivalBanner({
  sessionId,
  arrival,
  style,
}: {
  sessionId: string;
  arrival: CrossMachineHandoffArrival | null;
  style?: CSSProperties;
}) {
  const dismissals = useBannerDismissals();
  if (!arrival) return null;
  const dismissKey = `cross-machine-arrival:${sessionId}`;
  if (dismissals.isDismissed(dismissKey, arrival.handoffId)) return null;
  const changes = describeTravellingChanges(arrival.unpushedCommits, arrival.changedFiles);
  return (
    <Banner
      layout="inline"
      style={style}
      testId="cross-machine-arrival-banner"
      model={{
        id: "cross-machine-arrival",
        tone: "neutral",
        icon: <CloudArrowDown size={13} weight="bold" />,
        title: [
          `Arrived from ${arrival.sourceMachineName}`,
          arrival.mode === "fork" ? "fork" : "brief",
          changes,
        ].filter(Boolean).join(" · "),
        actions: arrival.sourceSessionId
          ? [{ label: "Open source", variant: "link", onClick: () => openChatOnOtherMachine(arrival.sourceSessionId) }]
          : [],
        dismiss: { onDismiss: () => dismissals.dismiss(dismissKey, arrival.handoffId), label: "Dismiss" },
      }}
    />
  );
}
