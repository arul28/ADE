import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  AiConfig,
  AiApiKeyVerificationResult,
  AiClaudeAvailability,
  AiProviderConnectionStatus,
  AiSettingsStatus,
  ProjectConfigSnapshot,
} from "../../../shared/types";
import type {
  AiCustomProviderConfig,
  OpenCodeProviderAuthMethods,
} from "../../../shared/types/config";
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
  Copy,
  Cpu,
  Info,
  MagnifyingGlass,
  WarningCircle,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { ClaudeLogo, CodexLogo, CursorAgentLogo, OpenCodeLogo } from "../terminals/ToolLogos";
import { ProviderLogo } from "../shared/ProviderLogos";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  LABEL_STYLE,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { cursorProviderAvailable, rendererPlatformAttribute } from "../../lib/platform";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { invalidateAiDiscoveryCache } from "../../lib/aiDiscoveryCache";
import { shouldRefreshAiStatusForChatEvent } from "../../lib/aiProviderStatus";
import { showToast } from "../app/toast/toastStore";
import { ClaudeLoginPromptButton, revealTerminalSessionInWork } from "../work/ClaudeLoginPromptButton";
import {
  OpenCodeProviderDetailModal,
  type ApiKeySource,
  type OpenCodeProviderDetail,
} from "./OpenCodeProviderDetailModal";

type CliName = "claude" | "codex" | "cursor" | "droid";

const KIMI_PROVIDER_ID = "kimi-for-coding";
const OPENCODE_CATALOG_EXCLUDED_IDS = new Set(["cursor", "ollama", "lmstudio"]);

/**
 * OpenCode's own documented install methods, per platform. Windows has neither
 * Homebrew nor a POSIX shell to pipe the install script into, so it gets the
 * package managers OpenCode actually documents for Windows (npm, Scoop,
 * Chocolatey) instead of commands that cannot run there.
 */
export function openCodeInstallCommands(
  platform: ReturnType<typeof rendererPlatformAttribute> = rendererPlatformAttribute(),
): string[] {
  if (platform === "win32") {
    return [
      "npm i -g opencode-ai",
      "scoop install opencode",
      "choco install opencode",
    ];
  }
  return [
    "brew install anomalyco/tap/opencode",
    "npm i -g opencode-ai",
    "curl -fsSL https://opencode.ai/install | bash",
  ];
}

const CUSTOM_PROVIDER_NPM_OPTIONS = [
  "@ai-sdk/openai-compatible",
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
];

// Factory ships a native Windows build of `droid` with its own installer and
// its own way of setting an environment variable — a POSIX `export` line and a
// bare docs link leave a Windows user with nothing to run.
// https://docs.factory.ai/cli/getting-started/quickstart
const DROID_INSTALL_HINT = rendererPlatformAttribute() === "win32"
  ? "irm https://app.factory.ai/cli/windows | iex — installs droid.exe into %USERPROFILE%\\bin and puts it on PATH"
  : "curl -fsSL https://app.factory.ai/cli | sh — ensure `droid` is on PATH";
const DROID_LOGIN_CMD = rendererPlatformAttribute() === "win32"
  ? "setx FACTORY_API_KEY … (or sign in via `droid` interactive login)"
  : "export FACTORY_API_KEY=… (or sign in via `droid` interactive login)";

