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
  AiConfig,
  AiApiKeyVerificationResult,
  AiSettingsStatus,
  ProjectConfigSnapshot,
  CursorSdkAuthEvent,
  CursorSdkAuthStatus,
} from "../../../shared/types";
import type {
  AcpProviderDiagnostics,
  OpenCodeProviderAuthMethods,
} from "../../../shared/types/config";
import { toggleDisabledProvider } from "../../../shared/providerEnablement";
import {
  getLocalProviderDefaultEndpoint,
  LOCAL_PROVIDER_LABELS,
  type LocalProviderFamily,
} from "../../../shared/modelRegistry";
import { CaretRight } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { invalidateAiDiscoveryCache } from "../../lib/aiDiscoveryCache";
import { shouldRefreshAiStatusForChatEvent } from "../../lib/aiProviderStatus";
import { showToast } from "../app/toast/toastStore";
import { revealTerminalSessionInWork } from "../work/ClaudeLoginPromptButton";
import {
  OpenCodeProviderDetailModal,
  type ApiKeySource,
  type OpenCodeProviderDetail,
} from "./OpenCodeProviderDetailModal";
import {
  SettingsManagerPage,
  SettingsManagerRow,
  SettingsManagerTable,
} from "./primitives/SettingsManagerPage";
import { HarnessesPage } from "./harnesses/HarnessesPage";
import { useHarnessPresets } from "./harnesses/useHarnessPresets";
import { CustomToolMark } from "../shared/CustomToolMark";
import { HelpHint } from "./primitives/HelpHint";

