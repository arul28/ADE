import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentChatEventEnvelope,
  AiConfig,
  AiApiKeyVerificationResult,
  AiProviderConnectionStatus,
  AiRuntimeConnectionStatus,
  AiSettingsStatus,
  ProjectConfigSnapshot,
} from "../../../shared/types";
import {
  getLocalModelIdTail,
  getLocalProviderDefaultEndpoint,
  getModelById,
  LOCAL_PROVIDER_LABELS,
  parseLocalProviderFromModelId,
  type LocalProviderFamily,
} from "../../../shared/modelRegistry";
import {
  ArrowsClockwise,
  CheckCircle,
  Cpu,
  Info,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { ClaudeLogo, CodexLogo, CursorAgentLogo, OpenCodeLogo } from "../terminals/ToolLogos";
import { ProviderLogo } from "../shared/ProviderLogos";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  LABEL_STYLE,
  cardStyle,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";

type CliName = "claude" | "codex" | "cursor" | "droid";
type ApiKeySource = "config" | "env" | "store";

const CLI_TOOLS: Array<{
  cli: CliName;
  label: string;
  description: string;
  loginCmd: string;
  installHint: string;
}> = [
  {
    cli: "claude",
    label: "Claude Code",
    description: "Anthropic CLI subscription",
    loginCmd: "claude auth login",
    installHint: "npm install -g @anthropic-ai/claude-code",
  },
  {
    cli: "codex",
    label: "Codex",
    description: "OpenAI Codex subscription",
    loginCmd: "codex login",
    installHint: "npm install -g @openai/codex",
  },
  {
    cli: "cursor",
    label: "Cursor",
    description: "Cursor CLI (agent), ACP work chat",
    loginCmd: "agent login",
    installHint: "Install Cursor and enable the cursor CLI from Cursor Settings > General",
  },
  {
    cli: "droid",
    label: "Factory Droid",
    description: "Factory Droid CLI, ACP work chat",
    loginCmd: "export FACTORY_API_KEY=… (or sign in via `droid` interactive login)",
    installHint: "Install from https://docs.factory.ai/cli/getting-started/quickstart — ensure `droid` is on PATH",
  },
];

const LOCAL_PROVIDER_SPECS: Array<{
  provider: LocalProviderFamily;
  label: string;
  description: string;
}> = [
  { provider: "lmstudio", label: "LM Studio", description: "OpenAI-compatible local server" },
  { provider: "ollama", label: "Ollama", description: "OpenAI-compatible local server" },
];

const API_KEY_PROVIDERS: Array<{
  provider: string;
  label: string;
  envVar: string;
  placeholder: string;
  accent: string;
}> = [
  { provider: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY", placeholder: "sk-ant-...", accent: "#D97757" },
  { provider: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY", placeholder: "sk-...", accent: "#10A37F" },
  { provider: "google", label: "Google AI", envVar: "GOOGLE_API_KEY", placeholder: "AIza...", accent: "#60A5FA" },
  { provider: "mistral", label: "Mistral", envVar: "MISTRAL_API_KEY", placeholder: "mistral-...", accent: "#F59E0B" },
  { provider: "deepseek", label: "DeepSeek", envVar: "DEEPSEEK_API_KEY", placeholder: "sk-...", accent: "#38BDF8" },
  { provider: "xai", label: "xAI", envVar: "XAI_API_KEY", placeholder: "xai-...", accent: "#A3A3A3" },
  { provider: "groq", label: "Groq", envVar: "GROQ_API_KEY", placeholder: "gsk_...", accent: "#F43F5E" },
  { provider: "together", label: "Together AI", envVar: "TOGETHER_API_KEY", placeholder: "tg_...", accent: "#22C55E" },
  { provider: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY", placeholder: "sk-or-...", accent: "#A78BFA" },
];

type LocalProviderDraft = {
  enabled: boolean;
  endpoint: string;
  autoDetect: boolean;
  preferredModelId: string;
};

const groupLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 0,
  color: COLORS.textSecondary,
};

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 10,
};

function CliLogo({ cli }: { cli: CliName }) {
  if (cli === "claude") return <ClaudeLogo size={24} />;
  if (cli === "cursor") return <CursorAgentLogo size={24} />;
  if (cli === "droid") return <Cpu size={24} className="text-zinc-100" />;
  return <CodexLogo size={24} className="text-zinc-100" />;
}

const SOURCE_BADGE_MAP: Record<ApiKeySource, { color: string; label: string }> = {
  store: { color: COLORS.success, label: "Local Store" },
  env: { color: COLORS.info, label: "Environment" },
  config: { color: COLORS.warning, label: "Project Config" },
};

function SourceBadge({ source }: { source: ApiKeySource }) {
  const { color, label } = SOURCE_BADGE_MAP[source];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        fontSize: 10,
        fontWeight: 700,
        fontFamily: MONO_FONT,
        textTransform: "uppercase",
        letterSpacing: "1px",
        color,
        background: `${color}18`,
        border: `1px solid ${color}30`,
      }}
    >
      {label}
    </span>
  );
}

