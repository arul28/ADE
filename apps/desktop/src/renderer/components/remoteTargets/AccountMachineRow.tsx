import { CaretDown, CaretUp, Cloud, PlugsConnected } from "@phosphor-icons/react";
import type { AdeAccountMachine } from "../../../shared/types";
import { accountMachineConnectionState } from "../../../shared/accountDirectory";
import { COLORS, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { ConnectionDoctorPanel } from "./ConnectionDoctorPanel";
import {
  formatMachineEndpoint,
  relativeLastSeenPhrase,
  type AccountMachineRow as AccountMachineRowModel,
  type MachineSection,
} from "./remoteMachineModel";
import { helperTextStyle, inlineDetailStyle, machineRowStyle, nameStyle, subTextStyle } from "./remoteTargetListStyles";

type AccountMachineRowProps = {
  row: AccountMachineRowModel;
  section: MachineSection;
  busy: boolean;
  connecting: boolean;
  detailOpen: boolean;
  onToggleDetail: (rowId: string) => void;
  onConnect: (machine: AdeAccountMachine) => void;
};

function relativeLastSeen(lastSeenAt: number | null): string {
  const phrase = relativeLastSeenPhrase(lastSeenAt);
  return phrase ? `Last seen ${phrase}` : "Never seen";
}

function accountMachineStatusLabel(
  machine: AdeAccountMachine,
  connectionState: ReturnType<typeof accountMachineConnectionState>,
): string {
  if (connectionState === "unreachable") {
    return "Can't reach this Mac right now — make sure it's online and up to date.";
  }
  if (machine.online) return "Ready to connect";
  return `${relativeLastSeen(machine.lastSeenAt)} · Open ADE on that Mac`;
}

export function AccountMachineRow({
  row,
  section,
  busy,
  connecting,
  detailOpen,
  onToggleDetail,
  onConnect,
}: AccountMachineRowProps) {
  const { machine } = row;
  const connectionState = accountMachineConnectionState(machine);
  const available = connectionState === "available";
  const trulyOffline = !machine.online;
  const needsSetup = connectionState === "unreachable";
  const canExplain = trulyOffline || needsSetup;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ ...machineRowStyle, opacity: trulyOffline && section === "unavailable" ? 0.62 : 1 }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 12, alignItems: "start" }}>
          <div style={{ minWidth: 0, display: "grid", gap: 5 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: machine.online ? COLORS.success : COLORS.textDim,
                }}
              />
              <span style={nameStyle}>{machine.name ?? "Unnamed machine"}</span>
            </div>
            <div style={{ ...subTextStyle, display: "flex", alignItems: "center", gap: 5 }}>
              <Cloud size={12} weight="fill" color={COLORS.accent} style={{ flexShrink: 0 }} />
              Connected to your ADE account
            </div>
            <div style={helperTextStyle}>
              {accountMachineStatusLabel(machine, connectionState)}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {available ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onConnect(machine)}
                style={primaryButton({ height: 30, padding: "0 10px", fontSize: 11 })}
              >
                <PlugsConnected size={14} weight="bold" />
                {connecting ? "Connecting…" : "Connect"}
              </button>
            ) : null}
            {canExplain ? (
              <button
                type="button"
                aria-expanded={detailOpen}
                aria-controls={`account-machine-detail-${row.id}`}
                onClick={() => onToggleDetail(row.id)}
                style={outlineButton({ height: 30, padding: "0 10px", fontSize: 11 })}
              >
                {needsSetup ? "How to connect" : "Why offline?"}
                {detailOpen ? <CaretUp size={12} weight="bold" /> : <CaretDown size={12} weight="bold" />}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {canExplain && detailOpen ? (
        <div id={`account-machine-detail-${row.id}`} style={inlineDetailStyle}>
          <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600 }}>
            {needsSetup ? "Finish setup on the other Mac" : relativeLastSeen(machine.lastSeenAt)}
          </div>
          <div style={helperTextStyle}>
            {needsSetup
              ? "On that Mac, open ADE and sign in to this same ADE account. Once it's online and up to date, it appears here automatically."
              : "This Mac hasn't checked in recently. Open ADE on it, then try again."}
          </div>
          {!needsSetup && machine.reachableEndpoints.length > 0 ? (
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600 }}>
                Last-known routes
              </div>
              {machine.reachableEndpoints.map((endpoint, index) => (
                <div key={`${endpoint.kind}-${index}`} style={subTextStyle}>
                  {formatMachineEndpoint(endpoint)}
                </div>
              ))}
            </div>
          ) : null}
          {row.matchedTargetId ? <ConnectionDoctorPanel machineId={row.matchedTargetId} /> : null}
        </div>
      ) : null}
    </div>
  );
}
