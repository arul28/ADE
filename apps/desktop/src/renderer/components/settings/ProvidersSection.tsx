import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  AiConfig,
  AiApiKeyVerificationResult,
  AiClaudeAvailability,
  AiProviderConnectionStatus,
  AiRuntimeConnectionStatus,
  AiSettingsStatus,
  ProjectConfigSnapshot,
} from "../../../shared/types";
import type {
  AiCustomProviderConfig,
  OpenCodeProviderAuthMethod,
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
  DotsThree,
  Info,
  MagnifyingGlass,
  WarningCircle,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { ClaudeLogo, CodexLogo, CursorAgentLogo, OpenCodeLogo } from "../terminals/ToolLogos";
import { ProviderLogo } from "../shared/ProviderLogos";
import { rendererPlatformAttribute } from "../../lib/platform";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  LABEL_STYLE,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { invalidateAiDiscoveryCache } from "../../lib/aiDiscoveryCache";
import { shouldRefreshAiStatusForChatEvent } from "../../lib/aiProviderStatus";
import { showToast } from "../app/toast/toastStore";
import { ClaudeLoginPromptButton, revealTerminalSessionInWork } from "../work/ClaudeLoginPromptButton";
import { OAuthConnectModal } from "./OAuthConnectModal";

type CliName = "claude" | "codex" | "cursor" | "droid";
type ApiKeySource = "config" | "env" | "store";

/**
 * Status payload plus the OpenCode inventory freshness fields the AI service
 * adds alongside the provider catalog. Typed locally as optional so this file
 * stays correct before those additive members land in shared types.
 */
type ProvidersStatus = AiSettingsStatus & {
  runtimeConnections?: Record<string, AiRuntimeConnectionStatus>;
  opencodeProvidersStale?: boolean;
  modelsDevLastFetchedAt?: number | null;
};

const KIMI_PROVIDER_ID = "kimi-for-coding";

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

const CLI_TOOLS: Array<{
  cli: CliName;
  label: string;
  authStory: string;
  loginCmd: string;
  installHint: string;
}> = [
  {
    cli: "claude",
    label: "Claude Code",
    authStory: "Uses your claude login — Claude Pro/Max subscription or ANTHROPIC_API_KEY.",
    loginCmd: "claude auth login or set ANTHROPIC_API_KEY",
    installHint: "npm install -g @anthropic-ai/claude-code",
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
  { provider: "moonshotai", label: "Moonshot AI", envVar: "MOONSHOT_API_KEY", placeholder: "sk-...", accent: "#7C5CFF" },
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

function formatSyncedAgo(ts: number | null | undefined): string {
  if (ts == null) return "—";
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
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

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
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

function buildLocalProviderDrafts(
  snapshot: ProjectConfigSnapshot | null | undefined,
  status: ProvidersStatus | null | undefined,
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
  const [status, setStatus] = useState<ProvidersStatus | null>(null);
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
  const [oauthTarget, setOauthTarget] = useState<{ providerId: string; providerName: string; methods: OpenCodeProviderAuthMethod[] } | null>(null);
  const [kimiDialogOpen, setKimiDialogOpen] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [verifyingAll, setVerifyingAll] = useState(false);
  const [openRowMenu, setOpenRowMenu] = useState<string | null>(null);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [customProviderDraft, setCustomProviderDraft] = useState<CustomProviderDraft>(EMPTY_CUSTOM_PROVIDER);
  const [customModelSlugs, setCustomModelSlugs] = useState("");
  const [savingAdvanced, setSavingAdvanced] = useState(false);
  const pendingRefreshTimerRef = useRef<number | null>(null);
  // Seed the slugs field from config exactly once — saves send the full list
  // (replace semantics), so the field must start from what's persisted or a
  // save would silently wipe existing entries.
  const slugsSeededRef = useRef(false);
  const revealClaudeLoginTerminalInWork = useCallback((terminal: { terminalId: string; laneId: string }) => {
    revealTerminalSessionInWork(navigate, terminal);
  }, [navigate]);

  const refreshStatus = useCallback(async (options?: { force?: boolean; silent?: boolean; refreshOpenCodeInventory?: boolean }): Promise<ProvidersStatus | null> => {
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
      setStatus(nextStatus as ProvidersStatus);
      setProjectConfigSnapshot(nextProjectConfig);
      if (editingLocalProvider == null && savingLocalProvider == null) {
        setLocalProviderDrafts(buildLocalProviderDrafts(nextProjectConfig, nextStatus as ProvidersStatus));
      }
      setStoredProviders(nextStoredProviders.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
      return nextStatus as ProvidersStatus;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    } catch {
      // Best-effort — subscription connect rows simply stay hidden if this
      // capability is not available yet.
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
  const isInitialCheckInFlight = loading && status == null;
  const catalogModelIds = useMemo(() => deriveConfiguredModelIds(status), [status]);
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

  // ── Subscription (OAuth + Kimi membership) rows ──
  const subscriptionRows = useMemo(() => {
    const nameById = new Map(opencodeProviders.map((p) => [p.id, p.name] as const));
    const oauthIds = authMethods
      ? Object.keys(authMethods).filter((id) => authMethods[id]?.some((m) => m.type === "oauth"))
      : [];
    const rows: Array<{
      id: string;
      name: string;
      methods: OpenCodeProviderAuthMethod[];
      kind: "oauth" | "kimi";
      connected: boolean;
    }> = oauthIds
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({
        id,
        name: nameById.get(id) ?? prettifyProviderId(id),
        methods: authMethods?.[id] ?? [],
        kind: "oauth" as const,
        connected: opencodeProviders.find((p) => p.id === id)?.connected === true,
      }));
    // Kimi for Coding is an API-membership key, not OAuth — always surfaced here.
    rows.push({
      id: KIMI_PROVIDER_ID,
      name: "Kimi for Coding",
      methods: [],
      kind: "kimi" as const,
      connected:
        opencodeProviders.find((p) => p.id === KIMI_PROVIDER_ID)?.connected === true
        || hasKeyFor(KIMI_PROVIDER_ID),
    });
    return rows;
  }, [authMethods, opencodeProviders, hasKeyFor]);

  const keyCount = useMemo(() => {
    const ids = new Set<string>();
    for (const p of API_KEY_PROVIDERS) {
      if (hasKeyFor(p.provider)) ids.add(p.provider);
    }
    for (const id of storedProviders) ids.add(id);
    for (const id of apiKeySources.keys()) ids.add(id);
    return ids.size;
  }, [hasKeyFor, storedProviders, apiKeySources]);

  const connectedSubscriptionCount = useMemo(
    () => subscriptionRows.filter((row) => row.connected).length,
    [subscriptionRows],
  );

  const beginEditing = (provider: string) => {
    setEditingProvider(provider);
    setEditValue("");
    setError(null);
    setNotice(null);
    setOpenRowMenu(null);
  };

  const cancelEditing = () => {
    setEditingProvider(null);
    setEditValue("");
  };

  const saveApiKey = async (provider: string, options?: { alsoOpenCode?: boolean }) => {
    const trimmed = editValue.trim();
    if (!trimmed) return;

    setError(null);
    setNotice(null);
    try {
      if (options?.alsoOpenCode) {
        const result = await window.ade.ai.setOpencodeProviderKey({ providerId: provider, key: trimmed });
        if (!result.ok) {
          throw new Error(result.error || "OpenCode rejected the provider key.");
        }
      } else {
        await window.ade.ai.storeApiKey(provider, trimmed);
      }
      invalidateAiDiscoveryCache();
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

  const deleteApiKey = async (provider: string, options?: { alsoOpenCode?: boolean }) => {
    setError(null);
    setNotice(null);
    setOpenRowMenu(null);
    try {
      if (options?.alsoOpenCode) {
        const result = await window.ade.ai.clearOpencodeProviderKey({ providerId: provider });
        if (!result.ok) {
          throw new Error(result.error || "OpenCode could not remove the provider key.");
        }
      }
      await window.ade.ai.deleteApiKey(provider);
      invalidateAiDiscoveryCache();
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
    setOpenRowMenu(null);
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

  const verifyAllKeys = async () => {
    const targets = API_KEY_PROVIDERS.filter((p) => hasKeyFor(p.provider)).map((p) => p.provider);
    if (!targets.length) return;
    setVerifyingAll(true);
    setError(null);
    setNotice(null);
    try {
      for (const provider of targets) {
        setVerifyingProvider(provider);
        try {
          const result = await window.ade.ai.verifyApiKey(provider);
          setVerificationByProvider((prev) => ({ ...prev, [provider]: result }));
        } catch {
          // Continue verifying the remaining providers.
        }
      }
      invalidateAiDiscoveryCache();
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
    } finally {
      setVerifyingProvider(null);
      setVerifyingAll(false);
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

  const saveKimiKey = async (key: string) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    setError(null);
    setNotice(null);
    try {
      const result = await window.ade.ai.setOpencodeProviderKey({ providerId: KIMI_PROVIDER_ID, key: trimmed });
      if (result && result.ok === false) {
        setError(result.error || "Failed to save Kimi for Coding key.");
        return;
      }
      invalidateAiDiscoveryCache();
      setKimiDialogOpen(false);
      setNotice("Kimi for Coding connected.");
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

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

  // ── More Providers chip cloud ──
  const moreProviders = useMemo(() => {
    const query = providerSearch.trim().toLowerCase();
    const filtered = opencodeProviders
      .filter((p) => !p.connected
        && p.id !== "cursor"
        && !API_KEY_PROVIDERS.some((a) => a.provider === p.id)
        && !["ollama", "lmstudio"].includes(p.id))
      .filter((p) => !query || p.id.toLowerCase().includes(query) || p.name.toLowerCase().includes(query))
      .sort((a, b) => b.modelCount - a.modelCount);
    return { list: filtered, query };
  }, [opencodeProviders, providerSearch]);

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
        {(() => {
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
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.success, background: "color-mix(in srgb, var(--color-success) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--color-success) 30%, transparent)" }}>
                          <CheckCircle size={13} weight="fill" /> Connected
                        </span>
                      ) : (
                        <button type="button" aria-label="Verify Cursor API key" style={outlineButton()} disabled={isVerifying} onClick={() => void verifyApiKey("cursor")}>
                          {isVerifying ? "Verifying..." : "Verify"}
                        </button>
                      )}
                      {keySource === "store" ? (
                        <>
                          <button type="button" style={outlineButton()} disabled={isVerifying} onClick={() => beginEditing("cursor")}>Replace</button>
                          <button type="button" style={outlineButton()} disabled={isVerifying} onClick={() => void deleteApiKey("cursor")}>Delete</button>
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
                {status?.opencodeBinarySource ? `${status.opencodeBinarySource} · ` : ""}managed by ADE
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, color: opencodeInstalled ? (status?.opencodeInventoryError ? COLORS.danger : COLORS.success) : COLORS.warning }}>
            {!opencodeInstalled ? <WarningCircle size={14} weight="fill" /> : status?.opencodeInventoryError ? <XCircle size={14} weight="fill" /> : <CheckCircle size={14} weight="fill" />}
            <span style={{ fontSize: 9, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px" }}>
              {!opencodeInstalled ? "Not found" : status?.opencodeInventoryError ? "Error" : "Installed"}
            </span>
          </div>
        </div>

        {!opencodeInstalled ? (
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
            {/* Summary strip + catalog freshness */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "10px 14px", borderBottom: `1px solid ${COLORS.border}`, background: "color-mix(in srgb, var(--color-muted-fg) 5%, transparent)" }}>
              <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
                {connectedSubscriptionCount} subscription{connectedSubscriptionCount === 1 ? "" : "s"} · {keyCount} key{keyCount === 1 ? "" : "s"} · {catalogModelIds.length} model{catalogModelIds.length === 1 ? "" : "s"} unlocked
                {providersStale ? <span style={{ marginLeft: 8, color: COLORS.textDim, fontStyle: "italic" }}>updating…</span> : null}
              </div>
              <button
                type="button"
                onClick={() => void handleRefreshCatalog()}
                disabled={refreshingCatalog}
                title="Refresh the models.dev catalog"
                style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "transparent", border: "none", cursor: "pointer", fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}
              >
                <ArrowsClockwise size={11} weight="bold" />
                {refreshingCatalog ? "syncing…" : `catalog synced ${formatSyncedAgo(status?.modelsDevLastFetchedAt)} · refresh`}
              </button>
            </div>

            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 22 }}>
              {/* ── a. Subscriptions ── */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={sectionLabelStyle}>Subscriptions</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 240px), 1fr))", gap: 8 }}>
                  {subscriptionRows.map((row) => (
                    <div key={row.id} style={panel({ padding: 10, display: "flex", flexDirection: "column", gap: 6 })}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <ProviderLogo family={row.id} size={20} />
                          <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name}</span>
                        </div>
                        {row.connected ? (
                          <ConnectedTag />
                        ) : (
                          <button
                            type="button"
                            aria-label={`Connect ${row.name}`}
                            style={outlineButton({ height: 26, padding: "0 10px", fontSize: 11 })}
                            onClick={() => {
                              if (row.kind === "kimi") {
                                setKimiDialogOpen(true);
                              } else {
                                setOauthTarget({ providerId: row.id, providerName: row.name, methods: row.methods });
                              }
                            }}
                          >
                            Connect
                          </button>
                        )}
                      </div>
                      {row.id === "openai" ? (
                        <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.4 }}>
                          Also powers OpenAI models inside OpenCode. For the Codex agent, connect the Codex CLI above.
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
                {subscriptionRows.length <= 1 && !authMethods ? (
                  <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                    {providersStale ? "Loading available subscriptions…" : "No OAuth subscriptions are available from OpenCode yet."}
                  </div>
                ) : null}
              </div>

              {/* ── b. API Provider Keys ── */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={sectionLabelStyle}>API Provider Keys</div>
                  <button
                    type="button"
                    style={outlineButton({ height: 26, padding: "0 10px", fontSize: 11 })}
                    disabled={verifyingAll || keyCount === 0}
                    onClick={() => void verifyAllKeys()}
                  >
                    {verifyingAll ? "Verifying…" : "Verify all"}
                  </button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))", gap: 8 }}>
                  {API_KEY_PROVIDERS.map((provider) => {
                    const keySource = apiKeySources.get(provider.provider) ?? (storedProviders.includes(provider.provider) ? "store" : undefined);
                    const verification = verificationByProvider[provider.provider];
                    const isEditing = editingProvider === provider.provider;
                    const isVerifying = verifyingProvider === provider.provider;
                    const menuOpen = openRowMenu === provider.provider;
                    return (
                      <div
                        key={provider.provider}
                        style={{ position: "relative", display: "flex", flexDirection: "column", gap: isEditing ? 8 : 0, minHeight: 44, border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: "8px 10px", justifyContent: "center" }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <ProviderLogo family={provider.provider} size={24} />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{provider.label}</div>
                            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>{provider.envVar}</div>
                          </div>
                          {!isEditing ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              {isVerifying ? (
                                <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.info }}>Checking…</span>
                              ) : verification?.ok ? (
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.success }} title="Verified">
                                  <CheckCircle size={12} weight="fill" /> Verified
                                </span>
                              ) : verification && !verification.ok ? (
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.danger }} title={verification.message}>
                                  <XCircle size={12} weight="fill" /> Failed
                                </span>
                              ) : keySource ? (
                                <SourceBadge source={keySource} />
                              ) : (
                                <button type="button" aria-label={`Add ${provider.label} key`} style={outlineButton({ height: 26, padding: "0 10px", fontSize: 11 })} onClick={() => beginEditing(provider.provider)}>Add</button>
                              )}
                              {keySource ? (
                                <button
                                  type="button"
                                  aria-label={`More actions for ${provider.label}`}
                                  onClick={() => setOpenRowMenu(menuOpen ? null : provider.provider)}
                                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, border: `1px solid ${COLORS.border}`, background: "transparent", color: COLORS.textSecondary, cursor: "pointer" }}
                                >
                                  <DotsThree size={16} weight="bold" />
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>

                        {isEditing ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <input
                              autoFocus
                              aria-label={`${provider.label} API key`}
                              value={editValue}
                              onChange={(event) => setEditValue(event.target.value)}
                              placeholder={provider.placeholder}
                              type="password"
                              style={{ flex: 1, minWidth: 0, background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "6px 8px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }}
                            />
                            <button type="button" style={primaryButton({ height: 28 })} onClick={() => void saveApiKey(provider.provider, { alsoOpenCode: true })}>Save</button>
                            <button type="button" style={outlineButton({ height: 28 })} onClick={cancelEditing}>Cancel</button>
                          </div>
                        ) : null}

                        {menuOpen && keySource ? (
                          <>
                            <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setOpenRowMenu(null)} />
                            <div style={{ position: "absolute", top: 40, right: 8, zIndex: 41, minWidth: 130, background: COLORS.cardBgSolid, border: `1px solid ${COLORS.outlineBorder}`, boxShadow: "0 14px 40px -18px rgba(0,0,0,0.7)", display: "flex", flexDirection: "column" }}>
                              <button type="button" style={{ textAlign: "left", padding: "8px 12px", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textPrimary, background: "transparent", border: "none", cursor: "pointer" }} onClick={() => void verifyApiKey(provider.provider)}>Verify</button>
                              {keySource === "store" ? (
                                <>
                                  <button type="button" style={{ textAlign: "left", padding: "8px 12px", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textPrimary, background: "transparent", border: "none", cursor: "pointer" }} onClick={() => beginEditing(provider.provider)}>Replace</button>
                                  <button type="button" style={{ textAlign: "left", padding: "8px 12px", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.danger, background: "transparent", border: "none", cursor: "pointer" }} onClick={() => void deleteApiKey(provider.provider, { alsoOpenCode: true })}>Delete</button>
                                </>
                              ) : null}
                            </div>
                          </>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ── c. More Providers ── */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <div style={sectionLabelStyle}>More Providers</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, border: `1px solid ${COLORS.border}`, background: COLORS.cardBg, padding: "4px 8px", minWidth: 180 }}>
                    <MagnifyingGlass size={12} style={{ color: COLORS.textMuted, flexShrink: 0 }} />
                    <input
                      aria-label="Search providers"
                      value={providerSearch}
                      onChange={(event) => setProviderSearch(event.target.value)}
                      placeholder="Search providers"
                      style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary }}
                    />
                  </div>
                </div>
                {moreProviders.list.length === 0 ? (
                  <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                    {moreProviders.query ? "No providers match your search." : "No additional providers available."}
                  </div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {(moreProviders.query ? moreProviders.list : moreProviders.list.slice(0, 30)).map((p) => {
                      const hasKey = hasKeyFor(p.id);
                      const isEditing = editingProvider === `__custom:${p.id}`;
                      return isEditing ? (
                        <div key={p.id} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textPrimary, minWidth: 120 }}>{p.name}</span>
                          <input
                            autoFocus
                            aria-label={`${p.name} API key`}
                            value={editValue}
                            onChange={(event) => setEditValue(event.target.value)}
                            placeholder="API key"
                            type="password"
                            style={{ flex: 1, background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "6px 8px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }}
                          />
                          <button type="button" style={primaryButton()} onClick={() => void saveApiKey(p.id, { alsoOpenCode: true })}>Save</button>
                          <button type="button" style={outlineButton()} onClick={cancelEditing}>Cancel</button>
                        </div>
                      ) : (
                        <button
                          key={p.id}
                          type="button"
                          style={{
                            ...outlineButton({ height: 28 }),
                            fontSize: 10,
                            padding: "4px 8px",
                            opacity: hasKey ? 1 : 0.72,
                            borderColor: hasKey ? COLORS.success : undefined,
                          }}
                          onClick={() => { if (!hasKey) beginEditing(`__custom:${p.id}`); }}
                          title={`${p.name} · ${p.id} — ${p.modelCount} models`}
                        >
                          {p.name} {hasKey ? "✓" : `(${p.modelCount})`}
                        </button>
                      );
                    })}
                    {!moreProviders.query && moreProviders.list.length > 30 ? (
                      <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, alignSelf: "center" }}>
                        +{moreProviders.list.length - 30} more — search to filter
                      </span>
                    ) : null}
                  </div>
                )}
              </div>

              {/* ── d. Local Model Servers ── */}
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

      {oauthTarget ? (
        <OAuthConnectModal
          providerId={oauthTarget.providerId}
          providerName={oauthTarget.providerName}
          methods={oauthTarget.methods}
          onClose={() => setOauthTarget(null)}
          onConnected={() => void handleSubscriptionConnected(oauthTarget.providerId, oauthTarget.providerName)}
        />
      ) : null}

      {kimiDialogOpen ? (
        <KimiKeyDialog
          onClose={() => setKimiDialogOpen(false)}
          onSave={(key) => void saveKimiKey(key)}
        />
      ) : null}
    </div>
  );
}

function KimiKeyDialog({ onClose, onSave }: { onClose: () => void; onSave: (key: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.70)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Connect Kimi for Coding"
        className="w-full max-w-sm"
        style={{ background: COLORS.cardBgSolid, border: `1px solid ${COLORS.outlineBorder}`, boxShadow: "0 28px 80px -36px rgba(0,0,0,0.82)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", height: 52, borderBottom: `1px solid ${COLORS.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <ProviderLogo family={KIMI_PROVIDER_ID} size={22} />
            <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>Connect Kimi for Coding</div>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} style={{ border: `1px solid ${COLORS.border}`, background: "transparent", color: COLORS.textSecondary, width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <X size={13} weight="bold" />
          </button>
        </div>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
            Paste your Kimi for Coding membership key. It is stored via OpenCode.
          </div>
          <input
            autoFocus
            aria-label="Kimi for Coding key"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="sk-..."
            type="password"
            style={{ width: "100%", background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" style={outlineButton()} onClick={onClose}>Cancel</button>
            <button type="button" style={primaryButton()} disabled={!value.trim()} onClick={() => onSave(value)}>Connect</button>
          </div>
        </div>
      </div>
    </div>
  );
}
