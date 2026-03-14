import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AiApiKeyVerificationResult,
  AiConfig,
  AiDetectedAuth,
  AiSettingsStatus,
  ProjectConfigSnapshot,
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
  dangerButton,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { deriveConfiguredModelOptions, includeSelectedModelOption } from "../../lib/modelOptions";
import { getModelById, resolveModelAlias } from "../../../shared/modelRegistry";

type CliName = "claude" | "codex";
type ApiKeySource = "config" | "env" | "store";

const CLI_TOOLS: Array<{ cli: CliName; label: string; description: string; loginCmd: string; installHint: string }> = [
  { cli: "claude", label: "Claude Code", description: "Anthropic CLI subscription", loginCmd: "claude auth login", installHint: "npm install -g @anthropic-ai/claude-code" },
  { cli: "codex", label: "Codex", description: "OpenAI Codex subscription", loginCmd: "codex login", installHint: "npm install -g @openai/codex" },
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(primary: unknown, fallback: unknown, defaultValue: string): string {
  if (typeof primary === "string" && primary.length > 0) return primary;
  if (typeof fallback === "string" && fallback.length > 0) return fallback;
  return defaultValue;
}

function normalizeModelSetting(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw.length) return "";
  return getModelById(raw)?.id ?? resolveModelAlias(raw)?.id ?? raw;
}

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 10,
};

const groupLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 0,
  color: COLORS.textSecondary,
};

const selectStyle: React.CSSProperties = {
  width: "100%",
  height: 32,
  padding: "0 8px",
  fontSize: 12,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 0,
  outline: "none",
  appearance: "none",
  WebkitAppearance: "none",
  cursor: "pointer",
};

function getStatusTone(args: { connected: boolean; warning?: boolean }): { color: string; label: string } {
  if (args.connected) return { color: COLORS.success, label: "Connected" };
  if (args.warning) return { color: COLORS.warning, label: "Sign-in Required" };
  return { color: COLORS.textDim, label: "Not Detected" };
}

function CliLogo({ cli }: { cli: CliName }) {
  if (cli === "claude") return <ClaudeLogo size={24} />;
  return <CodexLogo size={24} className="text-zinc-100" />;
}

function SourceBadge({ source }: { source: ApiKeySource }) {
  const color =
    source === "store" ? COLORS.success : source === "env" ? COLORS.info : COLORS.warning;
  const label = source === "store" ? "Local Store" : source === "env" ? "Environment" : "Project Config";
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

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, opacity: disabled ? 0.5 : 1 }}>
      <span style={LABEL_STYLE}>{label}</span>
      <div style={{ position: "relative" }}>
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          style={selectStyle}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div
          style={{
            position: "absolute",
            right: 8,
            top: "50%",
            transform: "translateY(-50%)",
            pointerEvents: "none",
            color: COLORS.textMuted,
            fontSize: 10,
          }}
        >
          &#9662;
        </div>
      </div>
    </label>
  );
}

