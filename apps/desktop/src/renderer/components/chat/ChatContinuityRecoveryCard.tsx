import { useCallback, useEffect, useState } from "react";
import {
  ArrowClockwise,
  CaretRight,
  ChatCircleDots,
  CircleNotch,
} from "@phosphor-icons/react";
import type {
  AgentChatContinuityRecoveryResult,
  AgentChatNoticeDetail,
  AgentChatRecoverContinuityArgs,
} from "../../../shared/types";
import { useAgentChatApi, useChatPaneScope } from "./agentChatApi";
import { chatApiPin, requireChatPin } from "./chatMachinePin";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { Banner } from "../ui/notice";
import { QUIET_LINE_ICON_CLASS, QUIET_LINE_TEXT_CLASS } from "./quietLineStyle";

/**
 * Window event the Work surface already listens for to switch the active chat
 * session — reused verbatim from the "Subagent spawned" deep-link chip so the
 * continuity card navigates through the same path.
 */
const SELECT_SESSION_EVENT = "ade:work:select-session";

type RecoverMode = AgentChatContinuityRecoveryResult["mode"];
type RecoveryFailureReason = AgentChatContinuityRecoveryResult["reason"];

function navigateToSession(sessionId: string, laneId?: string | null): void {
  try {
    window.dispatchEvent(
      new CustomEvent(SELECT_SESSION_EVENT, {
        detail: { sessionId, laneId: laneId ?? null },
      }),
    );
  } catch {
    /* no-op */
  }
}

function QuietLine({
  icon,
  children,
  testId,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 max-w-[var(--chat-content-width,52rem)] items-center gap-2 py-1 font-sans" data-testid={testId}>
      {icon}
      <span className={QUIET_LINE_TEXT_CLASS}>{children}</span>
    </div>
  );
}

function ReconnectedLine() {
  return (
    <QuietLine
      testId="continuity-reconnected"
      icon={<ArrowClockwise size={12} weight="regular" className={QUIET_LINE_ICON_CLASS} aria-hidden />}
    >
      Reconnected
    </QuietLine>
  );
}

function ContinuedInNewChatLine({ sessionId, laneId }: { sessionId: string; laneId?: string | null }) {
  return (
    <QuietLine
      testId="continuity-new-chat"
      icon={<ChatCircleDots size={12} weight="regular" className={QUIET_LINE_ICON_CLASS} aria-hidden />}
    >
      Continued in a new chat{" "}
      <button
        type="button"
        onClick={() => navigateToSession(sessionId, laneId)}
        className="inline-flex items-center gap-0.5 text-fg/70 underline-offset-2 transition-colors hover:text-fg hover:underline"
      >
        Open
        <CaretRight size={9} weight="bold" aria-hidden />
      </button>
    </QuietLine>
  );
}

/**
 * How long "Reconnecting…" may show. An attempt that never reported back (ADE
 * restarted mid-way, or the attempt hung) then offers the choices instead of
 * spinning forever.
 */
const AUTO_RECOVERY_PENDING_MAX_MS = 90_000;

/** Whether ADE's own attempt is still within its time; re-renders when it runs out. */
function useAutoRecoveryPending(detail: AgentChatNoticeDetail): boolean {
  const startedAt = detail.autoRecovery === "pending" ? Date.parse(detail.autoRecoveryStartedAt ?? "") : Number.NaN;
  // A notice written before the start time was recorded gets the full window from now.
  const deadline = Number.isFinite(startedAt) ? startedAt + AUTO_RECOVERY_PENDING_MAX_MS : null;
  const [expired, setExpired] = useState(() => deadline !== null && Date.now() >= deadline);
  useEffect(() => {
    if (detail.autoRecovery !== "pending") return;
    const remaining = deadline === null ? AUTO_RECOVERY_PENDING_MAX_MS : deadline - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    setExpired(false);
    const timer = window.setTimeout(() => setExpired(true), remaining);
    return () => window.clearTimeout(timer);
  }, [detail.autoRecovery, deadline]);
  return detail.autoRecovery === "pending" && !expired;
}

function failureCopy(reason: RecoveryFailureReason): string {
  switch (reason) {
    case "not_required":
      return "This chat is already reconnected.";
    case "unsupported_provider":
      return "This AI provider can't be reconnected automatically. Start a new chat to continue.";
    case "transient":
      return "That didn't work either. Wait a moment and try again.";
    default:
      return "That didn't work either. Start a new chat to keep going.";
  }
}

