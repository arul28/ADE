import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { GitHubAppInstallationStatus } from "../../../shared/types";
import { ArrowClockwise, ArrowSquareOut, CheckCircle, WarningCircle, WebhooksLogo } from "@phosphor-icons/react";
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
  const [loading, setLoading] = useState(false);

  const loadStatus = useCallback(async (forceRefresh = false) => {
    if (!window.ade?.github?.getAppInstallationStatus) return;
    setLoading(true);
    try {
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

  useEffect(() => {
    void loadStatus(false);
  }, [loadStatus]);

  const view = statusView(status, loading);
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

      <div style={actionRowStyle}>
        {status?.installed ? null : (
          <button
            type="button"
            style={primaryButton(compact ? compactPrimaryButtonStyle : undefined)}
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

function statusView(status: GitHubAppInstallationStatus | null, loading: boolean): {
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