export function ProvidersSection() {
  const [status, setStatus] = useState<AiSettingsStatus | null>(null);
  const [configSnapshot, setConfigSnapshot] = useState<ProjectConfigSnapshot | null>(null);
  const [storedProviders, setStoredProviders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingPermissions, setSavingPermissions] = useState(false);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verifyingProvider, setVerifyingProvider] = useState<string | null>(null);
  const [verificationByProvider, setVerificationByProvider] = useState<Record<string, AiApiKeyVerificationResult>>({});
  const [workerPermDraft, setWorkerPermDraft] = useState({
    cliMode: "full-auto" as string,
    cliSandboxPermissions: "workspace-write" as string,
    inProcessMode: "full-auto" as string,
  });
  const [utilityModel, setUtilityModel] = useState("anthropic/claude-haiku-4-5");
  const [chatAutoTitleEnabled, setChatAutoTitleEnabled] = useState(false);
  const [chatAutoTitleRefresh, setChatAutoTitleRefresh] = useState(true);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextStoredProviders, snapshot] = await Promise.all([
        window.ade.ai.getStatus(),
        window.ade.ai.listApiKeys(),
        window.ade.projectConfig.get(),
      ]);

      setStatus(nextStatus);
      setStoredProviders(nextStoredProviders.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
      setConfigSnapshot(snapshot);

      const effectiveAiRaw = snapshot.effective?.ai;
      const effectiveAiConfig = effectiveAiRaw && typeof effectiveAiRaw === "object" ? (effectiveAiRaw as AiConfig) : null;
      setUtilityModel(
        normalizeModelSetting(effectiveAiConfig?.sessionIntelligence?.summaries?.modelId)
        || normalizeModelSetting(effectiveAiConfig?.featureModelOverrides?.terminal_summaries)
        || normalizeModelSetting(effectiveAiConfig?.chat?.autoTitleModelId)
        || "anthropic/claude-haiku-4-5",
      );
      setChatAutoTitleEnabled(effectiveAiConfig?.chat?.autoTitleEnabled === true);
      setChatAutoTitleRefresh(effectiveAiConfig?.chat?.autoTitleRefreshOnComplete !== false);

      const effectiveAi = isRecord(snapshot.effective.ai) ? snapshot.effective.ai : {};
      const localAi = isRecord(snapshot.local.ai) ? snapshot.local.ai : {};
      const localPermissions = isRecord(localAi.permissions) ? localAi.permissions : {};
      const effectivePermissions = isRecord(effectiveAi.permissions) ? effectiveAi.permissions : {};
      const localCli = isRecord(localPermissions.cli) ? localPermissions.cli : {};
      const effectiveCli = isRecord(effectivePermissions.cli) ? effectivePermissions.cli : {};
      const localInProcess = isRecord(localPermissions.inProcess) ? localPermissions.inProcess : {};
      const effectiveInProcess = isRecord(effectivePermissions.inProcess) ? effectivePermissions.inProcess : {};

      setWorkerPermDraft({
        cliMode: readString(localCli.mode, effectiveCli.mode, "full-auto"),
        cliSandboxPermissions: readString(localCli.sandboxPermissions, effectiveCli.sandboxPermissions, "workspace-write"),
        inProcessMode: readString(localInProcess.mode, effectiveInProcess.mode, "full-auto"),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const detectedAuth = status?.detectedAuth ?? [];
  const configuredModelOptions = useMemo(
    () => deriveConfiguredModelOptions(status),
    [status],
  );
  const utilityModelOptions = useMemo(
    () => includeSelectedModelOption(configuredModelOptions, utilityModel),
    [configuredModelOptions, utilityModel],
  );

  const saveChatTitleSettings = useCallback(async (patch: Partial<NonNullable<AiConfig["chat"]>>) => {
    const nextModelId =
      patch.autoTitleModelId !== undefined
        ? patch.autoTitleModelId
        : utilityModel || utilityModelOptions[0]?.id || "";
    const nextEnabled =
      patch.autoTitleEnabled !== undefined ? patch.autoTitleEnabled : chatAutoTitleEnabled;
    const nextRefresh =
      patch.autoTitleRefreshOnComplete !== undefined
        ? patch.autoTitleRefreshOnComplete
        : chatAutoTitleRefresh;

    const nextChat = {
      autoTitleEnabled: nextEnabled,
      autoTitleModelId: nextModelId || undefined,
      autoTitleRefreshOnComplete: nextRefresh,
    } satisfies Partial<NonNullable<AiConfig["chat"]>>;

    await window.ade.ai.updateConfig({
      chat: nextChat as AiConfig["chat"],
    });

    setChatAutoTitleEnabled(nextEnabled);
    setChatAutoTitleRefresh(nextRefresh);
  }, [utilityModelOptions, chatAutoTitleEnabled, utilityModel, chatAutoTitleRefresh]);

  const cliAuthMap = useMemo(() => {
    const map = new Map<CliName, AiDetectedAuth>();
    for (const entry of detectedAuth) {
      if (entry.type !== "cli-subscription" || !entry.cli) continue;
      map.set(entry.cli, entry);
    }
    return map;
  }, [detectedAuth]);

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

  const claudeConnected = Boolean(cliAuthMap.get("claude")?.authenticated);
  const codexConnected = Boolean(cliAuthMap.get("codex")?.authenticated);

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

  const savePermissions = async () => {
    setError(null);
    setNotice(null);
    setSavingPermissions(true);
    try {
      const snapshot = configSnapshot ?? (await window.ade.projectConfig.get());
      const localAi = isRecord(snapshot.local.ai) ? snapshot.local.ai : {};

      const nextPermissions: Record<string, Record<string, unknown>> = {};

      const cliPermissions: Record<string, unknown> = {};
      if (workerPermDraft.cliMode && workerPermDraft.cliMode !== "full-auto") {
        cliPermissions.mode = workerPermDraft.cliMode;
      }
      if (workerPermDraft.cliSandboxPermissions && workerPermDraft.cliSandboxPermissions !== "workspace-write") {
        cliPermissions.sandboxPermissions = workerPermDraft.cliSandboxPermissions;
      }
      if (Object.keys(cliPermissions).length > 0) {
        nextPermissions.cli = cliPermissions;
      }

      const inProcessPermissions: Record<string, unknown> = {};
      if (workerPermDraft.inProcessMode && workerPermDraft.inProcessMode !== "full-auto") {
        inProcessPermissions.mode = workerPermDraft.inProcessMode;
      }
      if (Object.keys(inProcessPermissions).length > 0) {
        nextPermissions.inProcess = inProcessPermissions;
      }

      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          ai: {
            ...(snapshot.local.ai ?? {}),
            ...localAi,
            permissions: Object.keys(nextPermissions).length > 0 ? nextPermissions : undefined,
          },
        },
      });

      setNotice("Execution permissions saved.");
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPermissions(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 980 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>AI connections</h2>
          <p style={{ marginTop: 6, marginBottom: 0, fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
            Authenticate providers, confirm active connections, and configure execution permissions.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshStatus()}
          disabled={loading}
          style={{ ...outlineButton(), opacity: loading ? 0.6 : 1, cursor: loading ? "not-allowed" : "pointer" }}
        >
          <ArrowsClockwise size={14} />
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

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
        <div style={sectionLabelStyle}>CLI CONNECTIONS</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          {CLI_TOOLS.map((tool) => {
            const auth = cliAuthMap.get(tool.cli);
            const connected = Boolean(auth?.authenticated);
            const warning = Boolean(auth && !auth.authenticated);
            const tone = getStatusTone({ connected, warning });
            const verificationText = connected
              ? "Connection verified."
              : warning && auth?.verified
                ? `CLI detected but not signed in. Run: ${tool.loginCmd}`
                : warning && auth?.verified === false
                  ? `CLI found at ${auth?.path ?? tool.cli} but auth check was inconclusive. If you can use ${tool.cli} from the terminal, this connection should work. Try running: ${tool.loginCmd}`
                  : `CLI not found in PATH. Install: ${tool.installHint}. If already installed, ensure it's in your shell PATH and restart ADE.`;

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
                    {connected ? <CheckCircle size={14} weight="fill" /> : warning ? <WarningCircle size={14} weight="fill" /> : <XCircle size={14} weight="fill" />}
                    <span style={{ fontSize: 9, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px" }}>
                      {tone.label}
                    </span>
                  </div>
                </div>
                <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                  {verificationText}
                </div>
                {auth?.path && (
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
                    {auth.path}
                  </code>
                )}
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
                      width: 18,
                      height: 18,
                      display: "grid",
                      placeItems: "center",
                      fontSize: 9,
                      fontFamily: MONO_FONT,
                      color: provider.accent,
                      border: `1px solid ${provider.accent}60`,
                      background: `${provider.accent}15`,
                    }}
                  >
                    {provider.label.slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>{provider.label}</div>
                    <div style={{ fontSize: 9, fontFamily: MONO_FONT, color: COLORS.textMuted }}>{provider.envVar}</div>
                  </div>
                </div>

                {isEditing ? (
                  <input
                    type="password"
                    value={editValue}
                    onChange={(event) => setEditValue(event.target.value)}
                    placeholder={provider.placeholder || `Enter ${provider.label} API key`}
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveApiKey(provider.provider);
                      if (event.key === "Escape") cancelEditing();
                    }}
                    style={{
                      width: "100%",
                      height: 30,
                      border: `1px solid ${COLORS.outlineBorder}`,
                      background: COLORS.pageBg,
                      color: COLORS.textPrimary,
                      fontFamily: MONO_FONT,
                      fontSize: 11,
                      padding: "0 8px",
                      outline: "none",
                    }}
                  />
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {keySource ? (
                        <>
                          <SourceBadge source={keySource} />
                          <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                            Key is configured
                          </span>
                        </>
                      ) : (
                        <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                          No key configured
                        </span>
                      )}
                    </div>
                    {verification && (
                      <div
                        style={{
                          fontSize: 10,
                          fontFamily: MONO_FONT,
                          color: verification.ok ? COLORS.success : COLORS.warning,
                          lineHeight: 1.5,
                        }}
                      >
                        {verification.message}
                        <span style={{ color: COLORS.textDim }}> ({new Date(verification.verifiedAt).toLocaleTimeString()})</span>
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {isEditing ? (
                    <>
                      <button type="button" onClick={() => void saveApiKey(provider.provider)} style={primaryButton()}>
                        Save
                      </button>
                      <button type="button" onClick={cancelEditing} style={outlineButton()}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => beginEditing(provider.provider)}
                        style={outlineButton()}
                      >
                        {keySource ? "Update" : "Add Key"}
                      </button>
                      {keySource && (
                        <button
                          type="button"
                          onClick={() => void verifyApiKey(provider.provider)}
                          disabled={verifyingProvider === provider.provider}
                          style={{
                            ...outlineButton(),
                            opacity: verifyingProvider === provider.provider ? 0.6 : 1,
                            cursor: verifyingProvider === provider.provider ? "not-allowed" : "pointer",
                          }}
                        >
                          {verifyingProvider === provider.provider ? "Verifying..." : "Verify"}
                        </button>
                      )}
                      {storedProviders.includes(provider.provider) && (
                        <button
                          type="button"
                          onClick={() => void deleteApiKey(provider.provider)}
                          style={dangerButton()}
                        >
                          Remove
                        </button>
                      )}
                    </>
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

      <div style={groupLabelStyle}>EXECUTION SAFETY</div>

      <section style={cardStyle()}>
        <div style={sectionLabelStyle}>WORKER PERMISSIONS</div>
        <div
          style={{
            fontSize: 10,
            fontFamily: MONO_FONT,
            color: COLORS.textMuted,
            marginBottom: 10,
            lineHeight: 1.5,
          }}
        >
          Controls how automated background workers execute tasks. CLI workers run via Claude Code or Codex CLI processes.
          In-process workers use ADE's built-in runtime. These permissions apply to unattended/automated operations, not interactive CLI sessions.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
          <div
            style={{
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.border}`,
              borderLeft: `3px solid ${(claudeConnected || codexConnected) ? COLORS.success : COLORS.textDim}`,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary, fontWeight: 700 }}>CLI Workers</span>
              <span style={{ fontSize: 9, fontFamily: MONO_FONT, color: (claudeConnected || codexConnected) ? COLORS.success : COLORS.textMuted, textTransform: "uppercase", letterSpacing: "1px" }}>
                {(claudeConnected || codexConnected) ? "Available" : "Unavailable"}
              </span>
            </div>
            <div style={{ fontSize: 9, fontFamily: MONO_FONT, color: COLORS.textMuted, marginTop: -4 }}>
              Claude CLI: {claudeConnected ? "connected" : "offline"} · Codex CLI: {codexConnected ? "connected" : "offline"}
            </div>
            <SelectField
              label="MODE"
              value={workerPermDraft.cliMode}
              onChange={(value) => setWorkerPermDraft((prev) => ({ ...prev, cliMode: value }))}
              options={[
                { value: "read-only", label: "Read-only" },
                { value: "edit", label: "Edit" },
                { value: "full-auto", label: "Full auto" },
              ]}
            />
            <SelectField
              label="SANDBOX MODE"
              value={workerPermDraft.cliSandboxPermissions}
              onChange={(value) => setWorkerPermDraft((prev) => ({ ...prev, cliSandboxPermissions: value }))}
              options={[
                { value: "read-only", label: "Read-only" },
                { value: "workspace-write", label: "Workspace write" },
                { value: "danger-full-access", label: "Danger full access" },
              ]}
            />
          </div>

          <div
            style={{
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.border}`,
              borderLeft: `3px solid ${COLORS.info}`,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary, fontWeight: 700 }}>In-Process Workers</span>
              <span style={{ fontSize: 9, fontFamily: MONO_FONT, color: COLORS.info, textTransform: "uppercase", letterSpacing: "1px" }}>
                Unified Runtime
              </span>
            </div>
            <SelectField
              label="MODE"
              value={workerPermDraft.inProcessMode}
              onChange={(value) => setWorkerPermDraft((prev) => ({ ...prev, inProcessMode: value }))}
              options={[
                { value: "plan", label: "Plan" },
                { value: "edit", label: "Edit" },
                { value: "full-auto", label: "Full auto" },
              ]}
            />
          </div>
        </div>
        <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={() => void savePermissions()}
            disabled={savingPermissions}
            style={{ ...primaryButton(), opacity: savingPermissions ? 0.6 : 1, cursor: savingPermissions ? "not-allowed" : "pointer" }}
          >
            {savingPermissions ? "Saving..." : "Save Permissions"}
          </button>
        </div>
      </section>

      {/* ── AI Utilities ── */}
      <section style={{ marginTop: 24 }}>
        <div style={{ ...LABEL_STYLE, fontSize: 11, marginBottom: 6 }}>LIGHTWEIGHT TASKS</div>
        <div style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: MONO_FONT, marginBottom: 10 }}>
          Choose the model used for lightweight AI tasks like chat summaries, terminal summaries, and auto-naming chat tabs.
          A fast, inexpensive model (e.g. Haiku) is recommended.
        </div>
        <div style={cardStyle({ padding: 16, display: "grid", gap: 14 })}>
          <SelectField
            label="SUMMARY MODEL"
            value={utilityModel}
            onChange={(value) => {
              setUtilityModel(value);
              void window.ade.ai.updateConfig({
                featureModelOverrides: { terminal_summaries: value } as AiConfig["featureModelOverrides"],
                sessionIntelligence: {
                  summaries: {
                    modelId: value || undefined,
                  },
                } as AiConfig["sessionIntelligence"],
                chat: {
                  autoTitleEnabled: chatAutoTitleEnabled,
                  autoTitleModelId: value || undefined,
                  autoTitleRefreshOnComplete: chatAutoTitleRefresh,
                } as AiConfig["chat"],
              });
            }}
            options={
              utilityModelOptions.length > 0
                ? utilityModelOptions.map((m) => ({ value: m.id, label: m.label }))
                : [
                    { value: "haiku", label: "Haiku" },
                    { value: "sonnet", label: "Sonnet" },
                    { value: "opus", label: "Opus" },
                  ]
            }
          />

          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={chatAutoTitleEnabled}
              onChange={(event) => {
                const nextEnabled = event.target.checked;
                const fallbackModelId = utilityModel || utilityModelOptions[0]?.id || "";
                void saveChatTitleSettings({
                  autoTitleEnabled: nextEnabled,
                  autoTitleModelId: fallbackModelId || undefined,
                });
              }}
            />
            <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary, fontWeight: 600 }}>
              Auto-name chat tabs
            </span>
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={chatAutoTitleRefresh}
              onChange={(event) => {
                void saveChatTitleSettings({
                  autoTitleRefreshOnComplete: event.target.checked,
                });
              }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary, fontWeight: 600 }}>
                Refresh title when session closes
              </span>
              <span style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                Helpful when the work shifts after the initial prompt.
              </span>
            </div>
          </label>
        </div>
      </section>
    </div>
  );
}