/**
 * A lost provider thread is ADE's problem, not the user's. ADE rebuilds it
 * from its own copy by itself, so the usual story is two quiet lines:
 * "Reconnecting…", then "Reconnected". The user only sees a choice when that
 * did not work, and then one recommended button.
 */
export function ChatContinuityRecoveryCard({
  detail,
  sessionId,
  turnActive,
  onRecoverContinuity,
}: {
  detail: AgentChatNoticeDetail;
  sessionId: string | null;
  turnActive: boolean;
  onRecoverContinuity?: (
    args: AgentChatRecoverContinuityArgs,
  ) => Promise<AgentChatContinuityRecoveryResult>;
}) {
  const [pendingMode, setPendingMode] = useState<RecoverMode | null>(null);
  // Why the last action didn't work. A thrown error's wire text stays out.
  const [failure, setFailure] = useState<{ reason: RecoveryFailureReason } | null>(null);
  const [result, setResult] = useState<AgentChatContinuityRecoveryResult | null>(null);
  const agentChatApi = useAgentChatApi();
  // The chat's machine; a personal chat's adapter names its own.
  const recoveryPin = chatApiPin(useChatRuntimeScope().pin, useChatPaneScope() != null);
  const autoRecoveryPending = useAutoRecoveryPending(detail);

  const runRecovery = useCallback(
    async (mode: RecoverMode) => {
      if (!sessionId || pendingMode) return;
      setPendingMode(mode);
      setFailure(null);
      try {
        const res = onRecoverContinuity
          ? await onRecoverContinuity({ sessionId, mode })
          : await agentChatApi.recoverContinuity({ sessionId, mode }, requireChatPin(recoveryPin));
        if (!res.ok) {
          setFailure({ reason: res.reason });
          return;
        }
        setResult(res);
        if (mode === "start_new_chat" && res.newSessionId) {
          navigateToSession(res.newSessionId, detail.spawnedSession?.laneId ?? null);
        }
      } catch {
        setFailure({ reason: "recovery_failed" });
      } finally {
        setPendingMode(null);
      }
    },
    [sessionId, pendingMode, detail.spawnedSession?.laneId, onRecoverContinuity, agentChatApi, recoveryPin],
  );

  // ── Resolved ─────────────────────────────────────────────────────────────
  if (result?.ok) {
    if (result.mode === "start_new_chat" && result.newSessionId) {
      return <ContinuedInNewChatLine sessionId={result.newSessionId} laneId={detail.spawnedSession?.laneId ?? null} />;
    }
    return <ReconnectedLine />;
  }
  if (detail.state === "reconstructed") return <ReconnectedLine />;
  if (detail.supersededBySessionId) {
    return <ContinuedInNewChatLine sessionId={detail.supersededBySessionId} laneId={detail.spawnedSession?.laneId ?? null} />;
  }

  // ── ADE is reconnecting by itself ─────────────────────────────────────────
  if (autoRecoveryPending) {
    return (
      <QuietLine
        testId="continuity-reconnecting"
        icon={<CircleNotch size={12} weight="bold" className={`${QUIET_LINE_ICON_CLASS} animate-spin`} aria-hidden />}
      >
        Reconnecting…
      </QuietLine>
    );
  }

  // ── It could not: one recommended action ──────────────────────────────────
  // A thread the provider no longer has can't come back, so "try again" means
  // rebuilding from ADE's copy; anything else may have been a blip.
  const tryAgainMode: RecoverMode = detail.reason === "thread_missing" ? "recover_from_history" : "retry_original";
  const blocked = pendingMode !== null || turnActive || !sessionId;
  return (
    <Banner
      layout="inline"
      style={{ marginTop: 12 }}
      testId="continuity-recovery-card"
      model={{
        id: "chat-continuity-recovery",
        tone: "warning",
        title: "Couldn't reconnect this chat",
        detail: "Your messages and files are safe.",
        busy: pendingMode !== null,
        ...(failure ? { error: failureCopy(failure.reason) } : {}),
        actions: [
          {
            label: pendingMode === tryAgainMode ? "Reconnecting…" : "Try again",
            variant: "solid",
            busy: pendingMode === tryAgainMode,
            disabled: blocked,
            onClick: () => {
              void runRecovery(tryAgainMode);
            },
          },
          {
            label: "Start a new chat",
            variant: "secondary",
            busy: pendingMode === "start_new_chat",
            disabled: blocked,
            onClick: () => {
              void runRecovery("start_new_chat");
            },
          },
        ],
      }}
    />
  );
}
