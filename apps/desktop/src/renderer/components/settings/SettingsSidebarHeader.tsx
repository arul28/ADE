import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ChatCircleDots, Minus, Plus } from "@phosphor-icons/react";
import type { GitHubStatus } from "../../../shared/types";
import { accountSessionShortLabel, accountSessionState, useAccountStatus } from "../../lib/account";
import { resetAppZoom, useAppZoom, zoomAppIn, zoomAppOut } from "../../lib/appZoom";
import { modifierChordLabel } from "../../lib/platform";
import { DEFAULT_ZOOM } from "../../lib/zoom";
import { AccountAvatar } from "../account/AccountAvatar";
import { FeedbackReporterModal } from "../app/FeedbackReporterModal";
import { HelpMenu } from "../onboarding/HelpMenu";
import { settingsReturnRoute } from "../app/projectSidebar/settingsReturnRoute";
import { useAppStore } from "../../state/appStore";

/**
 * The top of the settings sidebar: a quiet row of app tools (feedback, help,
 * zoom), then who you are. These used to sit in the top bar, where they were
 * always in the way; here they are one click from anywhere and out of sight
 * the rest of the time.
 */
export function SettingsSidebarHeader({ onOpenAccount }: { onOpenAccount: () => void }) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const zoom = useAppZoom();
  const navigate = useNavigate();
  // The same key the project sidebar uses to remember where you were.
  const routeKey = useAppStore((s) => {
    if (s.projectBinding?.key) return s.projectBinding.key;
    return s.project?.rootPath ? `local:${s.project.rootPath}` : null;
  });

  return (
    <div className="ade-settings-sidebar-header">
      <div className="ade-settings-sidebar-tools">
        <button
          type="button"
          className="ade-settings-sidebar-tool ade-settings-sidebar-back"
          title="Back to where you were"
          onClick={() => navigate(settingsReturnRoute(routeKey))}
        >
          <ArrowLeft size={13} weight="bold" />
          <span>Back</span>
        </button>
        <button
          type="button"
          className="ade-settings-sidebar-tool"
          aria-label="Send feedback"
          title="Send feedback"
          onClick={() => setFeedbackOpen(true)}
        >
          <ChatCircleDots size={14} weight="regular" />
        </button>
        <HelpMenu align="start" className="ade-settings-sidebar-tool" iconSize={14} />

        <div className="ade-settings-sidebar-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            className="ade-settings-sidebar-tool"
            aria-label="Zoom out"
            title={`Zoom out  ${modifierChordLabel("-")}`}
            onClick={zoomAppOut}
          >
            <Minus size={11} weight="bold" />
          </button>
          <button
            type="button"
            className="ade-settings-sidebar-zoom-value"
            aria-label={`Zoom ${zoom}%, reset`}
            title={zoom === DEFAULT_ZOOM ? "Zoom" : `Reset to ${DEFAULT_ZOOM}%  ${modifierChordLabel("0")}`}
            onClick={resetAppZoom}
          >
            {zoom}%
          </button>
          <button
            type="button"
            className="ade-settings-sidebar-tool"
            aria-label="Zoom in"
            title={`Zoom in  ${modifierChordLabel("+")}`}
            onClick={zoomAppIn}
          >
            <Plus size={11} weight="bold" />
          </button>
        </div>
      </div>

      <SettingsSidebarIdentity onOpen={onOpenAccount} />

      <FeedbackReporterModal open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </div>
  );
}

/**
 * GitHub status, only while the avatar needs it: a signed-in account with no
 * image of its own falls back to the GitHub picture.
 */
function useAvatarGithubStatus(enabled: boolean): GitHubStatus | null {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void window.ade.github
      ?.getStatus?.()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {});
    const unsubscribe = window.ade.github?.onStatusChanged?.((next) => setStatus(next));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [enabled]);
  return enabled ? status : null;
}

/**
 * A shortcut to the Account section. It never shows a selected state: the
 * "Account" row in the section list already does, and two highlights read as
 * two places.
 */
function SettingsSidebarIdentity({ onOpen }: { onOpen: () => void }) {
  const { status } = useAccountStatus();
  const githubStatus = useAvatarGithubStatus(status.signedIn && !status.imageUrl);
  const githubLogin = githubStatus?.userLogin || null;
  const githubConnected = Boolean(githubStatus?.connected);
  // An expired or unreadable session is not "signed out", so the label names
  // the real state instead of flattening it.
  const sessionLabel = accountSessionShortLabel(accountSessionState(status));
  const name = status.signedIn ? status.name?.trim() || null : null;
  const email = status.signedIn ? status.email?.trim() || null : null;
  const primary = status.signedIn ? name || email || githubLogin || "Your ADE account" : sessionLabel;
  const secondary = name && email ? email : null;

  return (
    <button
      type="button"
      className="ade-settings-sidebar-identity"
      aria-label={`Account, ${primary}`}
      onClick={onOpen}
    >
      <AccountAvatar status={status} githubLogin={githubLogin} githubConnected={githubConnected} size={30} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="ade-settings-sidebar-identity-name">{primary}</span>
        {secondary ? <span className="ade-settings-sidebar-identity-email">{secondary}</span> : null}
      </span>
    </button>
  );
}