const CLI_TOOLS: Array<{
  cli: CliName;
  label: string;
  authStory: string;
  loginCmd: string;
  installHint: string;
  /** Used instead of installHint on Windows, where the vendor ships a different installer. */
  windowsInstallHint?: string;
}> = [
  {
    cli: "claude",
    label: "Claude Code",
    authStory: "Uses your claude login — Claude Pro/Max subscription or ANTHROPIC_API_KEY.",
    loginCmd: "claude auth login or set ANTHROPIC_API_KEY",
    installHint: "npm install -g @anthropic-ai/claude-code",
    // Anthropic's documented Windows installs: the PowerShell native installer
    // (drops claude.exe in %USERPROFILE%\.localin) or WinGet.
    windowsInstallHint: "irm https://claude.ai/install.ps1 | iex (PowerShell), or winget install Anthropic.ClaudeCode",
  },
  {
    cli: "codex",
    label: "Codex CLI",
    authStory: "Uses your ChatGPT sign-in — Plus/Pro subscription or OPENAI_API_KEY.",
    loginCmd: "codex login",
    installHint: "npm install -g @openai/codex",
  },
  {
    cli: "cursor",
    label: "Cursor",
    authStory: "Uses CURSOR_API_KEY.",
    loginCmd: "Add a Cursor API key",
    installHint: "Get a Cursor API key from https://cursor.com/dashboard/api",
  },
  {
    cli: "droid",
    label: "Droid",
    authStory: "Uses your Factory login or FACTORY_API_KEY.",
    loginCmd: DROID_LOGIN_CMD,
    installHint: DROID_INSTALL_HINT,
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
}> = [
  { provider: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY", placeholder: "sk-ant-..." },
  { provider: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY", placeholder: "sk-..." },
  { provider: "google", label: "Google AI", envVar: "GOOGLE_API_KEY", placeholder: "AIza..." },
  { provider: "mistral", label: "Mistral", envVar: "MISTRAL_API_KEY", placeholder: "mistral-..." },
  { provider: "deepseek", label: "DeepSeek", envVar: "DEEPSEEK_API_KEY", placeholder: "sk-..." },
  { provider: "xai", label: "xAI", envVar: "XAI_API_KEY", placeholder: "xai-..." },
  { provider: "groq", label: "Groq", envVar: "GROQ_API_KEY", placeholder: "gsk_..." },
  { provider: "together", label: "Together AI", envVar: "TOGETHER_API_KEY", placeholder: "tg_..." },
  { provider: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY", placeholder: "sk-or-..." },
  { provider: "moonshotai", label: "Moonshot AI", envVar: "MOONSHOT_API_KEY", placeholder: "sk-..." },
];

type LocalProviderDraft = {
  enabled: boolean;
  endpoint: string;
  autoDetect: boolean;
  preferredModelId: string;
};

type CustomProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  npm: string;
  slugs: string;
  apiKey: string;
};

const EMPTY_CUSTOM_PROVIDER: CustomProviderDraft = {
  id: "",
  name: "",
  baseUrl: "",
  npm: CUSTOM_PROVIDER_NPM_OPTIONS[0],
  slugs: "",
  apiKey: "",
};

const groupLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 0,
  color: COLORS.textSecondary,
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontFamily: MONO_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
  color: COLORS.textMuted,
  fontWeight: 700,
};

/** Squared bordered surface — the shared "ledger" panel used across this section. */
function panel(overrides?: React.CSSProperties): React.CSSProperties {
  return {
    border: `1px solid ${COLORS.border}`,
    background: COLORS.recessedBg,
    padding: 12,
    ...overrides,
  };
}

function prettifyProviderId(id: string): string {
  return id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function AlertBanner({
  tone,
  message,
  onDismiss,
}: {
  tone: "success" | "error" | "warning";
  message: string;
  onDismiss: () => void;
}) {
  const color = tone === "success" ? COLORS.success : tone === "warning" ? COLORS.warning : COLORS.danger;
  const token = tone === "success" ? "success" : tone === "warning" ? "warning" : "error";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      style={{
        padding: "8px 10px 8px 12px",
        fontSize: 11,
        fontFamily: MONO_FONT,
        color,
        background: `color-mix(in srgb, var(--color-${token}) 12%, transparent)`,
        border: `1px solid color-mix(in srgb, var(--color-${token}) 30%, transparent)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{message}</span>
      <button
        type="button"
        aria-label={`Dismiss ${tone} message`}
        onClick={onDismiss}
        style={{
          border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
          background: "transparent",
          color,
          width: 22,
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "pointer",
        }}
      >
        <X size={12} weight="bold" />
      </button>
    </div>
  );
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

function ConnectedTag() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 8px",
        fontSize: 10,
        fontFamily: MONO_FONT,
        color: COLORS.success,
        background: "color-mix(in srgb, var(--color-success) 14%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-success) 30%, transparent)",
      }}
    >
      <CheckCircle size={12} weight="fill" /> Connected
    </span>
  );
}

function OpenCodeProviderCard({
  provider,
  onOpen,
}: {
  provider: OpenCodeProviderDetail;
  onOpen: () => void;
}) {
  const badge = provider.connected
    ? "Connected"
    : provider.hasKey
      ? "Key"
      : provider.methods.some((m) => m.type === "oauth")
        ? "OAuth"
        : "Add";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={provider.connected || provider.hasKey ? `Open ${provider.name}` : `Connect ${provider.name}`}
      style={{
        ...panel({ padding: 10 }),
        display: "flex",
        flexDirection: "column",
        gap: 8,
        textAlign: "left",
        cursor: "pointer",
        width: "100%",
        minHeight: 72,
        background: COLORS.recessedBg,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <ProviderLogo family={provider.id} size={22} />
          <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {provider.name}
          </span>
        </div>
        {provider.connected ? (
          <ConnectedTag />
        ) : (
          <span style={{ fontSize: 9, fontFamily: MONO_FONT, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.6px" }}>
            {badge}
          </span>
        )}
      </div>
      {typeof provider.modelCount === "number" ? (
        <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
          {provider.modelCount} model{provider.modelCount === 1 ? "" : "s"}
        </div>
      ) : null}
    </button>
  );
}

function CopyableCommand({ command }: { command: string }) {
  const { copy, copied } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => void copy(command)}
      title="Copy"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        width: "100%",
        textAlign: "left",
        fontSize: 11,
        fontFamily: MONO_FONT,
        color: COLORS.textSecondary,
        background: "color-mix(in srgb, var(--color-muted-fg) 12%, transparent)",
        border: `1px solid ${COLORS.border}`,
        padding: "8px 10px",
        cursor: "pointer",
      }}
    >
      <code style={{ overflowWrap: "anywhere", wordBreak: "break-all" }}>{command}</code>
      {copied ? <CheckCircle size={13} weight="fill" style={{ flexShrink: 0, color: COLORS.success }} /> : <Copy size={13} weight="bold" style={{ flexShrink: 0 }} />}
    </button>
  );
}

function getStatusTone(connection: AiProviderConnectionStatus | null | undefined): { color: string; label: string } {
  if (connection?.runtimeAvailable) return { color: COLORS.success, label: "Connected" };
  if (connection?.runtimeDetected || connection?.authAvailable) return { color: COLORS.warning, label: "Sign-In Required" };
  return { color: COLORS.textDim, label: "Not Detected" };
}

function getClaudeAvailabilityTone(availability: AiClaudeAvailability | null | undefined): { color: string; label: string } {
  if (availability?.binary.present && availability.auth.ready) return { color: COLORS.success, label: "Ready" };
  if (availability?.binary.present) return { color: COLORS.warning, label: "Sign-In Required" };
  return { color: COLORS.textDim, label: "Binary Missing" };
}

function buildClaudeAvailabilityMessage(availability: AiClaudeAvailability | null | undefined): string {
  if (!availability?.binary.present) {
    return "Claude unavailable (binary missing; should not happen with bundled install; run /doctor).";
  }
  if (!availability.auth.ready) {
    return availability.auth.detail || "Sign in to use Claude";
  }
  return "Ready";
}

function describeCredentialSource(connection: AiProviderConnectionStatus | null | undefined): string | null {
  const localSource = connection?.sources.find((entry) => entry.kind === "local-credentials" && entry.detected);
  if (!localSource?.source) return null;
  if (localSource.source === "macos-keychain") return "Local credentials found in macOS Keychain.";
  if (localSource.source === "claude-credentials-file") return "Local credentials found in ~/.claude/.credentials.json.";
  if (localSource.source === "codex-auth-file") return "Local credentials found in ~/.codex/auth.json.";
  if (localSource.source === "cursor-env") return "Detected via CURSOR_API_KEY environment variable.";
  if (localSource.source === "cursor-api-key-store") return "Cursor API key is stored in ADE encrypted storage.";
  if (localSource.source === "factory-env") return "Detected via FACTORY_API_KEY environment variable.";
  return null;
}

const isWindowsRenderer = rendererPlatformAttribute() === "win32";

function installHintFor(tool: (typeof CLI_TOOLS)[number]): string {
  return (isWindowsRenderer && tool.windowsInstallHint) || tool.installHint;
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
    return `Local credentials exist but CLI not found in PATH. Install: ${installHintFor(tool)}`;
  }
  const pathAdvice = isWindowsRenderer
    ? "If already installed, add its folder to your Windows PATH (System Properties -> Environment Variables), reopen ADE, and use Refresh."
    : "If already installed, ensure it is on your shell PATH and use Refresh.";
  return `CLI not found in PATH. Install: ${installHintFor(tool)}. ${pathAdvice}`;
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

function buildLocalProviderDrafts(
  snapshot: ProjectConfigSnapshot | null | undefined,
  status: AiSettingsStatus | null | undefined,
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
  const navigate = useNavigate();
  const [status, setStatus] = useState<AiSettingsStatus | null>(null);
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
  const [dismissedApiKeyStoreWarning, setDismissedApiKeyStoreWarning] = useState<string | null>(null);
  const [verifyingProvider, setVerifyingProvider] = useState<string | null>(null);
  const [verificationByProvider, setVerificationByProvider] = useState<Record<string, AiApiKeyVerificationResult>>({});
  const [authMethods, setAuthMethods] = useState<OpenCodeProviderAuthMethods | null>(null);
  const [authMethodsError, setAuthMethodsError] = useState<string | null>(null);
  const [detailProviderId, setDetailProviderId] = useState<string | null>(null);
  const [providerSearch, setProviderSearch] = useState("");
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [customProviderDraft, setCustomProviderDraft] = useState<CustomProviderDraft>(EMPTY_CUSTOM_PROVIDER);
  const [customModelSlugs, setCustomModelSlugs] = useState("");
  const [savingAdvanced, setSavingAdvanced] = useState(false);
  const [statusLoadError, setStatusLoadError] = useState<string | null>(null);
  const statusKnownRef = useRef(false);
  const pendingRefreshTimerRef = useRef<number | null>(null);
  // Seed the slugs field from config exactly once — saves send the full list
  // (replace semantics), so the field must start from what's persisted or a
  // save would silently wipe existing entries.
  const slugsSeededRef = useRef(false);
  const revealClaudeLoginTerminalInWork = useCallback((terminal: { terminalId: string; laneId: string }) => {
    revealTerminalSessionInWork(navigate, terminal);
  }, [navigate]);

  const refreshStatus = useCallback(async (options?: { force?: boolean; silent?: boolean; refreshOpenCodeInventory?: boolean }): Promise<AiSettingsStatus | null> => {
    if (!options?.silent) {
      setLoading(true);
      if (!statusKnownRef.current) setStatusLoadError(null);
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
      statusKnownRef.current = true;
      setStatusLoadError(null);
      setStatus(nextStatus as AiSettingsStatus);
      setProjectConfigSnapshot(nextProjectConfig);
      if (editingLocalProvider == null && savingLocalProvider == null) {
        setLocalProviderDrafts(buildLocalProviderDrafts(nextProjectConfig, nextStatus as AiSettingsStatus));
      }
      setStoredProviders(nextStoredProviders.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
      return nextStatus as AiSettingsStatus;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!statusKnownRef.current) setStatusLoadError(message);
      setError(message);
      return null;
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [editingLocalProvider, savingLocalProvider]);

  const loadAuthMethods = useCallback(async () => {
    try {
      const result = await window.ade.ai.opencodeAuthMethods();
      setAuthMethods(result.methods ?? {});
      setAuthMethodsError(null);
    } catch (err) {
      // Keep any previously loaded methods so an intermittent failure does not
      // wipe SuperGrok / ChatGPT OAuth rows mid-session.
      setAuthMethodsError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshStatus({
      force: forceRefreshOnMount,
      refreshOpenCodeInventory: true,
    });
    void loadAuthMethods();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceRefreshOnMount]);

  useEffect(() => {
    if (slugsSeededRef.current) return;
    const persisted = status?.customModelSlugs;
    if (!persisted) return;
    slugsSeededRef.current = true;
    // Never clobber text the user typed while the initial probe was loading.
    setCustomModelSlugs((current) => (current === "" && persisted.length ? persisted.join(", ") : current));
  }, [status?.customModelSlugs]);

  useEffect(() => {
    const unsubscribe = window.ade.agentChat.onEvent((envelope) => {
      if (!shouldRefreshAiStatusForChatEvent(envelope)) return;
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
  // Keep provider cards neutral while the status payload is unavailable. A
  // failed first probe must not be presented as a real "Binary Missing" state.
  const isInitialCheckInFlight = status == null;
  const opencodeStatusKnown = status !== null;
  const opencodeStatusLoadFailed = !opencodeStatusKnown && !loading && statusLoadError !== null;
  const opencodeInstalled = status?.opencodeBinaryInstalled !== false;
  const opencodeProviders = useMemo(() => status?.opencodeProviders ?? [], [status?.opencodeProviders]);
  const providersStale = status?.opencodeProvidersStale === true;

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

  const hasKeyFor = useCallback(
    (providerId: string) => apiKeySources.has(providerId) || storedProviders.includes(providerId),
    [apiKeySources, storedProviders],
  );

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
    if (status?.apiKeyStore?.macosKeychainError) {
      return status.apiKeyStore.macosKeychainError;
    }
    if (status?.apiKeyStore?.decryptionFailed) {
      if (status.apiKeyStore.macosKeychainAvailable) {
        return "An older encrypted API key file could not be decrypted from this app identity. New keys are stored in macOS Keychain; re-enter any missing keys.";
      }
      return "Encrypted API keys exist but could not be decrypted on this machine. Re-enter the affected keys to continue using them.";
    }
    if (status?.apiKeyStore?.secureStorageAvailable === false) {
      return "OS secure storage is unavailable, so ADE cannot persist API keys locally right now.";
    }
    return null;
  }, [status?.apiKeyStore]);
  const visibleApiKeyStoreWarning =
    apiKeyStoreWarning && dismissedApiKeyStoreWarning !== apiKeyStoreWarning
      ? apiKeyStoreWarning
      : null;

  // Unified OpenCode provider catalog: inventory + auth methods + known API key rows.
  const openCodeCatalog = useMemo((): OpenCodeProviderDetail[] => {
    const byId = new Map<string, OpenCodeProviderDetail>();
    const inventoryById = new Map(
      opencodeProviders.map((p) => [p.id, p] as const),
    );
    const apiById = new Map(API_KEY_PROVIDERS.map((p) => [p.provider, p] as const));

    const upsert = (id: string, patch: Partial<OpenCodeProviderDetail> = {}) => {
      if (OPENCODE_CATALOG_EXCLUDED_IDS.has(id)) return;
      const apiSpec = apiById.get(id);
      const inventory = inventoryById.get(id);
      const prev = byId.get(id);
      const methods = patch.methods ?? prev?.methods ?? authMethods?.[id] ?? [];
      byId.set(id, {
        id,
        name: patch.name ?? prev?.name ?? inventory?.name ?? apiSpec?.label ?? prettifyProviderId(id),
        methods,
        connected: patch.connected ?? prev?.connected ?? inventory?.connected === true,
        hasKey: hasKeyFor(id),
        modelCount: patch.modelCount ?? prev?.modelCount ?? inventory?.modelCount,
        envVar: patch.envVar ?? prev?.envVar ?? apiSpec?.envVar,
        placeholder: patch.placeholder ?? prev?.placeholder ?? apiSpec?.placeholder,
      });
    };

    for (const p of opencodeProviders) {
      upsert(p.id, { name: p.name, modelCount: p.modelCount, connected: p.connected });
    }
    for (const [id, methods] of Object.entries(authMethods ?? {})) {
      upsert(id, { methods });
    }
    for (const api of API_KEY_PROVIDERS) {
      upsert(api.provider, {
        name: api.label,
        envVar: api.envVar,
        placeholder: api.placeholder,
      });
    }
    // Kimi for Coding is ADE's known API-key path; keep OpenCode-advertised methods if present.
    const kimiInventory = inventoryById.get(KIMI_PROVIDER_ID);
    upsert(KIMI_PROVIDER_ID, {
      name: "Kimi for Coding",
      envVar: "KIMI_API_KEY",
      placeholder: "sk-…",
      connected: kimiInventory?.connected === true || hasKeyFor(KIMI_PROVIDER_ID),
    });

    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [authMethods, opencodeProviders, hasKeyFor]);

  const openCodeCatalogById = useMemo(
    () => new Map(openCodeCatalog.map((row) => [row.id, row] as const)),
    [openCodeCatalog],
  );

  const connectedOpenCodeProviders = useMemo(
    () => openCodeCatalog.filter((p) => p.connected || p.hasKey),
    [openCodeCatalog],
  );

  const popularOpenCodeProviders = useMemo(() => {
    const popularIds = [
      ...API_KEY_PROVIDERS.map((p) => p.provider),
      ...Object.keys(authMethods ?? {}).filter((id) => authMethods?.[id]?.some((m) => m.type === "oauth")),
      KIMI_PROVIDER_ID,
    ];
    const connectedIds = new Set(
      openCodeCatalog.filter((p) => p.connected || p.hasKey).map((p) => p.id),
    );
    const seen = new Set<string>();
    const list: OpenCodeProviderDetail[] = [];
    for (const id of popularIds) {
      if (seen.has(id) || connectedIds.has(id)) continue;
      seen.add(id);
      const row = openCodeCatalogById.get(id);
      if (row) list.push(row);
    }
    return list;
  }, [openCodeCatalog, openCodeCatalogById, authMethods]);

  const searchableOpenCodeProviders = useMemo(() => {
    const query = providerSearch.trim().toLowerCase();
    return openCodeCatalog
      .filter((p) => !query || p.id.toLowerCase().includes(query) || p.name.toLowerCase().includes(query))
      .sort((a, b) => (b.modelCount ?? 0) - (a.modelCount ?? 0));
  }, [openCodeCatalog, providerSearch]);

  const detailProvider = useMemo(
    () => (detailProviderId ? openCodeCatalog.find((p) => p.id === detailProviderId) ?? null : null),
    [detailProviderId, openCodeCatalog],
  );
  const openProviderDetail = useCallback((id: string) => {
    // Always use the unified provider modal (OAuth + API key), including Kimi.
    setDetailProviderId(id);
  }, []);

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

  const deleteApiKey = async (provider: string, options?: { alsoOpenCode?: boolean }) => {
    setError(null);
    setNotice(null);
    try {
      if (options?.alsoOpenCode) {
        const result = await window.ade.ai.clearOpencodeProviderKey({ providerId: provider });
        if (!result.ok) {
          throw new Error(result.error || "OpenCode could not remove the provider key.");
        }
      }
      await window.ade.ai.deleteApiKey(provider);
      invalidateAiDiscoveryCache();
      const label =
        API_KEY_PROVIDERS.find((row) => row.provider === provider)?.label
        ?? (provider === KIMI_PROVIDER_ID ? "Kimi for Coding" : prettifyProviderId(provider));
      setNotice(`${label} disconnected.`);
      if (editingProvider === provider) cancelEditing();
      setVerificationByProvider((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Re-throw so nested modals (detail overlay) can show the failure in-dialog.
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  const verifyApiKey = async (provider: string) => {
    setError(null);
    setNotice(null);
    setVerifyingProvider(provider);
    setVerificationByProvider((prev) => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
    try {
      invalidateAiDiscoveryCache();
      const result = await window.ade.ai.verifyApiKey(provider);
      invalidateAiDiscoveryCache();
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
      setVerificationByProvider((prev) => ({ ...prev, [provider]: result }));
      if (result.ok) {
        setNotice(`${provider} connection verified.`);
      } else {
        setError(result.message || `${provider} verification failed.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifyingProvider(null);
    }
  };

  const saveCursorApiKey = async () => {
    const trimmed = editValue.trim();
    if (!trimmed) return;

    setError(null);
    setNotice(null);
    setVerifyingProvider("cursor");
    setVerificationByProvider((prev) => {
      const next = { ...prev };
      delete next.cursor;
      return next;
    });
    try {
      await window.ade.ai.storeApiKey("cursor", trimmed);
      invalidateAiDiscoveryCache();
      setStoredProviders((prev) => Array.from(new Set([...prev, "cursor"])));
      const result = await window.ade.ai.verifyApiKey("cursor");
      invalidateAiDiscoveryCache();
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
      setVerificationByProvider((prev) => ({ ...prev, cursor: result }));
      if (result.ok) {
        setNotice("Cursor connection verified.");
        cancelEditing();
      } else {
        setError(result.message || "Cursor verification failed.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifyingProvider(null);
    }
  };

  const handleRefreshCatalog = async () => {
    setRefreshingCatalog(true);
    try {
      await window.ade.ai.refreshModelsDev();
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingCatalog(false);
    }
  };

  const handleSubscriptionConnected = useCallback(async (providerId: string, providerName: string) => {
    const before = status?.availableModelIds?.length ?? 0;
    const next = await refreshStatus({ force: true, refreshOpenCodeInventory: true });
    void loadAuthMethods();
    const after = next?.availableModelIds?.length ?? before;
    const modelCount =
      next?.opencodeProviders?.find((p) => p.id === providerId)?.modelCount
      ?? Math.max(0, after - before);
    showToast({
      tone: "success",
      title: `${providerName} connected`,
      message: `${modelCount} model${modelCount === 1 ? "" : "s"} added`,
    });
  }, [status?.availableModelIds, refreshStatus, loadAuthMethods]);

  const saveAdvancedProvider = async () => {
    const draft = customProviderDraft;
    const id = draft.id.trim();
    const baseURL = draft.baseUrl.trim();
    const slugs = draft.slugs.split(",").map((s) => s.trim()).filter(Boolean);
    if (!id || !baseURL || slugs.length === 0) {
      setError("A custom provider needs an id, a base URL, and at least one model slug.");
      return;
    }
    setSavingAdvanced(true);
    setError(null);
    setNotice(null);
    try {
      if (draft.apiKey.trim()) {
        await window.ade.ai.storeApiKey(id, draft.apiKey.trim());
      }
      // Full-list write: config merge uses replace semantics, so include every
      // existing provider (replacing any same-id entry) or they'd be dropped.
      const existingProviders = (status?.customProviders ?? []).filter((entry) => entry.id !== id);
      await window.ade.ai.updateConfig({
        customProviders: [
          ...existingProviders,
          {
            id,
            name: draft.name.trim() || prettifyProviderId(id),
            baseURL,
            npm: draft.npm as AiCustomProviderConfig["npm"],
            models: slugs,
          },
        ],
      });
      invalidateAiDiscoveryCache();
      setNotice(`Custom provider ${id} saved.`);
      setCustomProviderDraft(EMPTY_CUSTOM_PROVIDER);
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAdvanced(false);
    }
  };

  const saveCustomModelSlugs = async () => {
    const slugs = customModelSlugs.split(",").map((s) => s.trim()).filter(Boolean);
    setSavingAdvanced(true);
    setError(null);
    setNotice(null);
    try {
      await window.ade.ai.updateConfig({
        customModelSlugs: slugs,
      });
      invalidateAiDiscoveryCache();
      setNotice("Custom model slugs saved.");
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAdvanced(false);
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
      invalidateAiDiscoveryCache();
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
        <AlertBanner tone="success" message={notice} onDismiss={() => setNotice(null)} />
      )}

      {error && (
        <AlertBanner tone="error" message={error} onDismiss={() => setError(null)} />
      )}

      {visibleApiKeyStoreWarning && (
        <AlertBanner
          tone="warning"
          message={visibleApiKeyStoreWarning}
          onDismiss={() => setDismissedApiKeyStoreWarning(visibleApiKeyStoreWarning)}
        />
      )}

      {/* ══ Coding Agents ══ */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={groupLabelStyle}>Coding Agents</div>

        {/* ── Claude Code ── */}
        {(() => {
          const tool = CLI_TOOLS.find((t) => t.cli === "claude")!;
          const connection = providerConnections?.[tool.cli] ?? null;
          const availability = status?.availableProviders?.claude ?? null;
          const credentialSourceDesc = describeCredentialSource(connection);
          const tone = isInitialCheckInFlight ? { color: COLORS.info, label: "Checking" } : getClaudeAvailabilityTone(availability);
          const message = isInitialCheckInFlight ? "Checking Claude SDK binary and login status." : buildClaudeAvailabilityMessage(availability);
          const binaryPath = availability?.binary.path ?? connection?.path ?? null;
          return (
            <section style={panel({ borderLeft: `3px solid ${tone.color}`, padding: 14 })}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <ClaudeLogo size={26} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>Claude Code</div>
                    <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.35 }}>{tool.authStory}</div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 4, color: tone.color }}>
                  {isInitialCheckInFlight ? <Info size={14} weight="fill" /> : availability?.auth.ready ? <CheckCircle size={14} weight="fill" /> : availability?.binary.present ? <WarningCircle size={14} weight="fill" /> : <XCircle size={14} weight="fill" />}
                  <span style={{ fontSize: 9, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px" }}>{tone.label}</span>
                </div>
              </div>
              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5, marginTop: 10 }}>{message}</div>
              {!isInitialCheckInFlight && availability?.binary.present && !availability.auth.ready ? (
                <div style={{ display: "flex", marginTop: 10 }}>
                  <ClaudeLoginPromptButton
                    visible
                    storageKey="settings:claude-auth"
                    dismissible={false}
                    onTerminalCreated={revealClaudeLoginTerminalInWork}
                  />
                </div>
              ) : null}
              {credentialSourceDesc && !availability?.auth.ready && !isInitialCheckInFlight ? <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.info, marginTop: 4 }}>{credentialSourceDesc}</div> : null}
              {binaryPath && !isInitialCheckInFlight ? <code style={{ display: "block", marginTop: 6, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary, background: "color-mix(in srgb, var(--color-muted-fg) 12%, transparent)", border: `1px solid ${COLORS.border}`, padding: "6px 8px", overflowWrap: "anywhere", wordBreak: "break-all" }}>{binaryPath}</code> : null}
            </section>
          );
        })()}

        {/* ── Codex CLI ── */}
        {(() => {
          const tool = CLI_TOOLS.find((t) => t.cli === "codex")!;
          const connection = providerConnections?.[tool.cli] ?? null;
          const credentialSourceDesc = describeCredentialSource(connection);
          const tone = isInitialCheckInFlight ? { color: COLORS.info, label: "Checking" } : getStatusTone(connection);
          const message = isInitialCheckInFlight ? "Checking CLI availability and login status." : buildCliMessage(tool, connection);
          return (
            <section style={panel({ borderLeft: `3px solid ${tone.color}`, padding: 14 })}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <CodexLogo size={26} className="text-zinc-100" />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>Codex CLI</div>
                    <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.35 }}>{tool.authStory}</div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 4, color: tone.color }}>
                  {isInitialCheckInFlight ? <Info size={14} weight="fill" /> : connection?.runtimeAvailable ? <CheckCircle size={14} weight="fill" /> : connection?.authAvailable || connection?.runtimeDetected ? <WarningCircle size={14} weight="fill" /> : <XCircle size={14} weight="fill" />}
                  <span style={{ fontSize: 9, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px" }}>{tone.label}</span>
                </div>
              </div>
              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5, marginTop: 10 }}>{message}</div>
              {credentialSourceDesc && !connection?.runtimeAvailable && !isInitialCheckInFlight ? <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.info, marginTop: 4 }}>{credentialSourceDesc}</div> : null}
              {connection?.path && !isInitialCheckInFlight ? <code style={{ display: "block", marginTop: 6, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary, background: "color-mix(in srgb, var(--color-muted-fg) 12%, transparent)", border: `1px solid ${COLORS.border}`, padding: "6px 8px", overflowWrap: "anywhere", wordBreak: "break-all" }}>{connection.path}</code> : null}
            </section>
          );
        })()}

        {/* ── Cursor ── */}
        {/* Hidden entirely on Windows on ARM: @cursor/sdk has no win32-arm64
            build, so the card could only ever offer a provider that cannot
            start. See shared/providerPlatformSupport.ts. */}
        {!cursorProviderAvailable() ? null : (() => {
          const tool = CLI_TOOLS.find((t) => t.cli === "cursor")!;
          const connection = providerConnections?.[tool.cli] ?? null;
          const credentialSourceDesc = describeCredentialSource(connection);
          const keySource = apiKeySources.get("cursor") ?? (storedProviders.includes("cursor") ? "store" : undefined);
          const verification = verificationByProvider.cursor;
          const isEditing = editingProvider === "cursor";
          const isVerifying = verifyingProvider === "cursor";
          const isVerified = !isVerifying && verification?.ok;
          const isInvalid = !isVerifying && verification && !verification.ok;
          const isKeyConnected = Boolean(isVerified || (!isInvalid && keySource && connection?.runtimeAvailable));
          const tone = isVerifying
            ? { color: COLORS.info, label: "Verifying" }
            : isVerified
              ? { color: COLORS.success, label: "Connected" }
              : isInvalid
                ? { color: COLORS.danger, label: "Verification failed" }
                : isInitialCheckInFlight ? { color: COLORS.info, label: "Checking" } : getStatusTone(connection);
          const message = isVerifying
            ? "Verifying Cursor API key with the Cursor SDK."
            : isVerified
              ? "Cursor SDK connected. ADE uses this key for Cursor chat and Cursor Cloud agents."
              : isInvalid
                ? verification.message
                : isInitialCheckInFlight ? "Checking Cursor SDK API key." : (connection?.blocker ?? "Enter a Cursor API key.");
          return (
            <section style={panel({ borderLeft: `3px solid ${tone.color}`, padding: 14 })}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <CursorAgentLogo size={26} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>Cursor</div>
                    <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.35 }}>{tool.authStory}</div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 4, color: tone.color }}>
                  {isVerifying || isInitialCheckInFlight ? <Info size={14} weight="fill" /> : isVerified ? <CheckCircle size={14} weight="fill" /> : isInvalid ? <XCircle size={14} weight="fill" /> : connection?.runtimeAvailable ? <CheckCircle size={14} weight="fill" /> : connection?.authAvailable || connection?.runtimeDetected ? <WarningCircle size={14} weight="fill" /> : <XCircle size={14} weight="fill" />}
                  <span style={{ fontSize: 9, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px" }}>{tone.label}</span>
                </div>
              </div>
              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5, marginTop: 10 }}>{message}</div>
              {credentialSourceDesc && !connection?.runtimeAvailable && !isInitialCheckInFlight ? <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.info, marginTop: 4 }}>{credentialSourceDesc}</div> : null}
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}`, display: "grid", gridTemplateColumns: "140px minmax(0, 1fr) auto", gap: 10, alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 11, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>API key</div>
                  <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>CURSOR_API_KEY</div>
                </div>
                <div style={{ minWidth: 0 }}>
                  {isEditing ? (
                    <input
                      autoFocus
                      aria-label="Cursor API key"
                      value={editValue}
                      onChange={(event) => setEditValue(event.target.value)}
                      placeholder="crsr_..."
                      type="password"
                      disabled={isVerifying}
                      style={{ width: "100%", background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }}
                    />
                  ) : keySource ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <SourceBadge source={keySource} />
                      {isVerifying ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: COLORS.info, fontSize: 10, fontFamily: MONO_FONT }}>
                          <Info size={12} weight="fill" />
                          Verifying...
                        </span>
                      ) : isKeyConnected ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: COLORS.success, fontSize: 10, fontFamily: MONO_FONT }}>
                          <CheckCircle size={12} weight="fill" />
                          Connected
                        </span>
                      ) : verification ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: verification.ok ? COLORS.success : COLORS.danger, fontSize: 10, fontFamily: MONO_FONT }}>
                          {verification.ok ? <CheckCircle size={12} weight="fill" /> : <XCircle size={12} weight="fill" />}
                          {verification.ok ? "Verified" : verification.message}
                        </span>
                      ) : (
                        <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                          {keySource === "env" ? "Loaded from environment" : keySource === "config" ? "Defined in project config" : "Stored locally"}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>No Cursor API key configured</span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                  {isEditing ? (
                    <>
                      <button type="button" aria-label="Save Cursor API key" style={primaryButton()} disabled={isVerifying || !editValue.trim()} onClick={() => void saveCursorApiKey()}>
                        {isVerifying ? "Verifying..." : "Save"}
                      </button>
                      <button type="button" style={outlineButton()} disabled={isVerifying} onClick={cancelEditing}>Cancel</button>
                    </>
                  ) : keySource ? (
                    <>
                      {isKeyConnected ? (
                        <ConnectedTag />
                      ) : (
                        <button type="button" aria-label="Verify Cursor API key" style={outlineButton()} disabled={isVerifying} onClick={() => void verifyApiKey("cursor")}>
                          {isVerifying ? "Verifying..." : "Verify"}
                        </button>
                      )}
                      {keySource === "store" ? (
                        <>
                          <button type="button" style={outlineButton()} disabled={isVerifying} onClick={() => beginEditing("cursor")}>Replace</button>
                          <button type="button" style={outlineButton()} disabled={isVerifying} onClick={() => void deleteApiKey("cursor").catch(() => undefined)}>Delete</button>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <button type="button" aria-label="Add Cursor API key" style={outlineButton()} onClick={() => beginEditing("cursor")}>Add key</button>
                  )}
                </div>
              </div>
            </section>
          );
        })()}

        {/* ── Droid ── */}
        {(() => {
          const tool = CLI_TOOLS.find((t) => t.cli === "droid")!;
          const connection = providerConnections?.[tool.cli] ?? null;
          const credentialSourceDesc = describeCredentialSource(connection);
          const tone = isInitialCheckInFlight ? { color: COLORS.info, label: "Checking" } : getStatusTone(connection);
          const message = isInitialCheckInFlight ? "Checking CLI availability and login status." : buildCliMessage(tool, connection);
          return (
            <section style={panel({ borderLeft: `3px solid ${tone.color}`, padding: 14 })}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <ProviderLogo family="factory" size={26} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>Droid</div>
                    <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.35 }}>{tool.authStory}</div>
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
      </div>

      {/* ══ OpenCode — Universal Model Access ══ */}
      <section style={panel({ padding: 0 })}>
        {/* Group header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: 14, borderBottom: opencodeInstalled ? `1px solid ${COLORS.border}` : "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <OpenCodeLogo size={24} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>
                OpenCode — Universal Model Access
              </div>
              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.4 }}>
                SuperGrok OAuth, ChatGPT, Copilot, or API keys — same /connect providers as OpenCode
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, color: !opencodeStatusKnown ? (opencodeStatusLoadFailed ? COLORS.danger : COLORS.info) : opencodeInstalled ? (status?.opencodeInventoryError ? COLORS.danger : COLORS.success) : COLORS.warning }}>
            {!opencodeStatusKnown ? (opencodeStatusLoadFailed ? <XCircle size={14} weight="fill" /> : <Info size={14} weight="fill" />) : !opencodeInstalled ? <WarningCircle size={14} weight="fill" /> : status?.opencodeInventoryError ? <XCircle size={14} weight="fill" /> : <CheckCircle size={14} weight="fill" />}
            <span style={{ fontSize: 9, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px" }}>
              {!opencodeStatusKnown ? (opencodeStatusLoadFailed ? "Error" : "Checking") : !opencodeInstalled ? "Not found" : status?.opencodeInventoryError ? "Error" : "Installed"}
            </span>
          </div>
        </div>

        {!opencodeStatusKnown && opencodeStatusLoadFailed ? (
          <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.danger, lineHeight: 1.5 }}>
              Could not load OpenCode status.
            </div>
            <button
              type="button"
              aria-label="Re-check OpenCode"
              style={outlineButton()}
              disabled={loading}
              onClick={() => void refreshStatus({ force: true, refreshOpenCodeInventory: true })}
            >
              <ArrowsClockwise size={12} weight="bold" /> {loading ? "Checking..." : "Re-check OpenCode"}
            </button>
          </div>
        ) : !opencodeStatusKnown ? (
          <div style={{ padding: 14, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
            Checking OpenCode and its provider catalog…
          </div>
        ) : !opencodeInstalled ? (
          /* Collapsed install card */
          <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.55 }}>
              OpenCode powers every subscription, API key, and local model below. Install it, then re-check:
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {openCodeInstallCommands().map((cmd) => (
                <CopyableCommand key={cmd} command={cmd} />
              ))}
            </div>
            <div>
              <button
                type="button"
                style={outlineButton()}
                disabled={loading}
                onClick={() => void refreshStatus({ force: true, refreshOpenCodeInventory: true })}
              >
                <ArrowsClockwise size={12} weight="bold" /> {loading ? "Checking..." : "Re-check"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12, flexWrap: "wrap", padding: "8px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
              {providersStale ? (
                <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, fontStyle: "italic", marginRight: "auto" }}>
                  Updating provider catalog…
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => void handleRefreshCatalog()}
                disabled={refreshingCatalog}
                title="Refresh the models.dev catalog"
                style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "transparent", border: "none", cursor: "pointer", fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}
              >
                <ArrowsClockwise size={11} weight="bold" />
                {refreshingCatalog ? "syncing…" : `catalog · refresh`}
              </button>
            </div>

            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 22 }}>
              {/* ── Connected ── */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={sectionLabelStyle}>Connected</div>
                {connectedOpenCodeProviders.length === 0 ? (
                  <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                    No providers connected yet. Pick one below to sign in or add a key.
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 200px), 1fr))", gap: 8 }}>
                    {connectedOpenCodeProviders.map((row) => (
                      <OpenCodeProviderCard key={row.id} provider={row} onOpen={() => openProviderDetail(row.id)} />
                    ))}
                  </div>
                )}
              </div>

              {/* ── All providers ── */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <div style={sectionLabelStyle}>All providers</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, border: `1px solid ${COLORS.border}`, background: COLORS.cardBg, padding: "4px 8px", minWidth: 220 }}>
                    <MagnifyingGlass size={12} style={{ color: COLORS.textMuted, flexShrink: 0 }} />
                    <input
                      aria-label="Search all OpenCode providers"
                      value={providerSearch}
                      onChange={(event) => setProviderSearch(event.target.value)}
                      placeholder="Search all OpenCode providers"
                      style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary }}
                    />
                  </div>
                </div>

                {!providerSearch.trim() ? (
                  <>
                    <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>Popular</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 200px), 1fr))", gap: 8 }}>
                      {popularOpenCodeProviders.map((row) => (
                        <OpenCodeProviderCard key={row.id} provider={row} onOpen={() => openProviderDetail(row.id)} />
                      ))}
                    </div>
                  </>
                ) : searchableOpenCodeProviders.length === 0 ? (
                  <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                    No providers match your search.
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 200px), 1fr))", gap: 8 }}>
                    {searchableOpenCodeProviders.map((row) => (
                      <OpenCodeProviderCard key={row.id} provider={row} onOpen={() => openProviderDetail(row.id)} />
                    ))}
                  </div>
                )}
              </div>

              {/* ── Local Model Servers ── */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div style={sectionLabelStyle}>Local Model Servers</div>
                  <button
                    type="button"
                    style={outlineButton({ height: 26, padding: "0 10px", fontSize: 11 })}
                    disabled={loading}
                    onClick={() => void refreshStatus({ force: true, refreshOpenCodeInventory: true })}
                  >
                    <ArrowsClockwise size={11} weight="bold" /> {loading ? "Checking..." : "Refresh"}
                  </button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 8 }}>
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
                        style={{ border: `1px solid ${COLORS.border}`, borderLeft: `3px solid ${tone.color}`, background: COLORS.recessedBg, padding: 12, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            <ProviderLogo family={entry.provider} size={20} />
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

                        <code style={{ display: "block", width: "100%", boxSizing: "border-box", minWidth: 0, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary, background: "color-mix(in srgb, var(--color-muted-fg) 12%, transparent)", border: `1px solid ${COLORS.border}`, padding: "6px 8px", overflowWrap: "anywhere", wordBreak: "break-all" }}>
                          {draft?.endpoint?.trim() || entry.endpoint}
                        </code>

                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {loadedModels.length > 0 ? (
                            <>
                              {loadedModels.map((modelId) => (
                                <span key={modelId} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", border: `1px solid ${COLORS.border}`, background: "color-mix(in srgb, var(--color-muted-fg) 10%, transparent)", fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textPrimary }} title={modelId}>
                                  <Cpu size={11} />
                                  {formatLocalModelLabel(modelId)}
                                </span>
                              ))}
                              {extraModelCount > 0 ? (
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", border: `1px solid ${COLORS.border}`, background: "color-mix(in srgb, var(--color-muted-fg) 10%, transparent)", fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
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
                              <button type="button" style={outlineButton({ height: 28 })} onClick={() => beginEditingLocalRuntime(entry.provider)}>Edit</button>
                              <button type="button" style={outlineButton({ height: 28 })} disabled={loading} onClick={() => void refreshStatus({ force: true })}>Test</button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ── e. Advanced ── */}
              <details style={{ border: `1px solid ${COLORS.border}`, background: COLORS.cardBg }}>
                <summary style={{ cursor: "pointer", padding: "10px 12px", fontSize: 11, fontFamily: SANS_FONT, fontWeight: 600, color: COLORS.textSecondary, listStyle: "none" }}>
                  Advanced — custom providers &amp; model slugs
                </summary>
                <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 18, borderTop: `1px solid ${COLORS.border}` }}>
                  {/* Custom provider */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={sectionLabelStyle}>Custom provider</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: 8 }}>
                      <input aria-label="Provider id" value={customProviderDraft.id} onChange={(e) => setCustomProviderDraft((d) => ({ ...d, id: e.target.value }))} placeholder="provider-id" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }} />
                      <input aria-label="Provider name" value={customProviderDraft.name} onChange={(e) => setCustomProviderDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Display name" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textPrimary, outline: "none" }} />
                      <input aria-label="Base URL" value={customProviderDraft.baseUrl} onChange={(e) => setCustomProviderDraft((d) => ({ ...d, baseUrl: e.target.value }))} placeholder="https://api.example.com/v1" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }} />
                      <select aria-label="npm package" value={customProviderDraft.npm} onChange={(e) => setCustomProviderDraft((d) => ({ ...d, npm: e.target.value }))} style={{ background: COLORS.cardBgSolid, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
                        {CUSTOM_PROVIDER_NPM_OPTIONS.map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      <input aria-label="Model slugs" value={customProviderDraft.slugs} onChange={(e) => setCustomProviderDraft((d) => ({ ...d, slugs: e.target.value }))} placeholder="model-a, model-b" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }} />
                      <input aria-label="Provider API key" value={customProviderDraft.apiKey} onChange={(e) => setCustomProviderDraft((d) => ({ ...d, apiKey: e.target.value }))} placeholder="API key (optional)" type="password" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }} />
                    </div>
                    <div>
                      <button type="button" style={primaryButton()} disabled={savingAdvanced} onClick={() => void saveAdvancedProvider()}>{savingAdvanced ? "Saving…" : "Add provider"}</button>
                    </div>
                  </div>

                  {/* Custom model slugs */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={sectionLabelStyle}>Custom model slugs</div>
                    <input aria-label="Custom model slugs" value={customModelSlugs} onChange={(e) => setCustomModelSlugs(e.target.value)} placeholder="provider/model-a, provider/model-b" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }} />
                    <div>
                      <button type="button" style={primaryButton()} disabled={savingAdvanced} onClick={() => void saveCustomModelSlugs()}>{savingAdvanced ? "Saving…" : "Save model slugs"}</button>
                    </div>
                  </div>
                </div>
              </details>
            </div>
          </div>
        )}
      </section>

      {detailProvider ? (
        <OpenCodeProviderDetailModal
          provider={detailProvider}
          keySource={apiKeySources.get(detailProvider.id) ?? (storedProviders.includes(detailProvider.id) ? "store" : undefined)}
          verification={verificationByProvider[detailProvider.id]}
          verifying={verifyingProvider === detailProvider.id}
          authMethodsError={authMethodsError}
          onClose={() => setDetailProviderId(null)}
          onConnected={() => void handleSubscriptionConnected(detailProvider.id, detailProvider.name)}
          onRetryAuthMethods={() => void loadAuthMethods()}
          onSaveKey={async (key) => {
            const result = await window.ade.ai.setOpencodeProviderKey({ providerId: detailProvider.id, key });
            if (!result.ok) throw new Error(result.error || "OpenCode rejected the provider key.");
            invalidateAiDiscoveryCache();
            setVerificationByProvider((prev) => {
              const next = { ...prev };
              delete next[detailProvider.id];
              return next;
            });
            setNotice(`${detailProvider.name} key saved.`);
            await refreshStatus({ force: true, refreshOpenCodeInventory: true });
          }}
          onDeleteKey={async () => {
            await deleteApiKey(detailProvider.id, { alsoOpenCode: true });
          }}
          onVerifyKey={async () => {
            await verifyApiKey(detailProvider.id);
          }}
        />
      ) : null}
    </div>
  );
}
