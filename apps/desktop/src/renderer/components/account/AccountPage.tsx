import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AppleLogo,
  ArrowRight,
  CircleNotch,
  DesktopTower,
  DeviceMobile,
  EnvelopeSimple,
  GithubLogo,
  GoogleLogo,
  Laptop,
  ShieldCheck,
  SignOut,
  Sparkle,
  Users,
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
  inlineBadge,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import {
  accountAvatarImage,
  accountInitials,
  accountProviderCaption,
  providerTint,
  publishAccountStatus,
  useAccountStatus,
  type AdeAccountMachine,
  type AdeAccountMachinesResult,
  type AdeAccountStatus,
} from "../../lib/account";
import { useAccountLogin } from "../../lib/accountLogin";
import { openConnectionsPanel } from "../../lib/connectionsPanel";

const REPO_BRIDGE_DISMISS_KEY = "ade.account.repoBridgeDismissed.v1";

function firstName(name: string | null): string {
  return name?.trim().split(/\s+/)[0] ?? "there";
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

function relativeLastSeen(lastSeenAt: number | null): string {
  if (!lastSeenAt) return "Never seen";
  const deltaMs = Date.now() - lastSeenAt;
  if (deltaMs < 60_000) return "Active just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `Seen ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Seen ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Seen ${days}d ago`;
}

function machineRouteHint(machine: AdeAccountMachine): string | null {
  const endpoint = machine.reachableEndpoints[0];
  if (!endpoint) return null;
  if (endpoint.kind === "relay") return "relay";
  const host = endpoint.host ?? endpoint.url ?? "";
  return host ? `${endpoint.kind} · ${host}` : endpoint.kind;
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

function SignInCard({
  configured,
  onSignedIn,
}: {
  configured: boolean;
  onSignedIn: () => void;
}) {
  const { phase, error, beginLogin, cancel } = useAccountLogin({
    onSignedIn: () => onSignedIn(),
  });
  const busy = phase === "starting" || phase === "awaiting";

  const secondary: Array<{ label: string; icon: JSX.Element }> = [
    { label: "Email", icon: <EnvelopeSimple size={15} weight="regular" /> },
    { label: "Apple", icon: <AppleLogo size={15} weight="fill" /> },
    { label: "Google", icon: <GoogleLogo size={15} weight="bold" /> },
  ];

  return (
    <div style={cardStyle({ padding: 28, maxWidth: 440, width: "100%" })}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, textAlign: "center", alignItems: "center" }}>
        <img src="./logo.png" alt="ADE" style={{ height: 26, opacity: 0.95 }} draggable={false} />
        <div style={{ fontFamily: SANS_FONT, fontSize: 19, fontWeight: 700, color: COLORS.textPrimary, marginTop: 6 }}>
          Sign in to ADE
        </div>
        <div style={{ fontFamily: SANS_FONT, fontSize: 13, lineHeight: 1.5, color: COLORS.textSecondary, maxWidth: 320 }}>
          One identity for your machines, mobile, and web sessions — so they find each other wherever you are.
        </div>
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
          <span>
            Account sign-in isn't set up on this machine yet. You can still pair machines, phones, and web
            clients from <strong style={{ color: COLORS.textPrimary }}>Connections</strong>.
          </span>
        </div>
      ) : null}

      <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 12 }}>
        <button
          type="button"
          disabled={busy || !configured}
          onClick={() => void beginLogin()}
          style={{
            ...primaryButton({
              height: 44,
              fontSize: 14,
              gap: 8,
              background: "#24292f",
              color: "#ffffff",
              opacity: busy || !configured ? 0.55 : 1,
              cursor: busy || !configured ? "not-allowed" : "pointer",
            }),
          }}
        >
          {busy ? <CircleNotch size={16} weight="bold" className="animate-spin" /> : <GithubLogo size={17} weight="fill" />}
          Continue with GitHub
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10, color: COLORS.textDim }}>
          <div style={{ flex: 1, height: 1, background: COLORS.borderMuted }} />
          <span style={{ fontFamily: SANS_FONT, fontSize: 11 }}>or continue with</span>
          <div style={{ flex: 1, height: 1, background: COLORS.borderMuted }} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {secondary.map((option) => (
            <button
              key={option.label}
              type="button"
              disabled={busy || !configured}
              onClick={() => void beginLogin()}
              style={outlineButton({
                height: 38,
                gap: 6,
                fontSize: 12,
                opacity: busy || !configured ? 0.55 : 1,
                cursor: busy || !configured ? "not-allowed" : "pointer",
              })}
            >
              {option.icon}
              {option.label}
            </button>
          ))}
        </div>
      </div>

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
            style={{ ...outlineButton({ height: 26, fontSize: 11, padding: "0 10px" }) }}
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

      <div
        style={{
          marginTop: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
          fontFamily: SANS_FONT,
          fontSize: 12,
          color: COLORS.textMuted,
        }}
      >
        <ShieldCheck size={14} weight="regular" />
        Local pairing works without an account.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signed-in: machines-at-a-glance.
