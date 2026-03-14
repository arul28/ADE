import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ExternalConnectionAuthRecord,
  ExternalConnectionAuthRecordInput,
  ExternalConnectionOAuthSessionStartResult,
  ExternalMcpManagedAuthConfig,
  ExternalMcpServerConfig,
  ExternalMcpServerSnapshot,
  ExternalMcpUsageEvent,
} from "../../../shared/types";
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
  authMode: "none" | "api_key" | "bearer" | "oauth";
  authId: string;
  authDisplayName: string;
  authPlacementTarget: "header" | "env";
  authPlacementKey: string;
  authPlacementPrefix: string;
  authSecret: string;
  oauthAuthorizeUrl: string;
  oauthTokenUrl: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
  oauthAudience: string;
  oauthExtraAuthorizeLines: string;
  oauthExtraTokenLines: string;
};

type StarterTemplate = {
  id: string;
  label: string;
  description: string;
  config: ExternalMcpServerConfig;
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

const helperTextStyle: React.CSSProperties = {
  fontSize: 10,
  fontFamily: MONO_FONT,
  color: COLORS.textMuted,
  lineHeight: 1.5,
};

const starterButtonStyle = (active: boolean): React.CSSProperties => ({
  display: "grid",
  gap: 4,
  minWidth: 180,
  padding: "10px 12px",
  textAlign: "left",
  background: active ? COLORS.cardBg : COLORS.recessedBg,
  border: `1px solid ${active ? COLORS.accentBorder : COLORS.outlineBorder}`,
  color: COLORS.textPrimary,
  borderRadius: 0,
  cursor: "pointer",
});

const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: "stdio-local",
    label: "Local stdio server",
    description: "For npm, npx, uvx, python, or node-based MCP servers that run on your machine.",
    config: {
      name: "",
      transport: "stdio",
      command: "npx",
      args: [],
      autoStart: true,
      healthCheckIntervalSec: 30,
    },
  },
  {
    id: "ghost-os",
    label: "Ghost OS",
    description: "macOS computer-use backend over stdio. Install Ghost OS locally, run `ghost setup`, then let ADE launch `ghost mcp`.",
    config: {
      name: "Ghost OS",
      transport: "stdio",
      command: "ghost",
      args: ["mcp"],
      autoStart: true,
      healthCheckIntervalSec: 30,
    },
  },
  {
    id: "remote-bearer",
    label: "Remote bearer auth",
    description: "For hosted MCP endpoints that expect Authorization: Bearer <token>.",
    config: {
      name: "",
      transport: "http",
      url: "",
      auth: {
        authId: "",
        mode: "bearer",
        placement: { target: "header", key: "Authorization", prefix: "Bearer " },
      },
      autoStart: true,
      healthCheckIntervalSec: 30,
    },
  },
  {
    id: "remote-api-key",
    label: "Remote API key header",
    description: "For hosted MCP endpoints that use x-api-key or a custom header instead of Bearer auth.",
    config: {
      name: "",
      transport: "http",
      url: "",
      auth: {
        authId: "",
        mode: "api_key",
        placement: { target: "header", key: "x-api-key", prefix: "" },
      },
      autoStart: true,
      healthCheckIntervalSec: 30,
    },
  },
  {
    id: "remote-oauth",
    label: "Remote OAuth server",
    description: "For hosted MCP providers that need a browser-based account connect flow.",
    config: {
      name: "",
      transport: "http",
      url: "",
      auth: {
        authId: "",
        mode: "oauth",
        placement: { target: "header", key: "Authorization", prefix: "Bearer " },
      },
      autoStart: true,
      healthCheckIntervalSec: 30,
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const next = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return next.length ? next : undefined;
}

function readStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .map(([key, entry]) => {
      const nextKey = key.trim();
      if (!nextKey.length || entry == null) return null;
      return [nextKey, String(entry)] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry != null);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const lines = trimmed.split(/\r?\n/);
  if (lines.length >= 2 && lines.at(-1)?.startsWith("```")) {
    return lines.slice(1, -1).join("\n").trim();
  }
  return trimmed;
}

function parsePastedJson(value: string): unknown {
  const trimmed = stripCodeFence(value);
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  const candidate = trimmed.startsWith("{") && trimmed.endsWith("}")
    ? trimmed
    : (firstBrace >= 0 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : trimmed);
  return JSON.parse(candidate);
}

function normalizeImportedTransport(value: string | undefined): ServerDraft["transport"] {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "stdio") return "stdio";
  if (normalized === "http" || normalized === "streamable_http" || normalized === "streamable-http") return "http";
  if (normalized === "sse") return "sse";
  return "stdio";
}

