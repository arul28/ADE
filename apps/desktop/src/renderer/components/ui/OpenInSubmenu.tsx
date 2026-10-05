import { useState, type CSSProperties, type ReactNode } from "react";
import { AppWindow } from "@phosphor-icons/react";

import {
  editorTargetDefinition,
  type EditorTarget,
  type OpenPathInEditorRemote,
} from "../../../shared/editorTargets";
import {
  MENU_ITEM_CLASS,
  MenuSubmenu,
  MenuSubmenuStatus,
} from "../ui/MenuSubmenu";
import { COLORS } from "../lanes/laneDesignTokens";
import { EditorTargetLogo } from "./EditorTargetLogo";
import { useInstalledTargets } from "./useInstalledTargets";

export function OpenInSubmenu({
  rootPath,
  remote,
  onClose,
  className = MENU_ITEM_CLASS,
  style,
  hoverBackground,
  label = "Open in",
  icon,
}: {
  rootPath: string;
  remote?: OpenPathInEditorRemote | null;
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
  hoverBackground?: string;
  label?: string;
  icon?: ReactNode;
}) {
  const { items, error: detectionError } = useInstalledTargets<EditorTarget>(
    window.ade?.app?.getInstalledEditors,
  );
  // A row that failed to launch is its own message, distinct from "detection
  // failed" — the list is still valid, one editor just would not start.
  const [openError, setOpenError] = useState<string | null>(null);
  const eligible = (items ?? []).filter((target) => {
    const definition = editorTargetDefinition(target);
    if (!definition) return false;
    return !remote || definition.supportsRemote;
  });

  const open = async (target: EditorTarget) => {
    try {
      await window.ade.app.openPathInEditor({
        rootPath,
        target,
        ...(remote ? { remote } : {}),
      });
      onClose();
    } catch (reason) {
      setOpenError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <MenuSubmenu
      label={label}
      icon={
        icon ?? (
          <span
            aria-hidden
            data-menu-icon=""
            className="inline-flex shrink-0 text-fg/45"
          >
            <AppWindow size={13} weight="duotone" />
          </span>
        )
      }
      className={className}
      style={style}
      hoverBackground={hoverBackground}
      title="Open this lane in an installed editor"
      panelStyle={{
        border: `1px solid ${COLORS.outlineBorder}`,
        padding: "4px 0",
      }}
      panelMinWidth={230}
    >
      {items === null ? (
        <MenuSubmenuStatus>Detecting editors…</MenuSubmenuStatus>
      ) : eligible.length > 0 ? (
        eligible.map((target) => {
          const definition = editorTargetDefinition(target);
          if (!definition) return null;
          return (
            <button
              key={target}
              type="button"
              role="menuitem"
              className={MENU_ITEM_CLASS}
              onClick={() => void open(target)}
            >
              <EditorTargetLogo target={target} size={16} />
              {definition.label}
            </button>
          );
        })
      ) : (
        <MenuSubmenuStatus>
          {remote
            ? "No compatible remote editor detected"
            : "No installed editors detected"}
        </MenuSubmenuStatus>
      )}
      {detectionError || openError ? (
        <MenuSubmenuStatus tone="danger">{detectionError ?? openError}</MenuSubmenuStatus>
      ) : null}
    </MenuSubmenu>
  );
}
