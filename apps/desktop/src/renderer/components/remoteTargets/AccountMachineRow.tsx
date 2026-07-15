import { CaretDown, CaretUp, Cloud, PlugsConnected } from "@phosphor-icons/react";
import type { AdeAccountMachine } from "../../../shared/types";
import { accountMachineConnectionState } from "../../../shared/accountDirectory";
import { COLORS, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { ConnectionDoctorPanel } from "./ConnectionDoctorPanel";
import {
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

function endpointLabel(endpoint: AdeAccountMachine["reachableEndpoints"][number]): string {
  const detail = endpoint.host ?? endpoint.url ?? "";
  return detail ? `${endpoint.kind} · ${detail}` : endpoint.kind;
}

function relativeLastSeen(lastSeenAt: number | null): string {
  if (!lastSeenAt) return "Never seen";
  const deltaMs = Date.now() - lastSeenAt;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "Seen moments ago";
  if (minutes < 60) return `Last seen ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last seen ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Last seen ${days}d ago`;
}

function accountMachineStatusLabel(
  machine: AdeAccountMachine,
  connectionState: ReturnType<typeof accountMachineConnectionState>,
  relayOnly: boolean,
): string {
  if (connectionState === "unreachable") return "Online · no verified paired relay";
  if (relayOnly) return "Online · reachable through paired relay";
  if (machine.online) return "Online · reachable on your account";
  return relativeLastSeen(machine.lastSeenAt);
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
  const primaryEndpoint = machine.reachableEndpoints[0];
  const connectionState = accountMachineConnectionState(machine);
  const available = connectionState === "available";
  const isOffline = section === "unavailable";
  const relayOnly = machine.online
    && machine.reachableEndpoints.length > 0
    && machine.reachableEndpoints.every((endpoint) => endpoint.kind === "relay");
  const trulyOffline = !machine.online;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ ...machineRowStyle, opacity: isOffline ? 0.62 : 1 }}>
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
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3, color: COLORS.textDim, fontFamily: SANS_FONT, fontSize: 10, flexShrink: 0 }}>
                <Cloud size={11} weight="fill" />
                account
              </span>
              {primaryEndpoint ? (
                <span style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11, whiteSpace: "nowrap", flexShrink: 0 }}>
                  {endpointLabel(primaryEndpoint)}
                </span>
              ) : null}
            </div>
            <div style={subTextStyle}>
              {[machine.platform, machine.deviceType].filter(Boolean).join(" · ") || "Registered on your account"}
            </div>
            <div style={helperTextStyle}>
              {accountMachineStatusLabel(machine, connectionState, relayOnly)}
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
            {trulyOffline ? (
              <button
                type="button"
                aria-expanded={detailOpen}
                aria-controls={`account-machine-detail-${row.id}`}
                onClick={() => onToggleDetail(row.id)}
                style={outlineButton({ height: 30, padding: "0 10px", fontSize: 11 })}
              >
                Why offline?
                {detailOpen ? <CaretUp size={12} weight="bold" /> : <CaretDown size={12} weight="bold" />}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {trulyOffline && detailOpen ? (
        <div id={`account-machine-detail-${row.id}`} style={inlineDetailStyle}>
          <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600 }}>
            {relativeLastSeen(machine.lastSeenAt)}
          </div>
          <div style={helperTextStyle}>
            This machine hasn't checked in recently — it's likely asleep or offline. It'll reappear here
            the moment it comes back online.
          </div>
          {machine.reachableEndpoints.length > 0 ? (
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600 }}>
                Last-known routes
              </div>
              {machine.reachableEndpoints.map((endpoint, index) => (
                <div key={`${endpoint.kind}-${index}`} style={subTextStyle}>
                  {endpointLabel(endpoint)}
                </div>
              ))}
            </div>
          ) : (
            <div style={helperTextStyle}>No reachable routes advertised.</div>
          )}
          {row.matchedTargetId ? <ConnectionDoctorPanel machineId={row.matchedTargetId} /> : null}
        </div>
      ) : null}
    </div>
  );
}
