import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentChatEventEnvelope,
  AiApiKeyVerificationResult,
  AiProviderConnectionStatus,
  AiSettingsStatus,
} from "../../../shared/types";
import {
  ArrowsClockwise,
  CheckCircle,
  Cpu,
  Info,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { ClaudeLogo, CodexLogo } from "../terminals/ToolLogos";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  LABEL_STYLE,
  cardStyle,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";

type CliName = "claude" | "codex";
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

export function ProvidersSection({ forceRefreshOnMount = false }: { forceRefreshOnMount?: boolean }) {
  const [status, setStatus] = useState<AiSettingsStatus | null>(null);
  const [storedProviders, setStoredProviders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verifyingProvider, setVerifyingProvider] = useState<string | null>(null);
  const [verificationByProvider, setVerificationByProvider] = useState<Record<string, AiApiKeyVerificationResult>>({});
  const pendingRefreshTimerRef = useRef<number | null>(null);

  const refreshStatus = useCallback(async (options?: { force?: boolean; silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const [nextStatus, nextStoredProviders] = await Promise.all([
        window.ade.ai.getStatus(options?.force ? { force: true } : undefined),
        window.ade.ai.listApiKeys(),
      ]);
      setStatus(nextStatus);
      setStoredProviders(nextStoredProviders.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refreshStatus(forceRefreshOnMount ? { force: true } : undefined);
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

  const detectedAuth = status?.detectedAuth ?? [];
  const providerConnections = status?.providerConnections;
  const isInitialCheckInFlight = loading && status == null;

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

  const localEndpoints = useMemo(() => {
    const entries: Array<{ provider: string; endpoint: string }> = [];
    for (const entry of detectedAuth) {
      if (entry.type !== "local" || !entry.provider || !entry.endpoint) continue;
      entries.push({ provider: entry.provider, endpoint: entry.endpoint });
    }
    return entries;
  }, [detectedAuth]);

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
      setNotice(`${provider} key saved.`);
      cancelEditing();
      await refreshStatus();
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
      await refreshStatus();
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
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

      <div style={groupLabelStyle}>CONNECTIONS</div>

      <section style={cardStyle()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <div>
            <div style={sectionLabelStyle}>CLI CONNECTIONS</div>
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
              ADE now separates local auth detection from runtime launchability so Claude and Codex can explain what is actually blocked.
            </div>
          </div>
          <button
            type="button"
            style={outlineButton()}
            disabled={loading}
            onClick={() => void refreshStatus({ force: true })}
          >
            <ArrowsClockwise size={12} weight="bold" /> {loading ? "Checking..." : "Refresh"}
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          {CLI_TOOLS.map((tool) => {
            const connection = providerConnections?.[tool.cli] ?? null;
            const tone = isInitialCheckInFlight
              ? { color: COLORS.info, label: "Checking" }
              : getStatusTone(connection);
            const message = isInitialCheckInFlight
              ? "Checking local CLI availability, login status, and runtime launchability for this provider."
              : buildCliMessage(tool, connection);

            return (
              <div
                key={tool.cli}
                style={{
                  border: `1px solid ${COLORS.border}`,
                  borderLeft: `3px solid ${tone.color}`,
                  padding: 14,
                  background: COLORS.recessedBg,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <CliLogo cli={tool.cli} />
                    <div>
                      <div style={{ fontSize: 12, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>
                        {tool.label}
                      </div>
                      <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                        {tool.description}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, color: tone.color }}>
                    {isInitialCheckInFlight ? (
                      <Info size={14} weight="fill" />
                    ) : connection?.runtimeAvailable ? (
                      <CheckCircle size={14} weight="fill" />
                    ) : connection?.authAvailable || connection?.runtimeDetected ? (
                      <WarningCircle size={14} weight="fill" />
                    ) : (
                      <XCircle size={14} weight="fill" />
                    )}
                    <span style={{ fontSize: 9, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px" }}>
                      {tone.label}
                    </span>
                  </div>
                </div>

                <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                  {message}
                </div>

                {describeCredentialSource(connection) && !connection?.runtimeAvailable && !isInitialCheckInFlight ? (
                  <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.info }}>
                    {describeCredentialSource(connection)}
                  </div>
                ) : null}

                {connection?.path && !isInitialCheckInFlight ? (
                  <code
                    style={{
                      fontSize: 10,
                      fontFamily: MONO_FONT,
                      color: COLORS.textSecondary,
                      background: `${COLORS.textDim}12`,
                      border: `1px solid ${COLORS.border}`,
                      padding: "3px 6px",
                    }}
                  >
                    {connection.path}
                  </code>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section style={cardStyle()}>
        <div style={sectionLabelStyle}>API KEYS</div>
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
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: provider.accent,
                    }}
                  />
                  <div>
                    <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                      {provider.label}
                    </div>
                    <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                      {provider.envVar}
                    </div>
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
                      style={{
                        width: "100%",
                        background: COLORS.cardBg,
                        border: `1px solid ${COLORS.border}`,
                        padding: "8px 10px",
                        fontSize: 11,
                        fontFamily: MONO_FONT,
                        color: COLORS.textPrimary,
                        outline: "none",
                      }}
                    />
                  ) : keySource ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <SourceBadge source={keySource} />
                      {verification ? (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            color: verification.ok ? COLORS.success : COLORS.warning,
                            fontSize: 10,
                            fontFamily: MONO_FONT,
                          }}
                        >
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
                    <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                      No key configured
                    </span>
                  )}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {isEditing ? (
                    <>
                      <button type="button" style={primaryButton()} onClick={() => void saveApiKey(provider.provider)}>
                        Save
                      </button>
                      <button type="button" style={outlineButton()} onClick={cancelEditing}>
                        Cancel
                      </button>
                    </>
                  ) : keySource ? (
                    <>
                      <button
                        type="button"
                        style={outlineButton()}
                        disabled={verifyingProvider === provider.provider}
                        onClick={() => void verifyApiKey(provider.provider)}
                      >
                        {verifyingProvider === provider.provider ? "Checking..." : "Verify"}
                      </button>
                      {keySource === "store" ? (
                        <>
                          <button type="button" style={outlineButton()} onClick={() => beginEditing(provider.provider)}>
                            Replace
                          </button>
                          <button type="button" style={outlineButton()} onClick={() => void deleteApiKey(provider.provider)}>
                            Delete
                          </button>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <button type="button" style={outlineButton()} onClick={() => beginEditing(provider.provider)}>
                      Add
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section style={cardStyle()}>
        <div style={sectionLabelStyle}>LOCAL MODEL ENDPOINTS</div>
        {localEndpoints.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {localEndpoints.map((entry) => (
              <div
                key={`${entry.provider}:${entry.endpoint}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  border: `1px solid ${COLORS.border}`,
                  background: COLORS.recessedBg,
                  padding: "10px 12px",
                }}
              >
                <div>
                  <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                    {entry.provider}
                  </div>
                  <code style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                    {entry.endpoint}
                  </code>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 5, color: COLORS.success }}>
                  <Cpu size={14} />
                  <span style={{ fontSize: 9, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px" }}>
                    Reachable
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "10px 12px",
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.border}`,
              color: COLORS.textMuted,
              fontSize: 11,
              fontFamily: MONO_FONT,
            }}
          >
            <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            No local model endpoints detected (Ollama, LM Studio, vLLM).
          </div>
        )}
      </section>
    </div>
  );
}
