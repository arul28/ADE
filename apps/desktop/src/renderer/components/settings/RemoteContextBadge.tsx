import React from "react";
import { Desktop, HardDrives } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";

/**
 * Settings reflect whichever machine the active project is bound to. When the
 * project is opened on a remote runtime, the integration sections (Linear,
 * GitHub, AI) already route their reads/writes to that machine's daemon — so
 * they show the remote machine's connection state, not the local one. These
 * helpers make that scope explicit in the UI:
 *   - `RemoteSettingsBanner` clarifies the whole page reflects the remote host.
 *   - `MachineScopeBadge` marks the few sections that stay local (push certs,
 *     device pairing) so their values aren't mistaken for the remote machine's.
 */
export function useRemoteRuntimeContext(): {
  isRemote: boolean;
  runtimeName: string | null;
} {
  const projectBinding = useAppStore((s) => s.projectBinding);
  if (projectBinding?.kind === "remote") {
    return { isRemote: true, runtimeName: projectBinding.runtimeName || null };
  }
  return { isRemote: false, runtimeName: null };
}

/** Banner shown atop the Settings content when viewing a remote project. */
export function RemoteSettingsBanner() {
  const { isRemote, runtimeName } = useRemoteRuntimeContext();
  if (!isRemote) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        marginBottom: 20,
        borderRadius: 8,
        background: COLORS.accentSubtle,
        border: `1px solid ${COLORS.accentBorder}`,
        fontFamily: SANS_FONT,
        fontSize: 12,
        color: COLORS.textSecondary,
      }}
    >
      <HardDrives size={16} weight="regular" style={{ flexShrink: 0, color: COLORS.accent }} />
      <span>
        Showing settings for{" "}
        <strong style={{ color: COLORS.textPrimary, fontWeight: 600 }}>
          {runtimeName ?? "the remote machine"}
        </strong>
        . Connections and credentials reflect that machine, not this one.
      </span>
    </div>
  );
}

/**
 * Small pill marking a section whose values are tied to THIS desktop and do not
 * reflect the remote machine (e.g. local push certificate, device pairing).
 * Renders nothing unless the active project is remote.
 */
export function MachineScopeBadge() {
  const { isRemote } = useRemoteRuntimeContext();
  if (!isRemote) return null;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px",
        borderRadius: 999,
        background: COLORS.hoverBg,
        border: `1px solid ${COLORS.borderMuted}`,
        fontFamily: SANS_FONT,
        fontSize: 10,
        fontWeight: 600,
        color: COLORS.textMuted,
        whiteSpace: "nowrap",
      }}
      title="These values live on this computer and are not read from the remote machine."
    >
      <Desktop size={12} weight="regular" style={{ flexShrink: 0 }} />
      This machine
    </span>
  );
}
