import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  CircleNotch,
  DesktopTower,
  DotsThreeVertical,
  GithubLogo,
  Laptop,
  Question,
  SignOut,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import type {
  AdeAccountLocalMachineIdentity,
  AdeAccountMachineRemovalResult,
  GitHubStatus,
} from "../../../shared/types";
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
import {
  formatMachineEndpoint,
  relativeLastSeenPhrase,
} from "../remoteTargets/remoteMachineModel";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import { openExternalUrl } from "../../lib/openExternal";
import { docs } from "../../onboarding/docsLinks";

const REPO_BRIDGE_DISMISS_KEY = "ade.account.repoBridgeDismissed.v1";
const MACHINES_REFRESH_MS = 30_000;

type AccountBridge = {
  listMachines: () => Promise<AdeAccountMachinesResult>;
  getLocalMachineIdentity: () => Promise<AdeAccountLocalMachineIdentity>;
  removeMachine: (machineKey: string) => Promise<AdeAccountMachineRemovalResult>;
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

function machineRouteHint(machine: AdeAccountMachine): string | null {
  const endpoint = machine.reachableEndpoints[0];
  if (!endpoint) return null;
  // Beginners never need the relay URL; the word is enough.
  if (endpoint.kind === "relay") return "Relay";
  return formatMachineEndpoint(endpoint);
}

function lastSeenLabel(lastSeenAt: number | null): string {
  const phrase = relativeLastSeenPhrase(lastSeenAt);
  return phrase ? `Last seen ${phrase}` : "Never seen";
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
// Confirmation sheet — a calm modal consistent with the settings surface.
// ---------------------------------------------------------------------------

function ConfirmSheet({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "color-mix(in srgb, #000 55%, transparent)",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
      }}
    >
      <div
        style={cardStyle({
          width: 400,
          maxWidth: "100%",
          padding: 0,
          overflow: "hidden",
          background: COLORS.cardBgSolid,
          backdropFilter: "none",
          WebkitBackdropFilter: "none",
          boxShadow: "0 24px 64px -30px rgba(0,0,0,0.82)",
        })}
      >
        <div style={{ padding: "18px 20px 4px" }}>
          <div style={{ fontFamily: SANS_FONT, fontSize: 15, fontWeight: 700, color: COLORS.textPrimary }}>
            {title}
          </div>
          <div style={{ marginTop: 8, fontFamily: SANS_FONT, fontSize: 13, lineHeight: 1.55, color: COLORS.textSecondary }}>
            {body}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "16px 20px 18px" }}>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            style={outlineButton({ height: 34, fontSize: 12.5, padding: "0 14px", opacity: busy ? 0.6 : 1 })}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            autoFocus
            onClick={onConfirm}
            style={(danger ? dangerButton : primaryButton)({
              height: 34,
              fontSize: 12.5,
              padding: "0 16px",
              opacity: busy ? 0.6 : 1,
              cursor: busy ? "not-allowed" : "pointer",
            })}
          >
            {busy ? <CircleNotch size={14} weight="bold" className="animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signed-out: the rich sign-in card.
// ---------------------------------------------------------------------------

export function SignInCard({
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
            Sign in to ADE
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
            <span>Account sign-in isn't available in this build.</span>
          </div>
        ) : null}

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
            Sign in or create account
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
// Signed-in: Your Macs — the account directory, this Mac pinned first.
// ---------------------------------------------------------------------------

function YourMacsCard() {
  const [result, setResult] = useState<AdeAccountMachinesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [localIdentity, setLocalIdentity] = useState<AdeAccountLocalMachineIdentity | null>(null);
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<AdeAccountMachine | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = accountBridge();
    if (!api?.listMachines) {
      setResult({ state: "unavailable", machines: [], message: null });
      setLoading(false);
      return;
    }
    try {
      setResult(await api.listMachines());
    } catch {
      setResult({ state: "unavailable", machines: [], message: null });
    } finally {
      setLoading(false);
    }
  }, []);

  // Identify this Mac once so it can be pinned and shielded from removal.
  useEffect(() => {
    let cancelled = false;
    const api = accountBridge();
    void api
      ?.getLocalMachineIdentity?.()
      .then((identity) => {
        if (!cancelled) setLocalIdentity(identity);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Load now, then keep fresh while visible and on window focus.
  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), MACHINES_REFRESH_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const isThisMac = useCallback(
    (machine: AdeAccountMachine): boolean => {
      if (!localIdentity) return false;
      if (machine.machineKey === localIdentity.machineKey) return true;
      return Boolean(machine.deviceId) && machine.deviceId === localIdentity.deviceId;
    },
    [localIdentity],
  );

  const machines = useMemo(() => {
    const list = [...(result?.machines ?? [])];
    // Pin this Mac first; keep directory order otherwise.
    return list.sort((a, b) => (isThisMac(b) ? 1 : 0) - (isThisMac(a) ? 1 : 0));
  }, [result?.machines, isThisMac]);

  const onlineCount = machines.filter((m) => m.online).length;

  let summary: string;
  if (loading && !result) summary = "Checking your Macs…";
  else if (result?.state === "ok") {
    summary =
      machines.length === 0
        ? "No Macs connected yet"
        : `${onlineCount} online · ${machines.length} connected`;
  } else if (result?.state === "not_configured") {
    summary = "The account directory isn't set up yet";
  } else if (result?.state === "signed_out") {
    summary = "Sign in to see your Macs";
  } else {
    summary = "Can't reach the account directory";
  }

  const confirmRemoval = useCallback(async () => {
    const target = pendingRemoval;
    const api = accountBridge();
    if (!target || !api?.removeMachine) {
      setPendingRemoval(null);
      return;
    }
    setRemoving(true);
    setRemoveError(null);
    try {
      await api.removeMachine(target.machineKey);
      setPendingRemoval(null);
      await load();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Couldn't remove that Mac from your account.");
    } finally {
      setRemoving(false);
    }
  }, [pendingRemoval, load]);

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
              Your Macs
            </div>
            <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>{summary}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => openConnectionsPanel("machines")}
          style={outlineButton({ height: 30, fontSize: 12, padding: "0 12px" })}
        >
          Manage connections
          <ArrowRight size={13} weight="bold" />
        </button>
      </div>

      {result?.state === "ok" && machines.length > 0 ? (
        <div style={{ borderTop: `1px solid ${COLORS.borderMuted}` }}>
          {machines.map((machine) => {
            const thisMac = isThisMac(machine);
            const menuOpen = openMenuKey === machine.machineKey;
            const rightText = thisMac
              ? null
              : machine.online
                ? machineRouteHint(machine) ?? "Online"
                : lastSeenLabel(machine.lastSeenAt);
            return (
              <div
                key={machine.machineKey}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "11px 18px",
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
                    boxShadow: machine.online
                      ? `0 0 0 3px color-mix(in srgb, ${COLORS.success} 20%, transparent)`
                      : undefined,
                  }}
                />
                <Laptop size={15} weight="regular" color={COLORS.textMuted} style={{ flexShrink: 0 }} />
                <span
                  style={{
                    fontFamily: SANS_FONT,
                    fontSize: 13,
                    color: COLORS.textPrimary,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {machine.name ?? "Unnamed Mac"}
                </span>
                {thisMac ? (
                  <span style={inlineBadge(COLORS.accent, { fontSize: 10, padding: "2px 7px", flexShrink: 0 })}>
                    This Mac
                  </span>
                ) : null}
                <span style={{ flex: 1 }} />
                {rightText ? (
                  <span
                    style={{
                      fontFamily: SANS_FONT,
                      fontSize: 11,
                      color: machine.online ? COLORS.success : COLORS.textMuted,
                      flexShrink: 0,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {rightText}
                  </span>
                ) : null}
                {thisMac ? (
                  <span style={{ width: 26, flexShrink: 0 }} />
                ) : (
                  <span style={{ position: "relative", flexShrink: 0 }}>
                    <button
                      type="button"
                      aria-label={`Options for ${machine.name ?? "this Mac"}`}
                      onClick={() => setOpenMenuKey(menuOpen ? null : machine.machineKey)}
                      style={{
                        ...outlineButton({ height: 26, width: 26, padding: 0 }),
                        border: "none",
                        background: menuOpen ? COLORS.hoverBg : "transparent",
                        color: COLORS.textMuted,
                      }}
                    >
                      <DotsThreeVertical size={16} weight="bold" />
                    </button>
                    {menuOpen ? (
                      <>
                        <div
                          onClick={() => setOpenMenuKey(null)}
                          style={{ position: "fixed", inset: 0, zIndex: 40 }}
                        />
                        <div
                          role="menu"
                          style={{
                            position: "absolute",
                            top: 30,
                            right: 0,
                            zIndex: 41,
                            minWidth: 190,
                            padding: 4,
                            borderRadius: RADII.md,
                            background: COLORS.cardBgSolid,
                            border: `1px solid ${COLORS.outlineBorder}`,
                            boxShadow: "0 18px 44px -24px rgba(0,0,0,0.8)",
                          }}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setOpenMenuKey(null);
                              setRemoveError(null);
                              setPendingRemoval(machine);
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              width: "100%",
                              padding: "8px 10px",
                              borderRadius: RADII.sm,
                              border: "none",
                              background: "transparent",
                              color: COLORS.danger,
                              fontFamily: SANS_FONT,
                              fontSize: 12.5,
                              textAlign: "left",
                              cursor: "pointer",
                            }}
                          >
                            Remove from account…
                          </button>
                        </div>
                      </>
                    ) : null}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {removeError ? (
        <div
          style={{
            borderTop: `1px solid ${COLORS.borderMuted}`,
            padding: "10px 18px",
            fontFamily: SANS_FONT,
            fontSize: 12,
            color: COLORS.danger,
            lineHeight: 1.5,
          }}
        >
          {removeError}
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
              ? "Your Macs still connect from Connections — the shared directory just isn't live yet."
              : "Your Macs still connect from Connections while the directory reconnects."}
          </span>
          {result.state === "unavailable" ? (
            <button
              type="button"
              onClick={() => void load()}
              style={outlineButton({ height: 28, fontSize: 11, padding: "0 10px" })}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {pendingRemoval ? (
        <ConfirmSheet
          title="Remove this Mac from your account?"
          body={`${pendingRemoval.name ?? "This Mac"} will no longer connect through your account. You can add it back by signing in to ADE on that Mac.`}
          confirmLabel="Remove"
          danger
          busy={removing}
          onConfirm={() => void confirmRemoval()}
          onCancel={() => {
            if (!removing) setPendingRemoval(null);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signed-in: sign-out card (honest single-Mac scope, behind a confirmation).
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
          <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textPrimary }}>Signed in on this Mac</div>
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
          body="Signing out removes this Mac's access to your account and its account-connected machines. Devices paired directly with a code stay connected."
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
              <SignInCard configured={status.configured !== false} onSignedIn={handleSignedIn} />
            </div>
          </>
        ) : (
          <>
            {backButton}

            {/* Identity header */}
            <div style={cardStyle({ display: "flex", alignItems: "center", gap: 16 })}>
              <span style={{ flexShrink: 0 }}>
                {avatarImage ? (
                  <img
                    src={avatarImage}
                    alt=""
                    width={52}
                    height={52}
                    draggable={false}
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