// ---------------------------------------------------------------------------

function MachinesGlance() {
  const [result, setResult] = useState<AdeAccountMachinesResult | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const api = (window.ade as typeof window.ade & {
      account?: { listMachines: () => Promise<AdeAccountMachinesResult> };
    }).account;
    if (!api?.listMachines) {
      setResult({ state: "unavailable", machines: [], message: null });
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setResult(await api.listMachines());
    } catch {
      setResult({ state: "unavailable", machines: [], message: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const machines = result?.machines ?? [];
  const onlineCount = machines.filter((m) => m.online).length;

  let summary: string;
  if (loading) summary = "Checking your machines…";
  else if (result?.state === "ok") {
    summary = machines.length === 0
      ? "No machines registered yet"
      : `${onlineCount} online · ${machines.length} registered`;
  } else if (result?.state === "not_configured") {
    summary = "Machine directory isn't set up yet";
  } else if (result?.state === "signed_out") {
    summary = "Sign in to see your machines";
  } else {
    summary = "Can't reach the machine directory";
  }

  return (
    <div style={cardStyle({ padding: 0, overflow: "hidden" })}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "16px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              borderRadius: 8,
              background: COLORS.accentSubtle,
              color: COLORS.accent,
              flexShrink: 0,
            }}
          >
            <DesktopTower size={16} weight="duotone" />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
              Your machines
            </div>
            <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>{summary}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => openConnectionsPanel("machines")}
          style={outlineButton({ height: 30, fontSize: 12, padding: "0 12px" })}
        >
          Manage
          <ArrowRight size={13} weight="bold" />
        </button>
      </div>

      {result?.state === "ok" && machines.length > 0 ? (
        <div style={{ borderTop: `1px solid ${COLORS.borderMuted}` }}>
          {machines.slice(0, 4).map((machine) => (
            <div
              key={machine.machineKey}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 18px",
                borderTop: `1px solid ${COLORS.borderMuted}`,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: machine.online ? COLORS.success : COLORS.textDim,
                  boxShadow: machine.online ? `0 0 0 3px color-mix(in srgb, ${COLORS.success} 20%, transparent)` : undefined,
                }}
              />
              <Laptop size={15} weight="regular" color={COLORS.textMuted} style={{ flexShrink: 0 }} />
              <span style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textPrimary, minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {machine.name ?? "Unnamed machine"}
              </span>
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: machine.online ? COLORS.success : COLORS.textMuted, flexShrink: 0 }}>
                {machine.online ? machineRouteHint(machine) ?? "online" : relativeLastSeen(machine.lastSeenAt)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {result?.state === "unavailable" || result?.state === "not_configured" ? (
        <div
          style={{
            borderTop: `1px solid ${COLORS.borderMuted}`,
            padding: "12px 18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted, lineHeight: 1.5 }}>
            {result.state === "not_configured"
              ? "Local machines still connect from Connections — the shared directory just isn't live yet."
              : "Local machines still connect from Connections while the directory reconnects."}
          </span>
          {result.state === "unavailable" ? (
            <button type="button" onClick={() => void load()} style={outlineButton({ height: 28, fontSize: 11, padding: "0 10px" })}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signed-in: sessions (current session + clearly-marked cross-device seam).
// ---------------------------------------------------------------------------

function SessionsCard({ onSignOut, signingOut }: { onSignOut: () => void; signingOut: boolean }) {
  return (
    <div style={cardStyle({ padding: 0, overflow: "hidden" })}>
      <div style={{ padding: "16px 18px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={sectionLabelStyle}>Sessions</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 18px 14px" }}>
        <Laptop size={16} weight="regular" color={COLORS.textSecondary} style={{ flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textPrimary }}>This machine</div>
          <div style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>Signed in here</div>
        </div>
        <span style={inlineBadge(COLORS.success, { fontSize: 10 })}>Current</span>
      </div>
      <div
        style={{
          borderTop: `1px solid ${COLORS.borderMuted}`,
          padding: "12px 18px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted, lineHeight: 1.5, maxWidth: 320 }}>
          Signing out everywhere arrives with cross-device sessions. For now, this signs out on this machine.
        </span>
        <button
          type="button"
          disabled={signingOut}
          onClick={onSignOut}
          style={dangerButton({ height: 32, fontSize: 12, opacity: signingOut ? 0.6 : 1, cursor: signingOut ? "not-allowed" : "pointer" })}
        >
          {signingOut ? <CircleNotch size={14} weight="bold" className="animate-spin" /> : <SignOut size={14} weight="bold" />}
          Sign out
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export function AccountPage() {
  const navigate = useNavigate();
  const { status, refresh } = useAccountStatus();
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [justSignedIn, setJustSignedIn] = useState(false);
  const [repoBridgeDismissed, setRepoBridgeDismissed] = useState(() => readDismissed(REPO_BRIDGE_DISMISS_KEY));

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

  const handleSignedIn = useCallback(() => {
    setJustSignedIn(true);
    void refresh();
  }, [refresh]);

  const handleSignOut = useCallback(async () => {
    const api = (window.ade as typeof window.ade & {
      account?: { signOut: () => Promise<AdeAccountStatus> };
    }).account;
    if (!api?.signOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      const next = await api.signOut();
      publishAccountStatus(next);
      setJustSignedIn(false);
    } catch (err) {
      setSignOutError(
        err instanceof Error ? err.message : "Couldn't sign out of your ADE account.",
      );
    } finally {
      setSigningOut(false);
    }
  }, []);

  const dismissRepoBridge = useCallback(() => {
    writeDismissed(REPO_BRIDGE_DISMISS_KEY);
    setRepoBridgeDismissed(true);
  }, []);

  const showRepoBridge = useMemo(
    () => status.signedIn && !githubConnected && !repoBridgeDismissed,
    [status.signedIn, githubConnected, repoBridgeDismissed],
  );

  return (
    <div style={{ height: "100%", width: "100%", overflowY: "auto", background: COLORS.pageBg }}>
      <div
        style={{
          maxWidth: 640,
          margin: "0 auto",
          padding: "40px 24px 64px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          minHeight: "100%",
        }}
      >
        {!status.signedIn ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, gap: 16 }}>
            <SignInCard configured={status.configured !== false} onSignedIn={handleSignedIn} />
          </div>
        ) : (
          <>
            {justSignedIn ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "12px 16px",
                  borderRadius: RADII.lg,
                  background: `color-mix(in srgb, ${COLORS.accent} 12%, transparent)`,
                  border: `1px solid ${COLORS.accentBorder}`,
                }}
              >
                <Sparkle size={18} weight="fill" color={COLORS.accent} style={{ flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
                    You're in, {firstName(status.name)}.
                  </div>
                  <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary }}>
                    Here are your machines — connect one to pick up where you left off.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setJustSignedIn(false)}
                  aria-label="Dismiss"
                  style={{ ...outlineButton({ height: 26, width: 26, padding: 0 }), border: "none", background: "transparent" }}
                >
                  <X size={13} weight="bold" />
                </button>
              </div>
            ) : null}

            {/* Identity header */}
            <div style={cardStyle({ display: "flex", alignItems: "center", gap: 14 })}>
              <span style={{ flexShrink: 0 }}>
                {avatarImage ? (
                  <img
                    src={avatarImage}
                    alt=""
                    width={48}
                    height={48}
                    draggable={false}
                    style={{ width: 48, height: 48, borderRadius: "50%", objectFit: "cover", boxShadow: `0 0 0 2px color-mix(in srgb, ${ringTint} 55%, transparent)` }}
                  />
                ) : (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 48,
                      height: 48,
                      borderRadius: "50%",
                      fontFamily: SANS_FONT,
                      fontSize: 17,
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
                <div style={{ fontFamily: SANS_FONT, fontSize: 16, fontWeight: 700, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {status.name ?? status.email ?? "Your ADE account"}
                </div>
                {status.email ? (
                  <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {status.email}
                  </div>
                ) : null}
                {providerCaption ? (
                  <div style={{ marginTop: 4, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>{providerCaption}</div>
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
                  onClick={() => navigate("/settings?tab=general#github-connection")}
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

            <MachinesGlance />

            {/* Quick links to the other Connections surfaces */}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                type="button"
                onClick={() => openConnectionsPanel("mobile")}
                style={{ ...outlineButton({ height: 38, fontSize: 12, flex: 1, justifyContent: "flex-start", padding: "0 14px", gap: 8 }) }}
              >
                <DeviceMobile size={15} weight="regular" />
                Mobile
              </button>
              <button
                type="button"
                onClick={() => openConnectionsPanel("web")}
                style={{ ...outlineButton({ height: 38, fontSize: 12, flex: 1, justifyContent: "flex-start", padding: "0 14px", gap: 8 }) }}
              >
                <Users size={15} weight="regular" />
                Web clients
              </button>
            </div>

            <SessionsCard onSignOut={() => void handleSignOut()} signingOut={signingOut} />
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
