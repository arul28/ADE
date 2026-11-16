import React from "react";
import { GearSix, SidebarSimple } from "@phosphor-icons/react";
import type { CtoAvatarLook, CtoAvatarState } from "../../../shared/types";
import { CtoAvatar } from "./avatar/CtoAvatar";

/**
 * The CTO page's header: a centred floating pill with the CTO's live avatar,
 * its name and one status phrase; the panel toggle and settings on the right.
 */
export function CtoHeaderPill({
  look,
  name,
  statusPhrase,
  avatarState,
  panelOpen,
  settingsOpen,
  controlsDisabled,
  onTogglePanel,
  onOpenSettings,
}: {
  look: CtoAvatarLook;
  name: string;
  statusPhrase: string | null;
  avatarState: CtoAvatarState;
  panelOpen: boolean;
  settingsOpen: boolean;
  controlsDisabled: boolean;
  onTogglePanel: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="ade-cto-header" data-testid="cto-header">
      <div className="ade-cto-pill" aria-live="polite" title={statusPhrase ? `${name}, ${statusPhrase.toLowerCase()}` : name}>
        <CtoAvatar look={look} state={avatarState} size={22} motion="lazy" />
        <span className="ade-cto-pill-name">{name}</span>
        {statusPhrase ? (
          <>
            <span className="ade-cto-pill-sep" aria-hidden>·</span>
            <span className="ade-cto-pill-status">{statusPhrase}</span>
          </>
        ) : null}
      </div>
      <div className="ade-cto-header-actions">
        <button
          type="button"
          className="kit-icon-btn ade-cto-header-btn"
          aria-pressed={panelOpen}
          aria-label={panelOpen ? "Hide panel" : "Show panel"}
          title={panelOpen ? "Hide panel" : "Show panel"}
          disabled={controlsDisabled}
          onClick={onTogglePanel}
        >
          <SidebarSimple size={14} weight={panelOpen ? "fill" : "regular"} style={{ transform: "scaleX(-1)" }} />
        </button>
        <button
          type="button"
          className="kit-icon-btn ade-cto-header-btn"
          aria-pressed={settingsOpen}
          aria-label={`${name} settings`}
          title={settingsOpen ? "Back to chat" : "Settings"}
          disabled={controlsDisabled}
          onClick={onOpenSettings}
        >
          <GearSix size={14} weight={settingsOpen ? "fill" : "regular"} />
        </button>
      </div>
    </div>
  );
}
