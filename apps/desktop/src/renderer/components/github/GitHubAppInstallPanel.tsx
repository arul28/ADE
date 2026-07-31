import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type {
  GitHubAppDeviceAuthPollResult,
  GitHubAppDeviceAuthStartResult,
  GitHubAppInstallationStatus,
  GitHubAppUserAuthStatus,
} from "../../../shared/types";
import { ArrowClockwise, ArrowSquareOut, Check, CheckCircle, Copy, WarningCircle, WebhooksLogo } from "@phosphor-icons/react";
import { openExternalUrl } from "../../lib/openExternal";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, inlineBadge, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import {
  deriveGithubAccountAuthState,
  deriveGithubRepoConnectionState,
  githubAccountIssueCopy,
  githubRepoIssueCopy,
  isGithubRateLimitMessage,
  isGithubRealtimeHealthy,
  isGithubRepoAccessPending,
} from "../../lib/githubIntegrationStatus";

const ADE_GITHUB_APP_NAME = "ADE";
const ADE_GITHUB_APP_INSTALL_URL = "https://github.com/apps/ade-for-github/installations/new";
const GITHUB_APP_INSTALLATIONS_URL = "https://github.com/settings/installations";
const POST_AUTH_STATUS_RETRY_DELAYS_MS = [1_500, 3_000, 6_000] as const;
const SPIN_STYLE: CSSProperties = { animation: "ade-icon-spin 1s linear infinite" };

type GitHubAppInstallPanelProps = {
  variant?: "settings" | "onboarding";
};

