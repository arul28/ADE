import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, CheckCircle, Warning } from "@phosphor-icons/react";
import {
  runMachinePairingReconnect,
  type MachinePairingReconnectOutcome,
} from "../../lib/machinePairingReconnect";
import type { AccountDeviceLoginPrompt } from "../../lib/accountLogin";
import { openExternalUrl } from "../../lib/openExternal";
import { useBrainRepair } from "../../hooks/useBrainRepair";
import { BrainRepairButton } from "../settings/BrainRepairButton";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { isBrainAccountSessionFailure } from "../../../shared/types";
import { helperTextStyle } from "./remoteTargetListStyles";
import {
  describePublishHealth,
  describeThisComputerCard,
  type LocalPublishHealth,
} from "./remoteMachineModel";

/**
 * This computer's standing with the ADE account, and the one thing to press.
 *
 * Rendered INSIDE the "This machine" card at the top of the Connections
 * popover, never as a second card. The popover used to show the same failure
 * twice: a sentence in the header and a banner with the button under the
 * Machines heading, and then a third "This computer" card on top of both. One
 * component, one place, one button.
 *
 * The state comes from the brain's publisher health (`getInfo`), which is the
 * same record the Account page reads, so the two surfaces cannot disagree. The
 * button label follows the brain's refusal code: "Sign in again" when the
 * directory wants fresh proof, "Reconnect this computer" when it removed the
 * machine, "Retry" for a plain failure.
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
  const [reconnecting, setReconnecting] = useState(false);
  const [outcome, setOutcome] = useState<MachinePairingReconnectOutcome | null>(null);
  // The device sign-in prompt while a reconnect is proving fresh authentication.
  const [signInPrompt, setSignInPrompt] = useState<AccountDeviceLoginPrompt | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const cancelledRef = useRef(false);
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

  const repair = useBrainRepair(refresh);
  const card = useMemo(() => describeThisComputerCard(publishHealth), [publishHealth]);
  const failing = describePublishHealth(publishHealth).kind === "failing";
  const showRepair = failing && isBrainAccountSessionFailure(publishHealth?.state) && repair.available;

  const reconnect = useCallback(async () => {
    const api = window.ade.account;
    if (!api?.repairMachinePairing) return;
    setReconnecting(true);
    setOutcome(null);
    setSignInPrompt(null);
    setLinkCopied(false);
    cancelledRef.current = false;
    try {
      const result = await runMachinePairingReconnect({
        repair: () => api.repairMachinePairing(),
        onPrompt: (prompt) => {
          setSignInPrompt(prompt);
          setLinkCopied(false);
        },
        isCancelled: () => cancelledRef.current,
        afterAttempt: async () => {
          refresh();
          return "unverified";
        },
      });
      if (result) setOutcome(result);
      if (result?.tone === "success") {
        onAccountMachinesChanged?.();
        refresh();
      }
    } finally {
      setSignInPrompt(null);
      setReconnecting(false);
    }
  }, [onAccountMachinesChanged, refresh]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    setSignInPrompt(null);
  }, []);

  const signInUrl = signInPrompt?.verificationUriComplete ?? signInPrompt?.verificationUri ?? null;

  const copyLink = useCallback(() => {
    const write = window.ade.app?.writeClipboardText;
    if (!signInUrl || !write) return;
    void write(signInUrl).then(() => setLinkCopied(true)).catch(() => {});
  }, [signInUrl]);

  // Nothing to say while signed out or while the brain has not reported yet,
  // unless the brain itself cannot read the account session (Repair).
  if (!card) return null;
  if (!accountSignedIn && !isBrainAccountSessionFailure(publishHealth?.state)) return null;

  const button = card.action.label === "Repair"
    ? (showRepair ? <BrainRepairButton repair={repair} height={24} /> : null)
    : card.action.label
      ? (
        <button
          type="button"
          disabled={reconnecting}
          onClick={() => {
            if (card.action.retry) refresh();
            else void reconnect();
          }}
          style={outlineButton({
            height: 24,
            padding: "0 10px",
            fontSize: 11,
            flexShrink: 0,
            opacity: reconnecting ? 0.6 : 1,
            cursor: reconnecting ? "not-allowed" : "pointer",
          })}
        >
          {reconnecting ? (signInPrompt ? "Waiting for sign-in…" : "Reconnecting…") : card.action.label}
        </button>
      )
      : null;

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
            color: card.tone === "healthy" ? COLORS.textSecondary : COLORS.warning,
          }}
        >
          {card.tone === "healthy"
            ? <CheckCircle size={13} weight="fill" color={COLORS.accent} style={{ flexShrink: 0 }} />
            : <Warning size={13} weight="fill" style={{ flexShrink: 0 }} />}
          <span>{capitalizeSentence(card.summary)}</span>
        </span>
        {button}
      </div>

      {signInPrompt && signInUrl ? (
        <div
          style={{
            display: "grid",
            gap: 8,
            padding: "9px 10px",
            borderRadius: 8,
            border: `1px solid ${COLORS.borderMuted}`,
            background: COLORS.recessedBg,
          }}
        >
          <div style={{ ...helperTextStyle, color: COLORS.textPrimary, fontSize: 12 }}>
            {signInPrompt.browserOpened
              ? "Finish signing in in your browser. This closes on its own."
              : "Open the sign-in page in your browser and press Continue."}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {/* Always offered: the browser can open behind ADE, or not at all. */}
            <button
              type="button"
              onClick={() => openExternalUrl(signInUrl)}
              style={outlineButton({ height: 24, padding: "0 10px", fontSize: 11 })}
            >
              <ArrowSquareOut size={12} />
              Open sign-in page
            </button>
            <button
              type="button"
              onClick={copyLink}
              style={outlineButton({ height: 24, padding: "0 10px", fontSize: 11 })}
            >
              {linkCopied ? "Copied" : "Copy link"}
            </button>
            <button
              type="button"
              onClick={cancel}
              style={outlineButton({ height: 24, padding: "0 10px", fontSize: 11 })}
            >
              Cancel
            </button>
          </div>
          <div style={{ ...helperTextStyle, fontSize: 11 }}>
            Code <span style={{ fontFamily: MONO_FONT, color: COLORS.textPrimary }}>{signInPrompt.userCode}</span>
            {signInPrompt.browserOpened ? ", already filled in on the page." : ", enter it on the page."}
          </div>
        </div>
      ) : null}

      {outcome ? (
        <div
          role="status"
          style={{
            ...helperTextStyle,
            color: outcome.tone === "success"
              ? COLORS.success
              : outcome.tone === "warning"
                ? COLORS.warning
                : COLORS.danger,
          }}
        >
          {outcome.message}
        </div>
      ) : null}
    </div>
  );
}

function capitalizeSentence(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
