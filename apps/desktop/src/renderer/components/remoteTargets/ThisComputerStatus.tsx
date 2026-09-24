import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, Warning } from "@phosphor-icons/react";
import { useBrainRepair } from "../../hooks/useBrainRepair";
import { useReconnectThisComputer } from "../../hooks/useReconnectThisComputer";
import { useThisComputerRefusal } from "../../hooks/useThisComputerRefusal";
import { describeThisComputerRefusal } from "../../lib/thisComputerRefusal";
import { BrainRepairButton } from "../settings/BrainRepairButton";
import { COLORS, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { isBrainAccountSessionFailure } from "../../../shared/types";
import { helperTextStyle } from "./remoteTargetListStyles";
import {
  describePublishHealth,
  describeThisComputerCard,
  type LocalPublishHealth,
} from "./remoteMachineModel";

type CardOutcome = { tone: "success" | "warning" | "danger"; message: string };

/**
 * This computer's standing with the ADE account, and the one thing to press.
 *
 * Rendered INSIDE the "This machine" card at the top of the Connections
 * popover, never as a second card. The popover used to show the same failure
 * twice: a sentence in the header and a banner with the button under the
 * Machines heading, and then a third "This computer" card on top of both. One
 * component, one place, one button.
 *
 * A directory refusal (this computer was removed, or must confirm it's you) is
 * the shared reconnect flow's, word for word: `describeThisComputerRefusal`
 * for the sentence and `useReconnectThisComputer` for the button. That flow is
 * one per window, so this card, the shell banner and the Account page can never
 * start two browser sign-ins or say different things. The card keeps what that
 * flow has no answer for: Retry for a plain publish failure, Start sync when
 * nobody hosts sync here, and Repair for an unreadable brain session.
 */
export function ThisComputerStatus({
  accountSignedIn,
  onAccountMachinesChanged,
}: {
  accountSignedIn: boolean;
  /** The popover's roster comes from the directory; re-read it after success. */
  onAccountMachinesChanged?: () => void;
}) {
  const [publishHealth, setPublishHealth] = useState<LocalPublishHealth | null>(null);
  const [startingSync, setStartingSync] = useState(false);
  const [outcome, setOutcome] = useState<CardOutcome | null>(null);
  const mountedRef = useRef(true);
  // An older in-flight read must not land after a newer one and bring a
  // cleared failure back.
  const requestRef = useRef(0);

  const refresh = useCallback(() => {
    const infoPromise = window.ade.app?.getInfo?.();
    if (!infoPromise) return;
    const requestId = ++requestRef.current;
    void infoPromise
      .then((info) => {
        if (!mountedRef.current || requestId !== requestRef.current) return;
        const health = info.localRuntime?.publishHealth ?? null;
        setPublishHealth(
          health
            ? {
                state: health.state,
                failingSinceMs: health.failingSinceMs,
                lastHttpStatus: health.lastHttpStatus ?? null,
                lastHttpReason: health.lastHttpReason ?? null,
              }
            : null,
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const { refusal, refresh: refreshRefusal } = useThisComputerRefusal();
  const reconnect = useReconnectThisComputer({
    onSettled: () => {
      refreshRefusal();
      refresh();
      onAccountMachinesChanged?.();
    },
  });

  const repair = useBrainRepair(refresh);
  const card = useMemo(() => describeThisComputerCard(publishHealth), [publishHealth]);
  const failing = describePublishHealth(publishHealth).kind === "failing";
  const showRepair = failing && isBrainAccountSessionFailure(publishHealth?.state) && repair.available;

  /**
   * "Start sync": the brain's own sync-host recovery. What it says back is the
   * outcome line, so a conflict with another ADE app names that app instead of
   * a bare failure.
   */
  const startSync = useCallback(async () => {
    const start = window.ade.account?.startSyncHost;
    if (!start) {
      setOutcome({ tone: "danger", message: "This ADE build can't start sync from here. Restart ADE to start sync." });
      return;
    }
    setStartingSync(true);
    setOutcome(null);
    try {
      const result = await start();
      setOutcome({
        tone: result.ok ? "success" : "warning",
        message: result.ok ? "Sync is running on this computer." : result.message,
      });
      onAccountMachinesChanged?.();
      refresh();
    } catch (error) {
      setOutcome({ tone: "danger", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setStartingSync(false);
    }
  }, [onAccountMachinesChanged, refresh]);

  // The refusal read comes from this machine's sync snapshot; the card's own
  // read comes from the brain's publisher. Either one naming a refusal puts the
  // shared flow's button on the card.
  const refusalCopy = refusal && reconnect.available ? describeThisComputerRefusal(refusal) : null;
  const cardWantsReconnect = Boolean(
    card?.action.label
      && card.action.label !== "Repair"
      && !card.action.retry
      && !card.action.startSync,
  );
  const reconnectView = reconnect.available && (refusalCopy || cardWantsReconnect)
    ? reconnect.view({
        label: refusalCopy?.action ?? card?.action.label ?? "Reconnect this computer",
        detail: refusalCopy?.detail,
      })
    : null;
  const reconnectOutcome = reconnect.outcome;

  // Nothing to say while signed out or while the brain has not reported yet,
  // unless the brain itself cannot read the account session (Repair), or the
  // directory refuses this computer.
  if (!card && !refusalCopy) return null;
  if (!accountSignedIn && !isBrainAccountSessionFailure(publishHealth?.state) && !refusalCopy) return null;

  const tone = refusalCopy ? "warning" : card?.tone ?? "warning";
  const summary = refusalCopy?.title ?? capitalizeSentence(card?.summary ?? "");

  const button = reconnectView
    ? (
      <button
        type="button"
        disabled={reconnectView.disabled}
        onClick={reconnectView.onClick}
        style={outlineButton({
          height: 24,
          padding: "0 10px",
          fontSize: 11,
          flexShrink: 0,
          opacity: reconnectView.disabled ? 0.6 : 1,
          cursor: reconnectView.disabled ? "not-allowed" : "pointer",
        })}
      >
        {reconnectView.label}
      </button>
    )
    : card?.action.label === "Repair"
      ? (showRepair ? <BrainRepairButton repair={repair} height={24} /> : null)
      // Retry and Start sync only: a reconnect label with no shared flow
      // behind it (the hosted web client) gets no button rather than one that
      // only refreshes.
      : card?.action.label && (card.action.retry || card.action.startSync)
        ? (
          <button
            type="button"
            disabled={startingSync}
            onClick={() => {
              if (card.action.startSync) void startSync();
              else refresh();
            }}
            style={outlineButton({
              height: 24,
              padding: "0 10px",
              fontSize: 11,
              flexShrink: 0,
              opacity: startingSync ? 0.6 : 1,
              cursor: startingSync ? "not-allowed" : "pointer",
            })}
          >
            {startingSync ? "Starting sync…" : card.action.label}
          </button>
        )
        : null;

  // The shared flow's line: the browser code while it waits, the reason after
  // a failed attempt, or the refusal's own detail.
  const detail = reconnectView?.detail ?? null;
  const shownOutcome: CardOutcome | null = reconnectOutcome
    ? { tone: reconnectOutcome.tone === "success" ? "success" : "danger", message: reconnectOutcome.message }
    : outcome;
  // A failed reconnect already shows its reason as the detail line.
  const showOutcome = shownOutcome && !(reconnectView && shownOutcome.tone !== "success");

  return (
    <div data-this-computer-card style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            minWidth: 0,
            fontFamily: SANS_FONT,
            fontSize: 11.5,
            lineHeight: 1.4,
            color: tone === "healthy" ? COLORS.textSecondary : COLORS.warning,
          }}
        >
          {tone === "healthy"
            ? <CheckCircle size={13} weight="fill" color={COLORS.accent} style={{ flexShrink: 0 }} />
            : <Warning size={13} weight="fill" style={{ flexShrink: 0 }} />}
          <span>{summary}</span>
        </span>
        {button}
      </div>

      {detail ? (
        <div style={{ ...helperTextStyle, color: reconnectView?.cancels ? COLORS.textPrimary : undefined }}>
          {detail}
        </div>
      ) : null}

      {showOutcome && shownOutcome ? (
        <div
          role="status"
          style={{
            ...helperTextStyle,
            color: shownOutcome.tone === "success"
              ? COLORS.success
              : shownOutcome.tone === "warning"
                ? COLORS.warning
                : COLORS.danger,
          }}
        >
          {shownOutcome.message}
        </div>
      ) : null}
    </div>
  );
}

function capitalizeSentence(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
