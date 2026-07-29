import { useEffect, useState } from "react";
import { CaretDown, CaretUp, Check, Cloud, PencilSimple, PlugsConnected, X } from "@phosphor-icons/react";
import type { AdeAccountMachine } from "../../../shared/types";
import {
  accountMachineConnectionState,
  accountMachineDisplayName,
} from "../../../shared/accountDirectory";
import { COLORS, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { ConnectionDoctorPanel } from "./ConnectionDoctorPanel";
import {
  formatMachineEndpoint,
  relativeLastSeenPhrase,
  type AccountMachineRow as AccountMachineRowModel,
  type MachineSection,
} from "./remoteMachineModel";
import {
  helperTextStyle,
  inlineDetailStyle,
  inlineErrorTextStyle,
  inlineSuccessTextStyle,
  machineRowStyle,
  nameStyle,
  subTextStyle,
} from "./remoteTargetListStyles";

type AccountMachineRowProps = {
  row: AccountMachineRowModel;
  section: MachineSection;
  busy: boolean;
  connecting: boolean;
  error?: string | null;
  stageLabel?: string | null;
  successLabel?: string | null;
  onPairNearby?: (() => void) | null;
  detailOpen: boolean;
  onToggleDetail: (rowId: string) => void;
  onConnect: (machine: AdeAccountMachine) => void;
  onRenamed?: () => void;
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
  error = null,
  stageLabel = null,
  successLabel = null,
  onPairNearby = null,
  detailOpen,
  onToggleDetail,
  onConnect,
  onRenamed,
}: AccountMachineRowProps) {
  const { machine } = row;
  const displayName = accountMachineDisplayName(machine) ?? "Unnamed machine";
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(displayName);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  useEffect(() => {
    if (!renaming) setRenameValue(displayName);
  }, [displayName, renaming]);
  const connectionState = accountMachineConnectionState(machine);
  const available = connectionState === "available";
  const trulyOffline = !machine.online;
  const needsSetup = connectionState === "unreachable";
  const canExplain = trulyOffline || needsSetup;

  const saveRename = async (customName?: string | null) => {
    const api = window.ade.account;
    if (!api?.renameMachine) return;
    const nextName = customName === undefined ? renameValue.trim() : customName;
    if (nextName !== null && !nextName) return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      await api.renameMachine(machine.machineKey, nextName);
      setRenaming(false);
      onRenamed?.();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "Couldn't rename this Mac.");
    } finally {
      setRenameBusy(false);
    }
  };

  return (
    <div
      data-account-machine-key={machine.machineKey}
      style={{ display: "grid", gap: 8 }}
    >
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
              {renaming ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveRename();
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}
                >
                  <input
                    aria-label="Machine name"
                    autoFocus
                    maxLength={80}
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    disabled={renameBusy}
                    style={{
                      minWidth: 0,
                      width: "100%",
                      height: 30,
                      borderRadius: 8,
                      border: `1px solid ${COLORS.borderMuted}`,
                      background: COLORS.recessedBg,
                      color: COLORS.textPrimary,
                      fontFamily: SANS_FONT,
                      fontSize: 12,
                      padding: "0 9px",
                      outline: "none",
                    }}
                  />
                  <button
                    type="submit"
                    aria-label="Save machine name"
                    disabled={renameBusy || !renameValue.trim()}
                    style={outlineButton({ height: 30, padding: "0 8px", fontSize: 11 })}
                  >
                    <Check size={13} weight="bold" />
                  </button>
                  <button
                    type="button"
                    aria-label="Cancel rename"
                    disabled={renameBusy}
                    onClick={() => {
                      setRenaming(false);
                      setRenameError(null);
                    }}
                    style={outlineButton({ height: 30, padding: "0 8px", fontSize: 11 })}
                  >
                    <X size={13} weight="bold" />
                  </button>
                </form>
              ) : (
                <span style={nameStyle}>{displayName}</span>
              )}
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
            {!renaming ? (
              <button
                type="button"
                aria-label={`Rename ${displayName}`}
                disabled={busy}
                onClick={() => setRenaming(true)}
                style={outlineButton({ height: 30, padding: "0 8px", fontSize: 11 })}
              >
                <PencilSimple size={13} weight="bold" />
                Rename
              </button>
            ) : null}
            {machine.customName && !renaming ? (
              <button
                type="button"
                disabled={busy || renameBusy}
                onClick={() => void saveRename(null)}
                style={outlineButton({ height: 30, padding: "0 8px", fontSize: 11 })}
              >
                Use hostname
              </button>
            ) : null}
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

        {connecting && stageLabel ? (
          <div role="status" style={helperTextStyle}>
            {stageLabel}
          </div>
        ) : null}

        {successLabel ? (
          <div role="status" style={inlineSuccessTextStyle}>
            {successLabel}
          </div>
        ) : null}

        {error ? (
          <div role="alert" style={{ display: "grid", gap: 3 }}>
            <div style={inlineErrorTextStyle}>{error}</div>
            {onPairNearby ? (
              <button
                type="button"
                onClick={onPairNearby}
                style={{
                  justifySelf: "start",
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  color: COLORS.accent,
                  fontFamily: SANS_FONT,
                  fontSize: 12,
                  lineHeight: 1.45,
                  cursor: "pointer",
                }}
              >
                It's on your network — Pair nearby instead ›
              </button>
            ) : null}
          </div>
        ) : null}

        {renameError ? <div role="alert" style={inlineErrorTextStyle}>{renameError}</div> : null}
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