function getStatusTone(connection: AiProviderConnectionStatus | null | undefined): { color: string; label: string } {
  if (connection?.runtimeAvailable) return { color: COLORS.success, label: "Connected" };
  if (connection?.runtimeDetected || connection?.authAvailable) return { color: COLORS.warning, label: "Sign-In Required" };
  return { color: COLORS.textDim, label: "Not Detected" };
}

function describeCredentialSource(connection: AiProviderConnectionStatus | null | undefined): string | null {
  const localSource = connection?.sources.find((entry) => entry.kind === "local-credentials" && entry.detected);
  if (!localSource?.source) return null;
  if (localSource.source === "macos-keychain") return "Local credentials found in macOS Keychain.";
  if (localSource.source === "claude-credentials-file") return "Local credentials found in ~/.claude/.credentials.json.";
  if (localSource.source === "codex-auth-file") return "Local credentials found in ~/.codex/auth.json.";
  if (localSource.source === "cursor-env") return "Detected via CURSOR_API_KEY environment variable.";
  if (localSource.source === "factory-env") return "Detected via FACTORY_API_KEY environment variable.";
  return null;
}

function buildCliMessage(tool: (typeof CLI_TOOLS)[number], connection: AiProviderConnectionStatus | null | undefined): string {
  if (connection?.runtimeAvailable) {
    return "Connection verified.";
  }
  if (connection?.blocker) {
    return connection.blocker;
  }
  if (connection?.runtimeDetected && !connection.authAvailable) {
    return `CLI detected but not signed in. Run: ${tool.loginCmd}`;
  }
  if (connection?.authAvailable && !connection.runtimeDetected) {
    return `Local credentials exist but CLI not found in PATH. Install: ${tool.installHint}`;
  }
  return `CLI not found in PATH. Install: ${tool.installHint}. If already installed, ensure it is on your shell PATH and use Refresh.`;
}

function formatLocalModelLabel(modelId: string): string {
  const descriptor = getModelById(modelId);
  if (descriptor) return descriptor.displayName;
  const provider = parseLocalProviderFromModelId(modelId);
  if (provider) {
    const tail = getLocalModelIdTail(modelId, provider);
    const brand = LOCAL_PROVIDER_LABELS[provider];
    return tail.length ? `${tail} (${brand})` : String(modelId ?? "").trim();
  }
  return String(modelId ?? "").trim();
}

const AUTH_ERROR_SIGNALS = [
  "invalid authentication credentials",
  "authentication error",
  "authentication_error",
  "authentication failed",
  "not authenticated",
  "not logged in",
  "login required",
  "sign in",
  "invalid api key",
  "api error: 401",
  "status 401",
  "claude auth login",
  "codex login",
  "agent login",
  "/login",
];

function isAuthRelatedChatMessage(message: string | null | undefined): boolean {
  const normalized = String(message ?? "").trim().toLowerCase();
  if (!normalized.length) return false;
  return AUTH_ERROR_SIGNALS.some((signal) => normalized.includes(signal));
}

function shouldRefreshProvidersForChatEvent(envelope: AgentChatEventEnvelope): boolean {
  const event = envelope.event;
  if (event.type === "system_notice" && event.noticeKind === "auth") return true;
  if (event.type === "error") return isAuthRelatedChatMessage(event.message);
  if (event.type === "status" && event.turnStatus === "failed") {
    return isAuthRelatedChatMessage(event.message);
  }
  return false;
}

function buildLocalProviderDrafts(
  snapshot: ProjectConfigSnapshot | null | undefined,
  status: (AiSettingsStatus & { runtimeConnections?: Record<string, AiRuntimeConnectionStatus> }) | null | undefined,
): Record<LocalProviderFamily, LocalProviderDraft> {
  const configured = snapshot?.effective.ai?.localProviders ?? {};
  return Object.fromEntries(
    LOCAL_PROVIDER_SPECS.map((spec) => {
      const runtimeConnection = status?.runtimeConnections?.[spec.provider];
      const providerConfig = configured[spec.provider];
      return [spec.provider, {
        enabled: providerConfig?.enabled ?? true,
        endpoint:
          (typeof providerConfig?.endpoint === "string" && providerConfig.endpoint.trim().length
            ? providerConfig.endpoint.trim()
            : runtimeConnection?.endpoint?.trim())
          ?? getLocalProviderDefaultEndpoint(spec.provider),
        autoDetect: providerConfig?.autoDetect ?? true,
        preferredModelId: typeof providerConfig?.preferredModelId === "string" ? providerConfig.preferredModelId : "",
      }];
    }),
  ) as Record<LocalProviderFamily, LocalProviderDraft>;
}

