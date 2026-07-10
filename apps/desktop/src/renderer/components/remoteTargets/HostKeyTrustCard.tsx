import { CheckCircle, Warning } from "@phosphor-icons/react";
import type { RemoteRuntimeSshHostKeyTrustStatus } from "../../../shared/types";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { helperTextStyle } from "./remoteTargetListStyles";

type HostKeyTrustCardProps = {
  trust: RemoteRuntimeSshHostKeyTrustStatus;
  trusting: boolean;
  busy: boolean;
  onTrustAndConnect: () => void;
  onCancel: () => void;
};

export function HostKeyTrustCard({
  trust,
  trusting,
  busy,
  onTrustAndConnect,
  onCancel,
}: HostKeyTrustCardProps) {
  const changed = trust.state === "changed";
  const accent = changed ? COLORS.danger : COLORS.warning;

  return (
    <div
      style={{
        display: "grid",
        gap: 10,
        borderRadius: 8,
        border: `1px solid ${accent}`,
        background: `color-mix(in srgb, ${accent} 10%, transparent)`,
        padding: "10px 12px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: accent,
          fontFamily: SANS_FONT,
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        <Warning size={15} weight="fill" />
        {changed ? "Machine identity changed" : "Trust this machine"}
      </div>
      <div style={helperTextStyle}>
        {changed
          ? `ADE found a different SSH identity for ${trust.host}:${trust.port}. Review ${trust.knownHostsPath ?? "known_hosts"} before connecting.`
          : `ADE found a new SSH identity for ${trust.host}:${trust.port}. Trust it once to connect.`}
      </div>
      <div
        style={{
          color: COLORS.textPrimary,
          fontFamily: MONO_FONT,
          fontSize: 11,
          overflowWrap: "anywhere",
        }}
      >
        {trust.fingerprintSha256}
      </div>
      {trust.state === "needs_trust" ? (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            disabled={trusting || busy}
            onClick={onTrustAndConnect}
            style={{
              ...primaryButton({ height: 30, padding: "0 10px", fontSize: 11 }),
              opacity: trusting || busy ? 0.65 : 1,
            }}
          >
            <CheckCircle size={15} weight="bold" />
            {trusting ? "Trusting…" : "Trust & connect"}
          </button>
          <button
            type="button"
            disabled={trusting}
            onClick={onCancel}
            style={outlineButton({
              height: 30,
              padding: "0 10px",
              fontSize: 11,
            })}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}