export function GitHubAppInstallPanel({ variant = "settings" }: GitHubAppInstallPanelProps) {
  const compact = variant === "onboarding";
  const [status, setStatus] = useState<GitHubAppInstallationStatus | null>(null);
  const [appAuth, setAppAuth] = useState<GitHubAppUserAuthStatus | null>(null);
  const [deviceSession, setDeviceSession] = useState<GitHubAppDeviceAuthStartResult | null>(null);
  const [deviceMessage, setDeviceMessage] = useState<string | null>(null);
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const autoRenewCountRef = useRef(0);
  const copyFeedbackTimeoutRef = useRef<number | null>(null);
  const appAuthRef = useRef<GitHubAppUserAuthStatus | null>(null);
  const statusRequestSeqRef = useRef(0);
  const mountedRef = useRef(true);
  appAuthRef.current = appAuth;

  const loadStatus = useCallback(async (forceRefresh = false, opts: { retryAfterAuthorization?: boolean } = {}) => {
    if (!window.ade?.github?.getAppInstallationStatus) return;
    const requestSeq = statusRequestSeqRef.current + 1;
    statusRequestSeqRef.current = requestSeq;
    setLoading(true);
    let latestStatus: GitHubAppInstallationStatus | null = null;
    try {
      const attemptCount = opts.retryAfterAuthorization
        ? POST_AUTH_STATUS_RETRY_DELAYS_MS.length + 1
        : 1;
      for (let attempt = 0; attempt < attemptCount; attempt += 1) {
        latestStatus = await window.ade.github.getAppInstallationStatus({
          forceRefresh: forceRefresh || attempt > 0,
        });
        if (!mountedRef.current || statusRequestSeqRef.current !== requestSeq) return;
        setStatus(latestStatus);
        if (!opts.retryAfterAuthorization || !isGithubRepoAccessPending(latestStatus)) break;
        const retryDelay = POST_AUTH_STATUS_RETRY_DELAYS_MS[attempt];
        if (retryDelay == null) break;
        setDeviceMessage("GitHub authorization is complete. Waiting for repository access to appear...");
        await sleepMs(retryDelay);
        if (!mountedRef.current || statusRequestSeqRef.current !== requestSeq) return;
      }
    } catch (error) {
      if (!mountedRef.current || statusRequestSeqRef.current !== requestSeq) return;
      setStatus({
        repo: null,
        appName: ADE_GITHUB_APP_NAME,
        appSlug: "ade-for-github",
        installUrl: ADE_GITHUB_APP_INSTALL_URL,
        manageUrl: GITHUB_APP_INSTALLATIONS_URL,
        relayConfigured: false,
        installed: false,
        state: "error",
        installationId: null,
        repositorySelection: null,
        lastSeenAt: null,
        webhookEvents: [],
        missingWebhookEvents: [],
        webhookState: "unknown",
        webhookLastSeenAt: null,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      const isCurrentRequest = () => mountedRef.current && statusRequestSeqRef.current === requestSeq;
      // Read auth state AFTER the status call (success or failure): an
      // expired stored token can be cleared during the status check, and the
      // panel must reflect that immediately.
      if (isCurrentRequest()) {
        const authStatus = await window.ade.github.getAppUserAuthStatus?.().catch(() => null);
        if (isCurrentRequest()) {
          setAppAuth(authStatus ?? null);
          if (opts.retryAfterAuthorization) {
            setDeviceMessage(
              latestStatus && isGithubRepoAccessPending(latestStatus)
                ? "GitHub authorization is complete. Repository access is still warming up; use Recheck again in a moment."
                : null,
            );
          }
          setLoading(false);
        }
      }
    }
  }, []);

  const startAppAuthorization = useCallback(async () => {
    autoRenewCountRef.current = 0;
    if (!window.ade?.github?.startAppUserDeviceAuth) return;
    setAuthLoading(true);
    setDeviceMessage(null);
    setDeviceCodeCopied(false);
    try {
      const session = await window.ade.github.startAppUserDeviceAuth();
      setDeviceSession(session);
      openExternalUrl(session.verificationUriComplete ?? session.verificationUri);
    } catch (error) {
      setDeviceMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const copyDeviceCode = useCallback(async () => {
    if (!deviceSession) return;
    try {
      await navigator.clipboard.writeText(deviceSession.userCode);
      setDeviceCodeCopied(true);
      if (copyFeedbackTimeoutRef.current != null) {
        window.clearTimeout(copyFeedbackTimeoutRef.current);
      }
      copyFeedbackTimeoutRef.current = window.setTimeout(() => {
        setDeviceCodeCopied(false);
        copyFeedbackTimeoutRef.current = null;
      }, 1500);
    } catch (error) {
      setDeviceMessage(error instanceof Error ? error.message : String(error));
    }
  }, [deviceSession]);

  useEffect(() => {
    if (!deviceSession || !window.ade?.github?.pollAppUserDeviceAuth) return;
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      let result: GitHubAppDeviceAuthPollResult | null = null;
      try {
        result = await window.ade.github.pollAppUserDeviceAuth({ sessionId: deviceSession.sessionId });
      } catch (error) {
        result = {
          status: "error",
          intervalSec: null,
          message: error instanceof Error ? error.message : String(error),
          authStatus: appAuthRef.current,
        };
      }
      if (cancelled || !result) return;
      setAppAuth(result.authStatus);
      if (result.status === "pending" || result.status === "slow_down") {
        setDeviceMessage(result.message);
        setDeviceSession({ ...deviceSession, intervalSec: result.intervalSec ?? deviceSession.intervalSec });
        return;
      }
      if (result.status === "expired") {
        if (autoRenewCountRef.current >= 3 || !window.ade?.github?.startAppUserDeviceAuth) {
          setDeviceSession(null);
          setDeviceMessage("Code expired. Click Authorize ADE to get a new code.");
          return;
        }
        try {
          const nextSession = await window.ade.github.startAppUserDeviceAuth();
          if (cancelled) return;
          autoRenewCountRef.current += 1;
          setDeviceSession(nextSession);
          setDeviceMessage("Previous code expired — use this new code.");
        } catch (error) {
          if (cancelled) return;
          setDeviceSession(null);
          setDeviceMessage(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      setDeviceSession(null);
      setDeviceMessage(result.message);
      if (result.status === "authorized") {
        autoRenewCountRef.current = 0;
        setDeviceMessage("GitHub authorization is complete. Checking repository access...");
        await loadStatus(true, { retryAfterAuthorization: true });
        // Post-fix auto-heal: now that the App is authorized, kick a one-shot
        // reconcile so this project's PR badges light up without a manual refresh.
        // Swallow rejections (e.g. a project transition tearing down the runtime)
        // so this fire-and-forget can never surface as an unhandled rejection.
        void window.ade?.prs?.reconcileNow?.().catch(() => {});
      }
    }, Math.max(1, deviceSession.intervalSec) * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [deviceSession, loadStatus]);

  useEffect(() => {
    setDeviceCodeCopied(false);
  }, [deviceSession?.sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      statusRequestSeqRef.current += 1;
      if (copyFeedbackTimeoutRef.current != null) {
        window.clearTimeout(copyFeedbackTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    void loadStatus(false);
  }, [loadStatus]);

  // Two independent axes, derived by the shared helper so Settings and the
  // banner can never disagree.
  const accountState = deriveGithubAccountAuthState(appAuth);
  const repoState = deriveGithubRepoConnectionState(status);
  const appAuthorized = accountState !== "missing";
  const repoLabel = status?.repo ? `${status.repo.owner}/${status.repo.name}` : null;
  const healthy = isGithubRealtimeHealthy(accountState, repoState);
  // `appAuth === null` = not fetched yet (distinct from a fetched "no token").
  const accountChecking = appAuth === null && loading;

  const secondaryBtnStyle = outlineButton(compact ? compactSecondaryButtonStyle : undefined);
  const primaryBtnStyle = primaryButton(compact ? compactPrimaryButtonStyle : undefined);

  const authBusy = authLoading || Boolean(deviceSession);
  const accountCta = (
    <button
      type="button"
      style={accountState === "missing" ? primaryBtnStyle : secondaryBtnStyle}
      onClick={() => void startAppAuthorization()}
      disabled={authBusy}
    >
      <ArrowSquareOut size={12} weight="bold" />
      {authBusy ? "Authorizing" : accountState === "missing" ? "Authorize ADE" : "Re-authorize"}
    </button>
  );

  const account = accountView(accountState, appAuth, accountChecking);

  const recheckButton = (primaryStyle: boolean) => (
    <button
      type="button"
      style={primaryStyle ? primaryBtnStyle : secondaryBtnStyle}
      onClick={() => void loadStatus(true, { retryAfterAuthorization: appAuthorized })}
      disabled={loading}
    >
      <ArrowClockwise size={12} weight="bold" style={loading ? SPIN_STYLE : undefined} />
      {loading ? "Checking" : "Recheck"}
    </button>
  );
  const installButton = (
    <button type="button" style={primaryBtnStyle} onClick={() => openExternalUrl(status?.installUrl ?? ADE_GITHUB_APP_INSTALL_URL)}>
      <ArrowSquareOut size={12} weight="bold" />
      Install
    </button>
  );
  const manageButton = (
    <button type="button" style={secondaryBtnStyle} onClick={() => openExternalUrl(status?.manageUrl ?? GITHUB_APP_INSTALLATIONS_URL)}>
      Manage
    </button>
  );

  const repo = repoView(repoState, repoLabel, loading, status?.error ?? null);
  const repoActions: ReactNode[] = (() => {
    switch (repoState) {
      case "connected":
        return [manageButton, recheckButton(false)];
      case "webhook_off":
        return [manageButton, recheckButton(false)];
      case "not_installed":
        return [installButton, manageButton, recheckButton(false)];
      case "access_pending":
        return [recheckButton(true)];
      case "no_repo":
        return [recheckButton(false)];
      default:
        return [manageButton, recheckButton(false)];
    }
  })();

  const showWebhookEvents = repoState === "connected" && (status?.webhookEvents.length ?? 0) > 0;

  return (
    <div
      style={
        compact
          ? onboardingRootStyle
          : cardStyle({
              borderColor: healthy
                ? "color-mix(in srgb, var(--color-success) 26%, transparent)"
                : "color-mix(in srgb, var(--color-border) 88%, transparent)",
            })
      }
    >
      <div style={compact ? compactHeaderStyle : headerStyle}>
        <div style={iconStyle(compact)}>
          <WebhooksLogo size={compact ? 15 : 18} weight="duotone" />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <span style={titleStyle}>ADE for GitHub</span>
          <p style={descriptionStyle}>Webhook-backed, real-time pull request updates — independent of your account token.</p>
        </div>
      </div>

      <div style={blocksWrapStyle(compact)}>
        <section style={axisBlockStyle}>
          <div style={axisTopRowStyle}>
            <span style={axisHeadingStyle}>Account · ADE for GitHub</span>
            {renderPill(account.pill)}
          </div>
          <div style={axisBodyRowStyle}>
            <p style={axisSubtextStyle}>{account.subtext}</p>
            {!accountChecking ? <div style={axisActionsStyle}>{accountCta}</div> : null}
          </div>

          {deviceSession ? (
            <div style={deviceAuthBlockStyle}>
              <p style={deviceInstructionStyle}>
                Enter this code at{" "}
                <button type="button" style={deviceLinkButtonStyle} onClick={() => openExternalUrl(deviceSession.verificationUri)}>
                  github.com/login/device
                </button>
              </p>
              <button type="button" style={deviceCodeStyle} onClick={() => void copyDeviceCode()}>
                <span style={deviceLabelStyle}>GitHub code</span>
                <span style={deviceValueStyle}>{deviceSession.userCode}</span>
                <span style={deviceCopyIconStyle} aria-hidden="true">
                  {deviceCodeCopied ? <Check size={12} weight="bold" /> : <Copy size={12} weight="bold" />}
                </span>
              </button>
              {deviceMessage ? null : <p style={authMessageStyle}>Waiting for GitHub authorization…</p>}
            </div>
          ) : null}
          {deviceMessage ? <p style={authMessageStyle}>{deviceMessage}</p> : null}
          {accountState === "missing" && !deviceSession && !accountChecking ? (
            <p style={authMessageStyle}>One-time GitHub sign-off that lets ADE verify your repo access for instant PR updates.</p>
          ) : null}
        </section>

        <div style={axisDividerStyle} />

        <section style={axisBlockStyle}>
          <div style={axisTopRowStyle}>
            <span style={axisHeadingStyle}>{repoLabel ? `This repo · ${repoLabel}` : "This repo"}</span>
            {renderPill(repo.pill)}
          </div>
          <div style={axisBodyRowStyle}>
            <p style={axisSubtextStyle}>{repo.subtext}</p>
            <div style={axisActionsStyle}>
              {repoActions.map((action, index) => (
                <span key={index} style={{ display: "inline-flex" }}>
                  {action}
                </span>
              ))}
            </div>
          </div>

          {showWebhookEvents ? (
            <div style={eventChipRowStyle}>
              {status!.webhookEvents.map((event) => (
                <span key={event} style={eventChipStyle}>
                  {event}
                </span>
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

// --- Presentational derivations for the two axis blocks ---

type PillTone = "ok" | "warn" | "pending" | "neutral";
type PillSpec = { tone: PillTone; color: string; label: string };

function renderPill({ tone, color, label }: PillSpec): ReactNode {
  const icon =
    tone === "ok" ? (
      <CheckCircle size={11} weight="fill" />
    ) : tone === "warn" ? (
      <WarningCircle size={11} weight="fill" />
    ) : tone === "pending" ? (
      <ArrowClockwise size={11} weight="bold" style={SPIN_STYLE} />
    ) : (
      <span style={neutralDotStyle} />
    );
  return (
    <span style={inlineBadge(color, { fontSize: 10.5, padding: "3px 8px", gap: 5, flexShrink: 0, whiteSpace: "nowrap" })}>
      {icon}
      {label}
    </span>
  );
}

function accountView(
  state: ReturnType<typeof deriveGithubAccountAuthState>,
  appAuth: GitHubAppUserAuthStatus | null,
  checking: boolean,
): { pill: PillSpec; subtext: string } {
  if (checking) {
    return {
      pill: { tone: "pending", color: COLORS.textMuted, label: "Checking…" },
      subtext: "Checking your GitHub authorization…",
    };
  }
  if (state === "valid") {
    const who = appAuth?.userLogin ?? "GitHub account";
    const expiry = formatExpiry(appAuth?.expiresAt ?? null);
    return {
      pill: { tone: "ok", color: COLORS.success, label: "Authorized" },
      subtext: expiry ? `${who} · token valid to ${expiry}` : `${who} · token valid`,
    };
  }
  if (state === "expired") {
    return {
      pill: { tone: "warn", color: COLORS.warning, label: "Authorization expired" },
      subtext: githubAccountIssueCopy("expired").detail,
    };
  }
  return {
    pill: { tone: "neutral", color: COLORS.textMuted, label: "Not authorized" },
    subtext: githubAccountIssueCopy("missing").detail,
  };
}

function repoView(
  state: ReturnType<typeof deriveGithubRepoConnectionState>,
  repoLabel: string | null,
  loading: boolean,
  error: string | null,
): { pill: PillSpec; subtext: string } {
  switch (state) {
    case "connected":
      return {
        pill: { tone: "ok", color: COLORS.success, label: "Connected" },
        subtext: "Real-time PR updates are on.",
      };
    case "webhook_off":
      return {
        pill: { tone: "warn", color: COLORS.warning, label: "Webhook off" },
        subtext: githubRepoIssueCopy("webhook_off", repoLabel).detail,
      };
    case "not_installed":
      return {
        pill: { tone: "warn", color: COLORS.warning, label: "Not connected" },
        subtext: githubRepoIssueCopy("not_installed", repoLabel).detail,
      };
    case "access_pending":
      return {
        pill: { tone: "pending", color: COLORS.warning, label: "Finishing setup" },
        subtext: githubRepoIssueCopy("access_pending", repoLabel).detail,
      };
    case "no_repo":
      return {
        pill: { tone: "neutral", color: COLORS.textMuted, label: "No GitHub repo detected" },
        subtext: "Add a GitHub remote to this project to turn on real-time PR updates.",
      };
    default:
      if (loading) {
        return {
          pill: { tone: "pending", color: COLORS.textMuted, label: "Checking…" },
          subtext: "Checking whether ADE for GitHub is installed on this repo…",
        };
      }
      if (isGithubRateLimitMessage(error)) {
        return {
          pill: { tone: "warn", color: COLORS.warning, label: "Rate limited" },
          subtext: "GitHub temporarily paused automatic App checks. Wait for the cooldown, then recheck.",
        };
      }
      return {
        pill: { tone: "neutral", color: COLORS.textMuted, label: "Couldn't verify" },
        subtext: error?.trim()
          ? error
          : "ADE couldn't confirm the app status for this repo. Recheck in a moment.",
      };
  }
}

function formatExpiry(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const onboardingRootStyle: CSSProperties = {
  marginTop: 14,
  paddingTop: 14,
  borderTop: `1px solid ${COLORS.borderMuted}`,
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
};

const compactHeaderStyle: CSSProperties = {
  ...headerStyle,
  gap: 10,
};

function iconStyle(compact: boolean): CSSProperties {
  return {
    width: compact ? 28 : 34,
    height: compact ? 28 : 34,
    borderRadius: 8,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    color: "#3FB950",
    background: "color-mix(in srgb, #3FB950 16%, transparent)",
    border: "1px solid color-mix(in srgb, #3FB950 32%, transparent)",
  };
}

const titleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
};

const descriptionStyle: CSSProperties = {
  margin: "4px 0 0",
  fontSize: 11.5,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  lineHeight: 1.45,
};

function blocksWrapStyle(compact: boolean): CSSProperties {
  return {
    marginTop: compact ? 12 : 14,
    border: `1px solid ${COLORS.borderMuted}`,
    borderRadius: 10,
    background: "color-mix(in srgb, var(--color-fg) 2.5%, transparent)",
    overflow: "hidden",
  };
}

const axisBlockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  padding: 14,
};

const axisDividerStyle: CSSProperties = {
  height: 1,
  background: COLORS.borderMuted,
};

const axisTopRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
};

const axisHeadingStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const axisBodyRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  marginTop: 6,
};

const axisSubtextStyle: CSSProperties = {
  margin: 0,
  flex: 1,
  minWidth: 0,
  fontSize: 11.5,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  lineHeight: 1.45,
};

const axisActionsStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  flexShrink: 0,
  justifyContent: "flex-end",
};

const neutralDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "currentColor",
  display: "inline-block",
};

const eventChipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginTop: 10,
};

const eventChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 7px",
  borderRadius: 6,
  fontSize: 10,
  fontFamily: SANS_FONT,
  color: COLORS.textSecondary,
  background: "color-mix(in srgb, var(--color-fg) 5%, transparent)",
  border: `1px solid ${COLORS.borderMuted}`,
};

const deviceAuthBlockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
};

const deviceInstructionStyle: CSSProperties = {
  margin: "12px 0 0",
  fontSize: 11,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  lineHeight: 1.35,
};

const deviceLinkButtonStyle: CSSProperties = {
  display: "inline",
  padding: 0,
  border: "none",
  background: "transparent",
  color: COLORS.accent,
  font: "inherit",
  cursor: "pointer",
  textDecoration: "underline",
  textUnderlineOffset: 2,
};

const deviceCodeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  marginTop: 6,
  padding: "6px 8px",
  borderRadius: 6,
  border: `1px solid ${COLORS.borderMuted}`,
  background: "color-mix(in srgb, var(--color-bg-panel) 86%, transparent)",
  cursor: "pointer",
};

const deviceLabelStyle: CSSProperties = {
  fontSize: 10,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
};

const deviceValueStyle: CSSProperties = {
  fontSize: 12,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  letterSpacing: 0,
  fontWeight: 700,
};

const deviceCopyIconStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  color: COLORS.textMuted,
};

const authMessageStyle: CSSProperties = {
  margin: "8px 0 0",
  fontSize: 11,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  lineHeight: 1.35,
};

const compactPrimaryButtonStyle: CSSProperties = {
  height: 28,
  padding: "0 10px",
  fontSize: 11,
};

const compactSecondaryButtonStyle: CSSProperties = {
  height: 28,
  padding: "0 10px",
  fontSize: 11,
};
