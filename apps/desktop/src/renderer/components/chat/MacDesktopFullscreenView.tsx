import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../ui/cn";
import { WORK_TOOL_CHROME_ROW } from "../terminals/workToolChrome";
import { MacDesktopStatusStrip, type MacDesktopStripMessage } from "./MacDesktopStatusStrip";
import {
  MAC_DESKTOP_FULLSCREEN_Z,
  type MacDesktopChromeScope,
  type MacDesktopPanelController,
} from "./useMacDesktopPanelController";

const MAC_DESKTOP_FULLSCREEN_MARGIN = 16;

export function MacDesktopFullscreenView({
  controller,
  stripMessage,
  renderChromeRow,
  renderStopConfirm,
  renderPermissionNotice,
  renderPicture,
  renderCaptureOverlay,
  renderVideoOverlay,
}: {
  controller: MacDesktopPanelController;
  stripMessage: MacDesktopStripMessage | null;
  renderChromeRow: (scope: MacDesktopChromeScope) => ReactNode;
  renderStopConfirm: () => ReactNode;
  renderPermissionNotice: () => ReactNode;
  renderPicture: (scope: MacDesktopChromeScope) => ReactNode;
  renderCaptureOverlay: (scope: MacDesktopChromeScope) => ReactNode;
  renderVideoOverlay: (scope: MacDesktopChromeScope) => ReactNode;
}) {
  const { expanded, confirmStop, missingPermissions } = controller;
  if (!expanded || typeof document === "undefined") return null;

  return createPortal(
    <div
      data-testid="mac-desktop-fullscreen"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        zIndex: MAC_DESKTOP_FULLSCREEN_Z,
        background: "var(--color-bg)",
      }}
      className="flex flex-col"
    >
      <div
        data-testid="mac-desktop-fullscreen-chrome"
        className={cn(
          WORK_TOOL_CHROME_ROW,
          "relative z-10 shrink-0 flex-nowrap gap-1 border-b border-white/[0.06] px-3",
        )}
      >
        {renderChromeRow("fullscreen")}
      </div>
      <MacDesktopStatusStrip message={stripMessage} suffix="-fs" />
      {confirmStop || missingPermissions.length > 0 ? (
        <div className="flex shrink-0 flex-col gap-2 px-4 pt-3">
          {renderStopConfirm()}
          {renderPermissionNotice()}
        </div>
      ) : null}
      <div
        className="relative flex min-h-0 flex-1 items-stretch justify-stretch"
        style={{ padding: MAC_DESKTOP_FULLSCREEN_MARGIN }}
      >
        {renderPicture("fullscreen")}
        {renderCaptureOverlay("fullscreen")}
        {renderVideoOverlay("fullscreen")}
      </div>
    </div>,
    document.documentElement,
  );
}
