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
import { CaretDown } from "@phosphor-icons/react";
import { providerBrand } from "./providers/providerBrand";
import { ToolLogo } from "../terminals/ToolLogos";
import { DevinMark } from "../shared/ProviderLogos";
import { invalidateAiDiscoveryCache } from "../../lib/aiDiscoveryCache";
import { shouldRefreshAiStatusForChatEvent } from "../../lib/aiProviderStatus";
import { showToast } from "../app/toast/toastStore";
import {
  OpenCodeProviderDetailModal,
  useOpenCodeProviderDetail,
  type ApiKeySource,
  type OpenCodeProviderDetail,
} from "./OpenCodeProviderDetailModal";
import { SettingsToggle } from "./primitives";
import "./ProvidersSection.css";
import { CustomProvidersSection } from "./harnesses/CustomProvidersSection";
import { setUsageHeaderVisible, useUsageHeaderPreferences } from "../usage/usageHeaderPreferences";
import { availableProviderDescriptors, providerDescriptor, providerStatusFor } from "./providers/descriptors";
import { useProviderAccountCounts } from "./providers/accounts/useProviderInstances";
import { ProviderDetailPage } from "./providers/ProviderDetailPage";
import { ProviderSignInModal } from "./providers/ProviderSignInModal";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { acpLoginCommand, acpProviderLabel } from "./providers/acpProviders";
import type { TerminalToolType } from "../../../shared/types";
import type { AiProviderConnections } from "../../../shared/types/config";
import { MUSE_LOGIN_COMMAND, PROVIDER_DISPLAY_NAME } from "../../../shared/providers";

/**
 * The terminal sign-in for a provider: the ACP CLIs' own login commands, and
 * Muse's `muse login`. Muse's runs as a `muse` terminal so the PTY host swaps
 * in that machine's pinned binary (ADE never runs a `muse` from PATH).
 */
function providerSignIn(id: SettingsProviderId): { command: string; label: string; toolType: TerminalToolType } | null {
  if (id === "muse") return { command: MUSE_LOGIN_COMMAND, label: PROVIDER_DISPLAY_NAME.muse, toolType: "muse" };
  const command = acpLoginCommand(id);
  return command ? { command, label: acpProviderLabel(id) ?? id, toolType: "shell" } : null;
}

/** The connection row a provider's sign-in writes. OpenCode has none of its own; its providers are inside it. */
function connectionKeyFor(id: SettingsProviderId): keyof AiProviderConnections | null {
  return id === "opencode" ? null : id;
}
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
import { isAdeAvailable } from "../../lib/adeAvailability";

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
 * The provider list: one ordered list of small tiles — the maker's logo on a
 * tile of its colour, the name, the one fact that matters (accounts and
 * models when it works, what is wrong when it does not), one status chip and,
 * when it needs one, one action. Each tile opens the provider's own page,
 * where the rest lives.
 */

