import React from "react";

import type { AppInfo } from "../../../shared/types/core";
import type { AppPackageChannel } from "../../../shared/packageChannel";
import {
  ADE_GITHUB_URL,
  ADE_WINDOWS_SUPPORT_DOC_URL,
} from "../../../shared/productLinks";
import { COLORS, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { openExternalUrl } from "../../lib/openExternal";
import {
  ADE_OPEN_CHANNEL_NOTICE_EVENT,
  rendererPackageChannel,
} from "../../lib/packageChannel";
import { buildChannelIssueUrl, detectOsRelease } from "./channelIssueUrl";

export type ChannelNoticeModalProps = {
  channel: AppPackageChannel;
  /** Host platform. Only the Windows-specific line is gated on it. */
  platform: string;
  onClose: () => void;
  /** Test seam: skips the async AppInfo fetch. */
  appInfoOverride?: AppInfo | null;
  osReleaseOverride?: string | null;
};

function channelName(channel: AppPackageChannel): string {
  return channel === "alpha" ? "alpha" : "beta";
}

function adeHomeForChannel(channel: AppPackageChannel): string {
  // Matches main.ts applyPackagedChannelDefaults(): ADE_HOME defaults to
  // ~/.ade-<channel> for every non-stable package.
  return channel === "alpha" ? "~/.ade-alpha" : "~/.ade-beta";
}

export function ChannelNoticeModal({
  channel,
  platform,
  onClose,
  appInfoOverride,
  osReleaseOverride,
}: ChannelNoticeModalProps): React.ReactElement | null {
  const [appInfo, setAppInfo] = React.useState<AppInfo | null>(appInfoOverride ?? null);
  const [osRelease, setOsRelease] = React.useState<string | null>(osReleaseOverride ?? null);

  React.useEffect(() => {
    if (appInfoOverride !== undefined) return;
    let cancelled = false;
    void window.ade?.app
      ?.getInfo?.()
      .then((info) => {
        if (!cancelled) setAppInfo(info);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [appInfoOverride]);

  React.useEffect(() => {
    if (osReleaseOverride !== undefined) return;
    let cancelled = false;
    void detectOsRelease()
      .then((value) => {
        if (!cancelled) setOsRelease(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [osReleaseOverride]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const isWindows = /^win/i.test(platform);
  const name = channelName(channel);
  const version = appInfo?.appVersion ?? null;
  const issueUrl = buildChannelIssueUrl({ appInfo, channel, osRelease });

  const headline = isWindows
    ? `ADE on Windows is an early ${name}.`
    : `This is an early ${name} build of ADE.`;

  const body: React.CSSProperties = {
    fontFamily: SANS_FONT,
    fontSize: 13,
    lineHeight: 1.6,
    color: COLORS.textSecondary,
  };
  const linkStyle: React.CSSProperties = {
    color: COLORS.accent,
    background: "none",
    border: "none",
    padding: 0,
    font: "inherit",
    cursor: "pointer",
    textDecoration: "underline",
  };

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 220,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.52)",
        backdropFilter: "blur(10px)",
        padding: 20,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ade-channel-notice-title"
        style={{
          width: "min(520px, 100%)",
          borderRadius: 12,
          border: `1px solid ${COLORS.border}`,
          background: "var(--color-card)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
          <div
            id="ade-channel-notice-title"
            style={{ fontFamily: SANS_FONT, fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}
          >
            {headline}
          </div>
          <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted, marginTop: 3 }}>
            {version ? `${name} ${version}` : name}
          </div>
        </div>
        <div style={{ padding: 20, display: "grid", gap: 10 }}>
          <div style={body}>
            Its data lives in a separate ADE home ({adeHomeForChannel(channel)}), so it does not
            touch a Stable install.
          </div>
          <div style={body}>
            Bugs and PRs are encouraged. Report a bug prefills this build&apos;s diagnostics; PRs go
            to{" "}
            <button type="button" style={linkStyle} onClick={() => openExternalUrl(ADE_GITHUB_URL)}>
              github.com/arul28/ADE
            </button>
            .
          </div>
          <div style={body}>
            Known gaps on Windows are listed in{" "}
            <button
              type="button"
              style={linkStyle}
              onClick={() => openExternalUrl(ADE_WINDOWS_SUPPORT_DOC_URL)}
            >
              docs/development/windows-support.md
            </button>
            .
          </div>
        </div>
        <div
          style={{
            padding: "14px 20px",
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            borderTop: `1px solid ${COLORS.border}`,
          }}
        >
          <button type="button" onClick={onClose} style={outlineButton({ height: 34 })}>
            Dismiss
          </button>
          <button
            type="button"
            onClick={() => openExternalUrl(issueUrl)}
            style={primaryButton({ height: 34 })}
          >
            Report a bug
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Mounts the early-build notice once per app start, and re-opens it when the
 * header badge asks for it.
 *
 * Stable builds return null before any state, effect, or IPC: the channel comes
 * from the synchronous preload bridge, so a stable build renders nothing and
 * fetches nothing.
 */
export function ChannelNoticeHost({
  channel = rendererPackageChannel(),
  platform,
}: {
  channel?: AppPackageChannel;
  platform?: string;
} = {}): React.ReactElement | null {
  const isPrerelease = channel !== "stable";
  const [open, setOpen] = React.useState(isPrerelease);

  React.useEffect(() => {
    if (!isPrerelease) return;
    const onRequest = () => setOpen(true);
    window.addEventListener(ADE_OPEN_CHANNEL_NOTICE_EVENT, onRequest);
    return () => window.removeEventListener(ADE_OPEN_CHANNEL_NOTICE_EVENT, onRequest);
  }, [isPrerelease]);

  if (!isPrerelease || !open) return null;
  const resolvedPlatform =
    platform
    ?? (typeof window !== "undefined"
      ? (window as { ade?: { app?: { runtimeTarget?: { platform?: string } } } }).ade?.app
        ?.runtimeTarget?.platform
      : undefined)
    ?? "";
  return (
    <ChannelNoticeModal
      channel={channel}
      platform={resolvedPlatform}
      onClose={() => setOpen(false)}
    />
  );
}
