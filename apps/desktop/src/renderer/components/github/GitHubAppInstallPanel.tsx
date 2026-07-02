import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  GitHubAppDeviceAuthPollResult,
  GitHubAppDeviceAuthStartResult,
  GitHubAppInstallationStatus,
  GitHubAppUserAuthStatus,
} from "../../../shared/types";
import { ArrowClockwise, ArrowSquareOut, Check, CheckCircle, Copy, WarningCircle, WebhooksLogo } from "@phosphor-icons/react";
import { openExternalUrl } from "../../lib/openExternal";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, inlineBadge, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

const ADE_GITHUB_APP_NAME = "ADE";
const ADE_GITHUB_APP_INSTALL_URL = "https://github.com/apps/ade-for-github/installations/new";
const GITHUB_APP_INSTALLATIONS_URL = "https://github.com/settings/installations";

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
  appAuthRef.current = appAuth;

  const loadStatus = useCallback(async (forceRefresh = false) => {
    if (!window.ade?.github?.getAppInstallationStatus) return;
    setLoading(true);
    try {
      const authStatus = await window.ade.github.getAppUserAuthStatus?.().catch(() => null);
      setAppAuth(authStatus ?? null);
      setStatus(await window.ade.github.getAppInstallationStatus({ forceRefresh }));
    } catch (error) {
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
      setLoading(false);
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
        await loadStatus(true);
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
    return () => {
      if (copyFeedbackTimeoutRef.current != null) {
        window.clearTimeout(copyFeedbackTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    void loadStatus(false);
  }, [loadStatus]);

  const appAuthorized = appAuth?.tokenStored === true;
  const view = statusView(status, loading, appAuthorized);
  const repoLabel = status?.repo ? `${status.repo.owner}/${status.repo.name}` : null;

  return (
    <div style={compact ? onboardingRootStyle : cardStyle({ borderColor: "color-mix(in srgb, #3FB950 26%, transparent)" })}>
      <div style={compact ? compactHeaderStyle : headerStyle}>
        <div style={iconStyle(compact)}>
          <WebhooksLogo size={compact ? 15 : 18} weight="duotone" />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={titleRowStyle}>
            <span style={titleStyle}>{ADE_GITHUB_APP_NAME}</span>
            {!compact ? <span style={inlineBadge(view.color, { fontSize: 10, padding: "2px 7px" })}>{view.label}</span> : null}
          </div>
          <p style={descriptionStyle}>{view.description(repoLabel)}</p>
        </div>
      </div>

      <div style={chipRowStyle}>
        {["Pull requests", "Checks", "Statuses"].map((label) => (
          <span key={label} style={chipStyle}>
            <CheckCircle size={11} weight="fill" />
            {label}
          </span>
        ))}
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

      {!appAuthorized && !deviceSession ? <p style={authMessageStyle}>One-time GitHub sign-off that lets ADE verify your repo access for instant PR updates.</p> : null}

      <div style={actionRowStyle}>
        {!appAuthorized ? (
          <button
            type="button"
            style={primaryButton(compact ? compactPrimaryButtonStyle : undefined)}
            onClick={() => void startAppAuthorization()}
            disabled={authLoading || Boolean(deviceSession)}
          >
            <ArrowSquareOut size={12} weight="bold" />
            {authLoading || deviceSession ? "Authorizing" : "Authorize ADE"}
          </button>
        ) : null}
        {status?.installed ? null : (
          <button
            type="button"
            style={appAuthorized ? primaryButton(compact ? compactPrimaryButtonStyle : undefined) : outlineButton(compact ? compactSecondaryButtonStyle : undefined)}
            onClick={() => openExternalUrl(status?.installUrl ?? ADE_GITHUB_APP_INSTALL_URL)}
          >
            <ArrowSquareOut size={12} weight="bold" />
            Install app
          </button>
        )}
        <button
          type="button"
          style={outlineButton(compact ? compactSecondaryButtonStyle : undefined)}
          onClick={() => openExternalUrl(status?.manageUrl ?? GITHUB_APP_INSTALLATIONS_URL)}
        >
          Manage
        </button>
        <button
          type="button"
          style={outlineButton(compact ? compactSecondaryButtonStyle : undefined)}
          onClick={() => void loadStatus(true)}
          disabled={loading}
        >
          {loading ? <WarningCircle size={12} weight="bold" /> : <ArrowClockwise size={12} weight="bold" />}
          {loading ? "Checking" : "Refresh"}
        </button>
      </div>
    </div>
  );
}

function statusView(status: GitHubAppInstallationStatus | null, loading: boolean, appAuthorized: boolean): {
  label: string;
  color: string;
  description: (repoLabel: string | null) => string;
} {
  if (loading && !status) {
    return {
      label: "Checking",
      color: COLORS.warning,
      description: () => "Checking whether this project already has the ADE GitHub App installed.",
    };
  }
  if (status?.relayConfigured && status.webhookState === "deleted") {
    return {
      label: "Webhook off",
      color: COLORS.warning,
      description: (repoLabel) =>
        repoLabel
          ? `GitHub reported that the ADE App webhook was removed for this App. Re-enable the webhook in GitHub App settings so ${repoLabel} can receive realtime PR updates. Existing GitHub auth remains the fallback.`
          : "GitHub reported that the ADE App webhook was removed. Re-enable the webhook in GitHub App settings for realtime PR updates. Existing GitHub auth remains the fallback.",
    };
  }
  if (status?.installed && status.relayConfigured) {
    return {
      label: "Configured",
      color: COLORS.success,
      description: (repoLabel) =>
        repoLabel
          ? `The ADE GitHub App is installed for ${repoLabel}. PR updates can arrive instantly, with GitHub polling as fallback.`
          : "The ADE GitHub App is installed. PR updates can arrive instantly, with GitHub polling as fallback.",
    };
  }
  if (status?.installed && !status.relayConfigured) {
    return {
      label: "Installed",
      color: COLORS.warning,
      description: (repoLabel) =>
        repoLabel
          ? `The ADE GitHub App is installed for ${repoLabel}. ADE will use GitHub polling until realtime delivery is available.`
          : "The ADE GitHub App is installed. ADE will use GitHub polling until realtime delivery is available.",
    };
  }
  if (status?.state === "unconfigured" || (status && !status.relayConfigured && status.state !== "error")) {
    return {
      label: "Checking",
      color: COLORS.warning,
      description: () => "ADE could not confirm realtime delivery yet. GitHub polling remains available as fallback.",
    };
  }
  if (status?.state === "error") {
    if (!appAuthorized) {
      return {
        label: "Authorize GitHub",
        color: COLORS.warning,
        description: () => "Authorize ADE with GitHub to enable instant PR updates for this repo.",
      };
    }
    return {
      label: "Check failed",
      color: COLORS.danger,
      description: () => status.error ?? "ADE could not check GitHub App status. Existing GitHub auth remains the fallback.",
    };
  }
  return {
    label: "Not installed",
    color: COLORS.warning,
    description: (repoLabel) =>
      repoLabel
        ? `Install the ADE GitHub App for ${repoLabel} to enable instant PR updates. If the App is installed for selected repositories, make sure this repo is selected.`
        : "Install the ADE GitHub App for instant PR updates. If the App is installed for selected repositories, make sure this repo is selected.",
  };
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

const titleRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const titleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
};

const descriptionStyle: CSSProperties = {
  margin: "5px 0 0",
  fontSize: 11.5,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  lineHeight: 1.45,
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginTop: 12,
};

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "3px 7px",
  borderRadius: 6,
  fontSize: 10,
  fontFamily: MONO_FONT,
  color: COLORS.success,
  background: "color-mix(in srgb, var(--color-success) 9%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-success) 18%, transparent)",
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

const actionRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginTop: 12,
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
