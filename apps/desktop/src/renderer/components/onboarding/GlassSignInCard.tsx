import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { ArrowRight, CircleNotch, WarningCircle } from "@phosphor-icons/react";
import { fetchAccountStatus, accountSessionTitle, type AdeAccountSessionState } from "../../lib/account";
import { AnotherDeviceSignInPanel } from "../account/AnotherDeviceSignInPanel";
import { useSignInFlow } from "../account/useSignInFlow";
import type { ClerkSignInSetup } from "../../webclient/account/useClerkSignIn";
import { ClerkSignInPanel } from "./ClerkSignInPanel";
import { COLORS } from "../lanes/laneDesignTokens";
import { BrainRepairButton } from "../settings/BrainRepairButton";
import { AdeWordmark } from "../ui/AdeWordmark";
import { PRIVACY_URL, TERMS_URL } from "../../../shared/legalLinks";
import { openExternalUrl } from "../../lib/openExternal";
import { markPrivacyPolicyNoticeSeen } from "../../lib/privacyPolicyNotice";
import { BRAND } from "../../../shared/brand";

// The notice system (popover, issue report) loads only when a sign-in error
// shows. Imported here eagerly, it added 7 requests and about 105 KB of JS to
// ADE Web's signed-out page (#1951).
const Banner = lazy(() => import("../ui/notice/Banner").then((module) => ({ default: module.Banner })));

/**
 * Every sign-in that runs in the desktop or web renderer passes this card (the
 * desktop gate, ADE Web, and the page a desktop or `ade login` sign-in opens),
 * so the agreement lives here. The links open the system browser in the
 * desktop app and a new tab on the web.
 */
function LegalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        openExternalUrl(href);
      }}
    >
      {children}
    </a>
  );
}

function LegalAgreementLine() {
  return (
    <p className="ade-glass-legal" data-testid="sign-in-legal">
      By continuing, you agree to {BRAND.NAME}'s <LegalLink href={TERMS_URL}>Terms</LegalLink> and{" "}
      <LegalLink href={PRIVACY_URL}>Privacy Policy</LegalLink>.
    </p>
  );
}

/**
 * The launch gate's sign-in: a frosted card floating over the window mesh.
 * Needs `launchGateGlass.css` and an `.ade-gate` ancestor for its tokens. The
 * sign-in state is the Account page's (`useSignInFlow`); only the drawing
 * differs. With `clerk` (ADE Web, and the page a desktop sign-in opens) the
 * card runs the whole Clerk sign-in itself and falls back to the one button,
 * which opens Clerk's hosted page, only when Clerk cannot be reached.
 */
export function GlassSignInCard({
  configured,
  onSignedIn,
  sessionState = "signed_out",
  subtitle,
  clerk,
}: {
  configured: boolean;
  onSignedIn: () => void;
  sessionState?: AdeAccountSessionState;
  /** Replaces the default line under the title (a notice still wins). */
  subtitle?: string;
  clerk?: ClerkSignInSetup;
}) {
  // This card shows the agree line for the current policy, so a sign-in here
  // needs no "We updated our Privacy Policy" notice afterwards.
  const onSignedInHere = useCallback(() => {
    markPrivacyPolicyNoticeSeen();
    onSignedIn();
  }, [onSignedIn]);
  const clerkHere = useMemo<ClerkSignInSetup | undefined>(() => clerk && {
    ...clerk,
    finish: (decorate) => {
      markPrivacyPolicyNoticeSeen();
      return clerk.finish(decorate);
    },
  }, [clerk]);
  const { phase, error, beginLogin, cancel, busy, unreadable, expired, notice, repair, signInLabel, otherDevice } = useSignInFlow({
    onSignedIn: onSignedInHere,
    sessionState,
  });
  const blocked = busy || !configured;
  const [clerkUnavailable, setClerkUnavailable] = useState(false);
  const onClerkUnavailable = useCallback(() => setClerkUnavailable(true), []);
  const showClerk = Boolean(clerk) && configured && !clerkUnavailable && !unreadable;
  return (
    <div className="ade-glass-card" data-testid="sign-in-glass-card">
      <span className="ade-glass-mark">
        <AdeWordmark alt={BRAND.NAME} draggable={false} />
      </span>
      <h1 className="ade-glass-title">
        {unreadable || expired ? accountSessionTitle(sessionState) : `Sign in to ${BRAND.NAME}`}
      </h1>
      <p className="ade-glass-sub">
        {notice ?? subtitle ?? `One account for every computer and phone you run ${BRAND.NAME} on.`}
      </p>

      {!configured ? (
        <div className="ade-glass-notice">
          <WarningCircle size={16} weight="fill" color={COLORS.warning} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>Account sign-in isn't available in this build.</span>
        </div>
      ) : null}

      {showClerk && clerkHere ? (
        <ClerkSignInPanel setup={clerkHere} onUnavailable={onClerkUnavailable} />
      ) : unreadable ? (
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
      ) : otherDevice.prompt ? (
        <div style={{ marginTop: 22 }}>
          <AnotherDeviceSignInPanel prompt={otherDevice.prompt} onCancel={otherDevice.cancel} />
        </div>
      ) : (
        <div style={{ marginTop: 26, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
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
          {otherDevice.available ? (
            <button
              type="button"
              className="ade-glass-link"
              disabled={!configured || otherDevice.starting}
              onClick={() => void otherDevice.begin()}
            >
              Sign in with your phone or another device
            </button>
          ) : null}
        </div>
      )}

      <LegalAgreementLine />

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

      {error ? (
        <Suspense fallback={null}>
        <Banner
          layout="inline"
          style={{ marginTop: 14 }}
          model={{
            id: "glass-sign-in-error",
            tone: "error",
            title: error,
            report: { surface: "account_sign_in" },
          }}
        />
        </Suspense>
      ) : null}
    </div>
  );
}
