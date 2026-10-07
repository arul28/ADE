import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  CircleNotch,
  GithubLogo,
  Laptop,
  Question,
  SignOut,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import type { GitHubStatus } from "../../../shared/types";
import {
  COLORS,
  RADII,
  SANS_FONT,
  cardStyle,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import {
  accountAvatarImage,
  accountInitials,
  accountProviderCaption,
  accountSessionState,
  accountSessionTitle,
  fetchAccountStatus,
  providerTint,
  publishAccountStatus,
  useAccountStatus,
  type AdeAccountSessionState,
  type AdeAccountStatus,
} from "../../lib/account";
import { openExternalUrl } from "../../lib/openExternal";
import { docs } from "../../onboarding/docsLinks";
import { BrainRepairButton } from "../settings/BrainRepairButton";
import { ConfirmSheet, YourMacsCard } from "./YourMacsCard";
import { SmartTooltip } from "../ui/SmartTooltip";
import { settingsRouteFor } from "../settings/settingsManifest";
import { ModernPage, ModernRows, ModernSection } from "../settings/primitives";
import "./accountPage.css";
import { useSignInFlow } from "./useSignInFlow";

export { describeThisComputerMissing } from "./YourMacsCard";

const REPO_BRIDGE_DISMISS_KEY = "ade.account.repoBridgeDismissed.v1";

type AccountBridge = {
  signOut: () => Promise<AdeAccountStatus>;
};

function accountBridge(): Partial<AccountBridge> | undefined {
  return (window.ade as typeof window.ade & { account?: Partial<AccountBridge> }).account;
}

function accountReturnRoute(state: unknown): string {
  if (!state || typeof state !== "object" || !("returnTo" in state)) return "/work";
  const returnTo = (state as { returnTo?: unknown }).returnTo;
  if (
    typeof returnTo !== "string" ||
    !returnTo.startsWith("/") ||
    returnTo.startsWith("//") ||
    /^\/account(?:[/?#]|$)/.test(returnTo)
  ) {
    return "/work";
  }
  return returnTo;
}

function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // localStorage may be unavailable in hardened contexts.
  }
}



// ---------------------------------------------------------------------------
// Signed-out: the rich sign-in card.
// ---------------------------------------------------------------------------

export function SignInCard({
  configured,
  onSignedIn,
  sessionState = "signed_out",
}: {
  configured: boolean;
  onSignedIn: () => void;
  /**
   * Why there is no account here. "unreadable" is the one that must not lead
   * with a sign-in button — the stored session is probably fine and a new one
   * would overwrite it.
   */
  sessionState?: AdeAccountSessionState;
}) {
  const { phase, error, beginLogin, cancel, busy, unreadable, expired, notice, repair, signInLabel } = useSignInFlow({
    onSignedIn,
    sessionState,
  });
  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        maxWidth: 440,
        flexDirection: "column",
        alignItems: "center",
        gap: 14,
      }}
    >
      <img src="./logo.png" alt="ADE" style={{ height: 30, opacity: 0.95 }} draggable={false} />
      <div
        style={cardStyle({
          padding: 28,
          width: "100%",
          borderRadius: RADII.lg,
          background: COLORS.cardBgSolid,
          backdropFilter: "none",
          WebkitBackdropFilter: "none",
        })}
      >
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: SANS_FONT, fontSize: 19, fontWeight: 700, color: COLORS.textPrimary }}>
            {/*
              One source for the state's own words: `unreadable` and `expired`
              both take their title from the label table, so the header never
              drifts from the notice under it. `signed_out` keeps the call to
              action -- the table's "Signed out" describes the state, but
              this card is where you act on it.
            */}
            {unreadable || expired ? accountSessionTitle(sessionState) : "Sign in to ADE"}
          </div>
          {notice ? (
            <div
              style={{
                marginTop: 8,
                fontFamily: SANS_FONT,
                fontSize: 12.5,
                lineHeight: 1.5,
                color: COLORS.textSecondary,
              }}
            >
              {notice}
            </div>
          ) : null}
        </div>

        {!configured ? (
          <div
            style={{
              marginTop: 20,
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              padding: "10px 12px",
              borderRadius: RADII.md,
              background: "color-mix(in srgb, var(--color-warning) 10%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-warning) 26%, transparent)",
              color: COLORS.textSecondary,
              fontFamily: SANS_FONT,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <WarningCircle size={16} weight="fill" color={COLORS.warning} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>Account sign-in isn't available in this build.</span>
          </div>
        ) : null}

        {unreadable ? (
          // Repair first, sign-in demoted: the fix here is regaining access to
          // the session that already exists, not replacing it.
          <div style={{ marginTop: 22, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            {repair.available ? (
              <BrainRepairButton repair={repair} height={40} />
            ) : (
              <button
                type="button"
                onClick={() => void fetchAccountStatus({ force: true })}
                style={outlineButton({ height: 40, fontSize: 13, padding: "0 16px" })}
              >
                Try again
              </button>
            )}
            <button
              type="button"
              disabled={busy || !configured}
              onClick={() => void beginLogin()}
              style={{
                border: 0,
                padding: "6px 8px",
                background: "transparent",
                color: COLORS.textMuted,
                fontFamily: SANS_FONT,
                fontSize: 12,
                cursor: busy || !configured ? "not-allowed" : "pointer",
                opacity: busy || !configured ? 0.55 : 1,
                WebkitAppRegion: "no-drag",
              } as CSSProperties}
            >
              Sign in anyway
            </button>
          </div>
        ) : (
          <div style={{ marginTop: 22 }}>
            <button
              type="button"
              disabled={busy || !configured}
              onClick={() => void beginLogin()}
              style={primaryButton({
                width: "100%",
                height: 44,
                fontSize: 14,
                gap: 8,
                opacity: busy || !configured ? 0.55 : 1,
                cursor: busy || !configured ? "not-allowed" : "pointer",
                WebkitAppRegion: "no-drag",
              } as CSSProperties)}
            >
              {busy ? <CircleNotch size={16} weight="bold" className="animate-spin" /> : <ArrowRight size={17} weight="bold" />}
              {signInLabel}
            </button>
            <div
              style={{
                marginTop: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                color: COLORS.textMuted,
                fontFamily: SANS_FONT,
                fontSize: 11.5,
              }}
            >
              <span>Sign in to use ADE Relay</span>
              <SmartTooltip content={{ label: "ADE Relay", description: "ADE's hosted relay pairs this machine with your account so phones and other Macs can reach it.", docUrl: docs.adeRelay }}>
                <button
                  type="button"
                  aria-label="Learn about ADE Relay"
                  onClick={() => openExternalUrl(docs.adeRelay)}
                  style={{
                    display: "inline-flex",
                    width: 18,
                    height: 18,
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                    border: 0,
                    borderRadius: "50%",
                    background: "transparent",
                    color: COLORS.textMuted,
                    cursor: "pointer",
                    WebkitAppRegion: "no-drag",
                  } as CSSProperties}
                >
                  <Question size={13} weight="bold" />
                </button>
              </SmartTooltip>
            </div>
          </div>
        )}

        {phase === "awaiting" ? (
          <div
            style={{
              marginTop: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              padding: "9px 12px",
              borderRadius: RADII.md,
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.borderMuted}`,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary }}>
              <CircleNotch size={14} weight="bold" className="animate-spin" />
              Finish signing in in your browser…
            </span>
            <button
              type="button"
              onClick={cancel}
              style={outlineButton({ height: 26, fontSize: 11, padding: "0 10px" })}
            >
              Cancel
            </button>
          </div>
        ) : null}

        {error ? (
          <div style={{ marginTop: 14, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.danger, lineHeight: 1.5 }}>
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Signed-in: sign-out row (honest single-machine scope, behind a confirmation).
// ---------------------------------------------------------------------------

function SignOutCard({ onSignOut, signingOut }: { onSignOut: () => void; signingOut: boolean }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <ModernRows>
        <div className="ade-ap-rowcard">
          <span className="ade-acct-glyph" aria-hidden>
            <Laptop size={16} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="ade-ap-rowtitle">Signed in on this computer</div>
            <div className="ade-ap-rowhint">Signing out only affects this computer. Your other computers and phones stay signed in.</div>
          </div>
          <button
            type="button"
            className="ade-acct-btn"
            data-tone="danger"
            disabled={signingOut}
            onClick={() => setConfirming(true)}
          >
            {signingOut ? <CircleNotch size={13} weight="bold" className="animate-spin" /> : <SignOut size={13} weight="bold" />}
            Sign out
          </button>
        </div>
      </ModernRows>

      {confirming ? (
        <ConfirmSheet
          title="Sign out of ADE?"
          body="Signing out removes this computer's access to your account and its account-connected machines. Devices paired directly with a code stay connected."
          confirmLabel="Sign out"
          danger
          busy={signingOut}
          onConfirm={() => {
            setConfirming(false);
            onSignOut();
          }}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </>
  );
}

/** The profile card: avatar, name, email, and the facts about this sign-in. */
function ProfileCard({
  status,
  avatarImage,
  avatarBroken,
  onAvatarError,
  ringTint,
  providerCaption,
}: {
  status: AdeAccountStatus;
  avatarImage: string | null;
  avatarBroken: boolean;
  onAvatarError: () => void;
  ringTint: string;
  providerCaption: string | null;
}) {
  return (
    <div className="ade-acct-profile" style={{ "--ade-acct-tint": ringTint } as CSSProperties}>
      <div className="ade-acct-profile-main">
        <span className="ade-acct-avatar">
          {avatarImage && !avatarBroken ? (
            <img src={avatarImage} alt="" width={64} height={64} draggable={false} onError={onAvatarError} />
          ) : (
            <span className="ade-acct-monogram">{accountInitials(status)}</span>
          )}
          <span className="ade-acct-avatar-dot" aria-hidden />
        </span>
        <div className="ade-acct-who">
          {status.name ? <div className="ade-acct-name">{status.name}</div> : null}
          <div className={status.name ? "ade-acct-email" : "ade-acct-name"}>{status.email ?? "Your ADE account"}</div>
        </div>
      </div>
      <div className="ade-acct-facts">
        <div className="ade-acct-fact">
          <span className="kit-eyebrow">Session</span>
          <span className="ade-acct-fact-value">
            <span className="kit-dot" data-state="ok" aria-hidden />
            <span>Active on this computer</span>
          </span>
        </div>
        <div className="ade-acct-fact">
          <span className="kit-eyebrow">Sign-in</span>
          <span className="ade-acct-fact-value">
            <span>{providerCaption ?? "ADE account"}</span>
          </span>
        </div>
        <div className="ade-acct-fact">
          <span className="kit-eyebrow">Account ID</span>
          <span className="ade-acct-fact-value kit-num" title={status.userId ?? undefined}>
            <span>{status.userId ?? "—"}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

/**
 * The account: who you are, your Macs, and sign out; or the sign-in card.
 *
 * `embedded` renders it as a Settings section: no page scroll, no width cap,
 * no Back button. The standalone page (no project open) keeps all three.
 */
export function AccountPage({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { status, refresh } = useAccountStatus();
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const [repoBridgeDismissed, setRepoBridgeDismissed] = useState(() => readDismissed(REPO_BRIDGE_DISMISS_KEY));
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    void window.ade.github
      ?.getStatus?.()
      .then((next) => {
        if (!cancelled) setGithubStatus(next);
      })
      .catch(() => {});
    const unsubscribe = window.ade.github?.onStatusChanged?.((next) => setGithubStatus(next));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const githubConnected = Boolean(githubStatus?.connected);
  const avatarImage = accountAvatarImage(status, githubStatus?.userLogin ?? null);
  const ringTint = providerTint(status, githubConnected);
  const providerCaption = accountProviderCaption(status);

  // A new avatar URL deserves a fresh load attempt after a prior one failed.
  useEffect(() => {
    setAvatarBroken(false);
  }, [avatarImage]);

  const handleSignedIn = useCallback(() => {
    void refresh();
  }, [refresh]);

  const handleSignOut = useCallback(async () => {
    const api = accountBridge();
    if (!api?.signOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      const next = await api.signOut();
      publishAccountStatus(next);
    } catch (err) {
      setSignOutError(err instanceof Error ? err.message : "Couldn't sign out of your ADE account.");
    } finally {
      setSigningOut(false);
    }
  }, []);

  const dismissRepoBridge = useCallback(() => {
    writeDismissed(REPO_BRIDGE_DISMISS_KEY);
    setRepoBridgeDismissed(true);
  }, []);

  const goBack = useCallback(() => {
    navigate(accountReturnRoute(location.state), { replace: true });
  }, [location.state, navigate]);

  const showRepoBridge = useMemo(
    () => status.signedIn && !githubConnected && !repoBridgeDismissed,
    [status.signedIn, githubConnected, repoBridgeDismissed],
  );

  const backButton = embedded ? null : (
    <button
      ref={backRef}
      type="button"
      onClick={goBack}
      style={outlineButton({
        alignSelf: "flex-start",
        height: 30,
        padding: "0 9px",
        background: "transparent",
        border: "none",
      })}
    >
      <ArrowLeft size={14} weight="bold" />
      Back
    </button>
  );

  const signedInContent = (
    <ModernPage>
      <ProfileCard
          status={status}
          avatarImage={avatarImage}
          avatarBroken={avatarBroken}
          onAvatarError={() => setAvatarBroken(true)}
          ringTint={ringTint}
          providerCaption={providerCaption}
        />

      {/* GitHub repo bridge — identity stays decoupled from repo connection */}
      {showRepoBridge ? (
        <ModernSection group="Account" title="GitHub" hint="Your identity and your GitHub repo access stay separate — link it when you're ready.">
          <div className="ade-ap-rowcard">
            <span className="ade-acct-glyph" aria-hidden>
              <GithubLogo size={17} weight="fill" />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ade-ap-rowtitle">Connect your repos & PRs too?</div>
              <div className="ade-ap-rowhint">Lanes, pull requests and checks read from GitHub once it is connected.</div>
            </div>
            <button
              type="button"
              className="ade-acct-btn"
              onClick={() => navigate(settingsRouteFor("integrations.github"))}
            >
              Connect GitHub
            </button>
            <SmartTooltip content={{ label: "Dismiss", description: "Hide this suggestion for this session." }}>
              <button
                type="button"
                onClick={dismissRepoBridge}
                aria-label="Dismiss"
                className="ade-acct-btn ade-acct-icon-btn"
                data-variant="ghost"
              >
                <X size={13} weight="bold" />
              </button>
            </SmartTooltip>
          </div>
        </ModernSection>
      ) : null}

      <YourMacsCard />

      <ModernSection group="Account" title="Session">
        <SignOutCard onSignOut={() => void handleSignOut()} signingOut={signingOut} />
      </ModernSection>
      {signOutError ? <p role="alert" className="ade-acct-error">{signOutError}</p> : null}
    </ModernPage>
  );

  const content = !status.signedIn ? (
    <div
      style={embedded
        ? { display: "flex", flexDirection: "column", gap: 16 }
        : {
          maxWidth: 920,
          margin: "0 auto",
          padding: "36px clamp(20px, 5vw, 40px) 64px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          minHeight: "100%",
        }}
    >
      {backButton}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          gap: 16,
          padding: embedded ? "32px 0" : undefined,
        }}
      >
        <SignInCard
          configured={status.configured !== false}
          onSignedIn={handleSignedIn}
          sessionState={accountSessionState(status)}
        />
      </div>
    </div>
  ) : embedded ? (
    signedInContent
  ) : (
    <div className="ade-acct-standalone">
      {backButton}
      {signedInContent}
    </div>
  );

  if (embedded) return content;
  return (
    <div style={{ height: "100%", width: "100%", overflowY: "auto", background: COLORS.pageBg }}>
      {content}
    </div>
  );
}

export default AccountPage;
