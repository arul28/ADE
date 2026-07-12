import { useCallback, useState } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CaretRight,
  ChatCircleDots,
  ClockCounterClockwise,
  Warning,
} from "@phosphor-icons/react";
import type {
  AgentChatContinuityRecoveryResult,
  AgentChatNoticeDetail,
  AgentChatResumeFailureKind,
} from "../../../shared/types";

/**
 * Window event the Work surface already listens for to switch the active chat
 * session — reused verbatim from the "Subagent spawned" deep-link chip so the
 * continuity card navigates through the same path.
 */
const SELECT_SESSION_EVENT = "ade:work:select-session";

type RecoverMode = AgentChatContinuityRecoveryResult["mode"];

// Warm amber, never red — a chat whose provider thread couldn't be resumed is
// recoverable, not a crash. Card + button chrome mirror ProviderFailureRecoveryCard
// and AgentCliAuthCard so the three recovery surfaces read as one family.
const CARD_CLASS =
  "mt-3 rounded-[calc(var(--chat-radius-card)-8px)] border border-amber-300/14 bg-amber-400/[0.045] px-3 py-2.5";
const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-md border border-amber-200/16 bg-amber-300/[0.07] px-2.5 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-semibold text-amber-50/80 transition-colors hover:border-amber-200/30 hover:bg-amber-300/[0.13] disabled:pointer-events-none disabled:opacity-40";
const NEUTRAL_BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.035] px-2.5 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-semibold text-fg/65 transition-colors hover:border-violet-300/22 hover:bg-violet-400/[0.08] hover:text-fg/85 disabled:pointer-events-none disabled:opacity-40";
const DISCLOSURE_SUMMARY_CLASS =
  "cursor-pointer list-none font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-muted-fg/40 transition-colors hover:text-muted-fg/65";
const IDENTIFIER_BLOCK_CLASS =
  "mt-1.5 grid gap-1 rounded-[calc(var(--chat-radius-card)-8px)] border border-white/[0.06] bg-black/20 px-3 py-2 font-mono text-[length:calc(var(--chat-font-size)*10/14)] leading-relaxed text-fg/55";

// One plain-language line explaining *why* the thread could not be resumed.
// Only thread_missing/unknown reach the "required" state in practice, but the
// map stays total so there is always a human-readable line.
const REASON_COPY: Record<AgentChatResumeFailureKind, string> = {
  thread_missing: "The AI provider no longer has this chat's session record.",
  unknown: "Something interrupted this chat's connection to its AI session.",
  provider_environment:
    "The AI provider's environment changed, so this chat's session could not be reopened.",
  transient: "A temporary problem interrupted this chat's connection to its AI session.",
};

function reasonLine(reason: AgentChatNoticeDetail["reason"]): string {
  return (reason && REASON_COPY[reason]) || REASON_COPY.unknown;
}

// Plain-language copy for an unsuccessful recoverContinuity result. Kept amber
// and actionable — never a raw provider error.
function failureCopy(reason: AgentChatContinuityRecoveryResult["reason"]): string {
  switch (reason) {
    case "not_required":
      return "This chat has already been recovered.";
    case "unsupported_provider":
      return "This chat's AI provider doesn't support automatic recovery yet.";
    case "missing_original_thread":
      return "There's no original session on record to reconnect to.";
    case "thread_missing":
      return "The original session is no longer available. Recover from ADE history or start a new chat.";
    case "recovery_failed":
      return "ADE couldn't finish recovering this chat right now. Try again in a moment or pick another option.";
    case "provider_environment":
      return "The provider environment changed and blocked the reconnect. Try recovering from ADE history.";
    case "transient":
      return "A temporary problem interrupted the reconnect. Try again, or recover from ADE history.";
    default:
      return "Recovery didn't complete. Try another option.";
  }
}

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

/** Calm "resolved" pill shared by the reconstructed / superseded states. */
function ResolvedPill({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof ClockCounterClockwise;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mt-3">
      <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-emerald-400/18 bg-emerald-400/[0.06] px-3 py-1 text-[length:calc(var(--chat-font-size)*10.5/14)] font-medium text-emerald-100/85">
        <Icon size={13} weight="fill" aria-hidden />
        <span>{label}</span>
        {children}
      </div>
    </div>
  );
}

