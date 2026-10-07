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
import { openCodeProviderDisplayName } from "../../../shared/opencodeProviders";
import { toggleDisabledProvider } from "../../../shared/providerEnablement";
import {
  getLocalProviderDefaultEndpoint,
  LOCAL_PROVIDER_LABELS,
  type LocalProviderFamily,
} from "../../../shared/modelRegistry";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { invalidateAiDiscoveryCache } from "../../lib/aiDiscoveryCache";
import { shouldRefreshAiStatusForChatEvent } from "../../lib/aiProviderStatus";
import { showToast } from "../app/toast/toastStore";
import {
  OpenCodeProviderDetailModal,
  useOpenCodeProviderDetail,
  type ApiKeySource,
  type OpenCodeProviderDetail,
} from "./OpenCodeProviderDetailModal";
import { ModernSection, SettingsToggle } from "./primitives";
import "./ProvidersSection.css";
import { CustomProvidersSection } from "./harnesses/CustomProvidersSection";
import { setUsageHeaderVisible, useUsageHeaderPreferences } from "../usage/usageHeaderPreferences";
import { availableProviderDescriptors, providerDescriptor, providerStatusFor } from "./providers/descriptors";
import { useProviderAccountCounts } from "./providers/accounts/useProviderInstances";
import { ProviderDetailPage } from "./providers/ProviderDetailPage";
import { ProviderSignInModal } from "./providers/ProviderSignInModal";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { acpLoginCommand, acpProviderLabel } from "./providers/acpProviders";
import {
  AlertBanner,
  PreviewChip,
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
// Providers that have a tile of their own on this page. OpenCode's inventory
// also reports them, and listing them again under OpenCode read as a second,
// half-empty copy ("devin · Connected · 0 models").
const OPENCODE_CATALOG_EXCLUDED_IDS = new Set(["cursor", "ollama", "lmstudio", "devin"]);

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
 * The provider list is a grid of tiles: who it is, what state it is in, and
 * what ADE knows about it, with its own page behind each tile. The grid takes
 * as many columns as the page is wide, so a wide window shows the whole roster
 * without scrolling and a narrow one stacks it.
 */

/**
 * One provider card.
 *
 * The whole card is the open button, so its accessible name ("Open Claude Code
 * settings") covers the status tag and the message — a screen reader that lands
 * on it hears the same facts a sighted reader sees. The one quick action
 * (Sign in, Install, Review) is a sibling button laid over the card's corner,
 * never nested inside it.
 */
function ProviderCard({
  descriptor,
  ctx,
  accountCount,
  hidden = false,
  onOpen,
}: {
  descriptor: ProviderDescriptor;
  ctx: ProvidersViewContext;
  /** Local logins for this provider. Only Claude and Codex can exceed one. */
  accountCount?: number;
  /** Folded away with its group. */
  hidden?: boolean;
  onOpen: () => void;
}) {
  const status = providerStatusFor(descriptor, ctx);
  const models = descriptor.models(ctx);
  const version = normalizeProviderVersion(descriptor.version?.(ctx));
  // A count of zero while the probe is still out is a claim we cannot make.
  // A disabled provider's count is real but beside the point.
  const showModelCount = status.state !== "checking" && status.state !== "disabled";

  // A provider in trouble gets the real status sentence; a healthy one gets
  // where its credential came from — the only question a working one raises.
  const healthy = status.state === "connected";
  const problem = status.errorLine ?? (healthy ? null : status.message);
  const message = healthy ? descriptor.credentialLine?.(ctx) ?? null : problem;

  const metaParts = [
    // Only when there is more than one: "1 account" is noise on every card.
    ...(accountCount && accountCount > 1 ? [`${accountCount} accounts`] : []),
    ...(showModelCount ? [`${models.length} model${models.length === 1 ? "" : "s"}`] : []),
    ...(version ? [version] : []),
  ];

  const signInCommand = acpLoginCommand(descriptor.id);
  const action = status.state === "sign-in"
    ? {
      label: "Sign in",
      aria: `Sign in to ${descriptor.label}`,
      run: () => (signInCommand ? ctx.actions.openSignInTerminal(descriptor.id) : onOpen()),
    }
    : status.state === "not-installed"
      ? { label: "Install", aria: `Install ${descriptor.label}`, run: onOpen }
      : status.state === "attention"
        ? { label: "Review", aria: `Review ${descriptor.label}`, run: onOpen }
        : null;

  return (
    <div className="ade-pv-card" data-state={status.state} hidden={hidden}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${descriptor.label} settings`}
        className="ade-pv-open"
      >
        <span className="ade-pv-top">
          <span className="ade-pv-logo" aria-hidden>{descriptor.logo(22)}</span>
          <span className="ade-pv-id">
            <span className="ade-pv-name-row">
              <span className="ade-pv-name" data-testid={`provider-tile-name-${descriptor.id}`}>
                {descriptor.label}
              </span>
              {descriptor.preview ? <PreviewChip /> : null}
            </span>
            {metaParts.length > 0 ? (
              <span className="ade-pv-meta">{metaParts.join(" · ")}</span>
            ) : null}
          </span>
          <CaretRight size={12} className="ade-pv-caret" aria-hidden />
        </span>
        {message ? (
          <span className="ade-pv-line" title={message}>{message}</span>
        ) : null}
        <span className="ade-pv-foot">
          <span className="kit-tag" data-tone={PROVIDER_TAG_TONE[status.state]}>
            {status.label}
          </span>
        </span>
      </button>
      {action ? (
        <button type="button" className="ade-pv-action" aria-label={action.aria} onClick={action.run}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

const PROVIDER_TAG_TONE: Record<ProviderDescriptorState, string | undefined> = {
  checking: undefined,
  connected: "ok",
  "sign-in": "warn",
  attention: "crit",
  "not-installed": undefined,
  disabled: undefined,
};

type ProviderDescriptorState = ReturnType<typeof providerStatusFor>["state"];

/**
 * Ready first, then the ones asking for something, then the ones that are not
 * set up — folded away while anything above them exists, so the grid opens on
 * what works. Until the first status lands every card says Checking, and the
 * grid stays one flat list rather than shuffling as answers arrive.
 */
const PROVIDER_GROUPS: Array<{ id: string; label: string; states: ProviderDescriptorState[] }> = [
  { id: "ready", label: "Ready", states: ["connected"] },
  { id: "action", label: "Action needed", states: ["sign-in", "attention", "checking"] },
  { id: "unset", label: "Not set up", states: ["not-installed", "disabled"] },
];

function ProviderGrid({
  descriptors,
  ctx,
  accountCounts,
  onOpen,
}: {
  descriptors: ProviderDescriptor[];
  ctx: ProvidersViewContext;
  accountCounts: Partial<Record<string, number>>;
  onOpen: (id: string) => void;
}) {
  const [unsetOpen, setUnsetOpen] = useState(false);
  const card = (descriptor: ProviderDescriptor, hidden = false) => (
    <ProviderCard
      key={descriptor.id}
      descriptor={descriptor}
      ctx={ctx}
      hidden={hidden}
      {...(accountCounts[descriptor.id] != null ? { accountCount: accountCounts[descriptor.id] } : {})}
      onOpen={() => onOpen(descriptor.id)}
    />
  );
  // One flat, keyed list in one parent — headings included — so a card that
  // changes group when its status lands is moved, not remounted, and keeps
  // keyboard focus.
  if (ctx.status == null) {
    return <div className="ade-pv-grid">{descriptors.map((descriptor) => card(descriptor))}</div>;
  }
  const grouped = PROVIDER_GROUPS.map((group) => ({
    ...group,
    items: descriptors.filter((descriptor) => group.states.includes(providerStatusFor(descriptor, ctx).state)),
  })).filter((group) => group.items.length > 0);
  const foldable = grouped.length > 1;
  const children: React.ReactNode[] = [];
  grouped.forEach((group, index) => {
    const collapsible = foldable && group.id === "unset";
    const open = !collapsible || unsetOpen;
    children.push(
      <div key={`head-${group.id}`} className="ade-pv-group-head" data-first={index === 0 ? "true" : undefined}>
        <span className="kit-eyebrow">{group.label}</span>
        <span className="ade-pv-count kit-num">{group.items.length}</span>
        {collapsible ? (
          <button
            type="button"
            className="ade-pv-fold"
            aria-expanded={open}
            onClick={() => setUnsetOpen((value) => !value)}
          >
            {open ? "Hide" : "Show"}
            <CaretDown size={11} weight="bold" style={{ transform: open ? "rotate(180deg)" : undefined }} />
          </button>
        ) : null}
      </div>,
    );
    if (collapsible && !open) {
      children.push(
        <button
          key={`folded-${group.id}`}
          type="button"
          className="ade-pv-folded"
          onClick={() => setUnsetOpen(true)}
          aria-label={`Show ${group.items.length} providers that are not set up`}
        >
          <span className="ade-pv-folded-logos" aria-hidden>
            {group.items.slice(0, 8).map((descriptor) => (
              <span key={descriptor.id}>{descriptor.logo(16)}</span>
            ))}
          </span>
          <span>{group.items.map((descriptor) => descriptor.label).join(", ")}</span>
        </button>,
      );
    }
    for (const descriptor of group.items) children.push(card(descriptor, !open));
  });
  return <div className="ade-pv-grid">{children}</div>;
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
}: {
  forceRefreshOnMount?: boolean;
  /** `?provider=<id>` — which provider's page to show, if any. */
  providerParam?: string | null;
  /** Lets the settings shell keep the URL in step with the sub-view. */
  onProviderChange?: (providerId: string | null) => void;
  /** `#ai-harnesses` — scroll the Custom section into view on mount. */
  harnessesParam?: boolean;
} = {}) {
  const usageHeaderPreferences = useUsageHeaderPreferences();
  // The machine whose providers this page shows. Every runtime call below
  // carries `pin` (null = the tab's binding); the page is
  // remounted per machine, so a pin never changes under a live closure.
  const { pin } = useSettingsMachineScope();
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
  const statusKnownRef = useRef(false);
  const pendingRefreshTimerRef = useRef<number | null>(null);
  // Seed the slugs field from config exactly once — saves send the full list
  // (replace semantics), so the field must start from what's persisted or a
  // save would silently wipe existing entries.
  const slugsSeededRef = useRef(false);

  useEffect(() => {
    setSelectedProviderId(providerParam);
  }, [providerParam]);

  // Custom is a section of this page now, not a sub-view: the `#ai-harnesses`
  // deeplink (and `?harnesses=1`) scroll to it instead of replacing the page.
  useEffect(() => {
    if (!harnessesParam) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("ai-harnesses")?.scrollIntoView?.({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [harnessesParam]);

  const selectProvider = useCallback((next: string | null) => {
    setSelectedProviderId(next);
    onProviderChange?.(next);
  }, [onProviderChange]);

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
        }, pin),
        window.ade.ai.listApiKeys(pin),
        window.ade.projectConfig.get(pin),
        window.ade.ai.cursorAuthStatus(pin).catch(() => null),
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
  }, [editingLocalProvider, pin, savingLocalProvider]);

  const loadAuthMethods = useCallback(async () => {
    try {
      const result = await window.ade.ai.opencodeAuthMethods(pin);
      setAuthMethods(result.methods ?? {});
      setAuthMethodsError(null);
    } catch (err) {
      // Keep any previously loaded methods so an intermittent failure does not
      // wipe SuperGrok / ChatGPT OAuth rows mid-session.
      setAuthMethodsError(err instanceof Error ? err.message : String(err));
    }
  }, [pin]);

  useEffect(() => {
    // Cold paint is disk auth only. OpenCode inventory is a spawn and shares
    // the 30s runtime budget; OpenCode's Re-check still refreshes it.
    void (async () => {
      const next = await refreshStatus({ force: forceRefreshOnMount });
      void loadAuthMethods();
      // No cached OpenCode catalog (first run, or a cache from an older
      // layout): without one probe the provider list is only the fallback
      // names, and providers such as OpenCode Console cannot be found.
      if (next?.opencodeBinaryInstalled && !next.opencodeProviders?.length) {
        await refreshStatus({ force: true, refreshOpenCodeInventory: true, silent: true });
        void loadAuthMethods();
      }
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

  // The Cursor status feed re-subscribes only when the machine changes.
  // Re-subscribing when `refreshStatus` changes identity would re-anchor a
  // pinned feed at its live head and drop a "success" emitted in between.
  const refreshStatusRef = useRef(refreshStatus);
  refreshStatusRef.current = refreshStatus;
  useEffect(() => {
    const unsubscribe = window.ade.ai.onCursorAuthStatus((event: CursorSdkAuthEvent) => {
      if (event.url) setCursorLoginUrl(event.url);
      if (event.state === "pending") setCursorLoginBusy(true);
      if (event.state === "success" || event.state === "error" || event.state === "cancelled" || event.state === "logged-out") {
        setCursorLoginBusy(false);
        if (event.state === "success" || event.state === "logged-out" || event.state === "cancelled") {
          setCursorLoginUrl(null);
        }
        void refreshStatusRef.current({ force: true, refreshOpenCodeInventory: true, silent: true });
      }
      if (event.state === "error" && event.error) setError(event.error);
      if (event.state === "success") {
        setNotice(event.email ? `Signed in as ${event.email}.` : "Signed in with Cursor.");
      }
    }, pin);
    return unsubscribe;
  }, [pin]);

  useEffect(() => {
    // A convenience refresh when this machine's chats change model state.
    // Another machine's chat feed is not subscribed here; its status refreshes
    // on open and on every action instead.
    if (pin) return undefined;
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
  }, [pin, refreshStatus]);

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
        signedIn: patch.signedIn ?? prev?.signedIn ?? inventory?.signedIn === true,
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
        // The host names OpenCode's own services; a summary from an older
        // host still carries OpenCode's name for them.
        name: openCodeProviderDisplayName(p.id, p.name),
        modelCount: p.modelCount,
        connected: p.connected,
        signedIn: p.signedIn === true,
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

  // A provider OpenCode reports as connected stays visible even when it has no
  // models yet, so the user can inspect its status. A stored key also stays visible.
  const connectedOpenCodeProviders = useMemo(
    () => openCodeCatalog.filter((p) => p.hasKey || p.connected),
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

  const { provider: detailProvider, signInVia: detailSignInVia } = useOpenCodeProviderDetail(
    detailProviderId,
    openCodeCatalog,
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
        const result = await window.ade.ai.clearOpencodeProviderKey({ providerId: provider }, pin);
        if (!result.ok) {
          throw new Error(result.error || "OpenCode could not remove the provider key.");
        }
      }
      await window.ade.ai.deleteApiKey(provider, pin);
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
  }, [pin, refreshStatus]);

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
      const result = await window.ade.ai.verifyApiKey(provider, pin);
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
  }, [pin, refreshStatus]);

  const loginWithCursor = useCallback(async () => {
    setError(null);
    setNotice(null);
    setCursorLoginBusy(true);
    try {
      const result = await window.ade.ai.cursorAuthLogin(pin);
      if (!result.ok) {
        setError(result.error || "Cursor sign-in failed.");
        return;
      }
      setVerifyingProvider("cursor");
      invalidateAiDiscoveryCache();
      const verification = await window.ade.ai.verifyApiKey("cursor", pin);
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
  }, [pin, refreshStatus]);

  const logoutCursor = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      const result = await window.ade.ai.cursorAuthLogout(pin);
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
  }, [pin, refreshStatus]);

  const cancelCursorLogin = useCallback(async () => {
    try {
      await window.ade.ai.cursorAuthCancel(pin);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCursorLoginBusy(false);
    }
  }, [pin]);

  const handleRefreshCatalog = useCallback(async () => {
    setRefreshingCatalog(true);
    try {
      await window.ade.ai.refreshModelsDev(pin);
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingCatalog(false);
    }
  }, [pin, refreshStatus]);

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
      }, pin);
      invalidateAiDiscoveryCache();
      setNotice("Custom model slugs saved.");
      await refreshStatus({ force: true, refreshOpenCodeInventory: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAdvanced(false);
    }
  }, [pin, customModelSlugs, refreshStatus]);

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
      }, pin);
      invalidateAiDiscoveryCache();
      setNotice(`${LOCAL_PROVIDER_LABELS[provider]} settings saved.`);
      setEditingLocalProvider(null);
      await refreshStatus({ force: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingLocalProvider(null);
    }
  }, [pin, localProviderDrafts, refreshStatus]);

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
      } as Partial<AiConfig>, pin);
      invalidateAiDiscoveryCache();
      setNotice(`${descriptor?.label ?? provider} ${disabled ? "disabled" : "enabled"}.`);
      await refreshStatus({ force: false, silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingDisabledFor(null);
    }
  }, [pin, projectConfigSnapshot, refreshStatus]);

  const loadAcpDiagnostics = useCallback(async (provider: AcpSettingsProviderId) => {
    const read = window.ade.ai.acpProviderDiagnostics;
    if (!read) return;
    setAcpDiagnosticsBusy(provider);
    try {
      const result = await read({ provider }, pin);
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
  }, [pin]);

  const runAcpDoctor = useCallback(async (provider: AcpSettingsProviderId) => {
    const read = window.ade.ai.acpProviderDiagnostics;
    if (!read) {
      setAcpDiagnosticsError((prev) => ({ ...prev, [provider]: "This window cannot run provider diagnostics." }));
      return;
    }
    setAcpDoctorBusy(provider);
    try {
      const result = await read({ provider, runDoctor: true }, pin);
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
  }, [pin]);

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
      const result = await run({ provider }, pin);
      if (!result.ok) throw new Error(result.message);
      setNotice(result.message);
      // Re-read the diagnostics so the advisory reflects the version the
      // updater just wrote, not the pre-update snapshot.
      const read = window.ade.ai.acpProviderDiagnostics;
      if (read) {
        try {
          const diagnostics = await read({ provider }, pin);
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
  }, [pin]);

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
    verificationByProvider, verifyApiKey, verifyingProvider,
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
    // The `ai-providers` anchor lives on the section below. This wrapper is
    // layout only — giving it the id too would put the anchor in the DOM twice.
    <div className={selectedDescriptor ? "ade-pv-detail" : "ade-pv-page"}>
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
          />
        </div>
      ) : (
        <ModernSection
          group="Connections"
          anchor="ai-providers"
          title="Coding agents"
          hint="Every agent ADE can run. Open one to sign in, choose models, or turn it off."
          actions={(
            <label className="ade-pv-usage-toggle">
              Show usage in header
              <SettingsToggle
                label="Show usage in header"
                checked={usageHeaderPreferences.showInHeader}
                onChange={(next) => setUsageHeaderVisible(next)}
              />
            </label>
          )}
        >
          <ProviderGrid
            descriptors={descriptors}
            ctx={ctx}
            accountCounts={accountCounts as Partial<Record<string, number>>}
            onOpen={selectProvider}
          />
        </ModernSection>
      )}

      {selectedDescriptor ? null : <CustomProvidersSection status={status} storedProviders={storedProviders} />}

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
          signInVia={detailSignInVia}
          keySource={apiKeySources.get(detailProvider.id)
            ?? (storedProviders.includes(detailProvider.id) ? "store" : detailProvider.credentialSource)}
          verification={verificationByProvider[detailProvider.id]}
          verifying={verifyingProvider === detailProvider.id}
          authMethodsError={authMethodsError}
          onClose={() => setDetailProviderId(null)}
          onConnected={() => void handleSubscriptionConnected(detailProvider.id, detailProvider.name)}
          onRetryAuthMethods={() => void loadAuthMethods()}
          onSaveKey={async (key) => {
            const result = await window.ade.ai.setOpencodeProviderKey({ providerId: detailProvider.id, key }, pin);
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
