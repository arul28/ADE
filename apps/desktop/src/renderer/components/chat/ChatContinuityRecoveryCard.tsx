import { useCallback, useState } from "react";
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
import { useAgentChatApi } from "./agentChatApi";
import { Banner } from "../ui/notice";

/**
 * Window event the Work surface already listens for to switch the active chat
 * session — reused verbatim from the "Subagent spawned" deep-link chip so the
 * continuity card navigates through the same path.
 */
const SELECT_SESSION_EVENT = "ade:work:select-session";

type RecoverMode = AgentChatContinuityRecoveryResult["mode"];
type RecoveryFailureReason = AgentChatContinuityRecoveryResult["reason"];

/**
 * A lost provider thread is ADE's problem, not the user's. ADE rebuilds it
 * from its own copy by itself, so the usual story is two quiet lines:
 * "Reconnecting…", then "Reconnected". The user only sees a choice when that
 * did not work, and then one recommended button.
 */
const QUIET_LINE_CLASS =
  "flex min-w-0 max-w-[var(--chat-content-width,52rem)] items-center gap-2 py-1 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/55";

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
    <div className={QUIET_LINE_CLASS} data-testid={testId}>
      {icon}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function ReconnectedLine() {
  return (
    <QuietLine
      testId="continuity-reconnected"
      icon={<ArrowClockwise size={12} weight="regular" className="shrink-0 text-fg/35" aria-hidden />}
    >
      Reconnected
    </QuietLine>
  );
}

function ContinuedInNewChatLine({ sessionId, laneId }: { sessionId: string; laneId?: string | null }) {
  return (
    <QuietLine
      testId="continuity-new-chat"
      icon={<ChatCircleDots size={12} weight="regular" className="shrink-0 text-fg/35" aria-hidden />}
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

  const runRecovery = useCallback(
    async (mode: RecoverMode) => {
      if (!sessionId || pendingMode) return;
      setPendingMode(mode);
      setFailure(null);
      try {
        const res = await (onRecoverContinuity ?? agentChatApi.recoverContinuity)({ sessionId, mode });
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
    [sessionId, pendingMode, detail.spawnedSession?.laneId, onRecoverContinuity, agentChatApi],
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
  if (detail.autoRecovery === "pending") {
    return (
      <QuietLine
        testId="continuity-reconnecting"
        icon={<CircleNotch size={12} weight="bold" className="shrink-0 animate-spin text-fg/35" aria-hidden />}
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
