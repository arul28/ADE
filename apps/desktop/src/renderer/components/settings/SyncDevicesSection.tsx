import React, { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import type {
  SyncDesktopConnectionDraft,
  SyncDeviceRuntimeState,
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

const titleStyle: React.CSSProperties = {
  color: COLORS.textPrimary,
  fontFamily: SANS_FONT,
  fontSize: 24,
  fontWeight: 700,
  lineHeight: 1.15,
};

const panelStyle: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: 10,
  padding: 14,
  display: "grid",
  gap: 6,
};

const detailBlockStyle: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: 10,
  padding: 14,
  background: "rgba(255,255,255,0.015)",
};

const detailSummaryStyle: React.CSSProperties = {
  cursor: "pointer",
  color: COLORS.textPrimary,
  fontFamily: SANS_FONT,
  fontSize: 14,
  fontWeight: 600,
  listStyle: "none",
};

const codeValueStyle: React.CSSProperties = {
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  fontSize: 12,
  lineHeight: 1.8,
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

function tagStyle(color: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 8px",
    borderRadius: 8,
    border: `1px solid ${color}33`,
    background: `${color}14`,
    color,
    fontFamily: MONO_FONT,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.04em",
  };
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

function deviceConnectionLabel(device: SyncDeviceRuntimeState): string {
  switch (device.connectionState) {
    case "self":
      return "This desktop";
    case "connected":
      return "Connected";
    default:
      return "Disconnected";
  }
}

function connectionStateLabel(status: SyncRoleSnapshot): string {
  if (status.role === "brain") {
    return status.connectedPeers.length > 0
      ? `${status.connectedPeers.length} controller${status.connectedPeers.length === 1 ? "" : "s"} connected`
      : "Ready for phone pairing";
  }
  switch (status.client.state) {
    case "connected":
      return "Connected to host";
    case "connecting":
      return "Connecting to host";
    case "error":
      return "Host link needs attention";
    default:
      return "Not linked to a host";
  }
}

function summaryTitle(status: SyncRoleSnapshot): string {
  if (status.role === "brain") {
    return status.connectedPeers.length > 0 ? "This Mac is the current host" : "This Mac is ready to host";
  }
  if (status.client.state === "connected") {
    return `This Mac is linked to ${status.currentBrain?.name ?? "the current host"}`;
  }
  if (status.client.state === "connecting") {
    return "This Mac is connecting to a host";
  }
  if (status.client.state === "error") {
    return "Desktop link needs attention";
  }
  return "This Mac is not linked to a host";
}

function summaryBody(status: SyncRoleSnapshot): string {
  if (status.role === "brain") {
    return "Use the phone pairing block below to connect ADE on your iPhone. Desktop-to-desktop linking and host handoff stay under advanced options.";
  }
  if (status.client.state === "connected") {
    return "Phone pairing happens on the current host, not on this controller. Open Sync on the host Mac if you want to pair an iPhone.";
  }
  return "This screen can also link one desktop to another host, but that is an advanced fallback. It is separate from phone pairing.";
}

function connectionTagColor(status: SyncRoleSnapshot): string {
  if (status.client.state === "error") return COLORS.danger;
  if (status.role === "brain" || status.client.state === "connected") return COLORS.success;
  return COLORS.textMuted;
}

function formatEndpoint(host: string | null | undefined, port: number | null | undefined): string {
  if (!host) return "Not published yet";
  return port ? `${host}:${port}` : host;
}

export function SyncDevicesSection() {
  const [status, setStatus] = useState<SyncRoleSnapshot | null>(null);
  const [devices, setDevices] = useState<SyncDeviceRuntimeState[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localName, setLocalName] = useState("");
  const [connectHost, setConnectHost] = useState("");
  const [connectPort, setConnectPort] = useState("8787");
  const [connectToken, setConnectToken] = useState("");
  const [pairingQrDataUrl, setPairingQrDataUrl] = useState<string | null>(null);

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
    if (status.client.savedDraft?.host && !connectHost) {
      setConnectHost(status.client.savedDraft.host);
    }
    if (status.client.savedDraft?.port && connectPort === "8787") {
      setConnectPort(String(status.client.savedDraft.port));
    }
  }, [connectHost, connectPort, status]);

  useEffect(() => {
    let cancelled = false;
    const pairingInfo = status?.pairingConnectInfo;
    if (!pairingInfo?.qrPayloadText) {
      setPairingQrDataUrl(null);
      return;
    }
    void QRCode.toDataURL(pairingInfo.qrPayloadText, {
      width: 240,
      margin: 1,
      errorCorrectionLevel: "M",
      color: {
        dark: "#F4F7FB",
        light: "#11151A",
      },
    }).then((dataUrl) => {
      if (!cancelled) {
        setPairingQrDataUrl(dataUrl);
      }
    }).catch(() => {
      if (!cancelled) {
        setPairingQrDataUrl(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [status?.pairingConnectInfo]);

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
    if (!status) return;
    void runAction(async () => {
      await window.ade.sync.updateLocalDevice({
        name: localName.trim(),
        deviceType: status.localDevice.deviceType,
      });
      setNotice("Host name updated.");
    });
  }, [localName, runAction, status]);

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
        throw new Error("Enter the bootstrap token from the host.");
      }
      const draft: SyncDesktopConnectionDraft = {
        host: connectHost.trim(),
        port: Math.floor(port),
        token: connectToken.trim(),
      };
      await window.ade.sync.connectToBrain(draft);
      setNotice("This desktop is now linked to the host.");
    });
  }, [connectHost, connectPort, connectToken, runAction]);

  const handleDisconnect = useCallback(() => {
    void runAction(async () => {
      await window.ade.sync.disconnectFromBrain();
      setNotice("This desktop is no longer linked to a remote host.");
    });
  }, [runAction]);

  const handleTransfer = useCallback(() => {
    void runAction(async () => {
      await window.ade.sync.transferBrainToLocal();
      setNotice("Hosting moved to this desktop.");
    });
  }, [runAction]);

  const handleForget = useCallback((device: Pick<SyncDeviceRuntimeState, "deviceId" | "connectionState">) => {
    void runAction(async () => {
      await window.ade.sync.forgetDevice(device.deviceId);
      setNotice(device.connectionState === "connected" ? "Device revoked." : "Device removed.");
    });
  }, [runAction]);

  const handleCopyConnectInfo = useCallback(async () => {
    if (!status?.bootstrapToken) return;
    const host = status.localDevice.lastHost ?? "127.0.0.1";
    const port = status.localDevice.lastPort ?? 8787;
    await window.ade.app.writeClipboardText(`Host: ${host}\nPort: ${port}\nToken: ${status.bootstrapToken}`);
    setNotice("Desktop link details copied to the clipboard.");
  }, [status]);

  const handleCopyPairingInfo = useCallback(async () => {
    if (!status?.pairingConnectInfo) return;
    const addressHints = status.pairingConnectInfo.addressCandidates.map((entry) => `${entry.kind}:${entry.host}`).join(", ");
    await window.ade.app.writeClipboardText(
      `Pairing code: ${status.pairingConnectInfo.pairingCode}\nExpires: ${status.pairingConnectInfo.expiresAt}\nPort: ${status.pairingConnectInfo.port}\nAddress candidates: ${addressHints}`,
    );
    setNotice("Phone pairing details copied to the clipboard.");
  }, [status]);

  const handleCopyPairingPayload = useCallback(async () => {
    if (!status?.pairingConnectInfo) return;
    await window.ade.app.writeClipboardText(status.pairingConnectInfo.qrPayloadText);
    setNotice("Phone QR payload copied to the clipboard.");
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

  const isLocalHost = status.role === "brain";
  const currentHostName = status.currentBrain?.name ?? status.localDevice.name;
  const currentHostEndpoint = status.role === "brain"
    ? formatEndpoint(status.pairingConnectInfo?.addressCandidates[0]?.host ?? status.localDevice.lastHost, status.pairingConnectInfo?.port ?? status.localDevice.lastPort)
    : formatEndpoint(status.currentBrain?.lastHost, status.currentBrain?.lastPort);
  const otherDevices = devices.filter((device) => !device.isLocal);
  const pairingInfo = status.pairingConnectInfo;
  const primaryPairAddress = pairingInfo?.addressCandidates[0]?.host ?? status.localDevice.lastHost ?? "127.0.0.1";
  const secondaryPairAddresses = pairingInfo?.addressCandidates.slice(1) ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <section>
        <div style={sectionLabelStyle}>CURRENT SYNC STATE</div>
        <div style={{ ...cardStyle(), display: "grid", gap: 16 }}>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={titleStyle}>{summaryTitle(status)}</div>
            <div style={helperTextStyle}>{summaryBody(status)}</div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <span style={tagStyle(isLocalHost ? COLORS.success : COLORS.info)}>
              {isLocalHost ? "Host mode" : "Controller mode"}
            </span>
            <span style={tagStyle(connectionTagColor(status))}>
              {connectionStateLabel(status)}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <div style={panelStyle}>
              <div style={LABEL_STYLE}>Current host</div>
              <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 18, fontWeight: 700 }}>
                {status.role === "brain" ? "This Mac" : currentHostName}
              </div>
              <div style={helperTextStyle}>{currentHostEndpoint}</div>
            </div>
            <div style={panelStyle}>
              <div style={LABEL_STYLE}>This desktop</div>
              <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 18, fontWeight: 700 }}>
                {status.localDevice.name}
              </div>
              <div style={helperTextStyle}>
                {status.localDevice.platform} · {status.localDevice.deviceType}
              </div>
            </div>
            <div style={panelStyle}>
              <div style={LABEL_STYLE}>Connected controllers</div>
              <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 18, fontWeight: 700 }}>
                {isLocalHost ? status.connectedPeers.length : 0}
              </div>
              <div style={helperTextStyle}>
                {isLocalHost ? "Phones or desktops currently linked to this host." : "Phone pairing happens on the host Mac."}
              </div>
            </div>
          </div>

          {(status.role === "viewer" || status.client.state === "connected") ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button type="button" style={outlineButton()} disabled={busy} onClick={handleDisconnect}>
                Disconnect this desktop
              </button>
            </div>
          ) : null}

          {notice ? <div style={{ ...helperTextStyle, color: COLORS.success }}>{notice}</div> : null}
          {error ? <div style={{ ...helperTextStyle, color: COLORS.danger }}>{error}</div> : null}
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>PHONE PAIRING</div>
        <div style={{ ...cardStyle(), display: "grid", gap: 16 }}>
          {isLocalHost ? (
            pairingInfo ? (
              <>
                <div style={{ display: "grid", gap: 8 }}>
                  <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 20, fontWeight: 700 }}>
                    Pair ADE on your iPhone
                  </div>
                  <div style={helperTextStyle}>
                    On the phone, open ADE, tap the connection controls, then scan this QR code or enter the code manually.
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "240px minmax(260px, 1fr)", gap: 16, alignItems: "start" }}>
                  <div style={{ width: 240, height: 240, borderRadius: 10, overflow: "hidden", border: `1px solid ${COLORS.border}` }}>
                    {pairingQrDataUrl
                      ? <img src={pairingQrDataUrl} alt="Phone pairing QR code" style={{ display: "block", width: "100%", height: "100%" }} />
                      : <div style={{ ...helperTextStyle, display: "grid", placeItems: "center", height: "100%" }}>Generating QR…</div>}
                  </div>

                  <div style={{ display: "grid", gap: 12 }}>
                    <div style={panelStyle}>
                      <div style={LABEL_STYLE}>Manual fallback</div>
                      <div style={codeValueStyle}>
                        <div>Code: {pairingInfo.pairingCode}</div>
                        <div>Host: {primaryPairAddress}</div>
                        <div>Port: {pairingInfo.port}</div>
                        <div>Expires: {formatTimestamp(pairingInfo.expiresAt)}</div>
                      </div>
                    </div>

                    {secondaryPairAddresses.length > 0 ? (
                      <div style={panelStyle}>
                        <div style={LABEL_STYLE}>Other addresses the phone can try</div>
                        <div style={{ display: "grid", gap: 4 }}>
                          {secondaryPairAddresses.map((entry) => (
                            <div key={`${entry.kind}:${entry.host}`} style={helperTextStyle}>
                              {entry.kind}: {entry.host}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div style={panelStyle}>
                      <div style={LABEL_STYLE}>Fastest test path</div>
                      <ol style={{ ...helperTextStyle, margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
                        <li>Open ADE on the phone.</li>
                        <li>Tap the connection button.</li>
                        <li>Scan the QR, or enter `{pairingInfo.pairingCode}` with host `{primaryPairAddress}` and port `{pairingInfo.port}`.</li>
                      </ol>
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button type="button" style={outlineButton()} disabled={busy} onClick={() => void handleCopyPairingInfo()}>
                    Copy phone setup details
                  </button>
                  <button type="button" style={outlineButton()} disabled={busy} onClick={() => void handleCopyPairingPayload()}>
                    Copy raw QR payload
                  </button>
                </div>
              </>
            ) : (
              <div style={helperTextStyle}>Phone pairing is not available yet. Refresh this page or restart ADE if the host was just opened.</div>
            )
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 20, fontWeight: 700 }}>
                Pair the phone on the host Mac
              </div>
              <div style={helperTextStyle}>
                This desktop is acting as a controller, so it cannot mint phone pairing codes. Open Sync on the current host, then pair the phone there.
              </div>
              <div style={panelStyle}>
                <div style={LABEL_STYLE}>Current host</div>
                <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 16, fontWeight: 700 }}>{currentHostName}</div>
                <div style={helperTextStyle}>{currentHostEndpoint}</div>
              </div>
            </div>
          )}
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>PAIRED DEVICES</div>
        <div style={{ display: "grid", gap: 12 }}>
          {otherDevices.length === 0 ? (
            <div style={{ ...cardStyle({ padding: 16 }), ...helperTextStyle }}>
              No phones or remote controllers are registered yet.
            </div>
          ) : otherDevices.map((device) => {
            const canForget = !device.isBrain;
            const forgetLabel = device.connectionState === "connected" ? "Revoke device" : "Forget device";
            return (
              <div key={device.deviceId} style={{ ...cardStyle({ padding: 16 }), display: "grid", gap: 10 }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ display: "grid", gap: 4 }}>
                    <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 700 }}>
                      {device.name}
                    </div>
                    <div style={helperTextStyle}>
                      {device.platform} · {device.deviceType}
                    </div>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {device.isBrain ? <span style={tagStyle(COLORS.success)}>Host</span> : null}
                    <span style={tagStyle(connectionColor(device.connectionState))}>{deviceConnectionLabel(device)}</span>
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
                    <button type="button" style={dangerButton()} disabled={busy} onClick={() => handleForget(device)}>
                      {forgetLabel}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>ADVANCED</div>
        <div style={{ display: "grid", gap: 12 }}>
          <details style={detailBlockStyle}>
            <summary style={detailSummaryStyle}>Name shown to phones during pairing</summary>
            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
              <div style={helperTextStyle}>
                This is the device name the phone sees in discovery and pairing. It does not change ADE project data.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 1fr) auto", gap: 12, alignItems: "end" }}>
                <label style={{ display: "grid", gap: 6 }}>
                  <span style={LABEL_STYLE}>Host name</span>
                  <input value={localName} onChange={(event) => setLocalName(event.target.value)} style={inputStyle} placeholder="This Mac" />
                </label>
                <button
                  type="button"
                  style={primaryButton({ opacity: localName.trim() ? 1 : 0.5 })}
                  disabled={busy || !localName.trim()}
                  onClick={handleSaveLocal}
                >
                  Save host name
                </button>
              </div>
            </div>
          </details>

          <details style={detailBlockStyle}>
            <summary style={detailSummaryStyle}>
              {isLocalHost ? "Connect another desktop manually" : "Connect this desktop to a host manually"}
            </summary>
            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
              <div style={helperTextStyle}>
                This is the desktop-to-desktop fallback. It uses the shared bootstrap token and is separate from normal phone pairing.
              </div>

              {isLocalHost && status.bootstrapToken ? (
                <div style={panelStyle}>
                  <div style={LABEL_STYLE}>Host link details</div>
                  <div style={codeValueStyle}>
                    <div>Host: {status.localDevice.lastHost ?? "127.0.0.1"}</div>
                    <div>Port: {status.localDevice.lastPort ?? 8787}</div>
                    <div>Token: {status.bootstrapToken}</div>
                  </div>
                  <div>
                    <button type="button" style={outlineButton()} disabled={busy} onClick={() => void handleCopyConnectInfo()}>
                      Copy desktop link details
                    </button>
                  </div>
                </div>
              ) : (
                <>
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
                      <input value={connectToken} onChange={(event) => setConnectToken(event.target.value)} style={inputStyle} placeholder="Paste host bootstrap token" />
                    </label>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <button type="button" style={primaryButton()} disabled={busy} onClick={handleConnect}>
                      Connect this desktop
                    </button>
                    {(status.role === "viewer" || status.client.state === "connected") ? (
                      <button type="button" style={outlineButton()} disabled={busy} onClick={handleDisconnect}>
                        Disconnect this desktop
                      </button>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </details>

          {!isLocalHost ? (
            <details style={detailBlockStyle}>
              <summary style={detailSummaryStyle}>Move hosting to this desktop</summary>
              <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
                <div style={helperTextStyle}>
                  This is a host handoff. It does not move live processes. Running missions, chat turns, terminals, or managed processes must stop first.
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button
                    type="button"
                    style={outlineButton({
                      color: status.transferReadiness.ready ? COLORS.textPrimary : COLORS.textMuted,
                      borderColor: status.transferReadiness.ready ? COLORS.accentBorder : COLORS.border,
                    })}
                    disabled={busy || !status.transferReadiness.ready}
                    onClick={handleTransfer}
                  >
                    Make this desktop the host
                  </button>
                </div>

                <div style={{ ...helperTextStyle, color: status.transferReadiness.ready ? COLORS.success : COLORS.warning }}>
                  {status.transferReadiness.ready
                    ? "This desktop can take over hosting now."
                    : "Stop the blocking live work below before moving hosting."}
                </div>

                <div style={panelStyle}>
                  <div style={LABEL_STYLE}>State that survives the handoff</div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {status.transferReadiness.survivableState.map((line) => (
                      <div key={line} style={helperTextStyle}>• {line}</div>
                    ))}
                  </div>
                </div>

                <div style={panelStyle}>
                  <div style={LABEL_STYLE}>Blocking live work</div>
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
            </details>
          ) : null}
        </div>
      </section>
    </div>
  );
}