/** The one sentence behind the "?" on the Custom section. */
const CUSTOM_ENTRY_HELP = "An agent and the model it runs on, saved together — pick one in any model picker to start a chat with that whole setup.";
import { availableProviderDescriptors, providerDescriptor, providerStatusFor } from "./providers/descriptors";
import { useProviderAccountCounts } from "./providers/accounts/useProviderInstances";
import { ProviderDetailPage } from "./providers/ProviderDetailPage";
import { ProviderSignInModal } from "./providers/ProviderSignInModal";
import { acpLoginCommand, acpProviderLabel } from "./providers/acpProviders";
import {
  AlertBanner,
  PreviewChip,
  ProviderStatusChip,
  normalizeProviderVersion,
  prettifyProviderId,
} from "./providers/providerUi";
import type {
  AcpSettingsProviderId,
  LocalProviderDraft,
  LocalRuntimeRow,
  ProviderDescriptor,
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

/**
 * The provider list is a manager page: a table you scan, with one row per
 * provider and its own page behind each row. The columns are the three facts
 * the old tile stacked vertically — who it is, what state it is in, and what
 * ADE knows about it — which is why ten providers now read as a list instead
 * of as ten little dashboards.
 */
const PROVIDER_COLUMNS = [
  { label: "Provider", width: "minmax(180px, 1.1fr)" },
  { label: "Status", width: "minmax(130px, 0.7fr)" },
  { label: "Details", width: "minmax(200px, 1.5fr)" },
  { label: "", width: "20px", align: "right" as const },
];

/**
 * One provider row.
 *
 * The whole row is the button, spanning every column on the table's own track
 * template, so the accessible name ("Open Claude Code settings") still covers
 * the status and the message — a screen reader that lands on the control hears
 * the same three facts a sighted reader sees, and nothing is stranded in a
 * sibling cell the label does not reach.
 */
function ProviderManagerRow({
  descriptor,
  ctx,
  accountCount,
  onOpen,
}: {
  descriptor: ProviderDescriptor;
  ctx: ProvidersViewContext;
  /** Local logins for this provider. Only Claude and Codex can exceed one. */
  accountCount?: number;
  onOpen: () => void;
}) {
  const status = providerStatusFor(descriptor, ctx);
  const models = descriptor.models(ctx);
  const version = normalizeProviderVersion(descriptor.version?.(ctx));
  // A count of zero while the probe is still out is a claim we cannot make.
  // A disabled provider's count is real but beside the point — the row's job
  // is to say it is off and to be clickable.
  const showModelCount = status.state !== "checking" && status.state !== "disabled";

  // The detail line says one of two things. A provider in trouble gets the real
  // status sentence; a healthy one gets where its credential came from, which
  // is the only question a working provider still raises.
  const healthy = status.state === "connected";
  const problem = status.errorLine ?? (healthy ? null : status.message);
  const message = healthy ? descriptor.credentialLine?.(ctx) ?? null : problem;

  const metaParts = [
    // Only when there is more than one: "1 account" is the state every other
    // provider is permanently in, so saying it is noise on nine rows.
    ...(accountCount && accountCount > 1 ? [`${accountCount} accounts`] : []),
    ...(showModelCount ? [`${models.length} model${models.length === 1 ? "" : "s"}`] : []),
    ...(version ? [version] : []),
  ];

  return (
    <SettingsManagerRow>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${descriptor.label} settings`}
        style={{
          gridColumn: "1 / -1",
          display: "grid",
          gridTemplateColumns: "var(--settings-manager-columns)",
          gap: 12,
          alignItems: "center",
          width: "100%",
          margin: 0,
          padding: 0,
          border: "none",
          background: "transparent",
          textAlign: "left",
          cursor: "pointer",
          font: "inherit",
          color: "inherit",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {descriptor.logo(22)}
          <span
            data-testid={`provider-tile-name-${descriptor.id}`}
            style={{
              fontSize: 12,
              fontFamily: SANS_FONT,
              color: COLORS.textPrimary,
              minWidth: 0,
              // Never clipped: the name is the row's identity, and
              // "GitHub Co…" is a worse row than a two-line title.
              overflowWrap: "anywhere",
              lineHeight: 1.3,
            }}
          >
            {descriptor.label}
          </span>
          {descriptor.preview ? <PreviewChip /> : null}
        </span>

        <span style={{ minWidth: 0 }}>
          <ProviderStatusChip state={status.state} label={status.label} />
        </span>

        <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <span
            style={{
              fontSize: 10,
              fontFamily: SANS_FONT,
              color: COLORS.textMuted,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {metaParts.join(" · ")}
          </span>
          <span
            style={{
              fontSize: 10,
              fontFamily: SANS_FONT,
              // The dot already carries the state; red here is reserved for a
              // real probe failure so it still means something.
              color: status.errorLine ? COLORS.danger : COLORS.textDim,
              lineHeight: 1.4,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              overflowWrap: "anywhere",
            }}
            {...(message ? { title: message } : {})}
          >
            {message}
          </span>
        </span>

        <span aria-hidden style={{ display: "flex", justifyContent: "flex-end", color: COLORS.textDim }}>
          <CaretRight size={13} />
        </span>
      </button>
    </SettingsManagerRow>
  );
}

/**
 * Custom — its own section, under the provider list.
 *
 * It sat as a last row inside the providers table, where it read as an eleventh
 * provider: a thing you sign in to. It is not. It is the combinations *you*
 * saved of the ten above, which is a different kind of thing and belongs below
 * them with its own heading and its own mark — a purple gear and wrench, so the one
 * entry that is yours is not wearing a vendor's logo or the app's own.
 *
 * The count is the whole status: a saved setup has no connection to probe.
 */
function CustomPresetsCard({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <SettingsManagerPage
      anchor="ai-harnesses-entry"
      title="Custom"
      leading={<CustomToolMark size={18} />}
      titleAdornment={<HelpHint text={CUSTOM_ENTRY_HELP} />}
      toolbar={
        <button type="button" style={outlineButton()} onClick={onOpen}>
          {count === 0 ? "Add new" : "Manage"}
        </button>
      }
    >
      <button
        type="button"
        onClick={onOpen}
        data-custom-presets-entry="true"
        aria-label="Open custom setups"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          width: "100%",
          padding: "10px 12px",
          borderRadius: 8,
          border: `1px solid ${COLORS.outlineBorder}`,
          background: "var(--color-card)",
          textAlign: "left",
          cursor: "pointer",
          font: "inherit",
          color: COLORS.textPrimary,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <CustomToolMark size={20} />
          <span style={{ fontFamily: SANS_FONT, fontSize: 12 }}>
            {count === 0 ? "Nothing custom yet" : `${count} saved`}
          </span>
        </span>
        <span aria-hidden style={{ display: "flex", color: COLORS.textDim }}>
          <CaretRight size={13} />
        </span>
      </button>
    </SettingsManagerPage>
  );
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

export function ProvidersSection({
  forceRefreshOnMount = false,
  providerParam = null,
  onProviderChange,
  harnessesParam = false,
  onHarnessesChange,
}: {
  forceRefreshOnMount?: boolean;
  /** `?provider=<id>` — which provider's page to show, if any. */
  providerParam?: string | null;
  /** Lets the settings shell keep the URL in step with the sub-view. */
  onProviderChange?: (providerId: string | null) => void;
  /** `#ai-harnesses` — whether the harnesses page is the open sub-view. */
  harnessesParam?: boolean;
  onHarnessesChange?: (open: boolean) => void;
} = {}) {
  const navigate = useNavigate();
  // Claude and Codex can hold several local logins; the row says how many so
  // the count is visible without opening the page.
  const accountCounts = useProviderAccountCounts();
  const [status, setStatus] = useState<AiSettingsStatus | null>(null);
  const [projectConfigSnapshot, setProjectConfigSnapshot] = useState<ProjectConfigSnapshot | null>(null);
  const [storedProviders, setStoredProviders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingLocalProvider, setEditingLocalProvider] = useState<LocalProviderFamily | null>(null);
  const [savingLocalProvider, setSavingLocalProvider] = useState<LocalProviderFamily | null>(null);
  const [localProviderDrafts, setLocalProviderDrafts] = useState<Record<LocalProviderFamily, LocalProviderDraft>>(() =>
    buildLocalProviderDrafts(null, null),
  );
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
  const [customModelSlugs, setCustomModelSlugs] = useState("");
  const [savingAdvanced, setSavingAdvanced] = useState(false);
  const [statusLoadError, setStatusLoadError] = useState<string | null>(null);
  const [cursorAuth, setCursorAuth] = useState<CursorSdkAuthStatus | null>(null);
  const [cursorLoginBusy, setCursorLoginBusy] = useState(false);
  const [cursorLoginUrl, setCursorLoginUrl] = useState<string | null>(null);
  const [savingDisabledFor, setSavingDisabledFor] = useState<SettingsProviderId | null>(null);
  // ACP CLI facts. Loaded when a provider's page opens, because reading them
  // spawns the CLI — see `acpProviderDiagnostics` in main.
  const [acpDiagnostics, setAcpDiagnostics] = useState<Partial<Record<AcpSettingsProviderId, AcpProviderDiagnostics>>>({});
  const [acpDiagnosticsBusy, setAcpDiagnosticsBusy] = useState<AcpSettingsProviderId | null>(null);
  const [acpDoctorBusy, setAcpDoctorBusy] = useState<AcpSettingsProviderId | null>(null);
  const [acpUpdateBusy, setAcpUpdateBusy] = useState<AcpSettingsProviderId | null>(null);
  const [acpDiagnosticsError, setAcpDiagnosticsError] = useState<Partial<Record<AcpSettingsProviderId, string>>>({});
  const [signInProvider, setSignInProvider] = useState<SettingsProviderId | null>(null);
  // Which provider's page is open. Seeded and re-seeded from `?provider=`, but
  // owned here so the section works standalone (and in tests) without a router
  // that writes search params.
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(providerParam);
  // The harnesses page is the second sub-view of this tab. Same ownership rule
  // as the provider page: seeded from the URL, owned here so the section still
  // works standalone and in tests.
  const [harnessesOpen, setHarnessesOpen] = useState<boolean>(harnessesParam);
  const { presets: harnessPresets } = useHarnessPresets();
  const statusKnownRef = useRef(false);
  const pendingRefreshTimerRef = useRef<number | null>(null);
  // Seed the slugs field from config exactly once — saves send the full list
  // (replace semantics), so the field must start from what's persisted or a
  // save would silently wipe existing entries.
  const slugsSeededRef = useRef(false);

  useEffect(() => {
    setSelectedProviderId(providerParam);
  }, [providerParam]);

  useEffect(() => {
    setHarnessesOpen(harnessesParam);
  }, [harnessesParam]);

  const openHarnesses = useCallback((next: boolean) => {
    setHarnessesOpen(next);
    onHarnessesChange?.(next);
  }, [onHarnessesChange]);

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
        hasKey: hasKeyFor(id) || Boolean(patch.credentialSource ?? prev?.credentialSource ?? inventory?.credentialSource),
        modelCount: patch.modelCount ?? prev?.modelCount ?? inventory?.modelCount,
        envVars: patch.envVars
          ?? prev?.envVars
          ?? (inventory?.envVars?.length ? inventory.envVars : undefined)
          ?? (apiSpec?.envVar ? [apiSpec.envVar] : undefined),
        credentialSource: patch.credentialSource
          ?? prev?.credentialSource
          ?? inventory?.credentialSource,
        verificationSupported: patch.verificationSupported
          ?? prev?.verificationSupported
          ?? (apiSpec ? true : undefined),
        envVar: patch.envVar
          ?? prev?.envVar
          ?? (inventory?.envVars?.length === 1 ? inventory.envVars[0] : undefined)
          ?? apiSpec?.envVar,
        placeholder: patch.placeholder ?? prev?.placeholder ?? apiSpec?.placeholder,
      });
    };

    for (const p of opencodeProviders) {
      upsert(p.id, {
        name: p.name,
        modelCount: p.modelCount,
        connected: p.connected,
        envVars: p.envVars,
      });
    }
    for (const [id, methods] of Object.entries(authMethods ?? {})) {
      upsert(id, { methods });
    }
    for (const api of API_KEY_PROVIDERS) {
      upsert(api.provider, {
        name: api.label,
        envVar: api.envVar,
        envVars: [api.envVar],
        placeholder: api.placeholder,
      });
    }
    // Kimi for Coding is ADE's known API-key path; keep OpenCode-advertised methods if present.
    const kimiInventory = inventoryById.get(KIMI_PROVIDER_ID);
    upsert(KIMI_PROVIDER_ID, {
      name: "Kimi for Coding",
      envVar: "KIMI_API_KEY",
      envVars: ["KIMI_API_KEY"],
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

  const updateAcpProvider = useCallback(async (provider: AcpSettingsProviderId) => {
    const run = window.ade.ai.acpProviderUpdate;
    if (!run) {
      setAcpDiagnosticsError((prev) => ({ ...prev, [provider]: "This window cannot update providers." }));
      return;
    }
    setAcpUpdateBusy(provider);
    setAcpDiagnosticsError((prev) => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
    try {
      const result = await run({ provider });
      if (!result.ok) throw new Error(result.message);
      setNotice(result.message);
      // Re-read the diagnostics so the advisory reflects the version the
      // updater just wrote, not the pre-update snapshot.
      const read = window.ade.ai.acpProviderDiagnostics;
      if (read) {
        try {
          const diagnostics = await read({ provider });
          setAcpDiagnostics((prev) => ({ ...prev, [provider]: diagnostics }));
        } catch {
          // The update succeeded; a failed re-read does not undo it.
        }
      }
    } catch (err) {
      setAcpDiagnosticsError((prev) => ({
        ...prev,
        [provider]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setAcpUpdateBusy((current) => (current === provider ? null : current));
    }
  }, []);

  const openSignInTerminal = useCallback((provider: SettingsProviderId) => {
    const command = acpLoginCommand(provider);
    if (!command) return;
    setSignInProvider(provider);
  }, []);

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
    customModelSlugs,
    savingAdvanced,
    disabledProviders,
    savingDisabledFor,
    acpDiagnostics,
    acpDiagnosticsBusy,
    acpDoctorBusy,
    acpUpdateBusy,
    acpDiagnosticsError,
    actions: {
      refreshStatus,
      loadAuthMethods,
      setError,
      setNotice,
      deleteApiKey,
      verifyApiKey,
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
      setCustomModelSlugs,
      saveCustomModelSlugs,
      revealClaudeLoginTerminal: revealClaudeLoginTerminalInWork,
      setProviderDisabled,
      loadAcpDiagnostics,
      runAcpDoctor,
      updateAcpProvider,
      openSignInTerminal,
    },
  }), [
    apiKeySources, authMethods, authMethodsError, beginEditingLocalRuntime, cancelCursorLogin,
    cancelEditingLocalRuntime, connectedOpenCodeProviders, cursorAuth, cursorLoginBusy,
    cursorLoginUrl, customModelSlugs, deleteApiKey,
    editingLocalProvider, handleRefreshCatalog, hasKeyFor, isInitialCheckInFlight,
    loadAuthMethods, loading, localProviderDrafts, localRuntimes, loginWithCursor, logoutCursor,
    openCodeCatalog, openProviderDetail, popularOpenCodeProviders,
    projectConfigSnapshot, providerSearch, refreshStatus, refreshingCatalog,
    saveCustomModelSlugs, saveLocalProvider, savingAdvanced,
    savingLocalProvider, searchableOpenCodeProviders,
    status, statusLoadError, storedProviders, updateLocalProviderDraft,
    verificationByProvider, verifyApiKey, verifyingProvider, revealClaudeLoginTerminalInWork,
    disabledProviders, savingDisabledFor, setProviderDisabled, acpDiagnostics, acpDiagnosticsBusy,
    acpDoctorBusy, acpUpdateBusy, acpDiagnosticsError, loadAcpDiagnostics, runAcpDoctor,
    updateAcpProvider, openSignInTerminal,
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
    // The `ai-providers` anchor moved onto the manager page below, so the
    // template owns the id, the scope chip and the heading in one place. This
    // wrapper is layout only — giving it the id too would put the same anchor
    // in the DOM twice whenever the grid is on screen.
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
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

      {harnessesOpen ? (
        <HarnessesPage onBack={() => openHarnesses(false)} />
      ) : selectedDescriptor ? (
        <div id={`ai-provider-${selectedDescriptor.id}`}>
          <ProviderDetailPage
            descriptor={selectedDescriptor}
            ctx={ctx}
            onBack={() => selectProvider(null)}
          />
        </div>
      ) : (
        <SettingsManagerPage
          anchor="ai-providers"
          title="AI providers"
          description="Every coding agent ADE can run. Open one to sign in, choose models, or turn it off."
        >
          <SettingsManagerTable columns={PROVIDER_COLUMNS} minWidth={620}>
            {descriptors.map((descriptor) => (
              <ProviderManagerRow
                key={descriptor.id}
                descriptor={descriptor}
                ctx={ctx}
                {...(accountCounts[descriptor.id as keyof typeof accountCounts] != null
                  ? { accountCount: accountCounts[descriptor.id as keyof typeof accountCounts] }
                  : {})}
                onOpen={() => selectProvider(descriptor.id)}
              />
            ))}
          </SettingsManagerTable>
        </SettingsManagerPage>
      )}

      {harnessesOpen || selectedDescriptor ? null : (
        <CustomPresetsCard count={harnessPresets.length} onOpen={() => openHarnesses(true)} />
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
          keySource={apiKeySources.get(detailProvider.id)
            ?? (storedProviders.includes(detailProvider.id) ? "store" : detailProvider.credentialSource)}
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
