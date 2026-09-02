import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { AppWindow } from "@phosphor-icons/react";

import {
  editorTargetDefinition,
  type EditorTarget,
  type OpenPathInEditorRemote,
} from "../../../shared/editorTargets";
import { MenuSubmenu } from "../ui/MenuSubmenu";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.07] focus-visible:bg-white/[0.07] outline-none";

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
  const [installed, setInstalled] = useState<EditorTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const detector = window.ade?.app?.getInstalledEditors;
    if (typeof detector !== "function") {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void detector()
      .then((targets) => {
        if (!cancelled) setInstalled(targets);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const eligible = useMemo(
    () => installed.filter((target) => {
      const definition = editorTargetDefinition(target);
      if (!definition) return false;
      return !remote || definition.supportsRemote;
    }),
    [installed, remote],
  );

  const open = async (target: EditorTarget) => {
    try {
      await window.ade.app.openPathInEditor({
        rootPath,
        target,
        ...(remote ? { remote } : {}),
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <MenuSubmenu
      label={label}
      icon={icon ?? (
        <span aria-hidden data-menu-icon="" className="inline-flex shrink-0 text-fg/45">
          <AppWindow size={13} weight="duotone" />
        </span>
      )}
      className={className}
      style={style}
      hoverBackground={hoverBackground}
      title="Open this lane in an installed editor"
      panelStyle={{ border: `1px solid ${COLORS.outlineBorder}`, padding: "4px 0" }}
      panelMinWidth={230}
    >
      {loading ? (
        <div className="px-3 py-2 text-[11px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          Detecting editors…
        </div>
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
              {definition.label}
            </button>
          );
        })
      ) : (
        <div className="px-3 py-2 text-[11px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          {remote ? "No compatible remote editor detected" : "No installed editors detected"}
        </div>
      )}
      {error ? (
        <div className="px-3 py-2 text-[11px]" role="alert" style={{ color: COLORS.danger }}>
          {error}
        </div>
      ) : null}
    </MenuSubmenu>
  );
}
