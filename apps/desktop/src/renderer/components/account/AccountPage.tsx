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
  dangerButton,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import {
  accountAvatarImage,
  accountInitials,
  accountProviderCaption,
  accountSessionNotice,
  accountSessionState,
  accountSessionTitle,
  fetchAccountStatus,
  providerTint,
  publishAccountStatus,
  useAccountStatus,
  type AdeAccountSessionState,
  type AdeAccountStatus,
} from "../../lib/account";
import { useAccountLogin } from "../../lib/accountLogin";
import { openExternalUrl } from "../../lib/openExternal";
import { docs } from "../../onboarding/docsLinks";
import { useBrainRepair } from "../../hooks/useBrainRepair";
import { BrainRepairButton } from "../settings/BrainRepairButton";
import { ConfirmSheet, YourMacsCard } from "./YourMacsCard";
import { settingsRouteFor } from "../settings/settingsManifest";

export { describeThisComputerMissing, reconnectNeedsFreshSignIn } from "./YourMacsCard";

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


const sectionLabelStyle: CSSProperties = {
  fontFamily: SANS_FONT,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: COLORS.textMuted,
};

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
  const { phase, error, beginLogin, cancel } = useAccountLogin({
    onSignedIn: () => onSignedIn(),
  });
  const busy = phase === "starting" || phase === "awaiting";
  const unreadable = sessionState === "unreadable";
  const expired = sessionState === "expired";
  const notice = accountSessionNotice(sessionState);
  const repair = useBrainRepair(() => {
    void fetchAccountStatus({ force: true });
  });
  const signInLabel = expired ? "Sign in" : "Sign in or create account";

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
              <button
                type="button"
                aria-label="Learn about ADE Relay"
                title="Learn about ADE Relay"
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
// Signed-in: sign-out card (honest single-machine scope, behind a confirmation).
// ---------------------------------------------------------------------------

function SignOutCard({ onSignOut, signingOut }: { onSignOut: () => void; signingOut: boolean }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div style={cardStyle({ padding: 0, overflow: "hidden" })}>
      <div style={{ padding: "16px 18px 12px" }}>
        <div style={sectionLabelStyle}>Session</div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 18px 16px",
        }}
      >
        <Laptop size={16} weight="regular" color={COLORS.textSecondary} style={{ flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textPrimary }}>Signed in on this computer</div>
        </div>
        <button
          type="button"
          disabled={signingOut}
          onClick={() => setConfirming(true)}
          style={dangerButton({
            height: 32,
            fontSize: 12,
            opacity: signingOut ? 0.6 : 1,
            cursor: signingOut ? "not-allowed" : "pointer",
          })}
        >
          {signingOut ? <CircleNotch size={14} weight="bold" className="animate-spin" /> : <SignOut size={14} weight="bold" />}
          Sign out
        </button>
      </div>

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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export function AccountPage() {
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

  const backButton = (
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

  return (
    <div style={{ height: "100%", width: "100%", overflowY: "auto", background: COLORS.pageBg }}>
      <div
        style={{
          maxWidth: 920,
          margin: "0 auto",
          padding: "36px clamp(20px, 5vw, 40px) 64px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          minHeight: "100%",
        }}
      >
        {!status.signedIn ? (
          <>
            {backButton}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, gap: 16 }}>
              <SignInCard
                configured={status.configured !== false}
                onSignedIn={handleSignedIn}
                sessionState={accountSessionState(status)}
              />
            </div>
          </>
        ) : (
          <>
            {backButton}

            {/* Identity header */}
            <div style={cardStyle({ display: "flex", alignItems: "center", gap: 16 })}>
              <span style={{ flexShrink: 0 }}>
                {avatarImage && !avatarBroken ? (
                  <img
                    src={avatarImage}
                    alt=""
                    width={52}
                    height={52}
                    draggable={false}
                    onError={() => setAvatarBroken(true)}
                    style={{
                      width: 52,
                      height: 52,
                      borderRadius: "50%",
                      objectFit: "cover",
                      boxShadow: `0 0 0 2px color-mix(in srgb, ${ringTint} 55%, transparent)`,
                    }}
                  />
                ) : (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 52,
                      height: 52,
                      borderRadius: "50%",
                      fontFamily: SANS_FONT,
                      fontSize: 18,
                      fontWeight: 700,
                      color: COLORS.textPrimary,
                      background: `color-mix(in srgb, ${ringTint} 20%, transparent)`,
                      boxShadow: `0 0 0 2px color-mix(in srgb, ${ringTint} 55%, transparent)`,
                    }}
                  >
                    {accountInitials(status)}
                  </span>
                )}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                {status.name ? (
                  <div
                    style={{
                      fontFamily: SANS_FONT,
                      fontSize: 15,
                      fontWeight: 700,
                      color: COLORS.textPrimary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {status.name}
                  </div>
                ) : null}
                <div
                  style={{
                    fontFamily: SANS_FONT,
                    fontSize: status.name ? 14 : 16,
                    fontWeight: status.name ? 500 : 700,
                    color: status.name ? COLORS.textSecondary : COLORS.textPrimary,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {status.email ?? "Your ADE account"}
                </div>
                {providerCaption ? (
                  <div style={{ marginTop: 4, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
                    {providerCaption}
                  </div>
                ) : null}
              </div>
            </div>

            {/* GitHub repo bridge — identity stays decoupled from repo connection */}
            {showRepoBridge ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "13px 16px",
                  borderRadius: RADII.lg,
                  background: COLORS.cardBg,
                  border: `1px solid ${COLORS.border}`,
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    background: "color-mix(in srgb, #8b949e 20%, transparent)",
                    color: COLORS.textPrimary,
                    flexShrink: 0,
                  }}
                >
                  <GithubLogo size={17} weight="fill" />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
                    Connect your repos & PRs too?
                  </div>
                  <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
                    Your identity and your GitHub repo access stay separate — link it when you're ready.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => navigate(settingsRouteFor("integrations.github"))}
                  style={outlineButton({ height: 30, fontSize: 12, padding: "0 12px", flexShrink: 0 })}
                >
                  Connect GitHub
                </button>
                <button
                  type="button"
                  onClick={dismissRepoBridge}
                  aria-label="Dismiss"
                  style={{ ...outlineButton({ height: 26, width: 26, padding: 0 }), border: "none", background: "transparent", flexShrink: 0 }}
                >
                  <X size={13} weight="bold" />
                </button>
              </div>
            ) : null}

            <YourMacsCard />

            <SignOutCard onSignOut={() => void handleSignOut()} signingOut={signingOut} />
            {signOutError ? (
              <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.danger, lineHeight: 1.5 }}>
                {signOutError}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export default AccountPage;
