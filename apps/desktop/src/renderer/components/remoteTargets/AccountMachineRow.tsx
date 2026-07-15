import { CaretDown, CaretUp, Cloud, PlugsConnected } from "@phosphor-icons/react";
import type { AdeAccountMachine } from "../../../shared/types";
import { COLORS, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { ConnectionDoctorPanel } from "./ConnectionDoctorPanel";
import type { AccountMachineRow as AccountMachineRowModel, MachineSection } from "./remoteMachineModel";
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

/** The best lan/tailnet endpoint an account machine can be adopted+connected on. */
export function accountMachineConnectHost(machine: AdeAccountMachine): { host: string; port: number | null } | null {
  const ranked = [...machine.reachableEndpoints].sort((a, b) => {
    const rank = (kind: string) => (kind === "tailnet" ? 0 : kind === "lan" ? 1 : 2);
    return rank(a.kind) - rank(b.kind);
  });
  for (const endpoint of ranked) {
    if (endpoint.kind === "relay") continue;
    const host = endpoint.host ?? endpoint.url ?? null;
    if (host) return { host, port: endpoint.port ?? null };
  }
  return null;
}

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
  const connectHost = accountMachineConnectHost(machine);
  const isOffline = section === "unavailable";
  const relayOnly = machine.online && !connectHost;
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
              {relayOnly
                ? "Online · relay only — connect from a machine on its network"
                : machine.online
                  ? "Online · reachable on your account"
                  : relativeLastSeen(machine.lastSeenAt)}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {machine.online && connectHost ? (
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
