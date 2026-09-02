/**
 * Settings → Agents & Models.
 *
 * A grid of providers, and one page per provider. This file owns the data —
 * one status probe, one set of handlers — and nothing about how any individual
 * provider looks: that lives in `providers/descriptors.tsx`. Before the split,
 * each provider was its own hand-written block here and the file had grown past
 * 1800 lines with six different vocabularies for "connected".
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  AgentChatPermissionMode,
  AiConfig,
  AiApiKeyVerificationResult,
  AiSettingsStatus,
  ProjectConfigSnapshot,
  CursorSdkAuthEvent,
  CursorSdkAuthStatus,
} from "../../../shared/types";
import type {
  AcpProviderDiagnostics,
  AiCustomProviderConfig,
  AiProviderPermissions,
  OpenCodeProviderAuthMethods,
} from "../../../shared/types/config";
import { toggleDisabledProvider } from "../../../shared/providerEnablement";
import {
  getLocalProviderDefaultEndpoint,
  LOCAL_PROVIDER_LABELS,
  type LocalProviderFamily,
} from "../../../shared/modelRegistry";
import { COLORS, LABEL_STYLE } from "../lanes/laneDesignTokens";
import { invalidateAiDiscoveryCache } from "../../lib/aiDiscoveryCache";
import { shouldRefreshAiStatusForChatEvent } from "../../lib/aiProviderStatus";
import { showToast } from "../app/toast/toastStore";
import { revealTerminalSessionInWork } from "../work/ClaudeLoginPromptButton";
import {
  OpenCodeProviderDetailModal,
  type ApiKeySource,
  type OpenCodeProviderDetail,
} from "./OpenCodeProviderDetailModal";
import { ProviderGrid } from "./providerSectionPrimitives";
import { availableProviderDescriptors, providerDescriptor } from "./providers/descriptors";
import { ProviderTileCard } from "./providers/ProviderTileCard";
import { ProviderDetailPage } from "./providers/ProviderDetailPage";
import { ProviderSignInModal } from "./providers/ProviderSignInModal";
import { acpLoginCommand, acpProviderLabel } from "./providers/acpProviders";
import { AlertBanner, prettifyProviderId } from "./providers/providerUi";
import type {
  AcpSettingsProviderId,
  CustomProviderDraft,
  LocalProviderDraft,
  LocalRuntimeRow,
  ProvidersViewContext,
  SettingsProviderId,
} from "./providers/types";

export { openCodeInstallCommands } from "./providers/cliTools";

const KIMI_PROVIDER_ID = "kimi-for-coding";
const OPENCODE_CATALOG_EXCLUDED_IDS = new Set(["cursor", "ollama", "lmstudio"]);

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

const EMPTY_CUSTOM_PROVIDER: CustomProviderDraft = {
  id: "",
  name: "",
  baseUrl: "",
  npm: "@ai-sdk/openai-compatible",
  slugs: "",
  apiKey: "",
};

const groupLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 0,
  color: COLORS.textSecondary,
};

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

export function ProvidersSection({
  forceRefreshOnMount = false,
  providerParam = null,
  onProviderChange,
}: {
  forceRefreshOnMount?: boolean;
  /** `?provider=<id>` — which provider's page to show, if any. */
  providerParam?: string | null;
  /** Lets the settings shell keep the URL in step with the sub-view. */
  onProviderChange?: (providerId: string | null) => void;
} = {}) {
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
  const [cursorAuth, setCursorAuth] = useState<CursorSdkAuthStatus | null>(null);
  const [cursorLoginBusy, setCursorLoginBusy] = useState(false);
  const [cursorLoginUrl, setCursorLoginUrl] = useState<string | null>(null);
  const [savingPermissionFor, setSavingPermissionFor] = useState<SettingsProviderId | null>(null);
  const [savingDefaultModel, setSavingDefaultModel] = useState(false);
  const [savingDisabledFor, setSavingDisabledFor] = useState<SettingsProviderId | null>(null);
  // ACP CLI facts. Loaded when a provider's page opens, because reading them
  // spawns the CLI — see `acpProviderDiagnostics` in main.
  const [acpDiagnostics, setAcpDiagnostics] = useState<Partial<Record<AcpSettingsProviderId, AcpProviderDiagnostics>>>({});
  const [acpDiagnosticsBusy, setAcpDiagnosticsBusy] = useState<AcpSettingsProviderId | null>(null);
  const [acpDoctorBusy, setAcpDoctorBusy] = useState<AcpSettingsProviderId | null>(null);
  const [acpDiagnosticsError, setAcpDiagnosticsError] = useState<Partial<Record<AcpSettingsProviderId, string>>>({});
  const [signInProvider, setSignInProvider] = useState<SettingsProviderId | null>(null);
  // Which provider's page is open. Seeded and re-seeded from `?provider=`, but
  // owned here so the section works standalone (and in tests) without a router
  // that writes search params.
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(providerParam);
  const statusKnownRef = useRef(false);
  const pendingRefreshTimerRef = useRef<number | null>(null);
  // Seed the slugs field from config exactly once — saves send the full list
  // (replace semantics), so the field must start from what's persisted or a
  // save would silently wipe existing entries.
  const slugsSeededRef = useRef(false);

  useEffect(() => {
    setSelectedProviderId(providerParam);
  }, [providerParam]);

  const selectProvider = useCallback((next: string | null) => {
    setSelectedProviderId(next);
    onProviderChange?.(next);
  }, [onProviderChange]);

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
      const [nextStatus, nextStoredProviders, nextProjectConfig, nextCursorAuth] = await Promise.all([
        window.ade.ai.getStatus({
          force: options?.force === true,
          refreshOpenCodeInventory: options?.refreshOpenCodeInventory === true,
        }),
        window.ade.ai.listApiKeys(),
        window.ade.projectConfig.get(),
        window.ade.ai.cursorAuthStatus().catch(() => null),
      ]);
      statusKnownRef.current = true;
      setStatusLoadError(null);
      setStatus(nextStatus as AiSettingsStatus);
      setProjectConfigSnapshot(nextProjectConfig);
      if (nextCursorAuth) {
        setCursorAuth(nextCursorAuth);
        if (nextCursorAuth.loginInProgress) {
          setCursorLoginBusy(true);
          if (nextCursorAuth.loginUrl) setCursorLoginUrl(nextCursorAuth.loginUrl);
        }
      }
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
    // Cold paint is disk auth only. OpenCode inventory is a spawn and shares
    // the 30s runtime budget; OpenCode's Re-check still refreshes it.
    void (async () => {
      await refreshStatus({ force: forceRefreshOnMount });
      void loadAuthMethods();
    })();
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
    const unsubscribe = window.ade.ai.onCursorAuthStatus((event: CursorSdkAuthEvent) => {
      if (event.url) setCursorLoginUrl(event.url);
      if (event.state === "pending") setCursorLoginBusy(true);
      if (event.state === "success" || event.state === "error" || event.state === "cancelled" || event.state === "logged-out") {
        setCursorLoginBusy(false);
        if (event.state === "success" || event.state === "logged-out" || event.state === "cancelled") {
          setCursorLoginUrl(null);
        }
        void refreshStatus({ force: true, refreshOpenCodeInventory: true, silent: true });
      }
      if (event.state === "error" && event.error) setError(event.error);
      if (event.state === "success") {
        setNotice(event.email ? `Signed in as ${event.email}.` : "Signed in with Cursor.");
      }
    });
    return unsubscribe;
  }, [refreshStatus]);

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
  // Keep provider tiles neutral while the status payload is unavailable. A
  // failed first probe must not be presented as a real "Not installed" state.
  const isInitialCheckInFlight = status == null;
  const opencodeProviders = useMemo(() => status?.opencodeProviders ?? [], [status?.opencodeProviders]);

  const apiKeySources = useMemo(() => {
    const map = new Map<string, ApiKeySource>();
    const sourceForKey = (source: string | undefined): ApiKeySource | null =>
      source === "store" || source === "env" || source === "config" ? source : null;
    for (const entry of detectedAuth) {
      const source = sourceForKey(entry.source);
      if (entry.type === "api-key" && entry.provider && source) {
        map.set(entry.provider.toLowerCase(), source);
      } else if (entry.type === "openrouter" && source) {
        map.set("openrouter", source);
      }
    }
    return map;
  }, [detectedAuth]);

  const hasKeyFor = useCallback(
    (providerId: string) => apiKeySources.has(providerId) || storedProviders.includes(providerId),
    [apiKeySources, storedProviders],
  );

  const localRuntimes = useMemo((): LocalRuntimeRow[] => {
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

  const beginEditing = useCallback((provider: string) => {
    setEditingProvider(provider);
    setEditValue("");
    setError(null);
    setNotice(null);
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingProvider(null);
    setEditValue("");
  }, []);

  const deleteApiKey = useCallback(async (provider: string, options?: { alsoOpenCode?: boolean }) => {
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
      setEditingProvider((current) => (current === provider ? null : current));
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
  }, [refreshStatus]);

  const verifyApiKey = useCallback(async (provider: string) => {
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
  }, [refreshStatus]);

  const saveCursorApiKey = useCallback(async () => {
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
  }, [cancelEditing, editValue, refreshStatus]);

  const loginWithCursor = useCallback(async () => {
    setError(null);
    setNotice(null);
    setCursorLoginBusy(true);
    try {
      const result = await window.ade.ai.cursorAuthLogin();
      if (!result.ok) {
        setError(result.error || "Cursor sign-in failed.");
        return;
      }
      setVerifyingProvider("cursor");
      invalidateAiDiscoveryCache();
      const verification = await window.ade.ai.verifyApiKey("cursor");
      invalidateAiDiscoveryCache();
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
      setVerificationByProvider((prev) => ({ ...prev, cursor: verification }));
      if (verification.ok) {
        setNotice(result.email ? `Signed in as ${result.email}.` : "Cursor connection verified.");
        setCursorLoginUrl(null);
      } else {
        setError(verification.message || "Cursor verification failed.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCursorLoginBusy(false);
      setVerifyingProvider(null);
    }
  }, [refreshStatus]);

  const logoutCursor = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      const result = await window.ade.ai.cursorAuthLogout();
      if (!result.ok) {
        setError(result.error || "Cursor sign-out failed.");
        return;
      }
      invalidateAiDiscoveryCache();
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
      setVerificationByProvider((prev) => {
        const next = { ...prev };
        delete next.cursor;
        return next;
      });
      setNotice("Signed out of Cursor.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshStatus]);

  const cancelCursorLogin = useCallback(async () => {
    try {
      await window.ade.ai.cursorAuthCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCursorLoginBusy(false);
    }
  }, []);

  const handleRefreshCatalog = useCallback(async () => {
    setRefreshingCatalog(true);
    try {
      await window.ade.ai.refreshModelsDev();
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingCatalog(false);
    }
  }, [refreshStatus]);

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

  const saveAdvancedProvider = useCallback(async () => {
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
  }, [customProviderDraft, refreshStatus, status?.customProviders]);

  const saveCustomModelSlugs = useCallback(async () => {
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
  }, [customModelSlugs, refreshStatus]);

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

  const permissionDefaults: AiProviderPermissions = useMemo(
    () => projectConfigSnapshot?.effective.ai?.permissions?.providers ?? {},
    [projectConfigSnapshot],
  );
  const disabledProviders = useMemo(
    () => new Set((projectConfigSnapshot?.effective.ai?.disabledProviders ?? []).map((id) => id.toLowerCase())),
    [projectConfigSnapshot],
  );

  const setProviderDisabled = useCallback(async (
    provider: SettingsProviderId,
    disabled: boolean,
  ) => {
    const descriptor = providerDescriptor(provider);
    setSavingDisabledFor(provider);
    setError(null);
    setNotice(null);
    try {
      // The whole authoritative list, not a delta: `mergeAiConfig` replaces
      // this field, so a patch carrying only the change could never re-enable
      // anything.
      await window.ade.ai.updateConfig({
        disabledProviders: toggleDisabledProvider(
          projectConfigSnapshot?.effective.ai ?? null,
          provider,
          disabled,
        ),
      } as Partial<AiConfig>);
      invalidateAiDiscoveryCache();
      setNotice(`${descriptor?.label ?? provider} ${disabled ? "disabled" : "enabled"}.`);
      await refreshStatus({ force: false, silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingDisabledFor(null);
    }
  }, [projectConfigSnapshot, refreshStatus]);

  const loadAcpDiagnostics = useCallback(async (provider: AcpSettingsProviderId) => {
    const read = window.ade.ai.acpProviderDiagnostics;
    if (!read) return;
    setAcpDiagnosticsBusy(provider);
    try {
      const result = await read({ provider });
      setAcpDiagnostics((prev) => ({ ...prev, [provider]: result }));
      setAcpDiagnosticsError((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
    } catch (err) {
      setAcpDiagnosticsError((prev) => ({
        ...prev,
        [provider]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setAcpDiagnosticsBusy((current) => (current === provider ? null : current));
    }
  }, []);

  const runAcpDoctor = useCallback(async (provider: AcpSettingsProviderId) => {
    const read = window.ade.ai.acpProviderDiagnostics;
    if (!read) {
      setAcpDiagnosticsError((prev) => ({ ...prev, [provider]: "This window cannot run provider diagnostics." }));
      return;
    }
    setAcpDoctorBusy(provider);
    try {
      const result = await read({ provider, runDoctor: true });
      setAcpDiagnostics((prev) => ({ ...prev, [provider]: result }));
      setAcpDiagnosticsError((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
    } catch (err) {
      setAcpDiagnosticsError((prev) => ({
        ...prev,
        [provider]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setAcpDoctorBusy((current) => (current === provider ? null : current));
    }
  }, []);

  const openSignInTerminal = useCallback((provider: SettingsProviderId) => {
    const command = acpLoginCommand(provider);
    if (!command) return;
    setSignInProvider(provider);
  }, []);
  const defaultModelId = projectConfigSnapshot?.effective.ai?.defaultModel ?? null;

  const setPermissionDefault = useCallback(async (
    provider: SettingsProviderId,
    mode: AgentChatPermissionMode,
  ) => {
    const descriptor = providerDescriptor(provider);
    if (!descriptor) return;
    setSavingPermissionFor(provider);
    setError(null);
    setNotice(null);
    try {
      // The detail page writes the ABSTRACT mode only. Translating it to each
      // runtime's native flags stays where it already lives — one way, at
      // launch — so this cannot drift from what a chat actually does.
      await window.ade.ai.updateConfig({
        permissions: { providers: { [descriptor.permissions.key]: mode } },
      } as Partial<AiConfig>);
      setNotice(`${descriptor.label} permission default saved.`);
      await refreshStatus({ force: false, silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPermissionFor(null);
    }
  }, [refreshStatus]);

  const setDefaultModel = useCallback(async (modelId: string | null) => {
    setSavingDefaultModel(true);
    setError(null);
    setNotice(null);
    try {
      await window.ade.ai.updateConfig({ defaultModel: (modelId ?? undefined) as AiConfig["defaultModel"] });
      invalidateAiDiscoveryCache();
      setNotice(modelId ? `Default model set to ${modelId}.` : "Default model cleared.");
      await refreshStatus({ force: false, silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingDefaultModel(false);
    }
  }, [refreshStatus]);

  const ctx = useMemo((): ProvidersViewContext => ({
    status,
    projectConfigSnapshot,
    loading,
    statusLoadError,
    isInitialCheckInFlight,
    storedProviders,
    apiKeySources,
    hasKeyFor,
    verificationByProvider,
    verifyingProvider,
    editingProvider,
    editValue,
    cursorAuth,
    cursorLoginBusy,
    cursorLoginUrl,
    authMethods,
    authMethodsError,
    openCodeCatalog,
    connectedOpenCodeProviders,
    popularOpenCodeProviders,
    searchableOpenCodeProviders,
    providerSearch,
    refreshingCatalog,
    localRuntimes,
    localProviderDrafts,
    editingLocalProvider,
    savingLocalProvider,
    customProviderDraft,
    customModelSlugs,
    savingAdvanced,
    permissionDefaults,
    savingPermissionFor,
    defaultModelId,
    savingDefaultModel,
    disabledProviders,
    savingDisabledFor,
    acpDiagnostics,
    acpDiagnosticsBusy,
    acpDoctorBusy,
    acpDiagnosticsError,
    actions: {
      refreshStatus,
      loadAuthMethods,
      setError,
      setNotice,
      beginEditing,
      cancelEditing,
      setEditValue,
      deleteApiKey,
      verifyApiKey,
      saveCursorApiKey,
      loginWithCursor,
      logoutCursor,
      cancelCursorLogin,
      setProviderSearch,
      refreshCatalog: handleRefreshCatalog,
      openOpenCodeProviderDetail: openProviderDetail,
      updateLocalProviderDraft,
      beginEditingLocalRuntime,
      cancelEditingLocalRuntime,
      saveLocalProvider,
      setCustomProviderDraft,
      setCustomModelSlugs,
      saveAdvancedProvider,
      saveCustomModelSlugs,
      setPermissionDefault,
      setDefaultModel,
      revealClaudeLoginTerminal: revealClaudeLoginTerminalInWork,
      setProviderDisabled,
      loadAcpDiagnostics,
      runAcpDoctor,
      openSignInTerminal,
    },
  }), [
    apiKeySources, authMethods, authMethodsError, beginEditing, beginEditingLocalRuntime, cancelCursorLogin, cancelEditing,
    cancelEditingLocalRuntime, connectedOpenCodeProviders, cursorAuth, cursorLoginBusy,
    cursorLoginUrl, customModelSlugs, customProviderDraft, defaultModelId, deleteApiKey, editValue,
    editingLocalProvider, editingProvider, handleRefreshCatalog, hasKeyFor, isInitialCheckInFlight,
    loadAuthMethods, loading, localProviderDrafts, localRuntimes, loginWithCursor, logoutCursor,
    openCodeCatalog, openProviderDetail, permissionDefaults, popularOpenCodeProviders,
    projectConfigSnapshot, providerSearch, refreshStatus, refreshingCatalog, saveAdvancedProvider,
    saveCursorApiKey, saveCustomModelSlugs, saveLocalProvider, savingAdvanced, savingDefaultModel,
    savingLocalProvider, savingPermissionFor, searchableOpenCodeProviders, setDefaultModel,
    setPermissionDefault, status, statusLoadError, storedProviders, updateLocalProviderDraft,
    verificationByProvider, verifyApiKey, verifyingProvider, revealClaudeLoginTerminalInWork,
    disabledProviders, savingDisabledFor, setProviderDisabled, acpDiagnostics, acpDiagnosticsBusy,
    acpDoctorBusy, acpDiagnosticsError, loadAcpDiagnostics, runAcpDoctor, openSignInTerminal,
  ]);

  const descriptors = useMemo(() => availableProviderDescriptors(), []);
  const selectedDescriptor = selectedProviderId
    ? descriptors.find((descriptor) => descriptor.id === selectedProviderId) ?? null
    : null;

  // Opening an ACP provider's page is what pays for its CLI facts. Loading them
  // for the grid would spawn four CLIs to draw four tiles.
  const selectedAcpProvider = selectedDescriptor && acpLoginCommand(selectedDescriptor.id)
    ? (selectedDescriptor.id as AcpSettingsProviderId)
    : null;
  useEffect(() => {
    if (!selectedAcpProvider) return;
    if (acpDiagnostics[selectedAcpProvider]) return;
    void loadAcpDiagnostics(selectedAcpProvider);
  }, [acpDiagnostics, loadAcpDiagnostics, selectedAcpProvider]);

  const signInCommand = signInProvider ? acpLoginCommand(signInProvider) : null;

  return (
    <div id="ai-providers" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
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

      {selectedDescriptor ? (
        <div id={`ai-provider-${selectedDescriptor.id}`}>
          <ProviderDetailPage
            descriptor={selectedDescriptor}
            ctx={ctx}
            onBack={() => selectProvider(null)}
          />
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={groupLabelStyle}>Providers</div>
          {/* 320, not 280: at this window width 280 fits five columns, and five
              columns is where "GitHub Copilot" stopped fitting on one line. */}
          <ProviderGrid minWidth={320} autoFit gap={10}>
            {descriptors.map((descriptor) => (
              <ProviderTileCard
                key={descriptor.id}
                descriptor={descriptor}
                ctx={ctx}
                onOpen={() => selectProvider(descriptor.id)}
              />
            ))}
          </ProviderGrid>
        </div>
      )}

      {signInProvider && signInCommand ? (
        <ProviderSignInModal
          providerId={signInProvider}
          providerLabel={acpProviderLabel(signInProvider) ?? signInProvider}
          command={signInCommand}
          onClose={() => {
            setSignInProvider(null);
            void refreshStatus({ force: true, silent: true });
          }}
          onSignedIn={() => {
            setNotice(`Signed in to ${acpProviderLabel(signInProvider) ?? signInProvider}.`);
            invalidateAiDiscoveryCache();
          }}
          checkSignedIn={async () => {
            const next = await refreshStatus({ force: true, silent: true });
            // `authAvailable` is the disk credential the login just wrote —
            // that is the moment worth closing on. `runtimeAvailable` also
            // waits on the protocol probe, which is right for the tile and too
            // slow for a dialog someone is watching.
            return next?.providerConnections?.[signInProvider as AcpSettingsProviderId]?.authAvailable === true;
          }}
        />
      ) : null}

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
