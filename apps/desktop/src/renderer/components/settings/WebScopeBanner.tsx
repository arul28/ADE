import React from "react";
import { Browser, Cloud, HardDrives } from "@phosphor-icons/react";

import { isWebClientMode } from "../../lib/webClientMode";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { useRemoteRuntimeContext } from "./RemoteContextBadge";
import { sectionWebScope, type SettingWebScope } from "./settingsManifest";

/**
 * On the desktop, "where does this setting go" has one answer: this computer.
 * In the browser it has three — the machine the tab is connected to, the ADE
 * account, or nothing but this browser's localStorage — and which one you get
 * is not guessable from the control. Every web-visible settings section opens
 * with a line saying which, so a toggle that will not follow you to another
 * browser says so before you flip it.
 *
 * Desktop renders sections exactly as it did before: no banner, no wrapper.
 */

type ScopeCopy = {
  icon: React.ElementType;
  text: (machineName: string) => React.ReactNode;
};

const SCOPE_COPY: Record<Exclude<SettingWebScope, "hidden">, ScopeCopy> = {
  machine: {
    icon: HardDrives,
    text: (machineName) => (
      <>
        Applies to <strong style={{ color: COLORS.textPrimary, fontWeight: 600 }}>{machineName}</strong>
      </>
    ),
  },
  account: {
    icon: Cloud,
    text: () => <>Saved to your ADE account — applies on every machine</>,
  },
  browser: {
    icon: Browser,
    text: () => <>Saved in this browser</>,
  },
};

function SettingsScopeBanner({ scope }: { scope: Exclude<SettingWebScope, "hidden"> }) {
  const { runtimeName } = useRemoteRuntimeContext();
  const copy = SCOPE_COPY[scope];
  const Icon = copy.icon;

  return (
    <div
      style={{
        display: "inline-flex",
        marginBottom: 12,
        alignItems: "center",
        gap: 7,
        padding: "5px 10px",
        borderRadius: 999,
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.borderMuted}`,
        fontFamily: SANS_FONT,
        fontSize: 11,
        color: COLORS.textMuted,
      }}
    >
      <Icon size={13} weight="regular" style={{ flexShrink: 0, color: COLORS.textDim }} />
      <span>{copy.text(runtimeName ?? "the connected machine")}</span>
    </div>
  );
}

/**
 * Wraps one settings section. On the desktop it is its children, unchanged.
 * On web it drops the section entirely when the manifest marks its settings
 * unreachable, and otherwise heads it with the scope line.
 *
 * A section whose ids all fail to resolve renders bare rather than
 * disappearing (see `sectionWebScope`).
 */
export function WebSettingsSection({
  entryIds,
  children,
}: {
  entryIds: readonly string[];
  children: React.ReactNode;
}) {
  if (!isWebClientMode()) return <>{children}</>;
  const scope = sectionWebScope(entryIds);
  if (scope === "hidden") return null;
  if (scope === null) return <>{children}</>;
  // `data-settings-group` puts the banner under the settings search filter, so
  // searching cannot leave a scope line hanging over cards it just hid. The
  // filter clears `style.display` to unhide, so this element keeps the block
  // default rather than an inline flex layout it would wipe out.
  return (
    <div data-settings-group="web-scope">
      <SettingsScopeBanner scope={scope} />
      {children}
    </div>
  );
}
