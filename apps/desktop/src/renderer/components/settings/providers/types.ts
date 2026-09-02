/**
 * The descriptor contract behind Settings → Agents & Models.
 *
 * Every provider used to be its own hand-written block of JSX inside
 * `ProvidersSection`, which is why the six had six different ideas of what a
 * status word means and why adding a seventh meant copying four hundred lines.
 * A provider is now a *descriptor*: what it is called, how to read its status
 * out of the one status payload, what facts its tile shows, and — only for the
 * genuinely bespoke flows — a body component for its detail page.
 *
 * Adding a provider is adding a descriptor. Nothing else in this folder should
 * need to know a provider's name.
 */

import type React from "react";
import type {
  AcpProviderDiagnostics,
  AiApiKeyVerificationResult,
  AiSettingsStatus,
  CursorSdkAuthStatus,
  ProjectConfigSnapshot,
} from "../../../../shared/types";
import type { AgentChatPermissionMode } from "../../../../shared/types";
import type {
  AiProviderPermissions,
  OpenCodeProviderAuthMethods,
} from "../../../../shared/types/config";
import type { LocalProviderFamily } from "../../../../shared/modelRegistry";
import type { AcpProviderId } from "../../../../shared/acpProviderMetadata";
import type { ApiKeySource, OpenCodeProviderDetail } from "../OpenCodeProviderDetailModal";

/** Every provider with a tile and a page. Same ids as `ModelProviderGroup`. */
export type SettingsProviderId =
  | "claude"
  | "codex"
  | "cursor"
  | "droid"
  | "pi"
  | "opencode"
  | "qwen"
  | "kimi"
  | "grok"
  | "copilot";

/** The four providers ADE drives over the Agent Client Protocol. */
export type AcpSettingsProviderId = AcpProviderId;

/**
 * The six words a tile is allowed to say.
 *
 * `checking` is first-class and distinct from `not-installed`: a status probe
 * that has not answered yet is not the same claim as "this is not on your
 * machine", and presenting the first as the second is how a slow first probe
 * used to tell people to reinstall a working CLI.
 */
export type ProviderStatusState =
  | "checking"
  | "connected"
  | "sign-in"
  | "attention"
  | "not-installed"
  | "disabled";

export type ProviderStatusView = {
  state: ProviderStatusState;
  /** The one word (or two) next to the dot. */
  label: string;
  /** The sentence under the name on the detail page. */
  message: string;
  /**
   * The raw enumerate/probe failure, if there is one. The model list IS the
   * health check, so this is the only error surface — there is no Verify.
   */
  errorLine?: string | null;
};

export type ProviderFact = {
  label: string;
  value: string;
  /** Paths and commands only. */
  mono?: boolean;
};

/** Everything a descriptor, tile, or body can read or do. */
export type ProvidersViewContext = {
  status: AiSettingsStatus | null;
  projectConfigSnapshot: ProjectConfigSnapshot | null;
  loading: boolean;
  statusLoadError: string | null;
  /** True until the first status payload lands — the "Checking…" gate. */
  isInitialCheckInFlight: boolean;

  storedProviders: string[];
  apiKeySources: Map<string, ApiKeySource>;
  hasKeyFor: (providerId: string) => boolean;
  verificationByProvider: Record<string, AiApiKeyVerificationResult>;
  verifyingProvider: string | null;
  editingProvider: string | null;
  editValue: string;

  cursorAuth: CursorSdkAuthStatus | null;
  cursorLoginBusy: boolean;
  cursorLoginUrl: string | null;

  authMethods: OpenCodeProviderAuthMethods | null;
  authMethodsError: string | null;
  openCodeCatalog: OpenCodeProviderDetail[];
  connectedOpenCodeProviders: OpenCodeProviderDetail[];
  popularOpenCodeProviders: OpenCodeProviderDetail[];
  searchableOpenCodeProviders: OpenCodeProviderDetail[];
  providerSearch: string;
  refreshingCatalog: boolean;

  localRuntimes: LocalRuntimeRow[];
  localProviderDrafts: Record<LocalProviderFamily, LocalProviderDraft>;
  editingLocalProvider: LocalProviderFamily | null;
  savingLocalProvider: LocalProviderFamily | null;

  customProviderDraft: CustomProviderDraft;
  customModelSlugs: string;
  savingAdvanced: boolean;

  /** Providers switched off in `ai.disabledProviders`. */
  disabledProviders: ReadonlySet<string>;
  savingDisabledFor: SettingsProviderId | null;

  /**
   * Per-provider CLI facts, loaded when a detail page opens.
   *
   * Absent means "not asked yet", which is why this is a partial record rather
   * than a record of nullable values: the page must be able to tell "no version
   * reported" from "we have not looked".
   */
  acpDiagnostics: Partial<Record<AcpSettingsProviderId, AcpProviderDiagnostics>>;
  acpDiagnosticsBusy: AcpSettingsProviderId | null;
  acpDoctorBusy: AcpSettingsProviderId | null;
  acpDiagnosticsError: Partial<Record<AcpSettingsProviderId, string>>;

  /** Abstract permission defaults as persisted in `ai.permissions.providers`. */
  permissionDefaults: AiProviderPermissions;
  savingPermissionFor: SettingsProviderId | null;
  defaultModelId: string | null;
  savingDefaultModel: boolean;

  actions: ProvidersActions;
};