export function ProvidersSection({ forceRefreshOnMount = false }: { forceRefreshOnMount?: boolean }) {
  const [status, setStatus] = useState<(AiSettingsStatus & { runtimeConnections?: Record<string, AiRuntimeConnectionStatus> }) | null>(null);
  const [projectConfigSnapshot, setProjectConfigSnapshot] = useState<ProjectConfigSnapshot | null>(null);
  const [storedProviders, setStoredProviders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editingLocalProvider, setEditingLocalProvider] = useState<LocalProviderFamily | null>(null);
  const [savingLocalProvider, setSavingLocalProvider] = useState<LocalProviderFamily | null>(null);
  const [localProviderDrafts, setLocalProviderDrafts] = useState<Record<LocalProviderFamily, LocalProviderDraft>>(() =>
    buildLocalProviderDrafts(null, null),
  );
  const [editValue, setEditValue] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verifyingProvider, setVerifyingProvider] = useState<string | null>(null);
  const [verificationByProvider, setVerificationByProvider] = useState<Record<string, AiApiKeyVerificationResult>>({});
  const pendingRefreshTimerRef = useRef<number | null>(null);

  const refreshStatus = useCallback(async (options?: { force?: boolean; silent?: boolean; refreshOpenCodeInventory?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const [nextStatus, nextStoredProviders, nextProjectConfig] = await Promise.all([
        window.ade.ai.getStatus({
          force: options?.force === true,
          refreshOpenCodeInventory: options?.refreshOpenCodeInventory === true,
        }),
        window.ade.ai.listApiKeys(),
        window.ade.projectConfig.get(),
      ]);
      setStatus(nextStatus);
      setProjectConfigSnapshot(nextProjectConfig);
      if (editingLocalProvider == null && savingLocalProvider == null) {
        setLocalProviderDrafts(buildLocalProviderDrafts(nextProjectConfig, nextStatus));
      }
      setStoredProviders(nextStoredProviders.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [editingLocalProvider, savingLocalProvider]);

  useEffect(() => {
    void refreshStatus({
      force: forceRefreshOnMount,
      refreshOpenCodeInventory: true,
    });
  }, [forceRefreshOnMount, refreshStatus]);

  useEffect(() => {
    const unsubscribe = window.ade.agentChat.onEvent((envelope) => {
      if (!shouldRefreshProvidersForChatEvent(envelope)) return;
      if (pendingRefreshTimerRef.current != null) return;
      pendingRefreshTimerRef.current = window.setTimeout(() => {
        pendingRefreshTimerRef.current = null;
        void refreshStatus({ silent: true });
      }, 120);
    });
    return () => {
      unsubscribe();
      if (pendingRefreshTimerRef.current != null) {
        window.clearTimeout(pendingRefreshTimerRef.current);
        pendingRefreshTimerRef.current = null;
      }
    };
  }, [refreshStatus]);

  const detectedAuth = useMemo(() => status?.detectedAuth ?? [], [status?.detectedAuth]);
  const providerConnections = status?.providerConnections;
  const isInitialCheckInFlight = loading && status == null;
  const catalogModelIds = useMemo(() => deriveConfiguredModelIds(status), [status]);

  const apiKeySources = useMemo(() => {
    const map = new Map<string, ApiKeySource>();
    for (const entry of detectedAuth) {
      if (entry.type === "api-key" && entry.provider && entry.source) {
        map.set(entry.provider.toLowerCase(), entry.source);
      } else if (entry.type === "openrouter" && entry.source) {
        map.set("openrouter", entry.source);
      }
    }
    return map;
  }, [detectedAuth]);

  const localRuntimes = useMemo(() => {
    const availableModelIds = status?.availableModelIds ?? [];
    const runtimeConnections = status?.runtimeConnections ?? {};
    return LOCAL_PROVIDER_SPECS.map((spec) => {
      const runtimeConnection = runtimeConnections[spec.provider] ?? null;
      const detected = detectedAuth.find(
        (entry): entry is { type: "local"; provider: LocalProviderFamily; endpoint: string } =>
          entry.type === "local" && entry.provider === spec.provider,
      ) ?? null;
      const modelIds = runtimeConnection?.loadedModelIds?.length
        ? runtimeConnection.loadedModelIds.filter((rawId) => String(rawId ?? "").trim().startsWith(`${spec.provider}/`))
        : availableModelIds.filter((rawId) => String(rawId ?? "").trim().startsWith(`${spec.provider}/`));
      return {
        ...spec,
        endpoint: runtimeConnection?.endpoint ?? detected?.endpoint ?? getLocalProviderDefaultEndpoint(spec.provider),
        health: runtimeConnection?.health ?? null,
        blocker: runtimeConnection?.blocker ?? null,
        runtimeAvailable: runtimeConnection?.runtimeAvailable ?? false,
        detected,
        modelIds,
        hasModels: modelIds.length > 0,
      };
    });
  }, [detectedAuth, status?.availableModelIds, status?.runtimeConnections]);

  const apiKeyStoreWarning = useMemo(() => {
    if (status?.apiKeyStore?.legacyPlaintextDetected) {
      return "Legacy plaintext API keys were detected in .ade/secrets/api-keys.json. ADE now uses encrypted safeStorage, and plaintext keys are no longer loaded. Re-enter any keys you still need.";
    }
    if (status?.apiKeyStore?.decryptionFailed) {
      return "Encrypted API keys exist but could not be decrypted on this machine. Re-enter the affected keys to continue using them.";
    }
    if (status?.apiKeyStore?.secureStorageAvailable === false) {
      return "OS secure storage is unavailable, so ADE cannot persist API keys locally right now.";
    }
    return null;
  }, [status?.apiKeyStore]);

  const beginEditing = (provider: string) => {
    setEditingProvider(provider);
    setEditValue("");
    setError(null);
    setNotice(null);
  };

  const cancelEditing = () => {
    setEditingProvider(null);
    setEditValue("");
  };

  const saveApiKey = async (provider: string) => {
    const trimmed = editValue.trim();
    if (!trimmed) return;

    setError(null);
    setNotice(null);
    try {
      await window.ade.ai.storeApiKey(provider, trimmed);
      setVerificationByProvider((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
      setNotice(`${provider} key saved.`);
      cancelEditing();
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteApiKey = async (provider: string) => {
    setError(null);
    setNotice(null);
    try {
      await window.ade.ai.deleteApiKey(provider);
      setNotice(`${provider} key removed.`);
      if (editingProvider === provider) cancelEditing();
      setVerificationByProvider((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const verifyApiKey = async (provider: string) => {
    setError(null);
    setNotice(null);
    setVerifyingProvider(provider);
    try {
      const result = await window.ade.ai.verifyApiKey(provider);
      setVerificationByProvider((prev) => ({ ...prev, [provider]: result }));
      setNotice(result.ok ? `${provider} connection verified.` : `${provider} verification failed.`);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifyingProvider(null);
    }
  };

  const updateLocalProviderDraft = useCallback((
    provider: LocalProviderFamily,
    patch: Partial<LocalProviderDraft>,
  ) => {
    setLocalProviderDrafts((prev) => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        ...patch,
      },
    }));
  }, []);

  const beginEditingLocalRuntime = useCallback((provider: LocalProviderFamily) => {
    setEditingLocalProvider(provider);
    setError(null);
    setNotice(null);
  }, []);

  const cancelEditingLocalRuntime = useCallback(() => {
    setEditingLocalProvider(null);
    setLocalProviderDrafts(buildLocalProviderDrafts(projectConfigSnapshot, status));
  }, [projectConfigSnapshot, status]);

  const saveLocalProvider = useCallback(async (provider: LocalProviderFamily) => {
    const draft = localProviderDrafts[provider];
    if (!draft) return;
    setSavingLocalProvider(provider);
    setError(null);
    setNotice(null);
    try {
      await window.ade.ai.updateConfig({
        localProviders: {
          [provider]: {
            enabled: draft.enabled,
            endpoint: draft.endpoint.trim(),
            autoDetect: draft.autoDetect,
            preferredModelId: draft.preferredModelId.trim() || null,
          },
        } as AiConfig["localProviders"],
      });
      setNotice(`${LOCAL_PROVIDER_LABELS[provider]} settings saved.`);
      setEditingLocalProvider(null);
      await refreshStatus({ force: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingLocalProvider(null);
    }
  }, [localProviderDrafts, refreshStatus]);

  return (
    <div id="ai-providers" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {notice && (
        <div
          style={{
            padding: "8px 12px",
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: COLORS.success,
            background: `${COLORS.success}12`,
            border: `1px solid ${COLORS.success}30`,
          }}
        >
          {notice}
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "8px 12px",
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: COLORS.danger,
            background: `${COLORS.danger}12`,
            border: `1px solid ${COLORS.danger}30`,
          }}
        >
          {error}
        </div>
      )}

      {apiKeyStoreWarning && (
        <div
          style={{
            padding: "8px 12px",
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: COLORS.warning,
            background: `${COLORS.warning}12`,
            border: `1px solid ${COLORS.warning}30`,
          }}
        >
          {apiKeyStoreWarning}
        </div>
      )}

      {/* ── Model Availability Summary ── */}
      {(() => {
        const readyCount = catalogModelIds.length;
        const cliProviders = CLI_TOOLS.map((t) => ({
          label: t.label,
          connected: providerConnections?.[t.cli]?.runtimeAvailable === true,
          accent: undefined as string | undefined,
        }));
        // Use dynamic OpenCode provider list when available, fall back to hardcoded
        const ocProviders = status?.opencodeProviders;
        const opencodeProviderDots = ocProviders?.length
          ? ocProviders
              .filter((p) => p.connected)
              .map((p) => ({ label: p.name, connected: true, accent: undefined as string | undefined }))
          : [];
        const allProviders = [...cliProviders, ...opencodeProviderDots];
        const connectedCount = allProviders.filter((p) => p.connected).length;
        return (
          <section style={{ ...cardStyle(), borderLeft: `3px solid ${COLORS.accent}`, padding: "12px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>
                {readyCount} model{readyCount !== 1 ? "s" : ""} ready across {connectedCount} provider{connectedCount !== 1 ? "s" : ""}
              </div>
              <button
                type="button"
                style={outlineButton()}
                disabled={loading}
                onClick={() => void refreshStatus({ force: true, refreshOpenCodeInventory: true })}
              >
                <ArrowsClockwise size={12} weight="bold" /> {loading ? "Checking..." : "Refresh"}
              </button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {allProviders.map((p) => (
                <span
                  key={p.label}
                  title={p.label}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "2px 8px",
                    fontSize: 10,
                    fontFamily: MONO_FONT,
                    color: p.connected ? (p.accent ?? COLORS.success) : COLORS.textDim,
                    background: p.connected ? `${p.accent ?? COLORS.success}14` : `${COLORS.textDim}10`,
                    border: `1px solid ${p.connected ? `${p.accent ?? COLORS.success}30` : COLORS.border}`,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: p.connected ? (p.accent ?? COLORS.success) : COLORS.textDim,
                    }}
                  />
                  {p.label}
                </span>
              ))}
            </div>
          </section>
        );
      })()}

      {/* ── CLI Runtimes ── */}
      <div style={groupLabelStyle}>CLI Runtimes</div>

      {/* ── Claude ── */}
      {(() => {
        const tool = CLI_TOOLS.find((t) => t.cli === "claude")!;
        const connection = providerConnections?.[tool.cli] ?? null;
        const credentialSourceDesc = describeCredentialSource(connection);
        const tone = isInitialCheckInFlight ? { color: COLORS.info, label: "Checking" } : getStatusTone(connection);
        const message = isInitialCheckInFlight ? "Checking CLI availability and login status." : buildCliMessage(tool, connection);
        return (
          <section style={{ ...cardStyle(), borderLeft: `3px solid ${tone.color}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <ClaudeLogo size={28} />
                <div>
                  <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>Claude</div>
                  <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.35 }}>
                    Anthropic native runtime via Claude Code CLI
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, color: tone.color }}>
                {isInitialCheckInFlight ? <Info size={14} weight="fill" /> : connection?.runtimeAvailable ? <CheckCircle size={14} weight="fill" /> : connection?.authAvailable || connection?.runtimeDetected ? <WarningCircle size={14} weight="fill" /> : <XCircle size={14} weight="fill" />}
                <span style={{ fontSize: 9, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px" }}>{tone.label}</span>
              </div>
            </div>
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5, marginTop: 10 }}>{message}</div>
            {credentialSourceDesc && !connection?.runtimeAvailable && !isInitialCheckInFlight ? <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.info, marginTop: 4 }}>{credentialSourceDesc}</div> : null}
            {connection?.path && !isInitialCheckInFlight ? <code style={{ display: "block", marginTop: 6, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary, background: `${COLORS.textDim}12`, border: `1px solid ${COLORS.border}`, padding: "6px 8px", overflowWrap: "anywhere", wordBreak: "break-all" }}>{connection.path}</code> : null}
          </section>
        );
      })()}

      {/* ── Codex ── */}
      {(() => {
        const tool = CLI_TOOLS.find((t) => t.cli === "codex")!;
        const connection = providerConnections?.[tool.cli] ?? null;
        const credentialSourceDesc = describeCredentialSource(connection);
        const tone = isInitialCheckInFlight ? { color: COLORS.info, label: "Checking" } : getStatusTone(connection);
        const message = isInitialCheckInFlight ? "Checking CLI availability and login status." : buildCliMessage(tool, connection);
        return (
          <section style={{ ...cardStyle(), borderLeft: `3px solid ${tone.color}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <CodexLogo size={28} className="text-zinc-100" />
                <div>
                  <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>Codex</div>
                  <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.35 }}>
                    OpenAI native runtime via Codex CLI
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, color: tone.color }}>
                {isInitialCheckInFlight ? <Info size={14} weight="fill" /> : connection?.runtimeAvailable ? <CheckCircle size={14} weight="fill" /> : connection?.authAvailable || connection?.runtimeDetected ? <WarningCircle size={14} weight="fill" /> : <XCircle size={14} weight="fill" />}
                <span style={{ fontSize: 9, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px" }}>{tone.label}</span>
              </div>
            </div>
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5, marginTop: 10 }}>{message}</div>
            {credentialSourceDesc && !connection?.runtimeAvailable && !isInitialCheckInFlight ? <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.info, marginTop: 4 }}>{credentialSourceDesc}</div> : null}
            {connection?.path && !isInitialCheckInFlight ? <code style={{ display: "block", marginTop: 6, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary, background: `${COLORS.textDim}12`, border: `1px solid ${COLORS.border}`, padding: "6px 8px", overflowWrap: "anywhere", wordBreak: "break-all" }}>{connection.path}</code> : null}
          </section>
        );
      })()}

      {/* ── Cursor ── */}
      {(() => {
        const tool = CLI_TOOLS.find((t) => t.cli === "cursor")!;
        const connection = providerConnections?.[tool.cli] ?? null;
        const credentialSourceDesc = describeCredentialSource(connection);
        const tone = isInitialCheckInFlight ? { color: COLORS.info, label: "Checking" } : getStatusTone(connection);
        const message = isInitialCheckInFlight ? "Checking CLI availability and login status." : buildCliMessage(tool, connection);
        return (
          <section style={{ ...cardStyle(), borderLeft: `3px solid ${tone.color}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <CursorAgentLogo size={28} />
                <div>
                  <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>Cursor</div>
                  <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.35 }}>
                    Cursor native runtime via Cursor CLI (agent)
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, color: tone.color }}>
                {isInitialCheckInFlight ? <Info size={14} weight="fill" /> : connection?.runtimeAvailable ? <CheckCircle size={14} weight="fill" /> : connection?.authAvailable || connection?.runtimeDetected ? <WarningCircle size={14} weight="fill" /> : <XCircle size={14} weight="fill" />}
                <span style={{ fontSize: 9, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px" }}>{tone.label}</span>
              </div>
            </div>
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5, marginTop: 10 }}>{message}</div>
            {credentialSourceDesc && !connection?.runtimeAvailable && !isInitialCheckInFlight ? <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.info, marginTop: 4 }}>{credentialSourceDesc}</div> : null}
            {connection?.path && !isInitialCheckInFlight ? <code style={{ display: "block", marginTop: 6, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary, background: `${COLORS.textDim}12`, border: `1px solid ${COLORS.border}`, padding: "6px 8px", overflowWrap: "anywhere", wordBreak: "break-all" }}>{connection.path}</code> : null}
          </section>
        );
      })()}

      {/* ── OpenCode Status ── */}
      <section style={{ ...cardStyle(), borderLeft: `3px solid #2563EB` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <OpenCodeLogo size={22} />
            <div>
              <div style={{ fontSize: 12, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>OpenCode Runtime</div>
              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.35 }}>
                Powers all API-backed and local model chats
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, color: status?.opencodeBinaryInstalled === false ? COLORS.warning : status?.opencodeInventoryError ? COLORS.danger : COLORS.success }}>
            {status?.opencodeBinaryInstalled === false ? (
              <WarningCircle size={14} weight="fill" />
            ) : status?.opencodeInventoryError ? (
              <XCircle size={14} weight="fill" />
            ) : (
              <CheckCircle size={14} weight="fill" />
            )}
            <span style={{ fontSize: 9, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px" }}>
              {status?.opencodeBinaryInstalled === false ? "Not found" : status?.opencodeInventoryError ? "Error" : "Installed"}
            </span>
          </div>
        </div>

        {status?.opencodeBinaryInstalled === false ? (
          <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.warning, lineHeight: 1.55, marginTop: 8 }}>
            OpenCode CLI was not found on your PATH. Install OpenCode and ensure the <code style={{ color: COLORS.textSecondary }}>opencode</code> binary is discoverable, then use Refresh.
            The API keys and local model servers below require OpenCode to function.
          </div>
        ) : status?.opencodeInventoryError ? (
          <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.danger, lineHeight: 1.55, marginTop: 8 }}>
            Model inventory failed: {status.opencodeInventoryError}
          </div>
        ) : null}
      </section>

      {/* ── API Provider Keys ── */}
      <div style={{ position: "relative" }}>
        {status?.opencodeBinaryInstalled === false && (
          <div style={{ position: "absolute", inset: 0, zIndex: 2, background: `${COLORS.pageBg}CC`, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <span style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.warning, background: COLORS.pageBg, padding: "6px 14px", border: `1px solid ${COLORS.warning}40` }}>
              Install OpenCode to use API providers
            </span>
          </div>
        )}
        <div style={{ ...groupLabelStyle, marginBottom: 4 }}>API Provider Keys</div>
        <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.6, marginBottom: 12 }}>
          Add API keys to unlock models. All API-backed models run through the OpenCode runtime.
          {status?.opencodeProviders?.length ? (
            <span style={{ display: "block", marginTop: 4, opacity: 0.7 }}>
              Showing popular providers. OpenCode supports {status.opencodeProviders.length} total — add any provider by ID below.
            </span>
          ) : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {API_KEY_PROVIDERS.map((provider) => {
            const keySource = apiKeySources.get(provider.provider) ?? (storedProviders.includes(provider.provider) ? "store" : undefined);
            const verification = verificationByProvider[provider.provider];
            const isEditing = editingProvider === provider.provider;
            return (
              <div
                key={provider.provider}
                style={{
                  display: "grid",
                  gridTemplateColumns: "220px 1fr auto",
                  gap: 10,
                  alignItems: "center",
                  border: `1px solid ${COLORS.border}`,
                  background: COLORS.recessedBg,
                  padding: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <ProviderLogo family={provider.provider} size={22} />
                  <div>
                    <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>{provider.label}</div>
                    <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>{provider.envVar}</div>
                  </div>
                </div>
                <div style={{ minWidth: 0 }}>
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(event) => setEditValue(event.target.value)}
                      placeholder={provider.placeholder}
                      type="password"
                      style={{ width: "100%", background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }}
                    />
                  ) : keySource ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <SourceBadge source={keySource} />
                      {verification ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: verification.ok ? COLORS.success : COLORS.warning, fontSize: 10, fontFamily: MONO_FONT }}>
                          {verification.ok ? <CheckCircle size={12} weight="fill" /> : <WarningCircle size={12} weight="fill" />}
                          {verification.ok ? "Verified" : verification.message}
                        </span>
                      ) : (
                        <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                          {keySource === "env" ? "Loaded from environment" : keySource === "config" ? "Defined in project config" : "Stored locally"}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>No key configured</span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {isEditing ? (
                    <>
                      <button type="button" style={primaryButton()} onClick={() => void saveApiKey(provider.provider)}>Save</button>
                      <button type="button" style={outlineButton()} onClick={cancelEditing}>Cancel</button>
                    </>
                  ) : keySource ? (
                    <>
                      {verification?.ok ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.success, background: `${COLORS.success}14`, border: `1px solid ${COLORS.success}30` }}>
                          <CheckCircle size={13} weight="fill" /> Verified
                        </span>
                      ) : verification && !verification.ok ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.danger, background: `${COLORS.danger}14`, border: `1px solid ${COLORS.danger}30`, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={verification.message}>
                          <XCircle size={13} weight="fill" /> Failed
                        </span>
                      ) : (
                        <button type="button" style={outlineButton()} disabled={verifyingProvider === provider.provider} onClick={() => void verifyApiKey(provider.provider)}>
                          {verifyingProvider === provider.provider ? "Checking..." : "Verify"}
                        </button>
                      )}
                      {keySource === "store" ? (
                        <>
                          <button type="button" style={outlineButton()} onClick={() => beginEditing(provider.provider)}>Replace</button>
                          <button type="button" style={outlineButton()} onClick={() => void deleteApiKey(provider.provider)}>Delete</button>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <button type="button" style={outlineButton()} onClick={() => beginEditing(provider.provider)}>Add</button>
                  )}
                </div>
              </div>
            );
          })}

          {/* ── Add custom provider ── */}
          {(() => {
            const dynamicProviders = (status?.opencodeProviders ?? [])
              .filter((p) => !p.connected && !API_KEY_PROVIDERS.some((a) => a.provider === p.id) && !["ollama", "lmstudio"].includes(p.id))
              .sort((a, b) => b.modelCount - a.modelCount);
            if (!dynamicProviders.length && !editingProvider?.startsWith("__custom:")) return null;
            return (
              <div style={{ marginTop: 8, border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12 }}>
                <div style={{ fontSize: 10, fontFamily: SANS_FONT, fontWeight: 600, color: COLORS.textSecondary, marginBottom: 8 }}>
                  More providers ({dynamicProviders.length} available)
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: editingProvider?.startsWith("__custom:") ? 10 : 0 }}>
                  {dynamicProviders.slice(0, 30).map((p) => {
                    const hasKey = storedProviders.includes(p.id) || apiKeySources.has(p.id);
                    const isEditing = editingProvider === `__custom:${p.id}`;
                    return isEditing ? (
                      <div key={p.id} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textPrimary, minWidth: 120 }}>{p.name}</span>
                        <input
                          autoFocus
                          value={editValue}
                          onChange={(event) => setEditValue(event.target.value)}
                          placeholder="API key"
                          type="password"
                          style={{ flex: 1, background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "6px 8px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }}
                        />
                        <button type="button" style={primaryButton()} onClick={() => void saveApiKey(p.id)}>Save</button>
                        <button type="button" style={outlineButton()} onClick={cancelEditing}>Cancel</button>
                      </div>
                    ) : (
                      <button
                        key={p.id}
                        type="button"
                        style={{
                          ...outlineButton(),
                          fontSize: 10,
                          padding: "4px 8px",
                          opacity: hasKey ? 1 : 0.7,
                          borderColor: hasKey ? COLORS.success : undefined,
                        }}
                        onClick={() => { if (!hasKey) beginEditing(`__custom:${p.id}`); }}
                        title={`${p.name} — ${p.modelCount} models`}
                      >
                        {p.name} {hasKey ? "✓" : `(${p.modelCount})`}
                      </button>
                    );
                  })}
                  {dynamicProviders.length > 30 ? (
                    <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, alignSelf: "center" }}>
                      +{dynamicProviders.length - 30} more
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* ── Local Model Servers ── */}
      <div style={{ position: "relative" }}>
        {status?.opencodeBinaryInstalled === false && (
          <div style={{ position: "absolute", inset: 0, zIndex: 2, background: `${COLORS.pageBg}CC`, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <span style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.warning, background: COLORS.pageBg, padding: "6px 14px", border: `1px solid ${COLORS.warning}40` }}>
              Install OpenCode to use local models
            </span>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
          <div style={groupLabelStyle}>Local Model Servers</div>
          <button
            type="button"
            style={outlineButton()}
            disabled={loading}
            onClick={() => void refreshStatus({ force: true, refreshOpenCodeInventory: true })}
          >
            <ArrowsClockwise size={12} weight="bold" /> {loading ? "Checking..." : "Refresh"}
          </button>
        </div>
        <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.6, marginBottom: 12 }}>
          Connect to LM Studio or Ollama running on your machine.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 12 }}>
          {localRuntimes.map((entry) => {
            const isEditing = editingLocalProvider === entry.provider;
            const isSaving = savingLocalProvider === entry.provider;
            const draft = localProviderDrafts[entry.provider];
            const hasReadyRuntime = entry.runtimeAvailable || (entry.detected && entry.hasModels);
            const needsModelLoad = !hasReadyRuntime && !entry.hasModels && (entry.health === "reachable" || entry.health === "reachable_no_models");
            const tone = hasReadyRuntime
              ? { color: COLORS.success, label: entry.hasModels ? "Ready" : "Connected" }
              : needsModelLoad
                ? { color: COLORS.warning, label: "Load a model" }
                : entry.blocker
                  ? { color: COLORS.warning, label: "Blocked" }
                  : { color: COLORS.warning, label: "Not detected" };
            const loadedModels = entry.modelIds.slice(0, 4);
            const extraModelCount = Math.max(0, entry.modelIds.length - loadedModels.length);
            const message = entry.blocker
              ? entry.blocker
              : entry.detected
                ? entry.hasModels
                  ? `${entry.label} is reachable at ${entry.endpoint}. ADE can use ${entry.modelIds.length} loaded model${entry.modelIds.length === 1 ? "" : "s"} from this runtime${entry.health ? ` (${entry.health})` : ""}.`
                  : `${entry.label} responded, but no loaded models were reported yet. Load a model in ${entry.label} and refresh.`
                : `${entry.label} was not detected. Start it, load at least one model, then refresh so ADE can discover its OpenAI-compatible server.`;

            return (
              <div
                key={entry.provider}
                style={{
                  border: `1px solid ${COLORS.border}`,
                  borderLeft: `3px solid ${tone.color}`,
                  background: COLORS.recessedBg,
                  padding: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  minWidth: 0,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <ProviderLogo family={entry.provider} size={22} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>{entry.label}</div>
                      <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.35 }}>{entry.description}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, color: tone.color }}>
                    {hasReadyRuntime ? <CheckCircle size={14} weight="fill" /> : needsModelLoad || entry.blocker ? <WarningCircle size={14} weight="fill" /> : <XCircle size={14} weight="fill" />}
                    <span style={{ fontSize: 9, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px" }}>{tone.label}</span>
                  </div>
                </div>

                <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.55, overflowWrap: "break-word", wordBreak: "break-word" }}>{message}</div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", padding: "3px 8px", borderRadius: 999, border: `1px solid ${COLORS.border}`, background: `${COLORS.textDim}10`, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
                    {draft?.enabled === false ? "Disabled" : "Enabled"}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", padding: "3px 8px", borderRadius: 999, border: `1px solid ${COLORS.border}`, background: `${COLORS.textDim}10`, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
                    {draft?.autoDetect === false ? "Manual only" : "Auto-detect fallback"}
                  </span>
                </div>

                <code style={{ display: "block", width: "100%", boxSizing: "border-box", minWidth: 0, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary, background: `${COLORS.textDim}12`, border: `1px solid ${COLORS.border}`, padding: "6px 8px", overflowWrap: "anywhere", wordBreak: "break-all" }}>
                  {draft?.endpoint?.trim() || entry.endpoint}
                </code>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {loadedModels.length > 0 ? (
                    <>
                      {loadedModels.map((modelId) => (
                        <span key={modelId} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 999, border: `1px solid ${COLORS.border}`, background: `${COLORS.textDim}10`, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textPrimary }} title={modelId}>
                          <Cpu size={11} />
                          {formatLocalModelLabel(modelId)}
                        </span>
                      ))}
                      {extraModelCount > 0 ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 999, border: `1px solid ${COLORS.border}`, background: `${COLORS.textDim}10`, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                          +{extraModelCount} more
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>No loaded models reported yet.</span>
                  )}
                </div>

                {isEditing && draft ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4, borderTop: `1px solid ${COLORS.border}` }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: COLORS.textSecondary }}>
                      <input type="checkbox" checked={draft.enabled} onChange={(event) => updateLocalProviderDraft(entry.provider, { enabled: event.target.checked })} />
                      Enable {entry.label}
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                      <span>Endpoint</span>
                      <input value={draft.endpoint} onChange={(event) => updateLocalProviderDraft(entry.provider, { endpoint: event.target.value })} placeholder={getLocalProviderDefaultEndpoint(entry.provider)} style={{ width: "100%", border: `1px solid ${COLORS.border}`, background: COLORS.cardBgSolid, color: COLORS.textPrimary, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT }} />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: COLORS.textSecondary }}>
                      <input type="checkbox" checked={draft.autoDetect} onChange={(event) => updateLocalProviderDraft(entry.provider, { autoDetect: event.target.checked })} />
                      Fall back to the default detected endpoint
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                      <span>Preferred model</span>
                      <select value={draft.preferredModelId} onChange={(event) => updateLocalProviderDraft(entry.provider, { preferredModelId: event.target.value })} style={{ width: "100%", border: `1px solid ${COLORS.border}`, background: COLORS.cardBgSolid, color: COLORS.textPrimary, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT }}>
                        <option value="">Require explicit selection</option>
                        {entry.modelIds.map((modelId) => (
                          <option key={modelId} value={modelId}>{formatLocalModelLabel(modelId)}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {isEditing ? (
                    <>
                      <button type="button" style={primaryButton()} disabled={isSaving} onClick={() => void saveLocalProvider(entry.provider)}>{isSaving ? "Saving..." : "Save"}</button>
                      <button type="button" style={outlineButton()} disabled={isSaving} onClick={cancelEditingLocalRuntime}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button type="button" style={outlineButton()} onClick={() => beginEditingLocalRuntime(entry.provider)}>Edit</button>
                      <button type="button" style={outlineButton()} disabled={loading} onClick={() => void refreshStatus({ force: true })}>Test</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px", marginTop: 12, background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted, fontSize: 11, fontFamily: MONO_FONT }}>
          <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          If LM Studio is running but ADE does not show it, load at least one model in LM Studio, then use Refresh. ADE only marks a local runtime as ready after /v1/models returns loaded models.
        </div>
      </div>

    </div>
  );
}
