import React, { useCallback, useEffect, useState } from "react";
import type {
  SyncDesktopConnectionDraft,
  SyncDeviceRuntimeState,
  SyncPeerDeviceType,
  SyncRoleSnapshot,
} from "../../../shared/types";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  cardStyle,
  dangerButton,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 16,
};

const inputStyle: React.CSSProperties = {
  height: 32,
  width: "100%",
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 8,
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  fontSize: 12,
  padding: "0 10px",
  outline: "none",
};

const helperTextStyle: React.CSSProperties = {
  color: COLORS.textMuted,
  fontFamily: MONO_FONT,
  fontSize: 11,
  lineHeight: 1.6,
};

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Never";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatLag(value: number | null | undefined): string {
  if (typeof value !== "number") return "n/a";
  return `${value} change${value === 1 ? "" : "s"}`;
}

function formatLatency(value: number | null | undefined): string {
  if (typeof value !== "number") return "n/a";
  return `${value} ms`;
}

function badgeStyle(color: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 8px",
    borderRadius: 999,
    border: `1px solid ${color}33`,
    background: `${color}14`,
    color,
    fontFamily: MONO_FONT,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  };
}

function roleColor(mode: SyncRoleSnapshot["mode"]): string {
  switch (mode) {
    case "brain":
      return COLORS.success;
    case "viewer":
      return COLORS.info;
    default:
      return COLORS.textMuted;
  }
}

function modeLabel(mode: SyncRoleSnapshot["mode"]): string {
  switch (mode) {
    case "brain":
      return "host";
    case "viewer":
      return "controller";
    default:
      return "independent";
  }
}

function connectionColor(state: SyncDeviceRuntimeState["connectionState"]): string {
  switch (state) {
    case "self":
      return COLORS.accent;
    case "connected":
      return COLORS.success;
    default:
      return COLORS.textMuted;
  }
}

