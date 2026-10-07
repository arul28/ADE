import { ArrowRight, CircleNotch, Question, WarningCircle } from "@phosphor-icons/react";
import { fetchAccountStatus, accountSessionTitle, type AdeAccountSessionState } from "../../lib/account";
import { openExternalUrl } from "../../lib/openExternal";
import { docs } from "../../onboarding/docsLinks";
import { useSignInFlow } from "../account/useSignInFlow";
import { COLORS } from "../lanes/laneDesignTokens";
import { BrainRepairButton } from "../settings/BrainRepairButton";
import { SmartTooltip } from "../ui/SmartTooltip";

/**
 * The launch gate's sign-in: a frosted card floating over the window mesh.
 * Needs `launchGateGlass.css` and an `.ade-gate` ancestor for its tokens. The
 * sign-in state is the Account page's (`useSignInFlow`); only the drawing
 * differs.
 */
export function GlassSignInCard({
  configured,
  onSignedIn,
  sessionState = "signed_out",
}: {
  configured: boolean;
  onSignedIn: () => void;
  sessionState?: AdeAccountSessionState;
}) {
  const { phase, error, beginLogin, cancel, busy, unreadable, expired, notice, repair, signInLabel } = useSignInFlow({
    onSignedIn,
    sessionState,
  });
  const blocked = busy || !configured;
  return (
    <div className="ade-glass-card" data-testid="sign-in-glass-card">
      <span className="ade-glass-mark">
        <img src="./logo.png" alt="ADE" draggable={false} />
      </span>
      <h1 className="ade-glass-title">
        {unreadable || expired ? accountSessionTitle(sessionState) : "Sign in to ADE"}
      </h1>
      <p className="ade-glass-sub">
        {notice ?? "One account for every computer and phone you run ADE on."}
      </p>

      {!configured ? (
        <div className="ade-glass-notice">
          <WarningCircle size={16} weight="fill" color={COLORS.warning} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>Account sign-in isn't available in this build.</span>
        </div>
      ) : null}

      {unreadable ? (
        <div style={{ marginTop: 26, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          {repair.available ? (
            <BrainRepairButton repair={repair} height={44} />
          ) : (
            <button
              type="button"
              className="ade-glass-secondary"
              onClick={() => void fetchAccountStatus({ force: true })}
            >
              Try again
            </button>
          )}
          <button
            type="button"
            className="ade-glass-link"
            disabled={blocked}
            onClick={() => void beginLogin()}
          >
            Sign in anyway
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 26 }}>
          <button
            type="button"
            className="ade-glass-primary"
            disabled={blocked}
            onClick={() => void beginLogin()}
          >
            {busy ? <CircleNotch size={16} weight="bold" className="animate-spin" /> : null}
            {signInLabel}
            {busy ? null : <ArrowRight size={16} weight="bold" className="ade-glass-primary-arrow" />}
          </button>
        </div>
      )}

      {phase === "awaiting" ? (
        <div className="ade-glass-awaiting">
          <span>
            <CircleNotch size={14} weight="bold" className="animate-spin" />
            Finish signing in in your browser…
          </span>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      ) : null}

      {error ? <div className="ade-glass-error">{error}</div> : null}

      <div className="ade-glass-foot">
        <span>Sign in to use ADE Relay</span>
        <SmartTooltip content={{ label: "ADE Relay", description: "ADE's hosted relay pairs this machine with your account so phones and other Macs can reach it.", docUrl: docs.adeRelay }}>
          <button
            type="button"
            className="ade-glass-help"
            aria-label="Learn about ADE Relay"
            onClick={() => openExternalUrl(docs.adeRelay)}
          >
            <Question size={12} weight="bold" />
          </button>
        </SmartTooltip>
      </div>
    </div>
  );
}
