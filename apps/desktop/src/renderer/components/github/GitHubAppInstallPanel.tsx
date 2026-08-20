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
  describeGithubAccountAxis,
  deviceAuthErrorCopy,
  deviceAuthMessageCopy,
  githubRepoIssueCopy,
  isGithubRateLimitMessage,
  isGithubAppUserAuthSupported,
  isGithubRealtimeHealthy,
  isGithubRepoAccessPending,
  type GithubAccountAuthState,
  type GithubAccountAxisTone,
} from "../../lib/githubIntegrationStatus";
import { useGithubAppUserAuth } from "../../lib/useGithubAppUserAuth";
import { isGithubServiceUnavailable } from "../../../shared/githubServiceHealth";

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
  // Shared with the Settings connection ladder, so disconnecting here updates
  // the badge there instead of leaving it reporting a removed authorization.
  const { appAuth, refresh: refreshAppAuth, set: setAppAuth } = useGithubAppUserAuth();
  const [deviceSession, setDeviceSession] = useState<GitHubAppDeviceAuthStartResult | null>(null);
  const [deviceMessage, setDeviceMessage] = useState<string | null>(null);
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
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
        // The call itself failed, so nothing was learned about the account.
        appUserAuthFailure: null,
      });
    } finally {
      const isCurrentRequest = () => mountedRef.current && statusRequestSeqRef.current === requestSeq;
      // Read auth state AFTER the status call (success or failure): an
      // expired stored token can be cleared during the status check, and the
      // panel must reflect that immediately.
      if (isCurrentRequest()) {
        // Forced: this read has to have started after the status call, or it
        // joins one from before it and reports the credential that check
        // replaced.
        await refreshAppAuth({ force: true });
        if (isCurrentRequest()) {
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
  }, [refreshAppAuth]);

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
      setDeviceMessage(deviceAuthErrorCopy(error));
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const disconnectAppAuthorization = useCallback(async () => {
    if (!window.ade?.github?.clearAppUserAuth) return;
    setDisconnecting(true);
    try {
      const next = await window.ade.github.clearAppUserAuth();
      setAppAuth(next ?? null);
      setDeviceSession(null);
      setDeviceMessage("ADE's GitHub authorization was removed on this machine.");
    } catch (error) {
      setDeviceMessage(deviceAuthErrorCopy(error));
    } finally {
      setDisconnecting(false);
      setDisconnectArmed(false);
    }
  }, [setAppAuth]);

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
          message: deviceAuthErrorCopy(error),
          authStatus: appAuthRef.current,
        };
      }
      if (cancelled || !result) return;
      setAppAuth(result.authStatus);
      if (result.status === "pending" || result.status === "slow_down") {
        setDeviceMessage(deviceAuthMessageCopy(result.message));
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
          setDeviceMessage(deviceAuthErrorCopy(error));
        }
        return;
      }
      setDeviceSession(null);
      setDeviceMessage(deviceAuthMessageCopy(result.message));
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
  }, [deviceSession, loadStatus, setAppAuth]);

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
  const repoState = deriveGithubRepoConnectionState(status, accountState);
  const appAuthorized = accountState === "valid";
  const repoLabel = status?.repo ? `${status.repo.owner}/${status.repo.name}` : null;
  const healthy = isGithubRealtimeHealthy(accountState, repoState);
  // `appAuth === null` = not fetched yet (distinct from a fetched "no token").
  const accountChecking = appAuth === null && loading;

  const secondaryBtnStyle = outlineButton(compact ? compactSecondaryButtonStyle : undefined);
  const primaryBtnStyle = primaryButton(compact ? compactPrimaryButtonStyle : undefined);

  const authBusy = authLoading || Boolean(deviceSession);
  const account = describeGithubAccountAxis(accountChecking ? "checking" : accountState, appAuth);
  // No button in the states ADE recovers from on its own. Offering one while
  // GitHub has the account paused is what sent users back through the device
  // flow against the very endpoint that was refusing them.
  const accountCta = account.cta ? (
    <button
      type="button"
      style={account.cta === "authorize" ? primaryBtnStyle : secondaryBtnStyle}
      onClick={() => void startAppAuthorization()}
      disabled={authBusy}
    >
      <ArrowSquareOut size={12} weight="bold" />
      {authBusy ? "Authorizing" : account.cta === "authorize" ? "Authorize ADE" : "Re-authorize"}
    </button>
  ) : null;

  // Unobtrusive by design: a plain muted control, and only where there is
  // something to disconnect. Two clicks, because clearing the credential stops
  // real-time updates until the user goes through the device flow again.
  const showDisconnect = accountState !== "missing"
    && !accountChecking
    && !deviceSession
    // Hosts without the clear action (older brains) must not show a control
    // that silently does nothing — and neither must the web client, whose stub
    // implements the call but has no credential to clear. Both are judged by
    // one mechanism, so a new stub cannot pass half of the check.
    && typeof window.ade?.github?.clearAppUserAuth === "function"
    && isGithubAppUserAuthSupported(appAuth);
  const disconnectControl = showDisconnect ? (
    disconnectArmed ? (
      <>
        <button
          type="button"
          style={quietButtonStyle}
          onClick={() => setDisconnectArmed(false)}
          disabled={disconnecting}
        >
          Cancel
        </button>
        <button
          type="button"
          style={secondaryBtnStyle}
          onClick={() => void disconnectAppAuthorization()}
          disabled={disconnecting}
        >
          {disconnecting ? "Disconnecting" : "Confirm disconnect"}
        </button>
      </>
    ) : (
      <button type="button" style={quietButtonStyle} onClick={() => setDisconnectArmed(true)}>
        Disconnect
      </button>
    )
  ) : null;

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

  const repo = repoView(repoState, repoLabel, loading, status?.error ?? null, accountState);
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
      // Install and Manage would both be guesses while the account axis is
      // unresolved: ADE has not been able to check the installation at all.
      case "waiting_on_account":
        return [recheckButton(false)];
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
            {renderPill(accountPill(account.tone, account.label))}
          </div>
          <div style={axisBodyRowStyle}>
            <p style={axisSubtextStyle}>{account.subtext}</p>
            {!accountChecking && (accountCta || disconnectControl) ? (
              <div style={axisActionsStyle}>
                {disconnectControl}
                {accountCta}
              </div>
            ) : null}
          </div>
          {account.note ? <p style={authMessageStyle}>{account.note}</p> : null}
          {disconnectArmed ? (
            <p style={authMessageStyle}>
              Disconnecting removes ADE's GitHub authorization on this machine. Real-time pull request updates stop until you authorize again.
            </p>
          ) : null}

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