export function SyncDevicesSection() {
  const [status, setStatus] = useState<SyncRoleSnapshot | null>(null);
  const [devices, setDevices] = useState<SyncDeviceRuntimeState[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localName, setLocalName] = useState("");
  const [localType, setLocalType] = useState<SyncPeerDeviceType>("desktop");
  const [connectHost, setConnectHost] = useState("");
  const [connectPort, setConnectPort] = useState("8787");
  const [connectToken, setConnectToken] = useState("");

  const refresh = useCallback(async () => {
    const [nextStatus, nextDevices] = await Promise.all([
      window.ade.sync.getStatus(),
      window.ade.sync.listDevices(),
    ]);
    setStatus(nextStatus);
    setDevices(nextDevices);
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
      } catch (refreshError) {
        if (!cancelled) {
          setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    const dispose = window.ade.sync.onEvent((event) => {
      if (event.type !== "sync-status" || cancelled) return;
      setStatus(event.snapshot);
      void window.ade.sync.listDevices().then((nextDevices) => {
        if (!cancelled) {
          setDevices(nextDevices);
        }
      }).catch(() => {
        // Best effort; the next manual refresh can recover.
      });
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [refresh]);

  useEffect(() => {
    if (!status) return;
    setLocalName(status.localDevice.name);
    setLocalType(status.localDevice.deviceType);
    if (status.client.savedDraft?.host && !connectHost) {
      setConnectHost(status.client.savedDraft.host);
    }
    if (status.client.savedDraft?.port && connectPort === "8787") {
      setConnectPort(String(status.client.savedDraft.port));
    }
  }, [connectHost, connectPort, status]);

  const runAction = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleSaveLocal = useCallback(() => {
    void runAction(async () => {
      await window.ade.sync.updateLocalDevice({
        name: localName.trim(),
        deviceType: localType,
      });
      setNotice("Local device details updated.");
    });
  }, [localName, localType, runAction]);

  const handleConnect = useCallback(() => {
    void runAction(async () => {
      const port = Number(connectPort);
      if (!connectHost.trim()) {
        throw new Error("Enter the host address or IP.");
      }
      if (!Number.isFinite(port) || port <= 0) {
        throw new Error("Enter a valid port.");
      }
      if (!connectToken.trim()) {
        throw new Error("Enter the bootstrap token from the current host.");
      }
      const draft: SyncDesktopConnectionDraft = {
        host: connectHost.trim(),
        port: Math.floor(port),
        token: connectToken.trim(),
      };
      await window.ade.sync.connectToBrain(draft);
      setNotice("Connected to the current host.");
    });
  }, [connectHost, connectPort, connectToken, runAction]);

  const handleDisconnect = useCallback(() => {
    void runAction(async () => {
      await window.ade.sync.disconnectFromBrain();
      setNotice("Disconnected. This desktop is now running in independent desktop mode.");
    });
  }, [runAction]);

  const handleTransfer = useCallback(() => {
    void runAction(async () => {
      await window.ade.sync.transferBrainToLocal();
      setNotice("This desktop is now the host machine.");
    });
  }, [runAction]);

  const handleForget = useCallback((deviceId: string) => {
    void runAction(async () => {
      await window.ade.sync.forgetDevice(deviceId);
      setNotice("Device removed from the local registry.");
    });
  }, [runAction]);

  const handleCopyConnectInfo = useCallback(async () => {
    if (!status?.bootstrapToken) return;
    const host = status.localDevice.lastHost ?? "127.0.0.1";
    const port = status.localDevice.lastPort ?? 8787;
    await window.ade.app.writeClipboardText(`Host: ${host}\nPort: ${port}\nToken: ${status.bootstrapToken}`);
    setNotice("Manual connect details copied to the clipboard.");
  }, [status]);

  const handleCopyPairingInfo = useCallback(async () => {
    if (!status?.pairingSession) return;
    const host = status.localDevice.lastHost ?? "127.0.0.1";
    const port = status.localDevice.lastPort ?? 8787;
    await window.ade.app.writeClipboardText(
      `Host: ${host}\nPort: ${port}\nPairing code: ${status.pairingSession.code}\nExpires: ${status.pairingSession.expiresAt}`,
    );
    setNotice("Pairing code copied to the clipboard.");
  }, [status]);

  if (loading) {
    return <div style={helperTextStyle}>Loading sync status…</div>;
  }

  if (error && !status) {
    return <div style={{ ...helperTextStyle, color: COLORS.danger }}>Failed to load sync settings: {error}</div>;
  }

  if (!status) {
    return <div style={helperTextStyle}>Sync is unavailable for this project.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <section>
        <div style={sectionLabelStyle}>HOST MACHINE</div>
        <div style={{ ...cardStyle(), display: "grid", gap: 16 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            <span style={badgeStyle(roleColor(status.mode))}>{modeLabel(status.mode)}</span>
            <span style={badgeStyle(status.client.state === "connected" ? COLORS.success : status.client.state === "error" ? COLORS.danger : COLORS.textMuted)}>
              link {status.client.state}
            </span>
            {status.currentBrain ? (
              <span style={badgeStyle(COLORS.textMuted)}>
                host {status.currentBrain.name}
              </span>
            ) : null}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 12 }}>
              <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>Local device</div>
              <div style={{ color: COLORS.textPrimary, fontWeight: 700, fontFamily: SANS_FONT }}>{status.localDevice.name}</div>
              <div style={helperTextStyle}>{status.localDevice.platform} · {status.localDevice.deviceType}</div>
              <div style={{ ...helperTextStyle, marginTop: 6 }}>Last seen: {formatTimestamp(status.localDevice.lastSeenAt)}</div>
            </div>
            <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 12 }}>
              <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>Current host machine</div>
              <div style={{ color: COLORS.textPrimary, fontWeight: 700, fontFamily: SANS_FONT }}>
                {status.currentBrain?.name ?? "Not assigned yet"}
              </div>
              <div style={helperTextStyle}>
                {status.currentBrain?.lastHost ?? "No host yet"}
                {status.currentBrain?.lastPort ? `:${status.currentBrain.lastPort}` : ""}
              </div>
              <div style={{ ...helperTextStyle, marginTop: 6 }}>
                Ownership epoch: {status.clusterState?.brainEpoch ?? 0}
              </div>
            </div>
            <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 12 }}>
              <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>Live execution ownership</div>
              <div style={{ ...helperTextStyle, color: COLORS.textPrimary }}>{status.survivableStateText}</div>
              <div style={{ ...helperTextStyle, marginTop: 6, color: COLORS.warning }}>{status.blockingStateText}</div>
            </div>
          </div>

          {notice ? <div style={{ ...helperTextStyle, color: COLORS.success }}>{notice}</div> : null}
          {error ? <div style={{ ...helperTextStyle, color: COLORS.danger }}>{error}</div> : null}
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>LOCAL DEVICE</div>
        <div style={{ ...cardStyle(), display: "grid", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 1fr) 180px auto", gap: 12, alignItems: "end" }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={LABEL_STYLE}>Device name</span>
              <input value={localName} onChange={(event) => setLocalName(event.target.value)} style={inputStyle} placeholder="This desktop" />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={LABEL_STYLE}>Device type</span>
              <select value={localType} onChange={(event) => setLocalType(event.target.value as SyncPeerDeviceType)} style={inputStyle}>
                <option value="desktop">desktop</option>
                <option value="phone">phone</option>
                <option value="vps">vps</option>
                <option value="unknown">unknown</option>
              </select>
            </label>
            <button
              type="button"
              style={primaryButton({ opacity: localName.trim() ? 1 : 0.5 })}
              disabled={busy || !localName.trim()}
              onClick={handleSaveLocal}
            >
              Save local device
            </button>
          </div>
          <div style={helperTextStyle}>
            Device identity is synced operational metadata. Pairing codes mint per-device secrets for controllers, while bootstrap tokens remain available for manual desktop controller connects. Legacy internal sync fields still use brain naming for compatibility.
          </div>
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>CONNECT CONTROLLER</div>
        <div style={{ ...cardStyle(), display: "grid", gap: 16 }}>
          <div style={helperTextStyle}>
            Pair phones and other remote controllers with the short-lived code below. A second desktop can either connect as a controller to this host or stay independent and use Git plus the tracked ADE scaffold/config layer. Paused missions, CTO history, and idle or ended chats remain available after host handoff. Live missions, chats, terminals, or run processes must stop first.
          </div>

          {(status.mode === "brain" || status.mode === "standalone") && status.pairingSession ? (
            <div style={{ border: `1px solid ${COLORS.info}33`, borderRadius: 12, padding: 12, background: `${COLORS.info}14` }}>
              <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>Controller pairing code</div>
              <div style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT, fontSize: 12, lineHeight: 1.8 }}>
                <div>Host: {status.localDevice.lastHost ?? "127.0.0.1"}</div>
                <div>Port: {status.localDevice.lastPort ?? 8787}</div>
                <div>Code: {status.pairingSession.code}</div>
                <div>Expires: {formatTimestamp(status.pairingSession.expiresAt)}</div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button type="button" style={outlineButton()} disabled={busy} onClick={() => void handleCopyPairingInfo()}>
                  Copy pairing details
                </button>
              </div>
            </div>
          ) : null}

          {(status.mode === "brain" || status.mode === "standalone") && status.bootstrapToken ? (
            <div style={{ border: `1px solid ${COLORS.accentBorder}`, borderRadius: 12, padding: 12, background: COLORS.accentSubtle }}>
              <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>Current host connect details</div>
              <div style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT, fontSize: 12, lineHeight: 1.8 }}>
                <div>Host: {status.localDevice.lastHost ?? "127.0.0.1"}</div>
                <div>Port: {status.localDevice.lastPort ?? 8787}</div>
                <div>Token: {status.bootstrapToken}</div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button type="button" style={outlineButton()} disabled={busy} onClick={() => void handleCopyConnectInfo()}>
                  Copy connect details
                </button>
              </div>
            </div>
          ) : null}

          <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) 140px minmax(240px, 1fr)", gap: 12 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={LABEL_STYLE}>Host address or IP</span>
              <input value={connectHost} onChange={(event) => setConnectHost(event.target.value)} style={inputStyle} placeholder="127.0.0.1" />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={LABEL_STYLE}>Port</span>
              <input value={connectPort} onChange={(event) => setConnectPort(event.target.value)} style={inputStyle} placeholder="8787" />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={LABEL_STYLE}>Bootstrap token</span>
              <input value={connectToken} onChange={(event) => setConnectToken(event.target.value)} style={inputStyle} placeholder="Paste token from the current host" />
            </label>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" style={primaryButton()} disabled={busy} onClick={handleConnect}>
              Connect as controller
            </button>
          </div>
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>ADVANCED DESKTOP OPTIONS</div>
        <div style={{ ...cardStyle(), display: "grid", gap: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {status.role === "viewer" || status.client.state === "connected" ? (
              <button type="button" style={outlineButton()} disabled={busy} onClick={handleDisconnect}>
                Disconnect controller
              </button>
            ) : null}
            <button
              type="button"
              style={outlineButton({
                color: status.transferReadiness.ready ? COLORS.textPrimary : COLORS.textMuted,
                borderColor: status.transferReadiness.ready ? COLORS.accentBorder : COLORS.border,
              })}
              disabled={busy || status.role === "brain" || !status.transferReadiness.ready}
              onClick={handleTransfer}
            >
              Take over host role
            </button>
          </div>

          <div style={{ ...helperTextStyle, color: status.transferReadiness.ready ? COLORS.success : COLORS.warning }}>
            {status.transferReadiness.ready
              ? "This desktop is ready to take over the host role."
              : "Stop the live work below before handing off the host role."}
          </div>

          <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 12 }}>
            <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>Durable state that survives host handoff</div>
            <div style={{ display: "grid", gap: 6 }}>
              {status.transferReadiness.survivableState.map((line) => (
                <div key={line} style={helperTextStyle}>• {line}</div>
              ))}
            </div>
          </div>

          <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 12 }}>
            <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>Blocking live work</div>
            {status.transferReadiness.blockers.length > 0 ? (
              <div style={{ display: "grid", gap: 8 }}>
                {status.transferReadiness.blockers.map((blocker) => (
                  <div key={`${blocker.kind}:${blocker.id}`} style={{ borderBottom: `1px solid ${COLORS.borderMuted}`, paddingBottom: 8 }}>
                    <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 13, fontWeight: 700 }}>{blocker.label}</div>
                    <div style={helperTextStyle}>{blocker.detail}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={helperTextStyle}>No live blockers are active.</div>
            )}
          </div>
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>REGISTERED DEVICES</div>
        <div style={{ display: "grid", gap: 12 }}>
          {devices.map((device) => {
            const canForget = !device.isLocal && !device.isBrain && device.connectionState === "disconnected";
            return (
              <div key={device.deviceId} style={{ ...cardStyle({ padding: 16 }), display: "grid", gap: 10 }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 700 }}>
                      {device.name}
                    </div>
                    <div style={helperTextStyle}>
                      {device.platform} · {device.deviceType} · {device.lastHost ?? "no host"}
                      {device.lastPort ? `:${device.lastPort}` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {device.isLocal ? <span style={badgeStyle(COLORS.accent)}>local</span> : null}
                    {device.isBrain ? <span style={badgeStyle(COLORS.success)}>host</span> : null}
                    <span style={badgeStyle(connectionColor(device.connectionState))}>{device.connectionState}</span>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                  <div style={helperTextStyle}>Last seen: {formatTimestamp(device.lastSeenAt)}</div>
                  <div style={helperTextStyle}>Connected at: {formatTimestamp(device.connectedAt)}</div>
                  <div style={helperTextStyle}>Latency: {formatLatency(device.latencyMs)}</div>
                  <div style={helperTextStyle}>Sync lag: {formatLag(device.syncLag)}</div>
                </div>

                {canForget ? (
                  <div>
                    <button type="button" style={dangerButton()} disabled={busy} onClick={() => handleForget(device.deviceId)}>
                      Forget device
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
