import React from "react";
import { ArrowSquareOut, BookOpenText, Bug, GithubLogo, WindowsLogo } from "@phosphor-icons/react";

import type { AppInfo } from "../../../shared/types/core";
import type { AppPackageChannel } from "../../../shared/packageChannel";
import {
  ADE_GITHUB_URL,
  ADE_WINDOWS_SUPPORT_DOC_URL,
} from "../../../shared/productLinks";
import { COLORS, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { openExternalUrl } from "../../lib/openExternal";
import { rendererPackageChannel } from "../../lib/packageChannel";
import {
  ADE_OPEN_WINDOWS_BETA_NOTICE_EVENT,
  isWindowsPlatform,
} from "../../lib/windowsBetaNotice";
import { buildBugReportIssueUrl, detectOsRelease } from "./bugReportIssueUrl";

export type WindowsBetaNoticeModalProps = {
  /**
   * Reported in the prefilled bug report so a report names the exact build.
   * Never rendered as user-facing chrome — release channels are dev vocabulary.
   */
  channel: AppPackageChannel;
  onClose: () => void;
  /** Test seam: skips the async AppInfo fetch. */
  appInfoOverride?: AppInfo | null;
  osReleaseOverride?: string | null;
};

function LinkRow({
  icon,
  label,
  detail,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string;
  onClick: () => void;
}): React.ReactElement {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        textAlign: "left",
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid ${
          hover ? COLORS.accentBorder : "color-mix(in srgb, var(--color-border) 80%, transparent)"
        }`,
        background: hover
          ? "color-mix(in srgb, var(--color-accent) 7%, transparent)"
          : "color-mix(in srgb, var(--color-fg) 3%, transparent)",
        cursor: "pointer",
        fontFamily: SANS_FONT,
        transition: "background 120ms ease, border-color 120ms ease",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          flexShrink: 0,
          borderRadius: 7,
          color: COLORS.textSecondary,
          background: "color-mix(in srgb, var(--color-fg) 5%, transparent)",
        }}
      >
        {icon}
      </span>
      <span style={{ display: "grid", gap: 2, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: COLORS.textPrimary }}>{label}</span>
        <span
          style={{
            fontSize: 11,
            color: COLORS.textMuted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {detail}
        </span>
      </span>
      <ArrowSquareOut
        size={14}
        aria-hidden
        style={{ flexShrink: 0, color: hover ? COLORS.accent : COLORS.textMuted }}
      />
    </button>
  );
}

export function WindowsBetaNoticeModal({
  channel,
  onClose,
  appInfoOverride,
  osReleaseOverride,
}: WindowsBetaNoticeModalProps): React.ReactElement | null {
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

  const version = appInfo?.appVersion ?? null;
  const issueUrl = buildBugReportIssueUrl({ appInfo, channel, osRelease });

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
        aria-labelledby="ade-windows-beta-notice-title"
        aria-describedby="ade-windows-beta-notice-body"
        style={{
          width: "min(520px, 100%)",
          borderRadius: 14,
          border: `1px solid ${COLORS.border}`,
          background: "var(--color-card)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 13,
            padding: "20px 22px 16px",
            borderBottom: `1px solid ${COLORS.borderMuted}`,
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 36,
              height: 36,
              flexShrink: 0,
              borderRadius: 10,
              color: COLORS.accent,
              background: COLORS.accentSubtle,
              border: `1px solid ${COLORS.accentBorder}`,
            }}
          >
            <WindowsLogo size={19} weight="fill" />
          </span>
          <div style={{ minWidth: 0 }}>
            <div
              id="ade-windows-beta-notice-title"
              style={{
                fontFamily: SANS_FONT,
                fontSize: 16,
                fontWeight: 700,
                letterSpacing: "-0.01em",
                color: COLORS.textPrimary,
              }}
            >
              ADE on Windows is in beta
            </div>
            <div
              style={{
                fontFamily: SANS_FONT,
                fontSize: 12,
                lineHeight: 1.5,
                color: COLORS.textMuted,
                marginTop: 3,
              }}
            >
              The Windows build is the newest part of ADE and is still catching up.
            </div>
          </div>
        </div>

        <div style={{ padding: "16px 22px 18px", display: "grid", gap: 13 }}>
          <div
            id="ade-windows-beta-notice-body"
            style={{
              fontFamily: SANS_FONT,
              fontSize: 13,
              lineHeight: 1.6,
              color: COLORS.textSecondary,
            }}
          >
            Day-to-day work — lanes, chats, terminals, PRs — is expected to hold up. Some corners
            are rougher here than on macOS or Linux, and a few are still missing. When something
            breaks, reporting it is what closes the gap.
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            <LinkRow
              icon={<BookOpenText size={15} />}
              label="Known gaps on Windows"
              detail="docs/development/windows-support.md"
              onClick={() => openExternalUrl(ADE_WINDOWS_SUPPORT_DOC_URL)}
            />
            <LinkRow
              icon={<GithubLogo size={15} />}
              label="Source, issues, and pull requests"
              detail="github.com/arul28/ADE"
              onClick={() => openExternalUrl(ADE_GITHUB_URL)}
            />
          </div>
        </div>

        <div
          style={{
            padding: "13px 22px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            borderTop: `1px solid ${COLORS.borderMuted}`,
            background: "color-mix(in srgb, var(--color-fg) 2%, transparent)",
          }}
        >
          <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
            {version ? `ADE ${version}` : ""}
          </span>
          <span style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={onClose} style={outlineButton({ height: 34 })}>
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => openExternalUrl(issueUrl)}
              style={primaryButton({ height: 34, fontWeight: 600 })}
            >
              <Bug size={14} weight="fill" />
              Report a bug
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Mounts the Windows beta notice once per app start, and re-opens it when a
 * surface (the header build chip, Settings → About) asks for it.
 *
 * Gated on the HOST PLATFORM, not the release channel: every Windows install
 * shows it, Stable included, and macOS/Linux render nothing. The platform comes
 * from the synchronous preload bridge, so a non-Windows build returns null
 * before any effect or IPC — it never calls `app.getInfo()`.
 */
export function WindowsBetaNoticeHost({
  platform,
  channel = rendererPackageChannel(),
}: {
  platform?: string;
  channel?: AppPackageChannel;
} = {}): React.ReactElement | null {
  const isWindows = isWindowsPlatform(platform);
  const [open, setOpen] = React.useState(isWindows);

  React.useEffect(() => {
    if (!isWindows) return;
    const onRequest = () => setOpen(true);
    window.addEventListener(ADE_OPEN_WINDOWS_BETA_NOTICE_EVENT, onRequest);
    return () => window.removeEventListener(ADE_OPEN_WINDOWS_BETA_NOTICE_EVENT, onRequest);
  }, [isWindows]);

  if (!isWindows || !open) return null;
  return <WindowsBetaNoticeModal channel={channel} onClose={() => setOpen(false)} />;
}