function ContinuedInNewChatPill({
  sessionId,
  laneId,
}: {
  sessionId: string;
  laneId?: string | null;
}) {
  return (
    <ResolvedPill icon={ChatCircleDots} label="Continued in a new chat">
      <button
        type="button"
        onClick={() => navigateToSession(sessionId, laneId)}
        className="inline-flex items-center gap-0.5 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-semibold text-emerald-100/75 transition-colors hover:text-emerald-50"
        title="Open the new chat"
      >
        Open chat
        <CaretRight size={10} weight="bold" aria-hidden />
      </button>
    </ResolvedPill>
  );
}

function ReconstructedPill({ detail }: { detail: AgentChatNoticeDetail }) {
  const original = detail.originalThreadId?.trim() || null;
  const rebuilt = detail.reconstructedThreadId?.trim() || null;
  return (
    <div className="mt-3">
      <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-emerald-400/18 bg-emerald-400/[0.06] px-3 py-1 text-[length:calc(var(--chat-font-size)*10.5/14)] font-medium text-emerald-100/85">
        <ClockCounterClockwise size={13} weight="fill" aria-hidden />
        <span>Rebuilt from ADE history</span>
      </div>
      <details className="mt-1.5">
        <summary className={DISCLOSURE_SUMMARY_CLASS}>Details</summary>
        <div className={IDENTIFIER_BLOCK_CLASS}>
          <div>
            <span className="text-fg/40">Original session</span> {original ?? "unknown"}
          </div>
          <div>
            <span className="text-fg/40">Rebuilt session</span> {rebuilt ?? "unknown"}
          </div>
        </div>
      </details>
    </div>
  );
}

function CapsulePreviewDisclosure({ capsulePreview }: { capsulePreview: string }) {
  return (
    <details className="mt-1.5">
      <summary className={DISCLOSURE_SUMMARY_CLASS}>What the new session was told</summary>
      <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[calc(var(--chat-radius-card)-8px)] border border-white/[0.06] bg-black/20 px-3 py-2 font-mono text-[length:calc(var(--chat-font-size)*10/14)] leading-relaxed text-fg/60">
        {capsulePreview}
      </pre>
    </details>
  );
}

