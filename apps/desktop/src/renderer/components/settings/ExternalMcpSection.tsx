import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ExternalMcpServerConfig, ExternalMcpServerSnapshot, ExternalMcpUsageEvent } from "../../../shared/types";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  cardStyle,
  dangerButton,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";

type ServerDraft = {
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string;
  args: string;
  cwd: string;
  envLines: string;
  url: string;
  headerLines: string;
  autoStart: boolean;
  healthCheckIntervalSec: string;
  allowedTools: string;
  blockedTools: string;
  defaultCostCents: string;
  perToolCostLines: string;
};

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 10,
};

const fieldLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 10,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 32,
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 0,
  outline: "none",
};

function splitCommaSeparated(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseLineMap(value: string): Record<string, string> | undefined {
  const entries = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const divider = line.indexOf("=");
      if (divider < 0) return null;
      const key = line.slice(0, divider).trim();
      const nextValue = line.slice(divider + 1).trim();
      return key && nextValue ? [key, nextValue] as const : null;
    })
    .filter((entry): entry is readonly [string, string] => entry != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function formatLineMap(value?: Record<string, string>): string {
  if (!value) return "";
  return Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${key}=${entry}`)
    .join("\n");
}

function parsePerToolCosts(value: string): Record<string, number> | undefined {
  const entries = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const divider = line.indexOf("=");
      if (divider < 0) return null;
      const key = line.slice(0, divider).trim();
      const rawCost = Number(line.slice(divider + 1).trim());
      return key && Number.isFinite(rawCost) && rawCost >= 0 ? [key, Math.floor(rawCost)] as const : null;
    })
    .filter((entry): entry is readonly [string, number] => entry != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function formatPerToolCosts(value?: Record<string, number>): string {
  if (!value) return "";
  return Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, cost]) => `${key}=${cost}`)
    .join("\n");
}

function draftFromConfig(config?: ExternalMcpServerConfig | null): ServerDraft {
  return {
    name: config?.name ?? "",
    transport: config?.transport ?? "stdio",
    command: config?.command ?? "",
    args: (config?.args ?? []).join(" "),
    cwd: config?.cwd ?? "",
    envLines: formatLineMap(config?.env),
    url: config?.url ?? "",
    headerLines: formatLineMap(config?.headers),
    autoStart: config?.autoStart !== false,
    healthCheckIntervalSec: config?.healthCheckIntervalSec != null ? String(config.healthCheckIntervalSec) : "30",
    allowedTools: (config?.permissions?.allowedTools ?? []).join(", "),
    blockedTools: (config?.permissions?.blockedTools ?? []).join(", "),
    defaultCostCents: config?.costHints?.defaultCostCents != null ? String(config.costHints.defaultCostCents) : "",
    perToolCostLines: formatPerToolCosts(config?.costHints?.perToolCostCents),
  };
}

function configFromDraft(draft: ServerDraft): ExternalMcpServerConfig {
  const healthCheckIntervalSec = Number(draft.healthCheckIntervalSec.trim());
  const defaultCostCents = Number(draft.defaultCostCents.trim());
  return {
    name: draft.name.trim(),
    transport: draft.transport,
    ...(draft.transport === "stdio"
      ? {
          command: draft.command.trim(),
          ...(draft.args.trim() ? { args: draft.args.trim().split(/\s+/).filter(Boolean) } : {}),
          ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
          ...(parseLineMap(draft.envLines) ? { env: parseLineMap(draft.envLines) } : {}),
        }
      : {
          url: draft.url.trim(),
          ...(parseLineMap(draft.headerLines) ? { headers: parseLineMap(draft.headerLines) } : {}),
        }),
    autoStart: draft.autoStart,
    ...(Number.isFinite(healthCheckIntervalSec) && healthCheckIntervalSec > 0
      ? { healthCheckIntervalSec: Math.floor(healthCheckIntervalSec) }
      : {}),
    ...(splitCommaSeparated(draft.allowedTools).length || splitCommaSeparated(draft.blockedTools).length
      ? {
          permissions: {
            ...(splitCommaSeparated(draft.allowedTools).length ? { allowedTools: splitCommaSeparated(draft.allowedTools) } : {}),
            ...(splitCommaSeparated(draft.blockedTools).length ? { blockedTools: splitCommaSeparated(draft.blockedTools) } : {}),
          },
        }
      : {}),
    ...(Number.isFinite(defaultCostCents) || parsePerToolCosts(draft.perToolCostLines)
      ? {
          costHints: {
            ...(Number.isFinite(defaultCostCents) && defaultCostCents >= 0 ? { defaultCostCents: Math.floor(defaultCostCents) } : {}),
            ...(parsePerToolCosts(draft.perToolCostLines) ? { perToolCostCents: parsePerToolCosts(draft.perToolCostLines) } : {}),
          },
        }
      : {}),
  };
}

function formatTimestamp(value?: string | null): string {
  if (!value) return "Never";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export function ExternalMcpSection() {
  const [configs, setConfigs] = useState<ExternalMcpServerConfig[]>([]);
  const [snapshots, setSnapshots] = useState<ExternalMcpServerSnapshot[]>([]);
  const [usageEvents, setUsageEvents] = useState<ExternalMcpUsageEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyServerName, setBusyServerName] = useState<string | null>(null);
  const [editingServerName, setEditingServerName] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerDraft>(draftFromConfig());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!window.ade?.externalMcp) {
      setConfigs([]);
      setSnapshots([]);
      setUsageEvents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextConfigs, nextSnapshots, nextUsage] = await Promise.all([
        window.ade.externalMcp.listConfigs(),
        window.ade.externalMcp.listServers(),
        window.ade.externalMcp.getUsageEvents({ limit: 12 }),
      ]);
      setConfigs(nextConfigs);
      setSnapshots(nextSnapshots);
      setUsageEvents(nextUsage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load external MCP state.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!window.ade?.externalMcp?.onEvent) return undefined;
    return window.ade.externalMcp.onEvent(() => {
      void refresh();
    });
  }, [refresh]);

  const snapshotByName = useMemo(
    () => new Map(snapshots.map((entry) => [entry.config.name, entry] as const)),
    [snapshots],
  );

  const handleEdit = (config?: ExternalMcpServerConfig | null) => {
    setEditingServerName(config?.name ?? null);
    setDraft(draftFromConfig(config));
    setNotice(null);
    setError(null);
  };

  const handleSave = async () => {
    if (!window.ade?.externalMcp) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      await window.ade.externalMcp.saveServer(configFromDraft(draft));
      await refresh();
      setEditingServerName(null);
      setDraft(draftFromConfig());
      setNotice(`Saved external MCP server '${draft.name.trim()}'.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save server.");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!window.ade?.externalMcp) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const snapshot = await window.ade.externalMcp.testServer(configFromDraft(draft));
      setNotice(`Test succeeded for '${snapshot.config.name}' with ${snapshot.toolCount} discovered tool(s).`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection test failed.");
    } finally {
      setSaving(false);
    }
  };

  const handleConnect = async (serverName: string) => {
    if (!window.ade?.externalMcp) return;
    setBusyServerName(serverName);
    setError(null);
    try {
      await window.ade.externalMcp.connectServer(serverName);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to connect '${serverName}'.`);
    } finally {
      setBusyServerName(null);
    }
  };

  const handleDisconnect = async (serverName: string) => {
    if (!window.ade?.externalMcp) return;
    setBusyServerName(serverName);
    setError(null);
    try {
      await window.ade.externalMcp.disconnectServer(serverName);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to disconnect '${serverName}'.`);
    } finally {
      setBusyServerName(null);
    }
  };

  const handleRemove = async (serverName: string) => {
    if (!window.ade?.externalMcp) return;
    const confirmed = window.confirm(`Remove external MCP server '${serverName}'?`);
    if (!confirmed) return;
    setBusyServerName(serverName);
    setError(null);
    try {
      await window.ade.externalMcp.removeServer(serverName);
      if (editingServerName === serverName) {
        setEditingServerName(null);
        setDraft(draftFromConfig());
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to remove '${serverName}'.`);
    } finally {
      setBusyServerName(null);
    }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={cardStyle({ padding: 16 })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={sectionLabelStyle}>External MCP</div>
            <div style={{ fontSize: 12, color: COLORS.textSecondary, fontFamily: MONO_FONT, lineHeight: 1.5 }}>
              Configure external MCP once in ADE. Mission workers, direct worker chats, and CTO sessions then inherit the filtered tool surface through ADE’s own MCP layer.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={outlineButton()} onClick={() => void refresh()} disabled={loading || saving}>
              Refresh
            </button>
            <button type="button" style={primaryButton()} onClick={() => handleEdit(null)} disabled={saving}>
              Add MCP Server
            </button>
          </div>
        </div>
        {notice && <div style={{ marginTop: 10, color: COLORS.success, fontFamily: MONO_FONT, fontSize: 11 }}>{notice}</div>}
        {error && <div style={{ marginTop: 10, color: COLORS.danger, fontFamily: MONO_FONT, fontSize: 11 }}>{error}</div>}
      </div>

      <div style={{ ...cardStyle({ padding: 16 }), display: "grid", gap: 12 }}>
        <div style={sectionLabelStyle}>{editingServerName ? `Edit ${editingServerName}` : "Server Editor"}</div>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={fieldLabelStyle}>Name</span>
            <input style={inputStyle} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={fieldLabelStyle}>Transport</span>
            <select
              style={inputStyle}
              value={draft.transport}
              onChange={(event) => setDraft((current) => ({ ...current, transport: event.target.value as ServerDraft["transport"] }))}
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="sse">sse (compat)</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={fieldLabelStyle}>Health Interval (sec)</span>
            <input
              style={inputStyle}
              value={draft.healthCheckIntervalSec}
              onChange={(event) => setDraft((current) => ({ ...current, healthCheckIntervalSec: event.target.value }))}
            />
          </label>
        </div>

        {draft.transport === "stdio" ? (
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={fieldLabelStyle}>Command</span>
              <input style={inputStyle} value={draft.command} onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={fieldLabelStyle}>Args</span>
              <input style={inputStyle} value={draft.args} onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value }))} />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={fieldLabelStyle}>Working Directory</span>
              <input style={inputStyle} value={draft.cwd} onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))} />
            </label>
            <label style={{ display: "grid", gap: 4, gridColumn: "1 / -1" }}>
              <span style={fieldLabelStyle}>Environment (`KEY=value` per line)</span>
              <textarea
                style={{ ...inputStyle, minHeight: 88 }}
                value={draft.envLines}
                onChange={(event) => setDraft((current) => ({ ...current, envLines: event.target.value }))}
              />
            </label>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={fieldLabelStyle}>URL</span>
              <input style={inputStyle} value={draft.url} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} />
            </label>
            <label style={{ display: "grid", gap: 4, gridColumn: "1 / -1" }}>
              <span style={fieldLabelStyle}>Headers (`KEY=value` per line)</span>
              <textarea
                style={{ ...inputStyle, minHeight: 88 }}
                value={draft.headerLines}
                onChange={(event) => setDraft((current) => ({ ...current, headerLines: event.target.value }))}
              />
            </label>
          </div>
        )}

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={fieldLabelStyle}>Allowed Tools</span>
            <input style={inputStyle} value={draft.allowedTools} onChange={(event) => setDraft((current) => ({ ...current, allowedTools: event.target.value }))} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={fieldLabelStyle}>Blocked Tools</span>
            <input style={inputStyle} value={draft.blockedTools} onChange={(event) => setDraft((current) => ({ ...current, blockedTools: event.target.value }))} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={fieldLabelStyle}>Default Cost (cents)</span>
            <input style={inputStyle} value={draft.defaultCostCents} onChange={(event) => setDraft((current) => ({ ...current, defaultCostCents: event.target.value }))} />
          </label>
          <label style={{ display: "grid", gap: 4, gridColumn: "1 / -1" }}>
            <span style={fieldLabelStyle}>Per Tool Cost (`tool=value` per line)</span>
            <textarea
              style={{ ...inputStyle, minHeight: 72 }}
              value={draft.perToolCostLines}
              onChange={(event) => setDraft((current) => ({ ...current, perToolCostLines: event.target.value }))}
            />
          </label>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary }}>
          <input
            type="checkbox"
            checked={draft.autoStart}
            onChange={(event) => setDraft((current) => ({ ...current, autoStart: event.target.checked }))}
          />
          Auto-start this server when ADE loads the project
        </label>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" style={outlineButton()} onClick={() => handleEdit(null)} disabled={saving}>
            Reset
          </button>
          <button type="button" style={outlineButton()} onClick={() => void handleTest()} disabled={saving}>
            {saving ? "Working..." : "Test Connection"}
          </button>
          <button type="button" style={primaryButton()} onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving..." : "Save Server"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <div style={sectionLabelStyle}>Configured Servers</div>
        {loading ? (
          <div style={cardStyle({ padding: 16 })}>
            <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>Loading external MCP registry…</div>
          </div>
        ) : configs.length === 0 ? (
          <div style={cardStyle({ padding: 16 })}>
            <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
              No external MCP servers are configured yet.
            </div>
          </div>
        ) : (
          configs.map((config) => {
            const snapshot = snapshotByName.get(config.name);
            return (
              <div key={config.name} style={cardStyle({ padding: 16 })}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: MONO_FONT, fontSize: 13, fontWeight: 700, color: COLORS.textPrimary }}>
                      {config.name}
                    </div>
                    <div style={{ marginTop: 4, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
                      {config.transport === "stdio"
                        ? `${config.command ?? "(missing command)"} ${config.args?.join(" ") ?? ""}`.trim()
                        : config.url}
                    </div>
                    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 10, fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
                      <span>State: {snapshot?.state ?? "disconnected"}</span>
                      <span>Tools: {snapshot?.toolCount ?? 0}</span>
                      <span>Auto-start: {config.autoStart === false ? "off" : "on"}</span>
                      <span>Last connected: {formatTimestamp(snapshot?.lastConnectedAt)}</span>
                    </div>
                    {snapshot?.lastError && (
                      <div style={{ marginTop: 8, fontFamily: MONO_FONT, fontSize: 10, color: COLORS.danger }}>
                        {snapshot.lastError}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <button type="button" style={outlineButton()} onClick={() => handleEdit(config)} disabled={busyServerName === config.name}>
                      Edit
                    </button>
                    {snapshot?.state === "connected" ? (
                      <button type="button" style={outlineButton()} onClick={() => void handleDisconnect(config.name)} disabled={busyServerName === config.name}>
                        Disconnect
                      </button>
                    ) : (
                      <button type="button" style={outlineButton()} onClick={() => void handleConnect(config.name)} disabled={busyServerName === config.name}>
                        Connect
                      </button>
                    )}
                    <button type="button" style={dangerButton()} onClick={() => void handleRemove(config.name)} disabled={busyServerName === config.name}>
                      Remove
                    </button>
                  </div>
                </div>

                {snapshot?.tools?.length ? (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ ...fieldLabelStyle, marginBottom: 6 }}>Discovered Tools</div>
                    <div style={{ display: "grid", gap: 6 }}>
                      {snapshot.tools.map((tool) => (
                        <div
                          key={tool.namespacedName}
                          style={{
                            display: "grid",
                            gap: 2,
                            border: `1px solid ${COLORS.outlineBorder}`,
                            background: COLORS.recessedBg,
                            padding: "8px 10px",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                            <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary }}>
                              {tool.namespacedName}
                            </span>
                            <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: tool.safety === "write" ? COLORS.warning : COLORS.info }}>
                              {tool.safety}
                            </span>
                          </div>
                          {tool.description && (
                            <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
                              {tool.description}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div style={cardStyle({ padding: 16 })}>
        <div style={sectionLabelStyle}>Recent External Tool Usage</div>
        {usageEvents.length === 0 ? (
          <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
            No external MCP tool usage has been recorded yet.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {usageEvents.map((event) => (
              <div
                key={event.id}
                style={{
                  display: "grid",
                  gap: 4,
                  border: `1px solid ${COLORS.outlineBorder}`,
                  background: COLORS.recessedBg,
                  padding: "8px 10px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary }}>
                    {event.namespacedToolName}
                  </span>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
                    {formatTimestamp(event.occurredAt)}
                  </span>
                </div>
                <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
                  {event.callerRole}:{event.callerId} · {event.costCents}c {event.estimated ? "(estimated)" : "(exact)"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