/**
 * One provider tile.
 *
 * The whole tile is the open button, so its accessible name ("Open Claude
 * Code settings") covers the chip and the fact — a screen reader that lands
 * on it hears what a sighted reader sees. The one quick action (Sign in,
 * Download, Review) is a sibling button, never nested inside it.
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
  /** Folded away with "Not set up". */
  hidden?: boolean;
  onOpen: () => void;
}) {
  const status = providerStatusFor(descriptor, ctx);
  const models = descriptor.models(ctx);
  const version = normalizeProviderVersion(descriptor.version?.(ctx));
  // A count of zero while the probe is still out is a claim we cannot make.
  // A disabled provider's count is real but beside the point.
  // A connected provider reporting none yet uses its defaults; "0 models"
  // beside "Connected" reads as broken.
  const showModelCount = status.state !== "checking" && status.state !== "disabled"
    && !(status.state === "connected" && models.length === 0);

  // A provider in trouble says what is wrong; a healthy one what it has.
  const healthy = status.state === "connected";
  const problem = status.errorLine ?? (healthy ? null : status.message);
  const metaParts = [
    // Only when there is more than one: "1 account" is noise on every tile.
    ...(accountCount && accountCount > 1 ? [`${accountCount} accounts`] : []),
    ...(showModelCount ? [`${models.length} model${models.length === 1 ? "" : "s"}`] : []),
    ...(version && healthy ? [version] : []),
  ];
  // A provider that is not set up has nothing to say yet beyond its chip.
  const unset = status.state === "not-installed" || status.state === "disabled";
  const fact = unset
    ? null
    : problem ?? (metaParts.length > 0 ? metaParts.join(" · ") : healthy ? descriptor.credentialLine?.(ctx) ?? "Signed in" : null);

  const signInCommand = providerSignIn(descriptor.id)?.command ?? null;
  // A provider that is not set up is one whose pinned copy is not on this
  // machine yet: start (or retry) its download there and open the page,
  // which shows the progress.
  const { pin } = useSettingsMachineScope();
  const startDownload = () => {
    void window.ade?.ai?.pinnedToolDownload?.({ provider: descriptor.id }, pin).catch(() => undefined);
    onOpen();
  };
  const action = status.state === "sign-in"
    ? {
      label: "Sign in",
      aria: `Sign in to ${descriptor.label}`,
      run: () => (signInCommand ? ctx.actions.openSignInTerminal(descriptor.id) : onOpen()),
    }
    : status.state === "not-installed"
      ? { label: "Download", aria: `Download ${descriptor.label} for this machine`, run: startDownload }
      : status.state === "attention"
        ? { label: "Review", aria: `Review ${descriptor.label}`, run: onOpen }
        : null;
  const brand = providerBrand(descriptor.id);

  return (
    <div
      className="ade-pvl-tile"
      data-state={status.state}
      hidden={hidden}
      style={{ "--pvl-accent": brand.neutral ? "var(--color-fg)" : brand.accent } as React.CSSProperties}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${descriptor.label} settings`}
        className="ade-pvl-open"
      >
        <span className="ade-pvl-logo" aria-hidden>{providerListMark(descriptor, 30)}</span>
        <span className="ade-pvl-id">
          <span className="ade-pvl-name-row">
            <span className="ade-pvl-name" data-testid={`provider-tile-name-${descriptor.id}`}>
              {descriptor.label}
            </span>
            {descriptor.preview ? <PreviewChip /> : null}
          </span>
          {fact ? <span className="ade-pvl-fact" title={fact}>{fact}</span> : null}
        </span>
        <span className="kit-tag ade-pvl-chip" data-tone={PROVIDER_TAG_TONE[status.state]}>
          {status.label}
        </span>
      </button>
      {action ? (
        <button type="button" className="ade-pvl-action" aria-label={action.aria} onClick={action.run}>
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
 * The provider's mark with no box around it, for the list: the bare glyph in
 * its maker's colour (`ToolLogo`'s provider-mark look). The default logos are
 * app-icon avatars — a filled square or circle — which read as a box in a box
 * at this size. Devin's tool logo is its boxed app icon, so it takes the bare
 * Cognition glyph; a provider with no bare mark keeps its own logo.
 */
// Muse and Pi are left out: their own logos are already bare images (Meta's
// mark, the Pi glyph), and their masked provider-marks draw as a solid square.
const BARE_MARK_TOOLS: ReadonlySet<string> = new Set([
  "claude", "codex", "cursor", "droid", "copilot", "opencode", "qwen", "kimi", "grok",
]);

function providerListMark(descriptor: ProviderDescriptor, size: number): React.ReactNode {
  if (descriptor.id === "devin") return <DevinMark size={size} />;
  if (BARE_MARK_TOOLS.has(descriptor.id)) {
    return <ToolLogo toolType={descriptor.id as TerminalToolType} size={size} appearance="provider-mark" />;
  }
  return descriptor.logo(size);
}

/** The order inside the one list: what works, then what asks for something, then the rest. */
const STATE_ORDER: Record<ProviderDescriptorState, number> = {
  connected: 0,
  attention: 1,
  "sign-in": 2,
  checking: 3,
  "not-installed": 4,
  disabled: 5,
};
const UNSET_STATES: ReadonlySet<ProviderDescriptorState> = new Set(["not-installed", "disabled"]);

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
  // Until the first status lands every tile says Checking, and the list stays
  // in its given order rather than shuffling as answers arrive.
  if (ctx.status == null) {
    return <div className="ade-pvl-grid">{descriptors.map((descriptor) => card(descriptor))}</div>;
  }
  // One flat, keyed list in one parent — the divider included — so a tile
  // whose status lands is moved, not remounted, and keeps keyboard focus.
  const ordered = descriptors
    .map((descriptor, index) => ({ descriptor, index, state: providerStatusFor(descriptor, ctx).state }))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.index - b.index);
  const set = ordered.filter((row) => !UNSET_STATES.has(row.state));
  const unset = ordered.filter((row) => UNSET_STATES.has(row.state));
  // With nothing set up yet, there is nothing to fold away behind.
  const foldable = set.length > 0 && unset.length > 0;
  const open = !foldable || unsetOpen;
  // One array, so every tile stays the same element when the divider appears.
  const children: React.ReactNode[] = set.map((row) => card(row.descriptor));
  if (foldable) {
    children.push(
      <button
        key="unset-divider"
        type="button"
        className="ade-pvl-divider"
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} ${unset.length} providers that are not set up`}
        onClick={() => setUnsetOpen((value) => !value)}
      >
        <span className="ade-pvl-divider-label">Not set up</span>
        <span className="kit-num ade-pvl-divider-count">{unset.length}</span>
        {open ? null : (
          <span className="ade-pvl-divider-logos" aria-hidden>
            {unset.slice(0, 10).map((row) => <span key={row.descriptor.id}>{providerListMark(row.descriptor, 18)}</span>)}
          </span>
        )}
        <CaretDown size={11} weight="bold" className="ade-pvl-divider-caret" style={{ transform: open ? "rotate(180deg)" : undefined }} aria-hidden />
      </button>,
    );
  }
  for (const row of unset) children.push(card(row.descriptor, !open));
  return <div className="ade-pvl-grid">{children}</div>;
}