export function ChatContinuityRecoveryCard({
  detail,
  sessionId,
  turnActive,
}: {
  detail: AgentChatNoticeDetail;
  sessionId: string | null;
  turnActive: boolean;
}) {
  // Which action, if any, is currently awaiting recoverContinuity.
  const [pendingMode, setPendingMode] = useState<RecoverMode | null>(null);
  // The "Recover from ADE history" button reveals an inline confirm before it runs.
  const [confirmingRecover, setConfirmingRecover] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Populated once an action in *this* card succeeds; drives the resolved view.
  const [result, setResult] = useState<AgentChatContinuityRecoveryResult | null>(null);

  const runRecovery = useCallback(
    async (mode: RecoverMode) => {
      if (!sessionId || pendingMode) return;
      setPendingMode(mode);
      setFailure(null);
      try {
        const res = await window.ade.agentChat.recoverContinuity({ sessionId, mode });
        if (!res.ok) {
          setFailure(failureCopy(res.reason));
          return;
        }
        setResult(res);
        setConfirmingRecover(false);
        if (mode === "start_new_chat" && res.newSessionId) {
          navigateToSession(res.newSessionId, detail.spawnedSession?.laneId ?? null);
        }
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        setPendingMode(null);
      }
    },
    [sessionId, pendingMode, detail.spawnedSession?.laneId],
  );

  // ── Resolved states after an action taken in this card ───────────────────
  if (result?.ok) {
    if (result.mode === "retry_original") {
      return <ResolvedPill icon={ArrowClockwise} label="Reconnected to the original thread" />;
    }
    if (result.mode === "start_new_chat" && result.newSessionId) {
      return (
        <ContinuedInNewChatPill
          sessionId={result.newSessionId}
          laneId={detail.spawnedSession?.laneId ?? null}
        />
      );
    }
    if (result.mode === "recover_from_history") {
      return (
        <div className="mt-3">
          <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-emerald-400/18 bg-emerald-400/[0.06] px-3 py-1 text-[length:calc(var(--chat-font-size)*10.5/14)] font-medium text-emerald-100/85">
            <ClockCounterClockwise size={13} weight="fill" aria-hidden />
            <span>Rebuilt from ADE history</span>
          </div>
          {result.capsulePreview ? (
            <CapsulePreviewDisclosure capsulePreview={result.capsulePreview} />
          ) : null}
        </div>
      );
    }
  }

  // ── Detail-driven states from a replayed/persisted notice ────────────────
  if (detail.state === "reconstructed") {
    return <ReconstructedPill detail={detail} />;
  }
  if (detail.supersededBySessionId) {
    return (
      <ContinuedInNewChatPill
        sessionId={detail.supersededBySessionId}
        laneId={detail.spawnedSession?.laneId ?? null}
      />
    );
  }

  // ── The actionable "required" card ───────────────────────────────────────
  const busy = pendingMode !== null;
  const actionsDisabled = busy || turnActive || !sessionId;

  return (
    <div className={CARD_CLASS}>
      <div className="flex items-start gap-2.5">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-amber-300/15 bg-amber-300/[0.08] text-amber-200">
          <Warning size={13} weight="bold" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-semibold text-amber-100/90">
            This chat's original AI thread could not be resumed.
          </div>
          <div className="mt-1 text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/66">
            Your chat history and project files are still here.
          </div>
          <div className="mt-1 text-[length:calc(var(--chat-font-size)*10.5/14)] leading-relaxed text-amber-50/72">
            {reasonLine(detail.reason)}
          </div>

          {confirmingRecover ? (
            <div className="mt-2.5 rounded-[calc(var(--chat-radius-card)-8px)] border border-amber-200/12 bg-amber-300/[0.05] px-3 py-2.5">
              <div className="text-[length:calc(var(--chat-font-size)*10.5/14)] leading-relaxed text-amber-50/78">
                ADE will start a fresh AI session and brief it with a short summary from this
                chat's saved history. The original conversation stays saved on this Mac.
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={actionsDisabled}
                  className={PRIMARY_BUTTON_CLASS}
                  onClick={() => {
                    void runRecovery("recover_from_history");
                  }}
                >
                  {pendingMode === "recover_from_history" ? (
                    <ArrowClockwise size={12} weight="bold" className="animate-spin" aria-hidden />
                  ) : (
                    <ClockCounterClockwise size={12} weight="bold" aria-hidden />
                  )}
                  {pendingMode === "recover_from_history" ? "Recovering" : "Confirm recover"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={NEUTRAL_BUTTON_CLASS}
                  onClick={() => {
                    setConfirmingRecover(false);
                    setFailure(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={actionsDisabled}
                className={PRIMARY_BUTTON_CLASS}
                onClick={() => {
                  void runRecovery("retry_original");
                }}
              >
                {pendingMode === "retry_original" ? (
                  <ArrowClockwise size={12} weight="bold" className="animate-spin" aria-hidden />
                ) : (
                  <ArrowClockwise size={12} weight="bold" aria-hidden />
                )}
                {pendingMode === "retry_original" ? "Retrying" : "Retry original thread"}
              </button>
              <button
                type="button"
                disabled={actionsDisabled}
                className={NEUTRAL_BUTTON_CLASS}
                onClick={() => {
                  setFailure(null);
                  setConfirmingRecover(true);
                }}
              >
                <ArrowCounterClockwise size={12} weight="bold" aria-hidden />
                Recover from ADE history
              </button>
              <button
                type="button"
                disabled={actionsDisabled}
                className={NEUTRAL_BUTTON_CLASS}
                onClick={() => {
                  void runRecovery("start_new_chat");
                }}
              >
                {pendingMode === "start_new_chat" ? (
                  <ArrowClockwise size={12} weight="bold" className="animate-spin" aria-hidden />
                ) : (
                  <ChatCircleDots size={12} weight="bold" aria-hidden />
                )}
                {pendingMode === "start_new_chat" ? "Starting" : "Start a new chat"}
              </button>
            </div>
          )}

          {failure ? (
            <div
              role="alert"
              className="mt-2 text-[length:calc(var(--chat-font-size)*10/14)] leading-relaxed text-amber-200/80"
            >
              {failure}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