function normalizeImportedServer(rawValue: unknown, nameHint?: string): ExternalMcpServerConfig {
  if (!isRecord(rawValue)) {
    throw new Error("The pasted MCP config is not a valid server object.");
  }

  const rawName = readStringValue(rawValue.name) ?? nameHint;
  const name = rawName?.trim();
  if (!name) {
    throw new Error("The pasted MCP config is missing a server name.");
  }

  const transport = normalizeImportedTransport(readStringValue(rawValue.transport) ?? readStringValue(rawValue.type));
  const commandValue = rawValue.command;
  const commandParts = Array.isArray(commandValue)
    ? commandValue.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
    : [];
  const command = readStringValue(commandValue) ?? commandParts[0];
  const args = readStringList(rawValue.args)
    ?? (commandParts.length > 1 ? commandParts.slice(1) : undefined);
  const url = readStringValue(rawValue.url) ?? readStringValue(rawValue.endpoint);
  const env = readStringMap(rawValue.env);
  const headers = readStringMap(rawValue.headers);
  const allowedTools = readStringList(rawValue.allowedTools)
    ?? readStringList(isRecord(rawValue.permissions) ? rawValue.permissions.allowedTools : undefined);
  const blockedTools = readStringList(rawValue.blockedTools)
    ?? readStringList(isRecord(rawValue.permissions) ? rawValue.permissions.blockedTools : undefined);
  const healthCheckIntervalSec = Number(rawValue.healthCheckIntervalSec ?? NaN);
  const autoStart = typeof rawValue.autoStart === "boolean" ? rawValue.autoStart : true;

  if (transport === "stdio" && !command) {
    throw new Error("The pasted stdio MCP config is missing a command.");
  }
  if (transport !== "stdio" && !url) {
    throw new Error("The pasted remote MCP config is missing a URL.");
  }

  return {
    name,
    transport,
    ...(transport === "stdio"
      ? {
          command,
          ...(args?.length ? { args } : {}),
          ...(readStringValue(rawValue.cwd) ? { cwd: readStringValue(rawValue.cwd) } : {}),
          ...(env ? { env } : {}),
        }
      : {
          url,
          ...(headers ? { headers } : {}),
        }),
    autoStart,
    ...(Number.isFinite(healthCheckIntervalSec) && healthCheckIntervalSec > 0
      ? { healthCheckIntervalSec: Math.floor(healthCheckIntervalSec) }
      : {}),
    ...(allowedTools?.length || blockedTools?.length
      ? {
          permissions: {
            ...(allowedTools?.length ? { allowedTools } : {}),
            ...(blockedTools?.length ? { blockedTools } : {}),
          },
        }
      : {}),
  };
}