/** One color per tone, shared with the Settings ladder so the two agree. */
export const PILL_TONE_COLORS: Record<GithubAccountAxisTone, string> = {
  ok: COLORS.success,
  warn: COLORS.warning,
  pending: COLORS.textMuted,
  neutral: COLORS.textMuted,
};

function accountPill(tone: GithubAccountAxisTone, label: string): PillSpec {
  return { tone, color: PILL_TONE_COLORS[tone], label };
}

function repoView(
  state: ReturnType<typeof deriveGithubRepoConnectionState>,
  repoLabel: string | null,
  loading: boolean,
  error: string | null,
  account: GithubAccountAuthState,
): { pill: PillSpec; subtext: string } {
  switch (state) {
    case "waiting_on_account":
      return {
        pill: { tone: "neutral", color: COLORS.textMuted, label: "Waiting on authorization" },
        subtext: githubRepoIssueCopy("waiting_on_account", repoLabel, account).detail,
      };
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
      // GitHub answered with a server error, so the install state is unknown
      // rather than broken. Say so instead of implying ADE's setup failed.
      if (isGithubServiceUnavailable({ message: error })) {
        return {
          pill: { tone: "neutral", color: COLORS.textMuted, label: "Waiting on GitHub" },
          subtext: "GitHub returned a server error, so ADE couldn't check this repo. Nothing to fix here — it will recheck once GitHub recovers.",
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

// Deliberately quieter than the outline buttons beside it: disconnecting is a
// rare, destructive action and must not compete with the primary control.
const quietButtonStyle: CSSProperties = {
  height: 28,
  padding: "0 8px",
  border: "none",
  background: "transparent",
  color: COLORS.textMuted,
  fontFamily: SANS_FONT,
  fontSize: 11,
  cursor: "pointer",
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