export type ProvidersActions = {
  refreshStatus: (options?: {
    force?: boolean;
    silent?: boolean;
    refreshOpenCodeInventory?: boolean;
  }) => Promise<AiSettingsStatus | null>;
  loadAuthMethods: () => Promise<void>;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;

  beginEditing: (provider: string) => void;
  cancelEditing: () => void;
  setEditValue: (value: string) => void;
  deleteApiKey: (provider: string, options?: { alsoOpenCode?: boolean }) => Promise<void>;
  verifyApiKey: (provider: string) => Promise<void>;

  saveCursorApiKey: () => Promise<void>;
  loginWithCursor: () => Promise<void>;
  logoutCursor: () => Promise<void>;
  cancelCursorLogin: () => Promise<void>;

  setProviderSearch: (value: string) => void;
  refreshCatalog: () => Promise<void>;
  openOpenCodeProviderDetail: (id: string) => void;

  updateLocalProviderDraft: (provider: LocalProviderFamily, patch: Partial<LocalProviderDraft>) => void;
  beginEditingLocalRuntime: (provider: LocalProviderFamily) => void;
  cancelEditingLocalRuntime: () => void;
  saveLocalProvider: (provider: LocalProviderFamily) => Promise<void>;

  setCustomProviderDraft: React.Dispatch<React.SetStateAction<CustomProviderDraft>>;
  setCustomModelSlugs: (value: string) => void;
  saveAdvancedProvider: () => Promise<void>;
  saveCustomModelSlugs: () => Promise<void>;

  setPermissionDefault: (provider: SettingsProviderId, mode: AgentChatPermissionMode) => Promise<void>;
  setDefaultModel: (modelId: string | null) => Promise<void>;

  revealClaudeLoginTerminal: (terminal: { terminalId: string; laneId: string }) => void;

  /** Flip a provider off (or back on). Writes the whole `disabledProviders` list. */
  setProviderDisabled: (provider: SettingsProviderId, disabled: boolean) => Promise<void>;
  /** Read binary path, config home, version, and last probe verdict. Spawns. */
  loadAcpDiagnostics: (provider: AcpSettingsProviderId) => Promise<void>;
  /** Run the vendor's own `doctor` and fold the output into the diagnostics. */
  runAcpDoctor: (provider: AcpSettingsProviderId) => Promise<void>;
  /** Open the embedded terminal that runs this provider's login command. */
  openSignInTerminal: (provider: SettingsProviderId) => void;
};

/**
 * The first status probe finished without a payload. Tiles must not stay on
 * Checking… after that — that reads as a hang, not a failed load.
 */
export function statusProbeFailed(
  ctx: Pick<ProvidersViewContext, "isInitialCheckInFlight" | "loading" | "statusLoadError">,
): boolean {
  return ctx.isInitialCheckInFlight && !ctx.loading && ctx.statusLoadError != null;
}

export type LocalProviderDraft = {
  enabled: boolean;
  endpoint: string;
  autoDetect: boolean;
  preferredModelId: string;
};

export type LocalRuntimeRow = {
  provider: LocalProviderFamily;
  label: string;
  description: string;
  endpoint: string;
  health: string | null;
  blocker: string | null;
  runtimeAvailable: boolean;
  detected: { type: "local"; provider: LocalProviderFamily; endpoint: string } | null;
  modelIds: string[];
  hasModels: boolean;
};

export type CustomProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  npm: string;
  slugs: string;
  apiKey: string;
};

/** A model row on a detail page. */
export type ProviderModelRow = {
  id: string;
  label: string;
  /** The provider's own curated default, marked with a star. */
  isDefault?: boolean;
  description?: string;
};

export type ProviderDescriptor = {
  id: SettingsProviderId;
  label: string;
  /** One plain line under the name. */
  tagline: string;
  logo: (size: number) => React.ReactNode;
  /** Settings-only tier label. Unused by the six; the ACP previews will set it. */
  preview?: boolean;
  /** Platforms where the provider cannot run at all hide the whole card. */
  isAvailable?: () => boolean;

  /** Which `getPermissionOptions` table this provider's abstract modes come from. */
  permissions: { family: string; isCliWrapped: boolean; key: keyof AiProviderPermissions };

  status: (ctx: ProvidersViewContext) => ProviderStatusView;
  /** Models ADE can offer for this provider right now. */
  models: (ctx: ProvidersViewContext) => ProviderModelRow[];
  /** Version string when the provider reports one. No update-available surface. */
  version?: (ctx: ProvidersViewContext) => string | null;
  /** Left-rail identity rows (binary path, config files, credential source). */
  facts?: (ctx: ProvidersViewContext) => ProviderFact[];
  /**
   * Two or three words for where a working provider's credential came from —
   * "CLI subscription", "API key", "OAuth", "Signed in".
   *
   * This is what a connected tile shows in the slot a broken tile uses for its
   * error, so the grid stays one shape. Null when the payload does not actually
   * say; an empty slot is honest and a guess is not.
   */
  credentialLine?: (ctx: ProvidersViewContext) => string | null;

  /**
   * Extra rows under Troubleshooting — the vendor `doctor` button, for the two
   * providers that ship one.
   */
  Diagnostics?: React.ComponentType<{ ctx: ProvidersViewContext }>;
  /** Sign in / sign out / key entry. Rendered in the left rail. */
  AuthActions?: React.ComponentType<{ ctx: ProvidersViewContext }>;
  /** The bespoke flow — Pi's catalog, OpenCode's catalog, Cursor's key field. */
  Body?: React.ComponentType<{ ctx: ProvidersViewContext }>;
};