function parseImportedServerConfig(value: string): ExternalMcpServerConfig {
  const trimmed = stripCodeFence(value);
  if (!trimmed.length) {
    throw new Error("Paste a JSON snippet or an add-json command first.");
  }

  const addJsonMatch = trimmed.match(/\badd-json\s+(['"]?)([^'"{\s]+)\1\s+/i);
  const parsed = parsePastedJson(trimmed);
  if (!isRecord(parsed)) {
    throw new Error("The pasted content did not contain a valid MCP config object.");
  }

  if (isRecord(parsed.mcpServers)) {
    const entries = Object.entries(parsed.mcpServers).filter(([, entry]) => isRecord(entry));
    if (entries.length !== 1) {
      throw new Error("Paste one MCP server at a time so ADE can load it into the editor.");
    }
    const [name, server] = entries[0]!;
    return normalizeImportedServer(server, name);
  }

  const directConfig = normalizeImportedServer(parsed, addJsonMatch?.[2]);
  return directConfig;
}

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

function parseAuthParamLines(value: string): Record<string, string> | undefined {
  return parseLineMap(value);
}

function formatAuthParamLines(value?: Record<string, string>): string {
  return formatLineMap(value);
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
    authMode: config?.auth?.mode ?? "none",
    authId: config?.auth?.authId ?? "",
    authDisplayName: config?.name ? `${config.name} auth` : "",
    authPlacementTarget: config?.auth?.placement.target ?? "header",
    authPlacementKey: config?.auth?.placement.key ?? "Authorization",
    authPlacementPrefix: config?.auth?.placement.prefix ?? (config?.auth?.mode === "api_key" ? "" : "Bearer "),
    authSecret: "",
    oauthAuthorizeUrl: "",
    oauthTokenUrl: "",
    oauthClientId: "",
    oauthClientSecret: "",
    oauthScope: "",
    oauthAudience: "",
    oauthExtraAuthorizeLines: "",
    oauthExtraTokenLines: "",
  };
}

function buildManagedAuthBinding(draft: ServerDraft, authId: string): ExternalMcpManagedAuthConfig | undefined {
  if (draft.authMode === "none") return undefined;
  const key = draft.authPlacementKey.trim();
  if (!authId.trim().length || !key.length) return undefined;
  return {
    authId: authId.trim(),
    mode: draft.authMode,
    placement: {
      target: draft.authPlacementTarget,
      key,
      prefix: draft.authPlacementPrefix,
    },
  };
}

function configFromDraft(draft: ServerDraft, authId: string): ExternalMcpServerConfig {
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
    ...(buildManagedAuthBinding(draft, authId) ? { auth: buildManagedAuthBinding(draft, authId) } : {}),
  };
}

function applyAuthRecordToDraft(draft: ServerDraft, record?: ExternalConnectionAuthRecord | null): ServerDraft {
  if (!record) return draft;
  return {
    ...draft,
    authId: record.id,
    authDisplayName: record.displayName,
    authMode: record.mode,
    oauthAuthorizeUrl: record.oauth?.authorizeUrl ?? draft.oauthAuthorizeUrl,
    oauthTokenUrl: record.oauth?.tokenUrl ?? draft.oauthTokenUrl,
    oauthClientId: record.oauth?.clientId ?? draft.oauthClientId,
    oauthScope: record.oauth?.scope ?? "",
    oauthAudience: record.oauth?.audience ?? "",
    oauthExtraAuthorizeLines: formatAuthParamLines(record.oauth?.extraAuthorizeParams),
    oauthExtraTokenLines: formatAuthParamLines(record.oauth?.extraTokenParams),
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
  const [authRecords, setAuthRecords] = useState<ExternalConnectionAuthRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyServerName, setBusyServerName] = useState<string | null>(null);
  const [editingServerName, setEditingServerName] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerDraft>(draftFromConfig());
  const [importText, setImportText] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [authEnvVar, setAuthEnvVar] = useState("MCP_API_KEY");
  const [authHeaderName, setAuthHeaderName] = useState("Authorization");
  const [authHeaderPrefix, setAuthHeaderPrefix] = useState("Bearer ");
  const [oauthSession, setOauthSession] = useState<ExternalConnectionOAuthSessionStartResult | null>(null);
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
      const [nextConfigs, nextSnapshots, nextUsage, nextAuthRecords] = await Promise.all([
        window.ade.externalMcp.listConfigs(),
        window.ade.externalMcp.listServers(),
        window.ade.externalMcp.getUsageEvents({ limit: 12 }),
        window.ade.externalMcp.listAuthRecords(),
      ]);
      setConfigs(nextConfigs);
      setSnapshots(nextSnapshots);
      setUsageEvents(nextUsage);
      setAuthRecords(nextAuthRecords);
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
  const authRecordById = useMemo(
    () => new Map(authRecords.map((entry) => [entry.id, entry] as const)),
    [authRecords],
  );

  useEffect(() => {
    if (!oauthSession || !window.ade?.externalMcp) return undefined;
    let cancelled = false;
    const interval = window.setInterval(() => {
      void window.ade.externalMcp.getOAuthSession(oauthSession.sessionId).then((status) => {
        if (cancelled) return;
        if (status.status === "completed") {
          setOauthSession(null);
          setNotice("OAuth account connected. Test the server, then connect it.");
          setError(null);
          void refresh();
          return;
        }
        if (status.status === "failed" || status.status === "expired") {
          setOauthSession(null);
          setError(status.error ?? "OAuth setup did not complete.");
        }
      }).catch((err) => {
        if (cancelled) return;
        setOauthSession(null);
        setError(err instanceof Error ? err.message : "OAuth setup did not complete.");
      });
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [oauthSession, refresh]);

  const handleEdit = (config?: ExternalMcpServerConfig | null) => {
    setEditingServerName(config?.name ?? null);
    setDraft(applyAuthRecordToDraft(draftFromConfig(config), config?.auth?.authId ? authRecordById.get(config.auth.authId) ?? null : null));
    setSelectedTemplateId(null);
    setNotice(null);
    setError(null);
  };

  const buildAuthRecordInput = (): ExternalConnectionAuthRecordInput | null => {
    if (draft.authMode === "none") return null;
    const displayName = draft.authDisplayName.trim() || `${draft.name.trim() || "External MCP"} auth`;
    if (draft.authMode === "oauth") {
      return {
        ...(draft.authId.trim() ? { id: draft.authId.trim() } : {}),
        displayName,
        mode: "oauth",
        oauth: {
          authorizeUrl: draft.oauthAuthorizeUrl.trim(),
          tokenUrl: draft.oauthTokenUrl.trim(),
          clientId: draft.oauthClientId.trim(),
          clientSecret: draft.oauthClientSecret.trim() || null,
          scope: draft.oauthScope.trim() || null,
          audience: draft.oauthAudience.trim() || null,
          extraAuthorizeParams: parseAuthParamLines(draft.oauthExtraAuthorizeLines),
          extraTokenParams: parseAuthParamLines(draft.oauthExtraTokenLines),
        },
      };
    }
    return {
      ...(draft.authId.trim() ? { id: draft.authId.trim() } : {}),
      displayName,
      mode: draft.authMode,
      secret: draft.authSecret.trim() || null,
    };
  };

  const saveManagedAuthRecord = async (): Promise<ExternalConnectionAuthRecord | null> => {
    if (!window.ade?.externalMcp) return null;
    const input = buildAuthRecordInput();
    if (!input) return null;
    const record = await window.ade.externalMcp.saveAuthRecord(input);
    setDraft((current) => ({
      ...current,
      authId: record.id,
      authDisplayName: record.displayName,
      authMode: record.mode,
      authSecret: "",
      oauthClientSecret: "",
    }));
    return record;
  };

  const handleSave = async () => {
    if (!window.ade?.externalMcp) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const authRecord = await saveManagedAuthRecord();
      await window.ade.externalMcp.saveServer(configFromDraft(draft, authRecord?.id ?? draft.authId.trim()));
      await refresh();
      setEditingServerName(null);
      setDraft(draftFromConfig());
      setSelectedTemplateId(null);
      setNotice(`Saved external MCP server '${draft.name.trim()}'.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save server.");
    } finally {
      setSaving(false);
    }
  };

  const handleImportPreview = () => {
    setNotice(null);
    setError(null);
    try {
      const imported = parseImportedServerConfig(importText);
      setEditingServerName(imported.name);
      setDraft(draftFromConfig(imported));
      setSelectedTemplateId(null);
      setNotice(`Loaded '${imported.name}' into the editor. Review it, then save when ready.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse the pasted MCP config.");
    }
  };

  const handleApplyTemplate = (template: StarterTemplate) => {
    setSelectedTemplateId(template.id);
    setEditingServerName(template.config.name ?? null);
    setDraft(draftFromConfig(template.config));
    setNotice(null);
    setError(null);
  };

  const applyAuthHeaderHelper = () => {
    const envVar = authEnvVar.trim();
    const headerName = authHeaderName.trim();
    if (!envVar.length || !headerName.length) {
      setError("Auth helper requires both a header name and an environment variable.");
      setNotice(null);
      return;
    }
    if (draft.authMode === "none") {
      const nextMode = authHeaderPrefix.trim().length ? "bearer" : "api_key";
      setDraft((current) => ({
        ...current,
        authMode: nextMode,
        authPlacementTarget: "header",
        authPlacementKey: headerName,
        authPlacementPrefix: authHeaderPrefix,
      }));
      setNotice(`Configured managed ${nextMode === "bearer" ? "bearer" : "API key"} auth for ${headerName}. Add the credential below, then save.`);
      setError(null);
      return;
    }
    const currentHeaders = parseLineMap(draft.headerLines) ?? {};
    currentHeaders[headerName] = `${authHeaderPrefix}\${env:${envVar}}`;
    setDraft((current) => ({ ...current, headerLines: formatLineMap(currentHeaders) }));
    setNotice(`Applied manual ${headerName} header using \${env:${envVar}}.`);
    setError(null);
  };

  const handleTest = async () => {
    if (!window.ade?.externalMcp) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const authRecord = await saveManagedAuthRecord();
      const snapshot = await window.ade.externalMcp.testServer(configFromDraft(draft, authRecord?.id ?? draft.authId.trim()));
      setNotice(`Test succeeded for '${snapshot.config.name}' with ${snapshot.toolCount} discovered tool(s).`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection test failed.");
    } finally {
      setSaving(false);
    }
  };

  const handleConnectOAuth = async () => {
    if (!window.ade?.externalMcp) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const authRecord = await saveManagedAuthRecord();
      if (!authRecord) throw new Error("Save the auth settings before connecting an account.");
      const session = await window.ade.externalMcp.startOAuthSession(authRecord.id);
      setOauthSession(session);
      await window.ade.app.openExternal(session.authUrl);
      setNotice("Opened the OAuth consent screen in your browser. Finish it there, then ADE will refresh automatically.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start OAuth.");
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
        <div style={sectionLabelStyle}>Starter Templates</div>
        <div style={helperTextStyle}>
          Pick the closest setup shape first if you are starting from scratch. If a provider already gave you JSON, use Quick Import instead.
        </div>
        <div
          style={{
            display: "grid",
            gap: 6,
            padding: "10px 12px",
            border: `1px solid ${COLORS.outlineBorder}`,
            background: COLORS.recessedBg,
          }}
        >
          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, fontWeight: 700 }}>
            Auth guide
          </div>
          <div style={helperTextStyle}>
            API key / bearer servers can be fully configured inside ADE. OAuth servers can also be handled in ADE if the provider’s authorize/token endpoints are known.
          </div>
          <div style={helperTextStyle}>
            Ghost is the simple case: it does not use webpage OAuth. Enter your Ghost site URL and Ghost Admin API key and ADE will inject them for every ADE-launched session.
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {STARTER_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              style={starterButtonStyle(selectedTemplateId === template.id)}
              onClick={() => handleApplyTemplate(template)}
              disabled={saving}
            >
              <span style={{ fontSize: 11, fontFamily: MONO_FONT, fontWeight: 700, color: COLORS.textPrimary }}>
                {template.label}
              </span>
              <span style={helperTextStyle}>{template.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ ...cardStyle({ padding: 16 }), display: "grid", gap: 12 }}>
        <div style={sectionLabelStyle}>Quick Import</div>
        <div style={helperTextStyle}>
          Most hosted MCP providers hand you a JSON snippet or a <code>claude mcp add-json ...</code> command.
          Paste that here and ADE will load the server into the editor so you can review it before saving.
        </div>
        <textarea
          style={{ ...inputStyle, minHeight: 120 }}
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
          placeholder={`{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}}`}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
          <div style={helperTextStyle}>
            Supported: one-server JSON snippets, <code>mcpServers</code> JSON, or <code>claude mcp add-json</code> commands.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              style={outlineButton()}
              onClick={() => {
                setImportText("");
                setNotice(null);
                setError(null);
              }}
              disabled={saving}
            >
              Clear
            </button>
            <button type="button" style={primaryButton()} onClick={handleImportPreview} disabled={saving}>
              Load Into Editor
            </button>
          </div>
        </div>
      </div>

      <div style={{ ...cardStyle({ padding: 16 }), display: "grid", gap: 12 }}>
        <div style={sectionLabelStyle}>{editingServerName ? `Review ${editingServerName}` : "Review and Save"}</div>
        <div style={helperTextStyle}>
          Start with server identity and auth below. Raw headers and env are still available, but they are an advanced escape hatch now.
        </div>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={fieldLabelStyle}>Name</span>
            <input style={inputStyle} value={draft.name} placeholder="playwright" onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
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
              placeholder="30"
              value={draft.healthCheckIntervalSec}
              onChange={(event) => setDraft((current) => ({ ...current, healthCheckIntervalSec: event.target.value }))}
            />
          </label>
        </div>

        <div style={{ display: "grid", gap: 12, paddingTop: 4, borderTop: `1px solid ${COLORS.outlineBorder}` }}>
          <div style={fieldLabelStyle}>Step 1: auth</div>
          <div style={helperTextStyle}>
            Managed auth keeps credentials in ADE’s encrypted store and materializes them into headers or env vars only at connect time.
          </div>
          {draft.name.trim() === "Ghost OS" || draft.command.trim() === "ghost" ? (
            <div
              style={{
                display: "grid",
                gap: 6,
                padding: "10px 12px",
                border: `1px solid ${COLORS.outlineBorder}`,
                background: COLORS.recessedBg,
              }}
            >
              <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, fontWeight: 700 }}>
                Ghost setup
              </div>
              <div style={helperTextStyle}>
                Ghost OS does not use ADE-managed OAuth or API keys. Install the <code>ghost</code> CLI on this Mac, run <code>ghost setup</code> once to grant permissions and install the vision sidecar, then let ADE launch <code>ghost mcp</code>.
              </div>
            </div>
          ) : null}
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={fieldLabelStyle}>Auth mode</span>
              <select
                style={inputStyle}
                value={draft.authMode}
                onChange={(event) => setDraft((current) => ({ ...current, authMode: event.target.value as ServerDraft["authMode"] }))}
              >
                <option value="none">No managed auth</option>
                <option value="api_key">API key</option>
                <option value="bearer">Bearer token</option>
                <option value="oauth">OAuth account</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={fieldLabelStyle}>Auth label</span>
              <input
                style={inputStyle}
                value={draft.authDisplayName}
                placeholder={`${draft.name || "Server"} auth`}
                onChange={(event) => setDraft((current) => ({ ...current, authDisplayName: event.target.value }))}
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={fieldLabelStyle}>Inject into</span>
              <select
                style={inputStyle}
                value={draft.authPlacementTarget}
                onChange={(event) => setDraft((current) => ({ ...current, authPlacementTarget: event.target.value as ServerDraft["authPlacementTarget"] }))}
                disabled={draft.authMode === "none"}
              >
                <option value="header">HTTP header</option>
                <option value="env">Environment variable</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={fieldLabelStyle}>{draft.authPlacementTarget === "header" ? "Header name" : "Env key"}</span>
              <input
                style={inputStyle}
                value={draft.authPlacementKey}
                onChange={(event) => setDraft((current) => ({ ...current, authPlacementKey: event.target.value }))}
                disabled={draft.authMode === "none"}
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={fieldLabelStyle}>Prefix</span>
              <input
                style={inputStyle}
                value={draft.authPlacementPrefix}
                onChange={(event) => setDraft((current) => ({ ...current, authPlacementPrefix: event.target.value }))}
                disabled={draft.authMode === "none"}
                placeholder={draft.authMode === "api_key" ? "" : "Bearer "}
              />
            </label>
          </div>

          {(draft.authMode === "api_key" || draft.authMode === "bearer") ? (
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
              <label style={{ display: "grid", gap: 4, gridColumn: "1 / -1" }}>
                <span style={fieldLabelStyle}>Stored credential</span>
                <input
                  type="password"
                  style={inputStyle}
                  value={draft.authSecret}
                  placeholder="Paste the token or API key. ADE stores it encrypted."
                  onChange={(event) => setDraft((current) => ({ ...current, authSecret: event.target.value }))}
                />
              </label>
            </div>
          ) : null}

          {draft.authMode === "oauth" ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={helperTextStyle}>
                Enter the provider’s OAuth endpoints once, save them, then use “Connect account” to finish the browser flow.
              </div>
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={fieldLabelStyle}>Authorize URL</span>
                  <input style={inputStyle} value={draft.oauthAuthorizeUrl} onChange={(event) => setDraft((current) => ({ ...current, oauthAuthorizeUrl: event.target.value }))} />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={fieldLabelStyle}>Token URL</span>
                  <input style={inputStyle} value={draft.oauthTokenUrl} onChange={(event) => setDraft((current) => ({ ...current, oauthTokenUrl: event.target.value }))} />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={fieldLabelStyle}>Client ID</span>
                  <input style={inputStyle} value={draft.oauthClientId} onChange={(event) => setDraft((current) => ({ ...current, oauthClientId: event.target.value }))} />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={fieldLabelStyle}>Client secret</span>
                  <input type="password" style={inputStyle} value={draft.oauthClientSecret} onChange={(event) => setDraft((current) => ({ ...current, oauthClientSecret: event.target.value }))} />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={fieldLabelStyle}>Scope</span>
                  <input style={inputStyle} value={draft.oauthScope} onChange={(event) => setDraft((current) => ({ ...current, oauthScope: event.target.value }))} />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={fieldLabelStyle}>Audience</span>
                  <input style={inputStyle} value={draft.oauthAudience} onChange={(event) => setDraft((current) => ({ ...current, oauthAudience: event.target.value }))} />
                </label>
                <label style={{ display: "grid", gap: 4, gridColumn: "1 / -1" }}>
                  <span style={fieldLabelStyle}>Extra authorize params (`KEY=value` per line)</span>
                  <textarea style={{ ...inputStyle, minHeight: 64 }} value={draft.oauthExtraAuthorizeLines} onChange={(event) => setDraft((current) => ({ ...current, oauthExtraAuthorizeLines: event.target.value }))} />
                </label>
                <label style={{ display: "grid", gap: 4, gridColumn: "1 / -1" }}>
                  <span style={fieldLabelStyle}>Extra token params (`KEY=value` per line)</span>
                  <textarea style={{ ...inputStyle, minHeight: 64 }} value={draft.oauthExtraTokenLines} onChange={(event) => setDraft((current) => ({ ...current, oauthExtraTokenLines: event.target.value }))} />
                </label>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <div style={helperTextStyle}>
                  {oauthSession ? "Waiting for the browser flow to finish..." : "OAuth stays disconnected until you explicitly connect an account."}
                </div>
                <button type="button" style={outlineButton()} onClick={() => void handleConnectOAuth()} disabled={saving}>
                  {oauthSession ? "Waiting..." : "Connect account"}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <details style={{ display: "grid", gap: 12, paddingTop: 4, borderTop: `1px solid ${COLORS.outlineBorder}` }}>
          <summary style={{ ...fieldLabelStyle, cursor: "pointer", userSelect: "none" }}>Step 2: advanced transport details</summary>
          <div style={helperTextStyle}>
            Use this only if the provider config needs manual transport overrides. Managed auth above is the preferred path.
          </div>
        {draft.transport === "stdio" ? (
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={fieldLabelStyle}>Command</span>
              <input style={inputStyle} placeholder="npx" value={draft.command} onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={fieldLabelStyle}>Args</span>
              <input style={inputStyle} placeholder="@playwright/mcp@latest" value={draft.args} onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value }))} />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={fieldLabelStyle}>Working Directory</span>
              <input style={inputStyle} placeholder="/absolute/path (optional)" value={draft.cwd} onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))} />
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
              <input style={inputStyle} placeholder="https://example.com/mcp" value={draft.url} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} />
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

        <div style={{ display: "grid", gap: 8 }}>
          <div style={fieldLabelStyle}>Tool Access & Cost Hints</div>
          <div style={helperTextStyle}>
            Restrict tools here if you do not want the full server surface exposed through ADE. Cost hints are optional.
          </div>
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={fieldLabelStyle}>Allowed Tools</span>
            <input style={inputStyle} placeholder="browser_navigate, browser_click" value={draft.allowedTools} onChange={(event) => setDraft((current) => ({ ...current, allowedTools: event.target.value }))} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={fieldLabelStyle}>Blocked Tools</span>
            <input style={inputStyle} placeholder="dangerous_tool" value={draft.blockedTools} onChange={(event) => setDraft((current) => ({ ...current, blockedTools: event.target.value }))} />
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

        {draft.transport !== "stdio" ? (
          <div style={{ display: "grid", gap: 12, paddingTop: 4, borderTop: `1px solid ${COLORS.outlineBorder}` }}>
            <div style={fieldLabelStyle}>Manual auth fallback</div>
            <div style={helperTextStyle}>
              If a provider hands you a raw config snippet instead of a token or OAuth flow, you can still stamp a manual header into the transport config here.
            </div>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={fieldLabelStyle}>Header Name</span>
                <input style={inputStyle} value={authHeaderName} onChange={(event) => setAuthHeaderName(event.target.value)} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={fieldLabelStyle}>Prefix</span>
                <input style={inputStyle} value={authHeaderPrefix} onChange={(event) => setAuthHeaderPrefix(event.target.value)} placeholder="Bearer " />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={fieldLabelStyle}>Env Var</span>
                <input style={inputStyle} value={authEnvVar} onChange={(event) => setAuthEnvVar(event.target.value)} placeholder="MCP_API_KEY" />
              </label>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" style={outlineButton()} onClick={() => {
                setAuthHeaderName("Authorization");
                setAuthHeaderPrefix("Bearer ");
                setAuthEnvVar("MCP_API_KEY");
              }}>
                Bearer Template
              </button>
              <button type="button" style={outlineButton()} onClick={() => {
                setAuthHeaderName("x-api-key");
                setAuthHeaderPrefix("");
                setAuthEnvVar("MCP_API_KEY");
              }}>
                x-api-key Template
              </button>
              <button type="button" style={primaryButton()} onClick={applyAuthHeaderHelper}>
                Apply Auth Header
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8, paddingTop: 4, borderTop: `1px solid ${COLORS.outlineBorder}` }}>
            <div style={fieldLabelStyle}>Manual env fallback</div>
            <div style={helperTextStyle}>
              Local stdio servers usually authenticate through their own CLI login flow or environment variables. Put manual env overrides above only if the server cannot use managed auth.
            </div>
          </div>
        )}
        </details>

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
        <div style={sectionLabelStyle}>Connection Status</div>
        <div style={helperTextStyle}>
          Once a server is saved, connect it here, verify the discovered tools, and inspect any transport or auth failures from the last connection attempt.
        </div>
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
                      <span>Auth: {snapshot?.authStatus?.state ?? (config.auth ? "needs setup" : "none")}</span>
                      <span>Transport: {config.transport}</span>
                      <span>Tools: {snapshot?.toolCount ?? 0}</span>
                      <span>Auto-start: {config.autoStart === false ? "off" : "on"}</span>
                      <span>Last connected: {formatTimestamp(snapshot?.lastConnectedAt)}</span>
                    </div>
                    {snapshot?.authStatus?.summary ? (
                      <div style={{ marginTop: 8, fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
                        {snapshot.authStatus.summary}
                        {snapshot.authStatus.materializationPreview?.length ? ` · ${snapshot.authStatus.materializationPreview.join(" · ")}` : ""}
                      </div>
                    ) : null}
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
        <div style={sectionLabelStyle}>Usage</div>
        <div style={{ ...helperTextStyle, marginBottom: 10 }}>
          ADE records which external MCP tools ran, who called them, and the attached cost hint when available.
        </div>
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