/** "12 coding agents — 3 ready, 2 need you", or "Checking…" before the first answer. */
function providerSummary(descriptors: ProviderDescriptor[], ctx: ProvidersViewContext): string {
  if (ctx.status == null) return `${descriptors.length} coding agents — checking…`;
  const states = descriptors.map((descriptor) => providerStatusFor(descriptor, ctx).state);
  const ready = states.filter((state) => state === "connected").length;
  const asking = states.filter((state) => state === "sign-in" || state === "attention").length;
  return [
    `${descriptors.length} coding agents`,
    [`${ready} ready`, asking > 0 ? `${asking} need${asking === 1 ? "s" : ""} you` : null].filter(Boolean).join(", "),
  ].join(" — ");
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
      ...Object.keys(authMethods ?? {}).filter((id) => authMethods?.[id]?.some((m) => m.type !== "api")),
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
    if (!isAdeAvailable(read)) return;
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
    if (!isAdeAvailable(read)) {
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

  const openSignInTerminal = useCallback((provider: SettingsProviderId) => {
    if (!providerSignIn(provider)) return;
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

  const signIn = signInProvider ? providerSignIn(signInProvider) : null;

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
        <section className="ade-pvl" id="ai-providers" data-settings-anchor="ai-providers" data-settings-group="Connections">
          <header className="ade-pvl-head">
            <span className="ade-pvl-summary">
              {providerSummary(descriptors, ctx)}
            </span>
            <label className="ade-pv-usage-toggle">
              Show usage in header
              <SettingsToggle
                label="Show usage in header"
                checked={usageHeaderPreferences.showInHeader}
                onChange={(next) => setUsageHeaderVisible(next)}
              />
            </label>
          </header>
          <ProviderGrid
            descriptors={descriptors}
            ctx={ctx}
            accountCounts={accountCounts as Partial<Record<string, number>>}
            onOpen={selectProvider}
          />
        </section>
      )}

      {selectedDescriptor ? null : <CustomProvidersSection status={status} storedProviders={storedProviders} />}

      {signInProvider && signIn ? (
        <ProviderSignInModal
          runtimePin={pin}
          providerId={signInProvider}
          providerLabel={signIn.label}
          command={signIn.command}
          toolType={signIn.toolType}
          onClose={() => {
            setSignInProvider(null);
            void refreshStatus({ force: true, silent: true });
          }}
          onSignedIn={() => {
            setNotice(`Signed in to ${signIn.label}.`);
            invalidateAiDiscoveryCache();
          }}
          checkSignedIn={async () => {
            const next = await refreshStatus({ force: true, silent: true });
            // `authAvailable` is the disk credential the login just wrote —
            // that is the moment worth closing on. `runtimeAvailable` also
            // waits on the protocol probe, which is right for the tile and too
            // slow for a dialog someone is watching.
            const key = connectionKeyFor(signInProvider);
            return key !== null && next?.providerConnections?.[key]?.authAvailable === true;
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
