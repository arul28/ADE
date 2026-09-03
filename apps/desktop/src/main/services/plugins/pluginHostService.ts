import fs from "node:fs";
import path from "node:path";

import {
  setPluginActionInvoker,
  setPluginAuthSessionCompleter,
  setPluginInstallService,
} from "../../../../../ade-cli/src/services/plugins/pluginInstallServiceRef";
import { setPluginPageHostService } from "../../../../../ade-cli/src/services/plugins/pluginPageHostRef";
import { getPluginPresenceService } from "../../../../../ade-cli/src/services/plugins/pluginPresenceService";
import type { PluginSyncMeter } from "../../../../../ade-cli/src/services/plugins/pluginSyncMeter";
import {
  deletePluginPresenceForPlugin,
  readAllPluginPresence,
  readPluginContributions,
  type PluginPresenceRow,
} from "../../../../../ade-cli/src/services/plugins/pluginTableWriters";
import {
  createPluginRegistryService,
  type PluginRegistryService,
} from "../../../../../ade-cli/src/services/plugins/pluginRegistryService";
import { getApiKey } from "../ai/apiKeyStore";
import type { AgentChatRuntimeRef } from "../../../shared/types/chat";
import type { IssueRef } from "../../../shared/issueRef";
import type {
  IssueLink,
  IssueLinkRole,
  IssueLinkSource,
  LaneSummary,
} from "../../../shared/types/lanes";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import {
  findPluginChatRuntime,
  isPluginBuiltinSurfaceId,
  parsePluginManifestJson,
  pluginHasRuntimeEntry,
  pluginPanelShowsOnMobile,
  type PluginManifest,
  type PluginManifestChatRuntime,
  type PluginManifestSetting,
  type PluginManifestWebhookIngressChannel,
  type PluginProviderKeyId,
} from "../../../shared/plugins/manifest";
import { nowIso, writeTextAtomic } from "../shared/utils";
import { isRecord } from "../../../shared/plugins/parse";
import { pluginActionIsFullyDisabled } from "../../../shared/plugins/disabledContributions";
import {
  assertPluginCollectionKey,
  assertPluginCollectionName,
  isPluginEventName,
  isPluginPushEventName,
  isPluginRuntimeHookName,
  pluginInvokeActionMissingMessage,
  readPluginInvokeAction,
  PluginSdkError,
  type PluginActionInvokeRecord,
  type PluginAudioClip,
  type PluginChangeEventName,
  type PluginPrTransition,
  type PluginRuntimeHookName,
  type PluginRuntimeHookPayload,
  type PluginCollectionRow,
  type PluginContributionRecord,
  type PluginDetail,
  type PluginDomainService,
  type PluginFilePickerOptions,
  type PluginLogEntry,
  type PluginMarketplaceIndex,
  type PluginNotificationResult,
  type PluginNotificationTargetRequest,
  type PluginPanelRecord,
  type PluginPresenceMachineRow,
  type PluginRuntimeStatus,
  type PluginSourceInspection,
  type PluginSummary,
  type PluginUsageSummary,
  type PluginPushEventName,
  type PluginWebhookIngressStatus,
  type PluginWebhookPayload,
  pluginChatDeliveryAction,
  hasPluginActionAuthSessionRequest,
  isReservedPluginActionName,
  PLUGIN_BRAND_ICONS_COLLECTION,
  readPluginActionAuthSessionRequest,
  reservedPluginActionMessage,
  type PluginChatRuntimeEventName,
  type PluginChatRuntimeEventPayload,
} from "../../../shared/plugins/sdk";
import {
  PLUGIN_SURFACE_IDS,
  clampPluginInvokeTimeoutMs,
  isPluginEntityKind,
  isPluginSocketKind,
  isPluginSurfaceId,
} from "../../../shared/plugins/sockets";
import { createPluginDataStore, type PluginDataStore } from "./pluginDataStore";
import { createPluginChildSupervisor, type PluginChildSupervisor } from "./pluginChildSupervisor";
import { emitPluginChange, subscribeToPluginChanges } from "./pluginEvents";
import { subscribeToPluginRuntimeHooks, type PluginRuntimeHookEmission } from "./pluginRuntimeHooks";
import {
  subscribeToPluginEntityChanges,
  type PluginEntityChangeFamily,
} from "./pluginEntityChanges";
import { createPluginInstallService, type PluginInstalledPlugin, type PluginInstallService } from "./pluginInstallService";
import { loadPluginBrandIcons } from "./pluginBrandIconLoader";
import { createPluginInstallServiceAdapter, toPluginPresenceRow } from "./pluginInstallServiceAdapter";
import {
  createPluginSdkServer,
  pluginAudioCaptureUnavailable,
  pluginCredentialHandoffUnavailable,
  pluginAutomationsUnavailable,
  pluginChatUnavailable,
  pluginLanesUnavailable,
  pluginWebhookIngressUnavailable,
  pluginDesktopUnavailable,
  pluginNotificationUnavailable,
} from "./pluginSdkServer";
import {
  findPluginChatRuntimeWriterForProjectRoot,
  requirePluginChatWriteTarget,
  setPluginChatRuntimeDelivery,
} from "../chat/pluginChatRuntime";
import { createPluginNotificationLimiter } from "./pluginNotificationLimiter";
import { createPluginScheduleService } from "./pluginScheduleService";
import { createPluginSecretStore, type PluginSecretStore } from "./pluginSecretStore";
import { createPluginAuthSessionService } from "./pluginAuthSessionService";
import {
  createPluginCredentialHandoffService,
  type PluginCredentialHandoffService,
} from "./pluginCredentialHandoff";
import { officialOAuthClientForPlugin } from "./pluginOfficialClients";
import { resolvePluginsRoot } from "./pluginRegistryFile";
import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";

/**
 * Where the host remembers whether a plugin was already offered a built-in
 * credential.
 *
 * Beside the install registry rather than inside the plugin's own directory,
 * for the reason the settings file gives below: a plugin's directory is
 * replaced wholesale on upgrade, and an upgrade must not turn into a second
 * consent card for a handoff the user already answered.
 */
const PLUGIN_CREDENTIAL_HANDOFF_STATE_FILE = "credential-handoff.json";

/**
 * Machine-scoped per-plugin settings values, for every installed plugin.
 *
 * ONE file beside the install registry, not one inside each plugin: a plugin's
 * directory IS its git checkout, which `plugin install` replaces wholesale on
 * upgrade, and settings the user typed must survive that. `plugin.setConfig`
 * writes it; `sdk.config.get()` and the settings UI read it back through
 * {@link effectiveConfig}, which layers stored values over manifest defaults.
 */
const PLUGIN_CONFIG_FILE = "config.json";

/**
 * Per-plugin notification counters, beside the install registry for the same
 * reason {@link PLUGIN_CONFIG_FILE} is: the ceiling is per plugin per machine,
 * and a file inside a plugin's own directory would be erased by the upgrade
 * that replaces that directory — handing a plugin a fresh allowance for the
 * cost of publishing a patch release.
 */
const PLUGIN_NOTIFICATION_USAGE_FILE = "notification-usage.json";

/** Plugin-owned schedules. Machine-scoped, and survives a plugin upgrade. */
const PLUGIN_SCHEDULES_FILE = "schedules.json";

/**
 * How long the host waits for a plugin to DISPATCH a turn.
 *
 * Longer than the default action budget because a conversation runtime is
 * usually a network call to somebody else's API, and short enough that a
 * wedged plugin fails the turn while the user is still looking at it. It is
 * not the budget for the ANSWER: the plugin is expected to return as soon as it
 * has handed the message off and stream the reply back through
 * `ade.chat.appendAssistant`, which has no timeout at all because the host is
 * not waiting on it.
 */
const PLUGIN_CHAT_TURN_DISPATCH_TIMEOUT_MS = 120_000;

/**
 * How long the host waits for a plugin to acknowledge a stop.
 *
 * Much shorter than a dispatch. The user pressed stop; a runtime that cannot
 * say "cancelling" within half a minute has already failed at the thing stop
 * asks for, and reporting that beats a spinner on the stop button.
 */
const PLUGIN_CHAT_INTERRUPT_TIMEOUT_MS = 30_000;

export type PluginProjectBinding = {
  projectId: string;
  projectRoot: string;
  db: AdeDb;
  invokeAdeAction: (
    domain: string,
    action: string,
    args: Record<string, unknown>,
    /**
     * Which plugin is calling, as the HOST knows it — resolved from the
     * supervisor that owns the child socket, never from the call's arguments.
     * The bridge uses it for anything that must be attributed rather than
     * merely permitted (`chat.emitAdeCard` stamps it onto the card), and for
     * the one thing that must be PERMITTED against the manifest rather than
     * against the verb alone (`projectSecrets`).
     */
    caller: {
      pluginId: string;
      displayName?: string | null;
      /**
       * `manifest.projectSecrets` — the project secret names this plugin
       * declared and the user approved at install.
       *
       * Read from the manifest the host parsed, never from the call. Absent
       * reads as "declared none", so a caller that has not been taught about
       * this field is refused rather than trusted.
       */
      projectSecrets?: readonly string[];
    },
  ) => Promise<unknown>;
  /**
   * Per-plugin wire accounting for this project's sync host. Optional: a scope
   * with no sync host reports storage usage and zero wire bytes, which is the
   * truth rather than a gap.
   */
  syncMeter?: PluginSyncMeter | null;
  /** Pushes plugin panels to subscribed peers now instead of on the next poll. */
  onPluginDataChanged?: () => void;
  /**
   * Hand a plugin's fired trigger to THIS project's automation engine.
   *
   * Per-project rather than machine-scoped because a rule is per-project: it is
   * authored in this project's `ade.yaml` and its steps run against this
   * project's lanes. Optional, so a bootstrap with automations disabled binds
   * as it always did and the SDK verb refuses instead of silently succeeding.
   */
  emitAutomationTrigger?: (args: {
    pluginId: string;
    triggerId: string;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  /**
   * This project scope's webhook drain — `pluginWebhookIngressService`.
   *
   * Bound rather than constructed here for the reason `emitAutomationTrigger`
   * is: the drain needs a project database, and the host outlives every project
   * that attaches to it. The drain in turn reads the host's install roster and
   * writes into the host's children, so the two are built as a pair by whoever
   * owns the project scope (`main.ts`, `bootstrap.ts`).
   *
   * Optional. A scope with no drain answers `sdk.webhooks.*` with
   * `unsupported_method`, which is the honest reading — a plugin should stop
   * waiting for events that will never arrive rather than retry forever.
   */
  webhookIngress?: {
    ack: (pluginId: string, deliveryId: string) => void;
    urlFor: (pluginId: string, channelId: string) => string | null;
    getStatus: (pluginId?: string) => Promise<PluginWebhookIngressStatus[]>;
  };
  /**
   * This project's lane service, for `ade.lanes.*`.
   *
   * Structurally the subset of `laneService` the SDK needs, so the scope owner
   * passes the service itself. Bound per project rather than resolved here for
   * the reason `emitAutomationTrigger` is: a lane belongs to a project, the
   * host outlives every project that attaches to it, and a captured service
   * would keep linking issues onto lanes in a project the user has closed.
   *
   * Optional. A scope that binds none answers `ade.lanes.*` with
   * `unsupported_method` rather than a silent success — see
   * {@link pluginLanesUnavailable}.
   */
  lanes?: {
    list: (args?: { includeArchived?: boolean; includeStatus?: boolean }) => Promise<LaneSummary[]>;
    getSummary: (
      laneId: string,
      options?: { includeStatus?: boolean },
    ) => Promise<LaneSummary | null>;
    listIssueLinks: (args: { laneId?: string; sessionId?: string }) => IssueLink[];
    listIssueLinksForLaneSessions: (args: { laneId: string }) => IssueLink[];
    linkIssueRef: (args: {
      laneId?: string;
      sessionId?: string;
      issue: IssueRef;
      role?: IssueLinkRole;
      source?: IssueLinkSource;
      includeInPr?: boolean;
      closeOnMerge?: boolean;
    }) => IssueLink;
    unlinkIssueRef: (args: {
      laneId?: string;
      sessionId?: string;
      provider: string;
      issueId: string;
      requirePluginId?: string;
    }) => boolean;
  };
};

export type PluginHostServiceArgs = {
  logger: Logger;
  pluginsRoot?: string;
  adeVersion?: string | null;
  /**
   * Builds a plugin's child supervisor. Injected only by tests: the host starts
   * every enabled plugin on its own now, and a unit test that installs a
   * fixture must be able to prove the host asked without spawning node.
   */
  createSupervisor?: typeof createPluginChildSupervisor;
} & PluginMachineContext;

/**
 * The machine-identity half of the host's dependencies, supplied AFTER
 * construction.
 *
 * The host is built early in bootstrap — the resource sampler and the action
 * registry both need it — while the machine identity and the push-relay state
 * file are established much later in the same startup. Rather than move either,
 * the host starts without them and learns them when they exist; every consumer
 * reads through the current value, so nothing captures a stale one.
 */
export type PluginMachineContext = {
  localMachineKey?: () => string | null;
  listAccountMachines?: () => Promise<{ machineKey: string; label?: string | null; online?: boolean }[] | null>;
  reportInstall?: (install: { pluginId: string; version: string }) => void | Promise<void>;
  /**
   * Drop the third-party account connection a plugin owned, on uninstall.
   *
   * A plugin is the whole vertical, and the account link is part of it: with
   * `ade-linear` gone there is no pane to read the issues, no action domain to
   * write them and no skill to explain them, so a stored Linear token would be
   * a credential on disk with nothing left that can use it. The uninstall
   * dialog says so before the user commits.
   *
   * Supplied late, like the rest of this bag, because the credential services
   * are built well after the host.
   */
  disconnectAccountsForPlugin?: (pluginId: string) => void | Promise<void>;
  /**
   * Record a clip through ADE's microphone, for `ade.audio.captureClip`.
   *
   * In this bag rather than in the constructor because the host is machine-
   * scoped and built early, while the capability arrives from a desktop that
   * may attach later, or never: a daemon on a headless machine has no window
   * to record from, and a plugin asking there gets
   * {@link pluginAudioCaptureUnavailable} instead of a call that hangs.
   */
  captureAudioClip?: (args: {
    pluginId: string;
    label: string;
    maxDurationMs?: number;
  }) => Promise<PluginAudioClip>;
  /**
   * Show a notification for `ade.notifications.post`.
   *
   * Supplied late like the rest of this bag because the two things that can
   * show one — the push publisher and an attached desktop — are both built well
   * after the host. The RATE LIMIT is not the supplier's job: it is applied
   * here, before this is called, so every route into notifications counts
   * against one ceiling rather than each supplier keeping its own.
   */
  postNotification?: (args: {
    pluginId: string;
    label: string;
    title: string;
    body?: string;
    target: PluginNotificationTargetRequest;
    /** Already validated as one of THIS plugin's own panel links, or absent. */
    deeplink?: string;
  }) => Promise<PluginNotificationResult>;
  /**
   * The Electron-only SDK verbs, when a desktop is attached to lend them.
   *
   * Absent reads as `desktop_unavailable`, which is a refusal a plugin can act
   * on: unlike a missing scheduler, a missing desktop can appear later.
   */
  desktopHost?: {
    readClipboard: () => Promise<string>;
    writeClipboard: (text: string) => Promise<void>;
    pickFile: (options: PluginFilePickerOptions) => Promise<string>;
  };
  /**
   * ADE's own machine credential store, for the one-time credential handoff.
   *
   * In this bag for the same reason `disconnectAccountsForPlugin` is: the
   * credential services are built long after the host, and on a machine where
   * they never are (a CLI with no secrets directory) the honest answer is that
   * there is nothing to hand over. Absent makes `ade.auth.requestHandoff`
   * answer `auth_unavailable` rather than reporting an empty connection, which
   * are very different things to tell a plugin on release day.
   */
  builtinCredentials?: SyncCredentialStore;
  /**
   * Put the handoff consent card in front of a person, and answer yes or no.
   *
   * A capability rather than a call into the chat approval machinery, because
   * a handoff is asked for by a plugin — usually from a Connect button in a
   * panel — and there is no chat session to raise a card in. The COPY is still
   * shared and derived (`pluginCredentialHandoff.ts` builds the title and body
   * from the descriptor and the parsed manifest, never from plugin arguments);
   * only the presentation is the client's.
   *
   * Absent means nothing here can ask, which is `auth_unavailable`. It must
   * never default to yes: this card is the only thing standing between a
   * plugin and a credential the user gave to ADE.
   */
  requestCredentialHandoffConsent?: (args: {
    pluginId: string;
    displayName: string;
    builtin: string;
    title: string;
    body: string;
  }) => Promise<boolean>;
};

/** Page failures kept per plugin. See {@link PluginHostService.recordPageError}. */
export const PLUGIN_PAGE_ERROR_RING_MAX = 50;

/**
 * Two log rings as one list, oldest first.
 *
 * Merged rather than concatenated because the reader is scanning for a cause
 * and a page error that arrived between two child lines belongs between them.
 * `at` is an ISO string on both sides, so a lexical compare is a time compare;
 * an unparseable timestamp sorts last rather than throwing, because a log with
 * one odd line is still the log.
 */
export function mergePluginLogs(
  childLogs: readonly PluginLogEntry[],
  pageLogs: readonly PluginLogEntry[],
): PluginLogEntry[] {
  if (pageLogs.length === 0) return [...childLogs];
  return [...childLogs, ...pageLogs].sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
}

export type PluginHostService = {
  attachProject(binding: PluginProjectBinding): { detach(): void };
  /**
   * Installed, enabled plugins that declare webhook channels — what the drain
   * polls for.
   *
   * Read from the host rather than from the install registry directly because
   * the answer has to follow an enable, a disable and a reload without the
   * drain being rebuilt, and the host is the one place that knows all three.
   */
  listWebhookIngressPlugins(): { pluginId: string; channels: PluginManifestWebhookIngressChannel[] }[];
  /**
   * Hand one webhook to a plugin's child. False when nobody could take it —
   * the child is not running, or it never subscribed to `webhook.received`.
   *
   * A false answer is NOT a delivery failure and the drain must not charge an
   * attempt for it. See `pluginWebhookIngressService`'s `deliver` contract.
   */
  deliverWebhookEvent(pluginId: string, payload: PluginWebhookPayload): boolean;
  /**
   * The machine plugin secret store, for the webhook drain.
   *
   * Handed out rather than re-created by the caller because there must be
   * exactly ONE writer of the per-plugin secret-name index: two
   * `EncryptedFileCredentialStore` instances over the same file would race on
   * it, and a lost index entry is a secret an uninstall never sweeps.
   *
   * Narrowed to `get`/`set` deliberately. The drain generates and reads the
   * relay registration secret and reads a channel's declared `verify` secret;
   * it has no business deleting a plugin's secrets or enumerating them.
   */
  secretsForWebhookIngress(): Pick<PluginSecretStore, "get" | "set">;
  /**
   * The phone's door for a sign-in it presented — see
   * `pluginAuthSessionService.completeAppCallback`.
   *
   * The caller passes ONLY the callback parameters. It names no plugin and no
   * session, because the host routes by the `state` it minted itself: a caller
   * that could name a session could address a flow it did not start, and the
   * one thing this seam must guarantee is that an authorization code reaches
   * the plugin that asked for it and no other.
   */
  completeAuthSessionCallback(params: Record<string, string>): { ok: boolean; reason?: string };
  /** Supply (or replace) the machine identity. Merged over what is already set. */
  setMachineContext(context: PluginMachineContext): void;
  /** The `plugin` action-domain service, scoped to one project (null = machine). */
  domainService(projectId: string | null): PluginDomainService;
  /**
   * A plugin's install directory, for an installed AND enabled plugin only.
   *
   * Null-returning rather than throwing: the caller is the `ade-plugin://`
   * protocol handler, where "no such plugin" and "disabled plugin" are ordinary
   * answers that both come out as a 404. Enabled is part of the question on
   * purpose — disabling a plugin has to close its pages, not leave a live origin
   * serving its files with nothing in the UI to show for it.
   */
  rootFor(pluginId: string): string | null;
  /**
   * Write one collection row on a plugin's behalf, for the webview bridge.
   *
   * Not a `plugin` domain action: `PLUGIN_DOMAIN_ACTIONS` is closed and mirrored
   * by the RPC schema and iOS's allowlist, so a write action there would let any
   * client write any plugin's rows. This is reachable only from a guest whose
   * plugin id the host derived from its own origin, and it applies the same
   * declared-collection rule `pluginSdkServer.ts` applies to a plugin's child.
   */
  writeCollection(args: { pluginId: string; collection: string; key: string; value: unknown }): void;
  /**
   * Write a plugin's own declared settings on its behalf, for the webview
   * bridge. Same reasoning as {@link writeCollection}: not a `plugin` domain
   * action, reachable only from a guest whose plugin id the host derived from
   * its own origin, and it applies the same manifest validation a child's
   * `ade.config.set` gets — including the refusal of `secret` settings.
   *
   * Does NOT restart the plugin. Returns the new effective config.
   */
  writeConfig(args: {
    pluginId: string;
    values: Record<string, unknown>;
  }): Record<string, string | number | boolean | null>;
  /**
   * Record that one of this plugin's PAGES failed, so the doctor can say so.
   *
   * A CSP violation is the case that forces it: a page whose bundle reaches
   * outside the plugin's own directory is refused silently by the browser, and
   * the author sees a blank frame with nothing anywhere naming the cause. The
   * line lands in the same ring `ade plugin logs` prints and `ade plugin
   * doctor` counts, so the finding survives the guest that produced it.
   *
   * Kept per plugin and independent of the child: a page can fail on a machine
   * where the plugin's child has never started, and a report that needed a
   * supervisor would be dropped exactly then.
   */
  recordPageError(args: {
    pluginId: string;
    kind: string;
    message: string;
    source?: string;
  }): void;
  /** Child pids for the resource sampler's "plugin-host" role. */
  listChildPids(): number[];
  skillRoots(): string[];
  /** This machine's install state, as the presence service publishes it. */
  listPresenceRows(): PluginPresenceRow[];
  dispose(): Promise<void>;
};

type AttachedProject = {
  binding: PluginProjectBinding;
  data: PluginDataStore;
  attachCount: number;
};

function readStoredConfig(pluginsRoot: string): Record<string, Record<string, string | number | boolean | null>> {
  try {
    const decoded = JSON.parse(fs.readFileSync(path.join(pluginsRoot, PLUGIN_CONFIG_FILE), "utf8")) as unknown;
    if (!isRecord(decoded) || !isRecord(decoded.config)) return {};
    const config: Record<string, Record<string, string | number | boolean | null>> = {};
    for (const [pluginId, values] of Object.entries(decoded.config)) {
      if (!isRecord(values)) continue;
      const entry: Record<string, string | number | boolean | null> = {};
      for (const [key, value] of Object.entries(values)) {
        if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          entry[key] = value;
        }
      }
      config[pluginId] = entry;
    }
    return config;
  } catch {
    return {};
  }
}

/**
 * Replace the whole settings file.
 *
 * Atomic because one file holds every plugin's settings: this is read at every
 * child spawn, and a torn write reads back as `{}` — every plugin on the machine
 * losing its configuration at once, with no error anywhere to explain it.
 */
function writeStoredConfig(
  pluginsRoot: string,
  config: Record<string, Record<string, string | number | boolean | null>>,
): void {
  fs.mkdirSync(pluginsRoot, { recursive: true });
  writeTextAtomic(path.join(pluginsRoot, PLUGIN_CONFIG_FILE), `${JSON.stringify({ version: 1, config }, null, 2)}\n`);
}

/**
 * Bring one submitted value to the type its setting declares.
 *
 * A `number` setting that stores the string "8080" reads back as a string in
 * the plugin, which is a bug the plugin cannot defend against — the manifest
 * promised it a number.
 */
function coerceSettingValue(setting: PluginManifestSetting, value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (setting.kind === "toggle") {
    if (typeof value === "boolean") return value;
    throw new PluginSdkError("invalid_args", `Setting "${setting.key}" expects true or false.`);
  }
  if (setting.kind === "number") {
    const parsed = typeof value === "number" ? value : Number(value);
    if (typeof value !== "number" && typeof value !== "string") {
      throw new PluginSdkError("invalid_args", `Setting "${setting.key}" expects a number.`);
    }
    if (!Number.isFinite(parsed)) {
      throw new PluginSdkError("invalid_args", `Setting "${setting.key}" expects a number.`);
    }
    return parsed;
  }
  if (typeof value !== "string") {
    throw new PluginSdkError("invalid_args", `Setting "${setting.key}" expects text.`);
  }
  if (setting.kind === "select" && setting.options && setting.options.length > 0) {
    if (!setting.options.some((option) => option.value === value)) {
      throw new PluginSdkError("invalid_args", `"${value}" is not an option for setting "${setting.key}".`);
    }
  }
  return value;
}

/**
 * Validate one batch of setting values against the manifest and store them.
 *
 * The single writer behind BOTH ways a setting gets written — ADE's own
 * generated settings form (`plugin.setConfig`) and a plugin writing its own
 * settings from a `settings-section` panel (`ade.config.set`). Sharing it is
 * the point: two validators would eventually disagree about what a `select`
 * accepts, and the plugin would be the one that looked broken.
 *
 * Throws before touching disk, so a refused batch leaves the stored config
 * exactly as it was rather than half-applied.
 */
function applyStoredConfig(args: {
  pluginsRoot: string;
  pluginId: string;
  declared: PluginManifestSetting[];
  values: Record<string, unknown>;
  /**
   * Refuse `secret`-kind keys.
   *
   * False for ADE's own form, which is where a secret setting is typed today.
   * True for a plugin writing its own settings: `config.json` is a plain file
   * this host hands to every child at spawn, and `ade.secrets` is the store
   * built to hold a credential instead.
   */
  refuseSecrets: boolean;
}): void {
  const declared = new Map(args.declared.map((setting) => [setting.key, setting]));
  const stored = readStoredConfig(args.pluginsRoot);
  const values = { ...(stored[args.pluginId] ?? {}) };
  for (const [key, value] of Object.entries(args.values)) {
    const setting = declared.get(key);
    // An undeclared key would read back as a setting the plugin never sees,
    // which is indistinguishable from a broken plugin.
    if (!setting) {
      throw new PluginSdkError("invalid_args", `Plugin "${args.pluginId}" declares no setting "${key}".`);
    }
    if (args.refuseSecrets && setting.kind === "secret") {
      throw new PluginSdkError(
        "invalid_args",
        `Setting "${key}" is a secret. Write it with ade.secrets.set("${key}", …) — secrets are not kept in the plain config store.`,
      );
    }
    const coerced = coerceSettingValue(setting, value);
    // null means "reset", so the stored override is REMOVED rather than
    // written as null: `effectiveConfig` layers stored values over the
    // manifest defaults, so a stored null would shadow the default with
    // nothing instead of restoring it.
    if (coerced === null) delete values[key];
    else values[key] = coerced;
  }
  stored[args.pluginId] = values;
  writeStoredConfig(args.pluginsRoot, stored);
  // The invalidation every other plugin write publishes: `{kind: "installs"}`
  // is what the marketplace, the slash-command cache and the webview bridge
  // already treat as "refetch this plugin", so a settings write made from
  // inside a plugin reaches an open Settings page by the same route one made
  // in the form does. Identity only, never the values — see `pluginEvents.ts`.
  emitPluginChange({ kind: "installs", pluginId: args.pluginId });
}

/** Case variants a plugin may ship its readme under, in the order tried. */
const PLUGIN_README_FILES = ["README.md", "readme.md", "Readme.md"] as const;

/** Bytes of a readme served to the UI. Past this it is a document, not a page. */
const PLUGIN_README_MAX_BYTES = 256 * 1024;

function readPluginReadme(pluginRoot: string): string | null {
  for (const name of PLUGIN_README_FILES) {
    try {
      const target = path.join(pluginRoot, name);
      const stats = fs.statSync(target);
      if (!stats.isFile()) continue;
      if (stats.size > PLUGIN_README_MAX_BYTES) {
        return `${fs.readFileSync(target, "utf8").slice(0, PLUGIN_README_MAX_BYTES)}\n\n…`;
      }
      return fs.readFileSync(target, "utf8");
    } catch {
      // Missing or unreadable: try the next spelling, then report none.
    }
  }
  return null;
}

/**
 * Parse `plugin.json` from a directory the machine can already read.
 *
 * Null for anything else — a URL, a missing path, an unparseable manifest.
 * Deliberately quiet: this answers "can I show you what this adds before you
 * install it", and "no" is a normal answer, not an error.
 */
function readManifestFromDirectory(source: string): PluginManifest | null {
  try {
    const resolved = path.resolve(source);
    const raw = fs.readFileSync(path.join(resolved, "plugin.json"), "utf8");
    const parsed = parsePluginManifestJson(raw);
    return parsed.manifest;
  } catch {
    return null;
  }
}

function effectiveConfig(
  manifest: PluginManifest | null,
  stored: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> {
  const config: Record<string, string | number | boolean | null> = {};
  for (const setting of manifest?.settings ?? []) {
    config[setting.key] = setting.default ?? null;
  }
  for (const [key, value] of Object.entries(stored ?? {})) config[key] = value;
  return config;
}

function toSummary(
  installed: PluginInstalledPlugin,
  runtime: { status: PluginRuntimeStatus; restartCount: number; lastCrashAt: string | null },
): PluginSummary {
  const manifest = installed.manifest;
  const brandIcons = loadPluginBrandIcons(installed.root, manifest);
  return {
    pluginId: installed.record.pluginId,
    version: manifest?.version ?? installed.record.version,
    displayName: manifest?.displayName ?? installed.record.pluginId,
    description: manifest?.description ?? "",
    icon: manifest?.icon ?? null,
    accent: manifest?.accent ?? null,
    enabled: installed.record.enabled,
    status: runtime.status,
    warnings: installed.warnings,
    errors: installed.errors,
    source: installed.record.source,
    installedAt: installed.record.installedAt,
    hasEntry: manifest ? pluginHasRuntimeEntry(manifest) : false,
    surfaces: (manifest?.surfaces ?? []).map((surface) => ({
      kind: surface.kind,
      id: surface.id,
      title: surface.title,
      panelId: surface.panelId,
      ...(surface.icon ? { icon: surface.icon } : {}),
      // The one field a webview guest cannot be mounted without. Every guest
      // host — the overlay, the plugin tab page, the panel slots — reads the
      // LIST payload, not the manifest on disk, and each treats an absent
      // `entryHtml` as "render the panel". Dropping it here therefore drew the
      // panel over every custom-UI plugin with no error anywhere, and the
      // author debugged their own HTML instead of this mapper.
      ...(surface.entryHtml ? { entryHtml: surface.entryHtml } : {}),
      // The anchored-placement size hint, carried for the same reason: the
      // popover host reads the LIST payload and has no manifest to fall back
      // on, so dropping it here would silently give every plugin the default
      // card size whatever its manifest asked for.
      ...(surface.popover ? { popover: surface.popover } : {}),
      // Passed through, not interpreted: the extraction pilot gates a builtin
      // tab on this, and a summary that drops it makes the gate impossible.
      ...(surface.builtin ? { builtin: surface.builtin } : {}),
    })),
    // Present only when the manifest declares tokens: the renderer's theme
    // engine treats a non-null `theme` as "this plugin can be applied as one".
    theme: manifest?.theme ? { displayName: manifest.displayName, tokens: manifest.theme.tokens } : null,
    disabledContributions: installed.record.disabledContributions ?? [],
    cli: manifest?.cli ?? [],
    // Engine registrations ride the summary so the rule builder, the search
    // palette and the keybinding matrix can each see every plugin at once.
    automationTriggers: manifest?.automationTriggers ?? [],
    automationSteps: manifest?.automationSteps ?? [],
    searchProviders: manifest?.searchProviders ?? [],
    keybindings: manifest?.keybindings ?? [],
    // Smart-link matchers ride the summary for the same reason: the composer
    // draws a chip from a pasted URL with no plugin running to ask.
    urlMatchers: manifest?.urlMatchers ?? [],
    ...(Object.keys(brandIcons).length > 0 ? { brandIcons } : {}),
    restartCount: runtime.restartCount,
    lastCrashAt: runtime.lastCrashAt,
  };
}

/**
 * Fold the sync meter's wire bytes into the storage numbers.
 *
 * The meter is the only source for these: it buffers counters in memory and
 * flushes on a timer, so reading its table directly would report zero for
 * traffic that happened in the current window and read as a broken meter.
 * A plugin that has sent frames but stores nothing still gets an entry — the
 * bytes are real usage whether or not it holds a row.
 */
function mergeWireUsage(
  summary: PluginUsageSummary,
  meter: PluginSyncMeter | null,
  pluginId: string | null,
): PluginUsageSummary {
  if (!meter) return summary;
  const entries = new Map(summary.entries.map((entry) => [entry.pluginId, { ...entry }]));
  for (const wire of meter.summary({ pluginId }).plugins) {
    const entry = entries.get(wire.pluginId) ?? {
      pluginId: wire.pluginId,
      collectionRows: 0,
      collectionBytes: 0,
      contributionRows: 0,
      panelRows: 0,
      syncBytesOut: 0,
      syncBytesIn: 0,
    };
    entry.syncBytesOut = wire.bytesOut;
    entry.syncBytesIn = wire.bytesIn;
    entries.set(wire.pluginId, entry);
  }
  return {
    ...summary,
    entries: [...entries.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
  };
}

function createHost(args: PluginHostServiceArgs): PluginHostService {
  const { logger } = args;
  let machine: PluginMachineContext = {
    ...(args.localMachineKey ? { localMachineKey: args.localMachineKey } : {}),
    ...(args.listAccountMachines ? { listAccountMachines: args.listAccountMachines } : {}),
    ...(args.reportInstall ? { reportInstall: args.reportInstall } : {}),
  };
  /**
   * The directory client, built on first use.
   *
   * Lazy because most sessions never open the Marketplace, and constructing it
   * resolves a cache path under the machine ADE directory — work a session that
   * only runs an installed plugin should not pay for.
   */
  let registryService: PluginRegistryService | null = null;
  const registry = (): PluginRegistryService => {
    registryService ??= createPluginRegistryService({ logger });
    return registryService;
  };

  /**
   * The sign-in broker. Built eagerly because it costs one empty map until a
   * plugin begins a flow, and because the phone's completion door has to be
   * answerable the moment the daemon is up — a callback that arrives while the
   * host is still deciding whether to build a broker is a code that is gone.
   */
  const authSessions = createPluginAuthSessionService({
    logger,
    emitCompleted: (pluginId, payload) => {
      const supervisor = supervisors.get(pluginId);
      // Delivered synchronously and NOT queued behind the runtime hooks, whose
      // contract is to drop rather than wait. This payload is the only copy of
      // a single-use authorization code that will ever exist: if the child is
      // gone or has stopped draining stdin there is no redelivery, so the loss
      // is logged loudly rather than counted as a drop nobody reads.
      if (!supervisor || supervisor.status() !== "running" || !supervisor.send({ type: "event", payload })) {
        logger.warn("plugin.auth_completion_undelivered", {
          pluginId,
          sessionId: payload.sessionId,
          ok: payload.ok,
        });
      }
    },
  });

  /**
   * The one-time credential handoff, built on first use and only when this
   * machine actually holds ADE's credential store.
   *
   * Null is a real answer and not a failure to configure: a headless CLI with
   * no secrets directory has no built-in connection to hand anyone, and the
   * SDK verb refuses with `auth_unavailable` rather than telling a plugin the
   * user has no Linear account.
   */
  /** Which client is driving the invoke currently running, per plugin. */
  const invokingClient = new Map<string, "desktop" | "mobile">();

  /**
   * Fill in the live sign-in URL a plugin asked a client to present.
   *
   * This is the whole reason `authSession` is not `openUrl`. The child returns
   * `{ authSession: { sessionId } }` and no URL at all; the host looks that id
   * up in its own table of flows it just started and stamps the rest on. So the
   * worst a wrong or forged result can name is one of this plugin's own
   * declared, already-running flows — there is no path by which a URL a plugin
   * typed reaches a browser.
   *
   * A request naming no live flow has its `authSession` REMOVED rather than
   * passed through empty, so a client cannot be handed a half-built
   * instruction, and the drop is logged because to the user it looks exactly
   * like a Connect button that does nothing.
   */
  const stampAuthSessionResult = (pluginId: string, result: unknown): unknown => {
    if (!hasPluginActionAuthSessionRequest(result)) return result;
    const request = readPluginActionAuthSessionRequest(result);
    const presentation = request ? authSessions.presentation(pluginId, request.sessionId) : null;
    if (!presentation) {
      logger.warn("plugin.auth_session_result_dropped", {
        pluginId,
        sessionId: request?.sessionId ?? null,
      });
      const { authSession: _dropped, ...rest } = result as Record<string, unknown>;
      return rest;
    }
    return { ...(result as Record<string, unknown>), authSession: presentation };
  };

  let credentialHandoffService: PluginCredentialHandoffService | null = null;
  const credentialHandoff = (): PluginCredentialHandoffService | null => {
    const credentials = machine.builtinCredentials;
    if (!credentials) return null;
    credentialHandoffService ??= createPluginCredentialHandoffService({
      logger,
      credentials,
      secrets,
      statePath: path.join(resolvePluginsRoot(), PLUGIN_CREDENTIAL_HANDOFF_STATE_FILE),
      // Read at CALL time, like every other capability in the machine bag, so a
      // desktop that attaches after the service was built can answer the card.
      requestConsent: async (consentArgs) => {
        const ask = machine.requestCredentialHandoffConsent;
        // Not `auth_unavailable`: a machine bag with no consent hook is a host
        // wired without the handoff seam, not one that cannot show a window.
        if (!ask) throw pluginCredentialHandoffUnavailable();
        return await ask(consentArgs);
      },
    });
    return credentialHandoffService;
  };
  const installs: PluginInstallService = createPluginInstallService({
    logger,
    ...(args.pluginsRoot ? { pluginsRoot: args.pluginsRoot } : {}),
    adeVersion: args.adeVersion ?? null,
    /**
     * The install service verifies against the directory's digest, so it needs
     * an answer CONFIRMED on this call — not the cache.
     *
     * The cache is usually cold: it holds an index for six hours and only if
     * someone opened the Marketplace, so reading it would report "no checksum
     * published" for a plugin the directory does vouch for, and an official
     * install would go through unverified with nothing said. A digest that
     * never left the machine also proves nothing about what the directory
     * currently vouches for. The install path pays one revalidating request and
     * decides for itself what an unreachable directory means.
     */
    resolveRegistryEntry: (pluginId: string) => registry().resolveEntryForVerification(pluginId),
    // Read through the mutable context, not captured at construction: the ping
    // target is wired later in bootstrap than the host is built.
    reportInstall: (install) => machine.reportInstall?.(install),
    // Forward reference to a `const` declared further down in this function:
    // safe because the callback only runs once an install actually reaches
    // the rename step, by which point `stopSupervisor` is long since defined
    // — the same pattern `setPluginInstallService`'s `runtimeStatus` below
    // already relies on for `supervisors`.
    beforeReplace: (pluginId: string) => stopSupervisor(pluginId),
  });
  const secrets: PluginSecretStore = createPluginSecretStore();
  /**
   * The provider-key broker, guarded.
   *
   * `getApiKey` throws when the store has not been initialized — a headless
   * brain that never opened a project, a unit test that built the host alone —
   * and that is not a fault the plugin should hear about. It is the same fact
   * as "no key connected", so it answers the same way and the plugin's remedy
   * is the same sentence: connect one in Settings.
   *
   * Nothing here logs the value. `provider` is the only thing worth recording,
   * and the doctor already reads that from the manifest.
   */
  const readProviderKey = (provider: PluginProviderKeyId): string | null => {
    try {
      return getApiKey(provider);
    } catch {
      return null;
    }
  };
  /**
   * The two per-plugin ledgers that live beside the install registry.
   *
   * Both are machine-scoped and both outlive any project, which is why they sit
   * next to `config.json` rather than in a project database: a notification
   * budget that reset when the user switched projects would not be a budget,
   * and a schedule is a claim on THIS machine's clock regardless of what is
   * open.
   */
  const notificationLimiter = createPluginNotificationLimiter({
    filePath: path.join(installs.root, PLUGIN_NOTIFICATION_USAGE_FILE),
    logger,
  });
  const schedules = createPluginScheduleService({
    filePath: path.join(installs.root, PLUGIN_SCHEDULES_FILE),
    logger,
    // Routed through the domain service rather than straight at a supervisor so
    // a schedule firing is indistinguishable from any other invoke: it starts a
    // stopped child, refuses a disabled plugin, and is bounded by the same
    // timeout.
    invoke: async ({ pluginId, action, args: invokeArgs }) => (
      await domainService(null).invoke({ pluginId, action, args: invokeArgs })
    ),
  });
  schedules.start();
  /**
   * Republish this machine's presence rows after a local install-state change.
   *
   * Fire-and-forget with a caught rejection on purpose: presence is a
   * convenience for other machines, and an install that succeeded must not be
   * reported as failed because a peer was unreachable.
   */
  const publishPresence = (): void => {
    void getPluginPresenceService()?.publishLocalPresence().catch((error: unknown) => {
      logger.debug("plugin.presence_publish_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  /**
   * Free everything an uninstalled plugin left behind that the registry
   * delete alone does not reach: its rows in every attached project, and its
   * machine-scoped secrets. Shared by the local `uninstall` action and the
   * remote-command adapter's `afterChange`, so a peer's uninstall cleans up
   * exactly as thoroughly as one run from this desktop's own UI.
   */
  const cleanupUninstalledPluginData = async (pluginId: string): Promise<void> => {
    // The invoke history goes with the install. A reinstall that inherited the
    // old plugin's last-run line would answer "yes, it ran" about code that is
    // no longer on the machine.
    lastInvokes.delete(pluginId);
    // Rows outlive the install otherwise: `plugin_collections` is keyed by
    // plugin id and nothing else would ever collect them.
    for (const attached of projects.values()) {
      try {
        attached.data.removePluginData(pluginId);
      } catch (error) {
        logger.warn("plugin.data_cleanup_failed", {
          pluginId,
          projectId: attached.binding.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // This machine's presence row for the plugin, in every attached project.
    //
    // Not covered by the republish `uninstall` already runs: that publishes
    // through the presence service, which holds ONE project's database — the
    // scope that happened to bind it last — while presence rows exist in every
    // project database this machine has attached. Rows left behind are the one
    // kind of leftover another COMPUTER can see: the coverage matrix reads them
    // and reports this machine as still having the plugin, enabled, forever.
    //
    // Keyed by this machine's own key. An uninstall here is a statement about
    // this computer only, and a sweep by plugin id alone would delete peers'
    // rows — asserting something about machines that never uninstalled.
    const localMachineKey = machine.localMachineKey?.() ?? null;
    if (localMachineKey) {
      for (const attached of projects.values()) {
        try {
          deletePluginPresenceForPlugin(attached.binding.db, localMachineKey, pluginId);
        } catch (error) {
          logger.warn("plugin.presence_cleanup_failed", {
            pluginId,
            projectId: attached.binding.projectId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    // The automation ingress log this plugin's firings wrote. Same reasoning
    // as `plugin_collections` above — rows keyed by a plugin nothing else
    // collects — and the key is the event key's `<pluginId>:` prefix, which is
    // how `dispatchIngressTrigger` stamps ownership onto a row whose `source`
    // column says only "plugin".
    //
    // What is deliberately NOT swept here: the user's automation RULES. A rule
    // is authored content that lives in `ade.yaml`, not host state — deleting
    // one on uninstall would destroy work the user can no longer see to
    // recover, and a reinstall would not bring it back. The rule survives; its
    // step refuses with the catalog sentence naming the missing plugin, and the
    // builder renders it attributed and unavailable.
    for (const attached of projects.values()) {
      try {
        // No LIKE escaping: a plugin id is `[a-z][a-z0-9-]*` by manifest
        // pattern, so it can hold none of `%`, `_` or `\`.
        attached.binding.db.run(
          `delete from automation_ingress_events where source = 'plugin' and event_key like ?`,
          [`${pluginId}:%`],
        );
      } catch (error) {
        logger.warn("plugin.ingress_cleanup_failed", {
          pluginId,
          projectId: attached.binding.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Secrets are machine-scoped, so no project cleanup would ever reach
    // them: an uninstalled plugin's tokens would sit in the credential
    // store with nothing left that knows their names.
    try {
      await secrets.removeAll(pluginId);
    } catch (error) {
      logger.warn("plugin.secret_cleanup_failed", {
        pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // The recorded answer to a credential-handoff card, so a reinstall asks
    // again. `removeAll` above already deleted the copied secrets; leaving the
    // "already answered" record behind would mean a user who reinstalled the
    // plugin got neither the credential nor the offer, and no way to ask for
    // either.
    try {
      credentialHandoff()?.forget(pluginId);
    } catch (error) {
      logger.warn("plugin.credential_handoff_cleanup_failed", {
        pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Schedules, which are the one thing here that keeps ACTING after the
    // plugin is gone. Rows and secrets left behind are inert clutter; a
    // surviving schedule wakes a plugin that is no longer installed, on a
    // timer the user has no surface left to cancel it from. This is why plugin
    // schedules are owned rather than borrowed — a chat cron a plugin created
    // through `actions.invoke` carries no owner and could not be found here.
    try {
      const removed = schedules.removeAllForPlugin(pluginId);
      if (removed > 0) logger.info("plugin.schedules_removed_on_uninstall", { pluginId, removed });
    } catch (error) {
      logger.warn("plugin.schedule_cleanup_failed", {
        pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // The notification counters, so a reinstall starts with a clean allowance
    // rather than inheriting a day the previous install spent. Not a security
    // boundary — a plugin that could uninstall itself could already do worse —
    // just correctness: the ledger should not name plugins that are not here.
    try {
      notificationLimiter.forget(pluginId);
    } catch (error) {
      logger.warn("plugin.notification_usage_cleanup_failed", {
        pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // The account link the plugin owned, if it owned one. Deliberately last:
    // it is the only step a user could be surprised by, and it must not be able
    // to strand the data and secret cleanup above if it throws.
    try {
      await machine.disconnectAccountsForPlugin?.(pluginId);
    } catch (error) {
      logger.warn("plugin.account_disconnect_failed", {
        pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  // The sync layer resolves this handle at call time to answer `plugins.*` from
  // another machine; `dispose()` clears it, because a stale handle answering
  // after teardown is worse than "plugins are unavailable on this computer".
  setPluginInstallService(createPluginInstallServiceAdapter({
    install: installs,
    onChanged: publishPresence,
    // Live child state, so a peer (the web client especially) sees a contained
    // or crashed plugin as dead rather than falling back to "none". Absent
    // without this, and a guess from `enabled` would put a green dot on a
    // crashed plugin.
    runtimeStatus: (pluginId) => supervisors.get(pluginId)?.status() ?? null,
    // A remote "install graph" names a directory entry; only the directory maps
    // that to a repository. The cached index answers when it can, and a refresh
    // is attempted once before giving up, because a machine that has never
    // opened the Marketplace has no cache to answer from.
    resolveRegistrySource: async (pluginId, version) => {
      const find = (result: { entries: { pluginId: string; source: string; version: string }[] } | null) =>
        result?.entries.find((entry) => entry.pluginId === pluginId) ?? null;
      const entry = find(registry().readCachedIndex()) ?? find(await registry().fetchIndex({ refresh: true }));
      if (!entry) return null;
      // The version is a tag on the entry's repository; an entry that does not
      // publish the asked-for version still installs from its default ref.
      return { source: entry.source, ref: version && version !== entry.version ? version : null };
    },
    // Remote install/enable/disable/uninstall used to touch only the install
    // REGISTRY: nothing stopped the old child, no codeless plugin's panels
    // were seeded, and an uninstall left the child running with its data and
    // secrets intact. This runs the same lifecycle the local action below
    // does, keyed by what changed.
    afterChange: async (pluginId, kind) => {
      if (kind === "uninstall") {
        await stopSupervisor(pluginId);
        await cleanupUninstalledPluginData(pluginId);
        return;
      }
      if (kind === "install") {
        await stopSupervisor(pluginId);
        reconcile({ replacePanelsFor: pluginId });
        return;
      }
      // enable / disable: no code changed, just whether it should be running.
      reconcile();
    },
  }));
  // Every plugin tap from a phone lands here: `plugins.invoke` resolves this at
  // call time and runs the same domain path the desktop's `plugin.invoke` does,
  // so a handler cannot behave differently depending on which device asked.
  setPluginActionInvoker(async (invokeArgs) => domainService(null).invoke(invokeArgs));
  // The three host operations a plugin PAGE performs that its client cannot do
  // for itself. The phone's page bridge reaches them over sync
  // (`plugins.putCollection`, `plugins.getConfig`, `plugins.setConfig`) and gets
  // the same functions the desktop webview bridge calls, so one page cannot be
  // held to a different rule depending on the client drawing it.
  // Called through arrows rather than passed by reference: the three writers
  // are declared below this line, and a direct reference here would read them
  // before they are initialized. A page cannot call any of them until the host
  // is built, so resolving at call time costs nothing.
  setPluginPageHostService({
    writeCollection: (collectionArgs) => writeCollectionForPage(collectionArgs),
    readConfig: async (configArgs) => readConfigForPage(configArgs),
    writeConfig: (configArgs) => writeConfigForPage(configArgs),
  });
  // The other half of a sign-in a phone presented: the browser handed the phone
  // a redirect, and `plugins.completeAuthSession` resolves this to hand it back.
  // Bound here rather than left to the caller to find, because the broker is the
  // only thing holding the `state` that says which flow the answer belongs to,
  // and a route that reached the phone but not the broker would leave the plugin
  // waiting on a callback that had already arrived.
  setPluginAuthSessionCompleter((params) => authSessions.completeAppCallback({ params }));
  const projects = new Map<string, AttachedProject>();
  const supervisors = new Map<string, PluginChildSupervisor>();
  /**
   * Which project a plugin's SDK calls resolve against.
   *
   * Plugin children are machine-scoped but `plugin_collections` lives in a
   * project database, so a child needs a project to write into. It is set to
   * the project an `invoke` arrived through, which makes a plugin's writes land
   * in the project the user is acting in; background work (event handlers,
   * timers) follows the most recent one. Multi-project plugin state is a v2
   * problem the single `plugin` action domain does not yet express.
   */
  const activeProjectByPlugin = new Map<string, string>();
  /**
   * The last invoke attempt per plugin, per action.
   *
   * The gap this closes: a contribution that published no rows and a
   * contribution whose action was never reached both looked identical from
   * outside the host — `ade plugin doctor` could only say "0 rows published
   * right now" for either, so "I pressed it and nothing happened" cost a manual
   * reproduction before anyone could tell which half was broken.
   *
   * In memory, and that is the honest scope: this answers "since ADE started",
   * which is the window a person debugging a press is asking about. Persisting
   * it would put a write on the hot path of every agent tool call to buy an
   * answer nobody asks after a restart.
   *
   * Bounded per plugin, oldest action evicted, because a plugin's action names
   * come from its own manifest and its own CLI words — a plugin that generates
   * them would otherwise grow this map for as long as ADE runs.
   */
  const lastInvokes = new Map<string, Map<string, PluginActionInvokeRecord>>();
  const PLUGIN_LAST_INVOKE_MAX_ACTIONS = 32;

  const recordInvoke = (pluginId: string, action: string, errorCode: string | null): void => {
    let byAction = lastInvokes.get(pluginId);
    if (!byAction) {
      byAction = new Map<string, PluginActionInvokeRecord>();
      lastInvokes.set(pluginId, byAction);
    }
    // Deleted before it is set so a repeat invoke moves to the END of the
    // insertion order: eviction below drops the least recently ATTEMPTED
    // action, which a plain size check would not do for a hot action inserted
    // long ago.
    byAction.delete(action);
    byAction.set(action, {
      action,
      at: nowIso(),
      ok: errorCode === null,
      ...(errorCode === null ? {} : { errorCode }),
    });
    while (byAction.size > PLUGIN_LAST_INVOKE_MAX_ACTIONS) {
      const oldest = byAction.keys().next();
      if (oldest.done) break;
      byAction.delete(oldest.value);
    }
  };

  /** Newest attempt first, which is the order a reader scans it in. */
  const lastInvokesFor = (pluginId: string): PluginActionInvokeRecord[] =>
    [...(lastInvokes.get(pluginId)?.values() ?? [])].reverse();

  let disposed = false;

  /** Any attached project, for callers with no reason to prefer one. */
  const anyProject = (): AttachedProject | null => projects.values().next().value ?? null;

  /**
   * One message for "there is nowhere to put plugin data", shared by both
   * resolvers below so a plugin cannot get two different explanations for the
   * same condition depending on which call it made.
   */
  const requireAttached = (attached: AttachedProject | null): AttachedProject => {
    if (!attached) {
      throw new PluginSdkError("internal_error", "No project is open, so plugin data is unavailable.");
    }
    return attached;
  };

  const resolveProject = (pluginId: string): AttachedProject | null => {
    const preferred = activeProjectByPlugin.get(pluginId);
    if (preferred) {
      const attached = projects.get(preferred);
      if (attached) return attached;
    }
    return anyProject();
  };

  const requireProject = (pluginId: string): AttachedProject => requireAttached(resolveProject(pluginId));

  /**
   * This plugin's project's lane service, or the refusal.
   *
   * A scope that bound none is `unsupported_method`, not a silent empty list: a
   * plugin told there are no lanes would report that to the user as fact.
   */
  const requireLanes = (pluginId: string): NonNullable<PluginProjectBinding["lanes"]> => {
    const lanes = requireProject(pluginId).binding.lanes;
    if (!lanes) throw pluginLanesUnavailable();
    return lanes;
  };

  /**
   * A `PluginDataStore` that resolves its project at call time. The supervisor
   * and its SDK server are built once, but the project they write into changes
   * as the user moves between projects.
   */
  const routingDataStore = (pluginId: string): PluginDataStore => ({
    getCollection: (id, collection, key) => requireProject(pluginId).data.getCollection(id, collection, key),
    putCollection: (id, collection, key, value) => requireProject(pluginId).data.putCollection(id, collection, key, value),
    deleteCollection: (id, collection, key) => requireProject(pluginId).data.deleteCollection(id, collection, key),
    listCollection: (id, collection, options) => requireProject(pluginId).data.listCollection(id, collection, options),
    publishContribution: (id, entityKind, entityId, socket, payload) =>
      requireProject(pluginId).data.publishContribution(id, entityKind, entityId, socket, payload),
    updatePanel: (id, panelId, panelArgs) => requireProject(pluginId).data.updatePanel(id, panelId, panelArgs),
    readPanel: (id, panelId) => requireProject(pluginId).data.readPanel(id, panelId),
    prunePanels: (id, declaredPanelIds) => requireProject(pluginId).data.prunePanels(id, declaredPanelIds),
    usage: (id) => requireProject(pluginId).data.usage(id),
    removePluginData: (id) => requireProject(pluginId).data.removePluginData(id),
  });

  const configFor = (pluginId: string, manifest: PluginManifest | null): Record<string, string | number | boolean | null> =>
    effectiveConfig(manifest, readStoredConfig(installs.root)[pluginId]);

  /**
   * Write a plugin's own settings on its behalf, WITHOUT restarting it.
   *
   * The restart `plugin.setConfig` performs is right for ADE's settings form —
   * the user typed a value and expects the plugin to be running on it — and
   * fatal here: a plugin calling `ade.config.set` from inside an action handler
   * would kill itself mid-call. It does not need the restart either, because
   * `config.get` is served by {@link configFor}, which re-reads `config.json`
   * on every call rather than from the copy handed to the child at spawn.
   *
   * Returns the new effective config so the caller does not have to read back.
   */
  const writeConfigFor = (
    pluginId: string,
    manifest: PluginManifest | null,
    values: Record<string, unknown>,
  ): Record<string, string | number | boolean | null> => {
    applyStoredConfig({
      pluginsRoot: installs.root,
      pluginId,
      declared: manifest?.settings ?? [],
      values,
      refuseSecrets: true,
    });
    return configFor(pluginId, manifest);
  };

  /**
   * Write one collection row for a plugin PAGE.
   *
   * A page is the plugin's own HTML in a guest whose plugin id the host derived
   * from the frame origin — the desktop webview, and the phone's page bridge,
   * which reaches this through the sync layer's `plugins.putCollection`. Both
   * clients call THIS function rather than each writing the table, so the
   * declared-collection rule and the store's budgets are one rule for a page
   * wherever it is drawn.
   *
   * Named and defined here, beside {@link writeConfigFor}, rather than inline in
   * the returned object: the page seam is bound below, before that object
   * exists.
   */
  const writeCollectionForPage = (
    { pluginId, collection, key, value }: {
      pluginId: string;
      collection: string;
      key: string;
      value: unknown;
    },
  ): void => {
    const installed = requireInstalled(pluginId);
    if (!installed.record.enabled) {
      throw new PluginSdkError("plugin_disabled", `Plugin "${pluginId}" is disabled.`);
    }
    const declared = installed.manifest?.collections ?? {};
    if (!Object.prototype.hasOwnProperty.call(declared, assertPluginCollectionName(collection))) {
      throw new PluginSdkError(
        "not_permitted",
        `Collection "${collection}" is not declared in ${pluginId}'s manifest.`,
      );
    }
    // The data store re-encodes and re-checks every budget inside its own
    // transaction — that check is the guarantee, and this path deliberately
    // adds none of its own so a page and a child cannot be held to different
    // ceilings for the same row.
    requireProject(pluginId).data.putCollection(
      pluginId,
      collection,
      assertPluginCollectionKey(key),
      value,
    );
  };

  /** The settings half of {@link writeCollectionForPage}, same rule and same callers. */
  const writeConfigForPage = (
    { pluginId, values }: { pluginId: string; values: Record<string, unknown> },
  ): Record<string, string | number | boolean | null> => {
    const installed = requireInstalled(pluginId);
    if (!installed.record.enabled) {
      throw new PluginSdkError("plugin_disabled", `Plugin "${pluginId}" is disabled.`);
    }
    return writeConfigFor(pluginId, installed.manifest, values);
  };

  /** What a page reads back: manifest defaults with the stored values over them. */
  const readConfigForPage = (
    { pluginId }: { pluginId: string },
  ): Record<string, string | number | boolean | null> => {
    const installed = requireInstalled(pluginId);
    if (!installed.record.enabled) {
      throw new PluginSdkError("plugin_disabled", `Plugin "${pluginId}" is disabled.`);
    }
    return configFor(pluginId, installed.manifest);
  };

  const buildSupervisor = args.createSupervisor ?? createPluginChildSupervisor;

  const ensureSupervisor = (installed: PluginInstalledPlugin): PluginChildSupervisor => {
    const pluginId = installed.record.pluginId;
    const existing = supervisors.get(pluginId);
    if (existing) return existing;
    const manifest = installed.manifest;
    if (!manifest) throw new PluginSdkError("plugin_not_found", `Plugin "${pluginId}" has no readable manifest.`);
    const sdkServer = createPluginSdkServer({
      pluginId,
      manifest,
      logger,
      data: routingDataStore(pluginId),
      secrets,
      invokeAdeAction: (domain, action, actionArgs) =>
        requireProject(pluginId).binding.invokeAdeAction(domain, action, actionArgs, {
          pluginId,
          displayName: manifest.displayName ?? null,
          projectSecrets: manifest.projectSecrets ?? [],
        }),
      readConfig: () => configFor(pluginId, manifest),
      writeConfig: (values) => writeConfigFor(pluginId, manifest, values),
      readProviderKey,
      // The plugin id and the manifest are closed over here and NOT taken from
      // the call, which is what makes these safe to hand a child: there is no
      // argument by which a plugin could begin a flow, or claim a credential,
      // belonging to a different plugin.
      beginAuthSession: (authArgs) => authSessions.begin({
        pluginId,
        manifest,
        sessionId: authArgs.sessionId,
        params: authArgs.params,
        ...(authArgs.transport ? { transport: authArgs.transport } : {}),
        client: invokingClient.get(pluginId) ?? null,
      }),
      cancelAuthSession: (sessionId) => authSessions.cancel(pluginId, sessionId),
      requestCredentialHandoff: async (builtin) => {
        const service = credentialHandoff();
        // A host with no credential store has nothing to inherit from, and
        // never will — so the plugin is told to use its own sign-in rather than
        // to open ADE and try again. See `pluginCredentialHandoffUnavailable`.
        if (!service) throw pluginCredentialHandoffUnavailable();
        // Narrowed here rather than in the SDK server, which validates argument
        // SHAPES and does not know ADE's built-in surfaces. An id that is not
        // one is `not_permitted` for the same reason an undeclared one is: the
        // manifest is the plugin's declared surface, and there is nothing to
        // widen it to.
        if (!isPluginBuiltinSurfaceId(builtin)) {
          throw new PluginSdkError(
            "not_permitted",
            `"${builtin}" is not one of ADE's built-in surfaces.`,
          );
        }
        return await service.request({ pluginId, manifest, builtin });
      },
      // `pluginId` is closed over from the supervisor this bag was built for,
      // exactly as `requestCredentialHandoff` above — so the ownership check
      // inside the broker runs against a host-derived identity and never
      // against anything the child sent.
      officialOAuthClient: (provider) => officialOAuthClientForPlugin({ pluginId, provider }),
      // Read through `machine` at call time rather than captured here: a
      // supervisor outlives the desktop that lends it a microphone, and a
      // captured `undefined` would keep refusing captures long after one
      // attached.
      captureAudioClip: (captureArgs) => {
        const capture = machine.captureAudioClip;
        if (!capture) return Promise.reject(pluginAudioCaptureUnavailable());
        return capture(captureArgs);
      },
      // The rate limit sits HERE rather than inside whatever ends up showing
      // the notification: `machine.postNotification` fans out to a phone push
      // and a desktop notification, and a ceiling applied on the far side of
      // that fan-out would count one post twice or not at all. Reserving first
      // also means a plugin over its budget never reaches the relay.
      postNotification: async (notifyArgs) => {
        const post = machine.postNotification;
        if (!post) throw pluginNotificationUnavailable();
        notificationLimiter.reserve(notifyArgs.pluginId);
        try {
          return await post(notifyArgs);
        } catch (error) {
          // Refunded, so a machine with nowhere to deliver does not spend the
          // plugin's daily budget on failures and then report the wrong reason
          // for the sixth one.
          notificationLimiter.release(notifyArgs.pluginId);
          throw error;
        }
      },
      schedules,
      // Resolved at call time through `requireProject`, never captured: which
      // project a plugin's calls belong to changes as projects attach and
      // detach, and a captured binding would keep firing triggers into a
      // project the user has closed.
      emitAutomationTrigger: async (emitArgs) => {
        const emit = requireProject(emitArgs.pluginId).binding.emitAutomationTrigger;
        if (!emit) throw pluginAutomationsUnavailable();
        await emit(emitArgs);
      },
      // Resolved per call through `requireProject` for the same reason the
      // trigger emitter is: the drain belongs to a project scope, and a
      // captured one would keep acking into a database the user has closed.
      webhooks: {
        url: (webhookPluginId, channelId) => {
          const ingress = requireProject(webhookPluginId).binding.webhookIngress;
          if (!ingress) throw pluginWebhookIngressUnavailable();
          return ingress.urlFor(webhookPluginId, channelId);
        },
        ack: (webhookPluginId, deliveryId) => {
          const ingress = requireProject(webhookPluginId).binding.webhookIngress;
          if (!ingress) throw pluginWebhookIngressUnavailable();
          ingress.ack(webhookPluginId, deliveryId);
        },
        status: async (webhookPluginId) => {
          const ingress = requireProject(webhookPluginId).binding.webhookIngress;
          if (!ingress) throw pluginWebhookIngressUnavailable();
          const [row] = await ingress.getStatus(webhookPluginId);
          if (!row) throw pluginWebhookIngressUnavailable();
          return row;
        },
      },
      // The chat seam. Every verb but `createSession` is addressed by a session
      // id, which is globally unique, so ownership resolves it to the right
      // project without anyone naming one — that is why these do NOT go through
      // `requireProject` the way the trigger emitter does. `createSession` is
      // the exception: it names a lane, not a session, so it needs the plugin's
      // currently bound project and refuses when there is none.
      //
      // `pluginId` is passed to every call and the gate compares it to the
      // session's own `runtimeRef.pluginId`. It is the id THIS supervisor was
      // built for — a plugin cannot reach another plugin's sessions by naming
      // them, because it never names itself at all.
      chat: {
        createSession: async (chatPluginId, input) => {
          const writer = findPluginChatRuntimeWriterForProjectRoot(
            resolveProject(chatPluginId)?.binding.projectRoot ?? null,
          );
          if (!writer) throw pluginChatUnavailable();
          return await writer.createSession(chatPluginId, input);
        },
        appendAssistant: async (chatPluginId, sessionId, chunk) => {
          const { writer } = requirePluginChatWriteTarget(chatPluginId, sessionId);
          await writer.appendAssistant(sessionId, chunk);
        },
        appendUser: async (chatPluginId, sessionId, input) => {
          const { writer } = requirePluginChatWriteTarget(chatPluginId, sessionId);
          await writer.appendUser(sessionId, input);
        },
        emitStatus: async (chatPluginId, sessionId, status) => {
          const { writer } = requirePluginChatWriteTarget(chatPluginId, sessionId);
          await writer.emitStatus(sessionId, status);
        },
        setArtifacts: async (chatPluginId, sessionId, artifacts) => {
          const { writer } = requirePluginChatWriteTarget(chatPluginId, sessionId);
          await writer.setArtifacts(sessionId, artifacts);
        },
        attachBranch: async (chatPluginId, sessionId, input) => {
          const { writer } = requirePluginChatWriteTarget(chatPluginId, sessionId);
          await writer.attachBranch(sessionId, input);
        },
        hydrate: async (chatPluginId, sessionId, transcript, options) => {
          const { writer } = requirePluginChatWriteTarget(chatPluginId, sessionId);
          return await writer.hydrate(sessionId, transcript, options);
        },
      },
      // The lane seam. Resolved per call through `requireProject` for the same
      // reason the trigger emitter is: lanes belong to a project scope, and a
      // captured service would keep writing issue links into a project the user
      // has closed.
      //
      // `lanesPluginId` is the id THIS supervisor was built for — the SDK
      // server passes it, never the child — and it is what the link is stamped
      // with and what `requirePluginId` is checked against. A plugin therefore
      // cannot link on another plugin's behalf, and cannot unlink what it did
      // not create.
      lanes: {
        list: async (lanesPluginId) => await requireLanes(lanesPluginId)
          .list({ includeArchived: false, includeStatus: false }),
        get: async (lanesPluginId, laneId) => await requireLanes(lanesPluginId)
          .getSummary(laneId, { includeStatus: false }),
        listSessionIssues: async (lanesPluginId, laneId) =>
          requireLanes(lanesPluginId).listIssueLinksForLaneSessions({ laneId }),
        listIssueLinks: async (lanesPluginId, target) =>
          requireLanes(lanesPluginId).listIssueLinks(target),
        linkIssue: async (lanesPluginId, linkArgs) => requireLanes(lanesPluginId).linkIssueRef({
          ...linkArgs,
          // The source is the HOST's word for how this link came to exist, so
          // it is set here and is not a field the plugin can spell. A link a
          // plugin made must not be able to claim the user made it.
          source: "plugin_link",
        }),
        unlinkIssue: async (lanesPluginId, unlinkArgs) =>
          requireLanes(lanesPluginId).unlinkIssueRef(unlinkArgs),
      },
      // Read through `machine` at call time, not captured: a supervisor
      // outlives the desktop that lends it these, and a captured `undefined`
      // would keep refusing long after one attached.
      desktopHost: {
        readClipboard: () => {
          const host = machine.desktopHost;
          if (!host) return Promise.reject(pluginDesktopUnavailable());
          return host.readClipboard();
        },
        writeClipboard: (text) => {
          const host = machine.desktopHost;
          if (!host) return Promise.reject(pluginDesktopUnavailable());
          return host.writeClipboard(text);
        },
        pickFile: (options) => {
          const host = machine.desktopHost;
          if (!host) return Promise.reject(pluginDesktopUnavailable());
          return host.pickFile(options);
        },
      },
    });
    const supervisor = buildSupervisor({
      pluginId,
      pluginRoot: installed.root,
      manifest,
      logger,
      config: configFor(pluginId, manifest),
      // `events.subscribe` is answered here rather than by the SDK server: it
      // writes fan-out state, which lives with the queue that reads it. See
      // `applyEventSubscription`.
      // `async` so a refusal becomes a rejection the supervisor can answer with
      // a `sdkResult` error frame; a synchronous throw here would escape the
      // frame handler and leave the child's request unanswered forever.
      onSdkCall: async (method, params) => (
        method === "events.subscribe"
          ? applyEventSubscription(pluginId, params)
          : sdkServer.handle(method, params)
      ),
    });
    supervisors.set(pluginId, supervisor);
    return supervisor;
  };

  /**
   * Drop a plugin's running child.
   *
   * Every caller that replaces what a child is running — a settings write, an
   * upgrade, a reload, an uninstall — has to do this first, and the supervisor
   * is removed from the map BEFORE the await so a concurrent `invoke` cannot
   * pick up the one that is on its way out.
   */
  const stopSupervisor = async (pluginId: string): Promise<void> => {
    const supervisor = supervisors.get(pluginId);
    if (!supervisor) return;
    supervisors.delete(pluginId);
    // The child's listeners die with it, and the next one re-registers from
    // `activate`. Anything still queued for it is telemetry for a process that
    // no longer exists.
    hookSubscriptions.delete(pluginId);
    hookQueues.delete(pluginId);
    pushSubscriptions.delete(pluginId);
    invokingClient.delete(pluginId);
    // A live sign-in belongs to the child that began it. With that child gone
    // there is nobody left to hand the code to, so the listener is closed now
    // rather than left holding a declared loopback port that the plugin's next
    // start would then find taken by its own corpse.
    authSessions.disposePlugin(pluginId);
    await supervisor.dispose();
  };

  const runtimeStateFor = (installed: PluginInstalledPlugin): {
    status: PluginRuntimeStatus;
    restartCount: number;
    lastCrashAt: string | null;
  } => {
    const supervisor = supervisors.get(installed.record.pluginId);
    if (supervisor) {
      return {
        status: supervisor.status(),
        restartCount: supervisor.restartCount(),
        lastCrashAt: supervisor.lastCrashAt(),
      };
    }
    const hasEntry = installed.manifest ? pluginHasRuntimeEntry(installed.manifest) : false;
    return { status: hasEntry ? "idle" : "no-entry", restartCount: 0, lastCrashAt: null };
  };

  /**
   * Read a panel's declared schema from the plugin's own tree.
   *
   * The manifest parser already refuses a path that escapes the plugin, and
   * this re-checks the resolved path anyway — the same belt-and-braces the
   * skills roots get, because this one is read from a directory a third party
   * wrote. Unreadable or unparseable reads as "no declared schema", which is
   * the honest answer: the plugin ships a panel it cannot render.
   */
  const readDeclaredPanelSchema = (pluginRoot: string, schemaFile: string): unknown => {
    const resolved = path.resolve(pluginRoot, schemaFile);
    if (resolved !== pluginRoot && !resolved.startsWith(`${pluginRoot}${path.sep}`)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
    } catch {
      return undefined;
    }
  };

  /**
   * Host-write the sanitized `brand:*` glyphs into the reserved collection
   * every client already syncs. The plugin cannot name this collection, so a
   * child cannot replace a sanitized path with a `<script>`.
   */
  const publishBrandIcons = (installed: PluginInstalledPlugin): void => {
    const pluginId = installed.record.pluginId;
    const glyphs = loadPluginBrandIcons(installed.root, installed.manifest);
    const keep = new Set(Object.keys(glyphs));
    for (const attached of projects.values()) {
      try {
        const existing = attached.data.listCollection(pluginId, PLUGIN_BRAND_ICONS_COLLECTION, {
          limit: 32,
        });
        for (const row of existing) {
          if (!keep.has(row.key)) {
            attached.data.deleteCollection(pluginId, PLUGIN_BRAND_ICONS_COLLECTION, row.key);
          }
        }
        for (const [token, glyph] of Object.entries(glyphs)) {
          attached.data.putCollection(pluginId, PLUGIN_BRAND_ICONS_COLLECTION, token, glyph);
        }
      } catch (error) {
        logger.warn("plugin.brand_icons_publish_failed", {
          pluginId,
          projectId: attached.binding.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  /**
   * Materialize the panels a manifest DECLARES, so a plugin that ships no code
   * still renders — and retire the rows it no longer declares, so the table
   * says exactly what the manifest on disk says.
   *
   * `plugin_panels` is the only thing any client reads — desktop, phone, TUI
   * and web all render the row, never the manifest — so before this a declared
   * `schemaFile` was never read by anything and every codeless plugin (themes,
   * static panels) opened onto "this plugin hasn't published this view yet".
   * The one pilot that worked around it did so by shipping an entry point whose
   * only job was to re-publish its own JSON on a retry loop.
   *
   * `replace` is false for a plain bind: a running plugin's live panel content
   * outranks its shipped default, and clobbering it on every project attach
   * would blank a populated view until the child republished. It is true when
   * the code on disk just changed (install, reload) — the declared schema is
   * then genuinely newer than whatever the previous version published.
   */
  const seedDeclaredPanels = (installed: PluginInstalledPlugin, replace: boolean): void => {
    const manifest = installed.manifest;
    if (!manifest || !installed.record.enabled) return;
    const pluginId = installed.record.pluginId;
    for (const panel of manifest.panels) {
      if (!panel.schemaFile) continue;
      const schema = readDeclaredPanelSchema(installed.root, panel.schemaFile);
      if (schema === undefined) continue;
      const surface = manifest.surfaces.find((entry) => entry.panelId === panel.id);
      // A panel no surface names is reachable only by a client that asks for it
      // directly, so nothing here decides it is desktop-only.
      const mobile = surface ? pluginPanelShowsOnMobile(surface) : true;
      const declared = {
        ...(panel.title ? { title: panel.title } : {}),
        ...(panel.icon ? { icon: panel.icon } : {}),
        ...(surface ? { surface: surface.id } : {}),
        mobile,
        refreshAction: panel.refreshAction ?? null,
        viewAction: panel.viewAction ?? null,
      };
      for (const attached of projects.values()) {
        try {
          const existing = replace ? null : attached.data.readPanel(pluginId, panel.id);
          if (existing) {
            // The row's CONTENT belongs to the plugin, and a plain convergence
            // pass must not clobber it. `mobile` is not content: it is the
            // host's answer, and it moves when the manifest changes it or when
            // a new ADE resolves it differently. A codeless plugin never
            // republishes, so a stale answer here would be permanent — the flag
            // is rewritten onto the schema the row already holds instead.
            const stored = isRecord(existing.schema) ? existing.schema : null;
            const storedRefresh = typeof stored?.refreshAction === "string" ? stored.refreshAction : null;
            const storedView = typeof stored?.viewAction === "string" ? stored.viewAction : null;
            // Whether the row is still the shipped default is the ROW's fact,
            // not the manifest's, so a convergence pass carries it across
            // rather than re-asserting it: the plugin may have published real
            // content since the seed, and re-stamping `seeded` would send every
            // client back to running the first refresh again.
            const storedSeeded = stored?.seeded === true;
            if (!stored || (
              stored.mobile === mobile
              && storedRefresh === (panel.refreshAction ?? null)
              && storedView === (panel.viewAction ?? null)
            )) continue;
            attached.data.updatePanel(pluginId, panel.id, {
              ...declared,
              seeded: storedSeeded,
              schema: existing.schema,
              vocabVersion: existing.vocabVersion,
            });
            continue;
          }
          // Through the store, so the budget writer sees this row exactly as it
          // sees a `panels.update` from the plugin itself — except for `seeded`,
          // which only this path may set: it is the host saying the row is the
          // manifest's shipped default and nothing has published over it yet.
          attached.data.updatePanel(pluginId, panel.id, {
            ...declared,
            seeded: true,
            schema,
            vocabVersion: manifest.vocabVersion,
          });
        } catch (error) {
          logger.warn("plugin.panel_seed_failed", {
            pluginId,
            panelId: panel.id,
            projectId: attached.binding.projectId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    // Then drop the rows this manifest no longer accounts for. AFTER the seed
    // loop, so a panel that is both declared and already published is rewritten
    // rather than deleted-and-reinserted, and outside it, so a manifest that
    // declares NO panels still retires every row the last one left behind.
    //
    // Reachable only past the `!manifest` guard at the top of this function
    // (and `reconcile`'s own, which skips a plugin whose manifest is null).
    // That guard is load-bearing for the prune in a way it is not for the
    // seed: a manifest that could not be read — a bad edit mid-`plugin dev`,
    // a half-written file, a reload that refused — leaves `installed.manifest`
    // null, and pruning against a manifest we do not have would read as "this
    // plugin declares nothing" and wipe a working plugin's panels off every
    // surface, on every client, over a transient bad read. No manifest means
    // no opinion about which panels are stale.
    const declaredPanelIds = manifest.panels.map((panel) => panel.id);
    for (const attached of projects.values()) {
      try {
        const pruned = attached.data.prunePanels(pluginId, declaredPanelIds);
        if (pruned.length > 0) {
          logger.info("plugin.panels_pruned", {
            pluginId,
            projectId: attached.binding.projectId,
            panelIds: pruned,
          });
        }
      } catch (error) {
        logger.warn("plugin.panel_prune_failed", {
          pluginId,
          projectId: attached.binding.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  /** Start a plugin without making the caller wait on — or fail with — it. */
  const startQuietly = (supervisor: PluginChildSupervisor): void => {
    void supervisor.start().catch((error: unknown) => {
      logger.warn("plugin.autostart_failed", {
        pluginId: supervisor.pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  /**
   * Bring running state in line with installed state.
   *
   * Two halves, and the second one is what makes a plugin visible at all:
   * supervisors for plugins that were disabled, removed or reloaded are
   * dropped, and every enabled plugin is then STARTED and has its declared
   * panels seeded. Nothing else starts a plugin except an explicit `invoke`, so
   * without this an installed plugin sat idle — no panels, no contributions,
   * nothing on any surface — until someone happened to invoke one of its
   * actions.
   *
   * `replacePanelsFor` names the ONE plugin whose code just changed, never a
   * blanket "replace everything": `reconcile` runs on install, and it also
   * runs a plain convergence pass over EVERY installed plugin (reload, enable,
   * project attach). A boolean here would clobber every OTHER plugin's live
   * panel content with its shipped default on somebody else's install — a
   * plugin that had published real data would flash back to its manifest
   * defaults because a second, unrelated plugin was installed.
   */
  const reconcile = (options?: { replacePanelsFor?: string }): void => {
    const installed = new Map(installs.list().map((plugin) => [plugin.record.pluginId, plugin]));
    for (const [pluginId, supervisor] of [...supervisors]) {
      const plugin = installed.get(pluginId);
      if (plugin && plugin.record.enabled && plugin.manifest && pluginHasRuntimeEntry(plugin.manifest)) {
        continue;
      }
      supervisors.delete(pluginId);
      void supervisor.dispose().catch((error: unknown) => {
        logger.warn("plugin.supervisor_dispose_failed", {
          pluginId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (disposed) return;
    for (const plugin of installed.values()) {
      if (!plugin.record.enabled || !plugin.manifest) continue;
      seedDeclaredPanels(plugin, options?.replacePanelsFor === plugin.record.pluginId);
      publishBrandIcons(plugin);
      if (!pluginHasRuntimeEntry(plugin.manifest)) continue;
      startQuietly(ensureSupervisor(plugin));
    }
  };

  /**
   * The tail every install-state change shares: bring running state in line,
   * tell the other machines, and answer with the plugin as it now is.
   */
  const applyInstallChange = (
    installed: PluginInstalledPlugin,
    options?: { replacePanelsFor?: string },
  ): PluginSummary => {
    reconcile(options);
    publishPresence();
    return toSummary(installed, runtimeStateFor(installed));
  };

  const requireInstalled = (pluginId: string): PluginInstalledPlugin => {
    const installed = installs.get(pluginId);
    if (!installed) throw new PluginSdkError("plugin_not_found", `Plugin "${pluginId}" is not installed.`);
    return installed;
  };

  /**
   * Page failures, per plugin, newest last. See `recordPageError` on the
   * service type for why they are kept apart from the child's own ring.
   *
   * Bounded per plugin: a page in a render loop reports the first handful and
   * then stops (the guest preload rate-limits itself), and this cap is the
   * second line of defence for a plugin drawn in six placements at once.
   */
  const pageErrors = new Map<string, PluginLogEntry[]>();

  const recordPageErrorForPlugin = (args: {
    pluginId: string;
    kind: string;
    message: string;
    source?: string;
  }): void => {
    const pluginId = typeof args?.pluginId === "string" ? args.pluginId.trim() : "";
    const message = typeof args?.message === "string" ? args.message.trim() : "";
    if (!pluginId || !message) return;
    const ring = pageErrors.get(pluginId) ?? [];
    ring.push({
      at: new Date().toISOString(),
      level: "error",
      message,
      // `source: "page"` is what tells `ade plugin doctor` this line came from
      // a guest rather than from the child, and `kind` is what lets it count
      // CSP violations apart from ordinary throws.
      fields: {
        source: "page",
        kind: args.kind === "csp" ? "csp" : "error",
        ...(args.source ? { blocked: args.source } : {}),
      },
    });
    while (ring.length > PLUGIN_PAGE_ERROR_RING_MAX) ring.shift();
    pageErrors.set(pluginId, ring);
  };

  const detailFor = (installed: PluginInstalledPlugin): PluginDetail => {
    const supervisor = supervisors.get(installed.record.pluginId);
    return {
      ...toSummary(installed, runtimeStateFor(installed)),
      manifest: installed.manifest,
      settings: installed.manifest?.settings ?? [],
      config: configFor(installed.record.pluginId, installed.manifest),
      root: installed.root,
      // The child's lines and the pages' merged into one log, in time order.
      // One list because the reader has one question — "what went wrong with
      // this plugin" — and a page that failed while the child was healthy is
      // exactly the case a second list would hide.
      logs: mergePluginLogs(
        supervisor ? supervisor.logs() : ([] as PluginLogEntry[]),
        pageErrors.get(installed.record.pluginId) ?? [],
      ),
      lastInvokes: lastInvokesFor(installed.record.pluginId),
      // Presence, never the value. The doctor needs to answer "is the key this
      // plugin declared actually connected", and that question is answerable
      // with a boolean — putting the key on a detail record would push a
      // credential through the action layer and into every reader of it.
      providerKeys: (installed.manifest?.providerKeys ?? []).map((provider) => ({
        provider,
        present: readProviderKey(provider) !== null,
      })),
    };
  };

  const domainService = (projectId: string | null): PluginDomainService => {
    const scopedProject = (): AttachedProject | null => (
      projectId ? projects.get(projectId) ?? null : anyProject()
    );
    const requireScopedProject = (): AttachedProject => requireAttached(scopedProject());
    const requireId = (value: unknown, field: string): string => {
      if (typeof value !== "string" || !value.trim()) {
        throw new PluginSdkError("invalid_args", `"${field}" is required.`);
      }
      return value;
    };

    /**
     * One invoke, from the gates through to the child's answer.
     *
     * Split out of `invoke` only so the attempt can be recorded around ALL of
     * it — a refusal is an attempt someone is trying to account for, and one
     * recorded only where the child answers reports "switched off" as though
     * nothing ever fired.
     */
    const runInvoke = async (
      pluginId: string,
      action: string,
      invokeArgs: {
        args?: Record<string, unknown>;
        argv?: string[];
        timeoutMs?: number;
        client?: "desktop" | "mobile";
      },
    ): Promise<unknown> => {
      const installed = requireInstalled(pluginId);
      if (!installed.record.enabled) {
        throw new PluginSdkError("plugin_disabled", `Plugin "${pluginId}" is disabled.`);
      }
      if (!installed.manifest || !pluginHasRuntimeEntry(installed.manifest)) {
        throw new PluginSdkError("plugin_no_entry", `Plugin "${pluginId}" ships no runtime entry.`);
      }
      // The per-contribution toggle has to hold HERE, not only where the
      // contribution is drawn. A menu that hides a disabled item stops one
      // route to the action; every other client, the phone, the CLI and a
      // stale renderer all reach this method directly, so a toggle enforced
      // only in the menu is a suggestion. See `pluginActionIsFullyDisabled`
      // for why a single disabled contribution is not enough to refuse.
      if (pluginActionIsFullyDisabled(
        installed.manifest,
        installed.record.disabledContributions,
        action,
      )) {
        throw new PluginSdkError(
          "not_permitted",
          `"${action}" is turned off for ${installed.manifest.displayName || pluginId} in its plugin settings.`,
        );
      }
      if (projectId) activeProjectByPlugin.set(pluginId, projectId);
      const supervisor = ensureSupervisor(installed);
      // Clamped again rather than trusted from the caller: this service is
      // also reached from the phone and the CLI, which do not go through the
      // desktop's preload normalizer.
      const timeoutMs = clampPluginInvokeTimeoutMs(invokeArgs.timeoutMs);
      // Which client is driving, for the length of this call only. A plugin
      // that begins a sign-in from a phone must get the transport the phone can
      // finish, and `beginAuthSession` runs inside `supervisor.invoke` below —
      // so the hint is set before it and cleared after, rather than kept as
      // per-plugin state that would outlive the call and mislead the next one.
      if (invokeArgs.client) invokingClient.set(pluginId, invokeArgs.client);
      let result: unknown;
      try {
        result = await supervisor.invoke(
          action,
          {
            ...(invokeArgs.args ?? {}),
            ...(invokeArgs.argv ? { argv: invokeArgs.argv } : {}),
          },
          timeoutMs ? { timeoutMs } : undefined,
        );
      } finally {
        invokingClient.delete(pluginId);
      }
      return stampAuthSessionResult(pluginId, result);
    };

    return {
      async invoke(invokeArgs) {
        const pluginId = invokeArgs?.pluginId;
        if (typeof pluginId !== "string" || !pluginId) {
          throw new PluginSdkError("invalid_args", '"pluginId" is required.');
        }
        // Either spelling: the manifest calls a handler `actionId`, so that is
        // what an author types here, and the refusal used to name only `action`.
        const action = readPluginInvokeAction(invokeArgs);
        if (!action) {
          throw new PluginSdkError("invalid_args", pluginInvokeActionMissingMessage());
        }
        // The host's own chat delivery rides this same frame under an `ade:`
        // action name, and the name is the ONLY thing that tells the two apart
        // on the child. So no caller through this door may spell one: a
        // published vocabulary node's `action`, a schedule, a remote command or
        // an agent tool could otherwise hand a child a forged `chat.turn`
        // naming any session it chose. The host's delivery does not come
        // through here — it calls `supervisor.invoke` directly — so closing
        // this door costs it nothing.
        if (isReservedPluginActionName(action)) {
          throw new PluginSdkError("not_permitted", reservedPluginActionMessage(action));
        }
        try {
          const result = await runInvoke(pluginId, action, invokeArgs);
          recordInvoke(pluginId, action, null);
          return result;
        } catch (error) {
          recordInvoke(pluginId, action, error instanceof PluginSdkError ? error.code : "plugin_error");
          throw error;
        }
      },

      async list(listArgs) {
        const includeDisabled = listArgs?.includeDisabled !== false;
        return installs
          .list()
          .filter((installed) => includeDisabled || installed.record.enabled)
          .map((installed) => toSummary(installed, runtimeStateFor(installed)));
      },

      async get(getArgs) {
        const installed = installs.get(getArgs.pluginId);
        return installed ? detailFor(installed) : null;
      },

      async marketplaceIndex(indexArgs): Promise<PluginMarketplaceIndex | null> {
        const result = await registry().fetchIndex(indexArgs?.refresh ? { refresh: true } : {});
        if (!result) return null;
        return { entries: result.entries, fetchedAt: result.fetchedAt, origin: result.origin };
      },

      async repoStars(starsArgs): Promise<number | null> {
        // The registry owns the URL check, the day-long cache and the rate-limit
        // degradation; there is deliberately nothing to add here. Null reaches
        // the client unchanged and is drawn as "unknown", never as zero.
        return registry().fetchRepoStars(starsArgs.repo);
      },

      async presence(): Promise<PluginPresenceMachineRow[]> {
        const attached = scopedProject();
        // No project database means no synced rows to read. Empty reads as
        // "this machine only", which is what the UI should show.
        if (!attached) return [];
        let localKey: string | null = null;
        try {
          localKey = machine.localMachineKey?.() ?? null;
        } catch {
          localKey = null;
        }
        const directory = new Map<string, { label?: string | null; online?: boolean }>();
        try {
          for (const entry of (await machine.listAccountMachines?.()) ?? []) {
            directory.set(entry.machineKey, { label: entry.label, online: entry.online });
          }
        } catch {
          // An unavailable directory costs names and reachability, not rows.
        }
        return readAllPluginPresence(attached.binding.db).map((row): PluginPresenceMachineRow => {
          const isThisMachine = localKey !== null && row.machineKey === localKey;
          const known = directory.get(row.machineKey);
          return {
            machineKey: row.machineKey,
            // Never invented: without a directory the key IS the name, which
            // reads as unfamiliar rather than as the wrong computer.
            machineName: known?.label?.trim() || (isThisMachine ? "This computer" : row.machineKey),
            pluginId: row.pluginId,
            version: row.version || null,
            enabled: row.enabled,
            // The machine answering is by definition reachable from itself.
            online: isThisMachine ? true : known?.online === true,
            isThisMachine,
          };
        });
      },

      async listContributions(contributionArgs): Promise<PluginContributionRecord[]> {
        // Named with its options rather than through the bare `requireId`.
        // "Show me those rows" is the natural next call after the doctor's
        // Places rung counts them, and `"surface" is required.` left the reader
        // to guess the vocabulary — the ids are a closed set, so listing them
        // costs one line and saves a round trip to the source.
        const surfaceInput = contributionArgs?.surface;
        if (typeof surfaceInput !== "string" || !surfaceInput.trim()) {
          throw new PluginSdkError(
            "invalid_args",
            `"surface" is required — contributions are listed one surface at a time.`
            + ` Pass one of: ${PLUGIN_SURFACE_IDS.join(", ")}.`,
          );
        }
        // Every socket a manifest declares is already restricted to
        // `PLUGIN_SURFACE_IDS` by the manifest parser, so an unrecognized
        // `surface` here can never match one and `declared` would end up
        // empty anyway — but that is an accident of the filter below, not a
        // guarantee this function makes. Checking directly is what makes it one.
        if (!isPluginSurfaceId(surfaceInput)) return [];
        const surface = surfaceInput;
        const attached = scopedProject();
        if (!attached) return [];
        // Manifest sockets are the join: the table stores a socket KIND, and
        // which surface that kind renders on is per-plugin manifest detail.
        // Built once per call rather than per row — a Lanes list asks for this
        // on every render, and a plugin declares a handful of sockets.
        //
        // The key joins plugin id, socket kind and SOCKET ID on NULs, which none
        // of them can contain, so no triple can ever collide into one entry.
        // Written as the ESCAPE, never as a literal NUL byte: a source file
        // holding one is binary to git, which stops diffing it and hides every
        // later change to this function.
        //
        // Keying on the socket id is what makes two declarations of one kind
        // independent. Keyed on `pluginId + kind` alone, a plugin declaring two
        // badges on Lanes collapsed to whichever it declared LAST, and every
        // published badge row was then stamped with that arbitrary winner's
        // `socketId` and its `enabled` flag — so the per-contribution toggle for
        // one badge could hide the other's rows, and the phone (which resolves
        // per declaration) disagreed with this machine about what was on screen.
        const declared = new Map<string, { socketId: string; enabled: boolean }>();
        // The unambiguous case, kept apart: a row naming no socket id can only
        // be resolved when its kind was declared exactly ONCE. Set to null the
        // moment a second declaration of that kind lands, which is what lets the
        // row loop tell "ambiguous" apart from "never declared".
        const soleByKind = new Map<string, { socketId: string; enabled: boolean } | null>();
        for (const installed of installs.list()) {
          if (!installed.record.enabled || !installed.manifest) continue;
          const off = new Set(installed.record.disabledContributions ?? []);
          for (const socket of installed.manifest.sockets) {
            if (socket.surface !== surface) continue;
            const declaration = { socketId: socket.id, enabled: !off.has(socket.id) };
            declared.set(
              `${installed.record.pluginId}\u0000${socket.socket}\u0000${socket.id}`,
              declaration,
            );
            const kindKey = `${installed.record.pluginId}\u0000${socket.socket}`;
            soleByKind.set(kindKey, soleByKind.has(kindKey) ? null : declaration);
          }
        }
        if (declared.size === 0) return [];
        // Warned once per (plugin, kind), not once per row: a surface asks for
        // this on every render and a plugin may publish hundreds of rows, so an
        // un-deduped warning would be the loudest thing in the log.
        const warnedAmbiguous = new Set<string>();
        const rows = readPluginContributions(attached.binding.db, {
          entityKind: contributionArgs.entityKind ?? null,
          entityIds: contributionArgs.entityIds ?? null,
        });
        const results: PluginContributionRecord[] = [];
        for (const row of rows) {
          // Parsed BEFORE the declaration join, because the payload is what
          // names the declaration: a row carrying `id` is addressed to one
          // specific socket the plugin declared, and joining on the kind alone
          // would throw that away before reading it.
          let payload: unknown = null;
          try {
            payload = JSON.parse(row.payloadJson) as unknown;
          } catch {
            payload = null;
          }
          const declaredId = isRecord(payload) && typeof payload.id === "string"
            ? payload.id.trim()
            : "";
          const kindKey = `${row.pluginId}\u0000${row.socket}`;
          let match: { socketId: string; enabled: boolean } | undefined;
          if (declaredId) {
            // Addressed: it resolves to that declaration or to nothing. A row
            // naming a socket id the plugin no longer declares is stale, and
            // adopting a different one would move it to a slot its author never
            // chose.
            match = declared.get(`${kindKey}\u0000${declaredId}`);
          } else {
            const sole = soleByKind.get(kindKey);
            // `null` means the plugin declared this kind more than once, so
            // there is no non-arbitrary answer. Left unmatched deliberately —
            // guessing is what produced the bug this branch fixes — and the
            // author is told, because only they can add the id.
            if (sole === null && !warnedAmbiguous.has(kindKey)) {
              warnedAmbiguous.add(kindKey);
              logger.warn("plugin.contribution_id_ambiguous", {
                pluginId: row.pluginId,
                socket: row.socket,
                surface,
                entityKind: row.entityKind,
                reason: "published_row_has_no_id_and_kind_is_declared_more_than_once",
              });
            }
            match = sole ?? undefined;
          }
          // Disabled plugins, switched-off sockets and rows left behind by a
          // plugin that stopped declaring a socket all drop out here, so no
          // caller has to re-derive any of it.
          if (!match || !match.enabled) continue;
          // `row.socket` matching a `declared` key already implies it is one
          // of `PLUGIN_SOCKET_KINDS` -- `declared`'s keys come from a parsed
          // manifest, which only ever carries those -- but `entityKind` has
          // no such indirect guarantee: it comes straight off the row with
          // nothing upstream restricting it to the closed union. A row from a
          // future entity kind this build predates, or a corrupted one, is
          // dropped rather than handed to a renderer as a value it has no
          // case for.
          if (!isPluginEntityKind(row.entityKind) || !isPluginSocketKind(row.socket)) continue;
          results.push({
            entityKind: row.entityKind,
            entityId: row.entityId,
            pluginId: row.pluginId,
            socket: row.socket,
            surface,
            socketId: match.socketId,
            payload,
            updatedAt: row.updatedAt || null,
          });
        }
        return results;
      },

      async getManifest(manifestArgs): Promise<PluginManifest | null> {
        return installs.get(requireId(manifestArgs?.pluginId, "pluginId"))?.manifest ?? null;
      },

      async openLogs(logArgs): Promise<PluginLogEntry[]> {
        const pluginId = requireId(logArgs?.pluginId, "pluginId");
        requireInstalled(pluginId);
        // The ring buffer lives on the supervisor, so a plugin that has never
        // started has no CHILD lines rather than an error — "nothing logged
        // yet" is the honest answer for an idle plugin. Its pages can still
        // have failed, and those lines are kept here rather than on the
        // supervisor precisely so they survive a plugin that never started.
        return mergePluginLogs(
          supervisors.get(pluginId)?.logs() ?? [],
          pageErrors.get(pluginId) ?? [],
        );
      },

      async getReadme(readmeArgs): Promise<string | null> {
        const installed = installs.get(requireId(readmeArgs?.pluginId, "pluginId"));
        if (!installed) return null;
        return readPluginReadme(installed.root);
      },

      async inspectSource(inspectArgs): Promise<PluginSourceInspection | null> {
        const source = requireId(inspectArgs?.source, "source").trim();
        // A local directory (or an already-installed plugin's root) can be read
        // here and now. A remote source is reported as itself with no manifest:
        // fetching one would mean cloning, and inspecting must never be the
        // step that puts code on the machine.
        const local = readManifestFromDirectory(source);
        return { source, manifest: local };
      },

      async setContributionEnabled(contributionArgs): Promise<PluginSummary> {
        const pluginId = requireId(contributionArgs?.pluginId, "pluginId");
        const socketId = requireId(contributionArgs?.socketId, "socketId");
        requireInstalled(pluginId);
        const installed = installs.setContributionEnabled(
          pluginId,
          socketId,
          contributionArgs.enabled !== false,
        );
        return toSummary(installed, runtimeStateFor(installed));
      },

      async getPanel(panelArgs): Promise<PluginPanelRecord | null> {
        const pluginId = requireId(panelArgs?.pluginId, "pluginId");
        const panelId = requireId(panelArgs?.panelId, "panelId");
        return requireScopedProject().data.readPanel(pluginId, panelId);
      },

      async getCollection(collectionArgs): Promise<PluginCollectionRow[]> {
        const pluginId = requireId(collectionArgs?.pluginId, "pluginId");
        const collection = requireId(collectionArgs?.collection, "collection");
        return requireScopedProject().data.listCollection(pluginId, collection, {
          ...(collectionArgs.keyPrefix === undefined ? {} : { keyPrefix: collectionArgs.keyPrefix }),
          ...(collectionArgs.limit === undefined ? {} : { limit: collectionArgs.limit }),
        });
      },

      async setConfig(configArgs): Promise<PluginDetail> {
        const pluginId = requireId(configArgs?.pluginId, "pluginId");
        const installed = requireInstalled(pluginId);
        applyStoredConfig({
          pluginsRoot: installs.root,
          pluginId,
          declared: installed.manifest?.settings ?? [],
          values: configArgs?.values ?? {},
          // ADE's own form is where a `secret` setting is typed, so this path
          // still accepts one. `ade.config.set` does not — see
          // `applyStoredConfig`.
          refuseSecrets: false,
        });
        // The child is handed its config at spawn, so a running one keeps the
        // old values until it is replaced. `reconcile` then brings it back with
        // the values the user just typed — a plugin that stayed stopped after a
        // settings change would read as the change having broken it.
        await stopSupervisor(pluginId);
        reconcile();
        return detailFor(requireInstalled(pluginId));
      },

      async install(installArgs) {
        // The stop-before-rename that used to live here only ever worked for a
        // local-directory source, because that was the only kind whose plugin
        // id `pluginHostService` could learn before `installs.install` ran —
        // a git source reveals its id only after cloning. `installs.install`
        // now runs the same stop for every source kind itself, through
        // `beforeReplace` (wired below), between parsing the manifest and
        // renaming the directory into place.
        let installed: PluginInstalledPlugin;
        try {
          installed = await installs.install(installArgs);
        } catch (error) {
          // A failed install (bad manifest, unsupported ADE version, checksum
          // mismatch) can still have stopped the plugin's OLD child via
          // `beforeReplace` before it failed. Reconcile so a plugin that
          // failed to upgrade comes back up on whatever code is still on disk
          // rather than sitting stopped with nothing to explain why.
          reconcile();
          throw error;
        }
        // Unconditional, not "only if this install learned a different id than
        // it stopped before renaming": a supervisor for the installed id must
        // not survive past this point regardless of how it got here — whether
        // `beforeReplace` already stopped it, or a concurrent call (another
        // `invoke`, another `reconcile`) resurrected one in the window while
        // this install was staging. `stopSupervisor` is a no-op if none runs.
        await stopSupervisor(installed.record.pluginId);
        return applyInstallChange(installed, { replacePanelsFor: installed.record.pluginId });
      },

      async uninstall(uninstallArgs) {
        await stopSupervisor(uninstallArgs.pluginId);
        const result = installs.uninstall(uninstallArgs.pluginId);
        await cleanupUninstalledPluginData(uninstallArgs.pluginId);
        publishPresence();
        return result;
      },

      async enable(enableArgs) {
        return applyInstallChange(installs.setEnabled(enableArgs.pluginId, true));
      },

      async disable(disableArgs) {
        return applyInstallChange(installs.setEnabled(disableArgs.pluginId, false));
      },

      async usageSummary(usageArgs): Promise<PluginUsageSummary> {
        const attached = scopedProject();
        if (attached) {
          const summary = attached.data.usage(usageArgs?.pluginId);
          return mergeWireUsage(summary, attached.binding.syncMeter ?? null, usageArgs?.pluginId ?? null);
        }
        // No project attached: report the budgets so the UI can still render
        // its meters rather than showing a broken card.
        return {
          entries: [],
          budgets: {
            collectionBytesPerPlugin: 0,
            collectionRowsPerPlugin: 0,
            contributionsPerPlugin: 0,
            panelsPerPlugin: 0,
          },
        };
      },

      /**
       * Webhook ingress health, for `ade plugin doctor` and the Marketplace
       * page.
       *
       * Answered from the attached project's drain, because that is where the
       * ledger and the relay cursor live. With NO project attached — a machine
       * scope, a client that has not opened one — the honest answer is the
       * declaration without the traffic: the URLs are still correct and still
       * worth showing, and reporting "nothing has arrived" would be a claim
       * nobody checked.
       */
      async webhookIngress(ingressArgs): Promise<PluginWebhookIngressStatus[]> {
        const ingress = scopedProject()?.binding.webhookIngress;
        if (ingress) return await ingress.getStatus(ingressArgs?.pluginId);
        const relayBaseUrl = "";
        const declared = listWebhookIngressPlugins();
        const rows = ingressArgs?.pluginId
          ? declared.filter((plugin) => plugin.pluginId === ingressArgs.pluginId)
          : declared;
        if (ingressArgs?.pluginId && rows.length === 0) {
          return [{
            pluginId: ingressArgs.pluginId,
            state: "undeclared",
            relayBaseUrl,
            channels: [],
            lastReceivedAt: null,
            lastPolledAt: null,
            lastError: null,
            pendingDeliveries: 0,
            abandonedDeliveries: 0,
          }];
        }
        return rows.map((plugin) => ({
          pluginId: plugin.pluginId,
          state: "unconfigured" as const,
          relayBaseUrl,
          channels: plugin.channels.map((channel) => ({
            channelId: channel.id,
            label: channel.label,
            ...(channel.description ? { description: channel.description } : {}),
            // Empty rather than a guessed URL. The relay base is per machine
            // and only a bound project scope knows which one this machine
            // uses; a URL invented here would be pasted into a third party and
            // then be wrong forever.
            url: "",
            verified: Boolean(channel.verify),
            lastReceivedAt: null,
          })),
          lastReceivedAt: null,
          lastPolledAt: null,
          lastError: null,
          pendingDeliveries: 0,
          abandonedDeliveries: 0,
        }));
      },

      async reload(reloadArgs) {
        await stopSupervisor(reloadArgs.pluginId);
        const before = installs.get(reloadArgs.pluginId)?.record.version ?? null;
        const installed = installs.reload(reloadArgs.pluginId);
        // The point of a reload is to run what is on disk NOW, panels included:
        // `ade plugin dev` edits a panel schema and expects the surface to
        // follow, so the declared schema replaces what the last run published.
        reconcile({ replacePanelsFor: reloadArgs.pluginId });
        // Only a version change is news for presence; the `ade plugin dev` loop
        // reloads constantly and republishing every time would be pure noise.
        if (installed.record.version !== before) publishPresence();
        return toSummary(installed, runtimeStateFor(installed));
      },
    };
  };

  /**
   * Install changes, delivered to running plugins as `sdk.events`.
   *
   * `events.on` is part of the documented SDK surface and the child already
   * dispatches `event` frames — nothing ever SENT one, so every listener a
   * plugin registered was dead. Coalesced because an install emits per plugin
   * and a `plugin install` of a package that replaces another produces a burst;
   * a plugin wants "the install set moved, re-read it", not one wake per row.
   */
  const PLUGIN_EVENT_COALESCE_MS = 250;
  /** Ids one payload carries. Past this the plugin should re-read the roster. */
  const PLUGIN_EVENT_MAX_IDS = 50;
  const pendingInstallIds = new Set<string>();
  let installEventTimer: ReturnType<typeof setTimeout> | null = null;

  const flushInstallEvent = (): void => {
    installEventTimer = null;
    const pending = [...pendingInstallIds];
    // Truncating silently used to mean a plugin that read only `ids` never
    // learned about the rest of a burst past the cap — the truncation was
    // invisible on the wire. `overflow` says so explicitly, so a listener
    // that only trusts `ids` at least knows it is trusting a partial list.
    const overflow = pending.length > PLUGIN_EVENT_MAX_IDS;
    const ids = pending.slice(0, PLUGIN_EVENT_MAX_IDS);
    pendingInstallIds.clear();
    for (const [pluginId, supervisor] of supervisors) {
      // Only a running child has an open stdin; `send` refuses the rest, and
      // one that is still starting reads its state at activation anyway.
      if (supervisor.status() !== "running") continue;
      supervisor.send({
        type: "event",
        payload: {
          event: "install.changed",
          ids,
          projectId: resolveProject(pluginId)?.binding.projectId ?? null,
          ...(overflow ? { overflow: true as const } : {}),
        },
      });
    }
  };

  /**
   * Lane, PR and session changes, delivered to running plugins as `sdk.events`.
   *
   * The other three quarters of the change-event family. `install.changed` had
   * a producer from the start and these did not, so a plugin subscribing to
   * `pr.changed` — which is the plugin skill's own worked example — registered
   * a listener and never heard anything.
   *
   * Same delivery contract as `install.changed`, deliberately: broadcast to
   * every running child (a change event is not filtered by subscription, see
   * `applyEventSubscription`), coalesced on the same window, capped at the same
   * id ceiling, and flagged `overflow` past it. One family per queue rather
   * than one shared queue, so a busy PR poll cannot push a lane id out of the
   * cap and leave a lane watcher looking at a truncated list it did not cause.
   *
   * `projectId` resolves through the same binding map the runtime hooks use, so
   * a change in a project no host has attached reports null rather than
   * borrowing whichever project happens to be attached.
   */
  const pendingEntityChanges = new Map<
    PluginChangeEventName,
    {
      ids: Set<string>;
      projectRoot: string | null;
      /**
       * One entry per id that reported a transition, in first-seen order.
       *
       * A Map rather than an array because coalescing has to MERGE rather than
       * append: a PR that goes draft → open → merged inside one 250 ms window
       * must arrive as one `{from: draft, to: merged}` and not as two rows a
       * reader would have to stitch back together. The first `from` is the
       * truth about where the window started, so it is never overwritten; `to`
       * is the truth about where it ended, so it always is.
       */
      transitions: Map<string, PluginPrTransition>;
    }
  >();
  let entityChangeTimer: ReturnType<typeof setTimeout> | null = null;

  const ENTITY_CHANGE_EVENT_NAMES: Record<PluginEntityChangeFamily, PluginChangeEventName> = {
    lane: "lane.changed",
    pr: "pr.changed",
    session: "session.changed",
  };

  const flushEntityChanges = (): void => {
    entityChangeTimer = null;
    const pending = [...pendingEntityChanges];
    pendingEntityChanges.clear();
    if (pending.length === 0) return;
    const running = [...supervisors].filter(([, supervisor]) => supervisor.status() === "running");
    if (running.length === 0) return;
    for (const [event, queue] of pending) {
      const all = [...queue.ids];
      const overflow = all.length > PLUGIN_EVENT_MAX_IDS;
      const ids = all.slice(0, PLUGIN_EVENT_MAX_IDS);
      // Dropped WHOLE on overflow rather than truncated alongside `ids`. A
      // transition list covering only the ids that fitted reads as complete —
      // "these are the ones that moved" — and would send a plugin acting on a
      // subset while believing it had the set. An overflowed delivery already
      // means "re-read the entities named here", and that instruction is the
      // same one a missing transition list gives.
      const transitions = overflow
        ? []
        : [...queue.transitions.values()].slice(0, PLUGIN_EVENT_MAX_IDS);
      const payload = {
        event,
        ids,
        projectId: projectIdForRoot(queue.projectRoot),
        ...(overflow ? { overflow: true as const } : {}),
        ...(transitions.length > 0 ? { transitions } : {}),
      };
      for (const [, supervisor] of running) {
        supervisor.send({ type: "event", payload });
      }
    }
  };

  const unsubscribeEntityChanges = subscribeToPluginEntityChanges((emission) => {
    if (disposed) return;
    const event = ENTITY_CHANGE_EVENT_NAMES[emission.family];
    const queue = pendingEntityChanges.get(event)
      ?? {
        ids: new Set<string>(),
        projectRoot: emission.projectRoot,
        transitions: new Map<string, PluginPrTransition>(),
      };
    for (const id of emission.ids) {
      const trimmed = id.trim();
      if (trimmed) queue.ids.add(trimmed);
    }
    for (const transition of emission.transitions ?? []) {
      const id = transition.id.trim();
      // An id the emission did not also name would put a transition in the
      // payload for an entity `ids` never mentions. The producer's contract
      // says that cannot happen; this is what makes it true rather than
      // assumed.
      if (!id || !queue.ids.has(id)) continue;
      const seen = queue.transitions.get(id);
      queue.transitions.set(id, {
        id,
        // First-seen `from` wins: it is where this window started, and the
        // second emission's `from` is only the first one's `to` restated.
        from: seen?.from ?? transition.from,
        to: transition.to,
      });
    }
    // Last writer names the project. Two checkouts changing inside one 250 ms
    // window is only possible on a machine running two brains, and the ids in
    // that payload are re-read against whatever the plugin is scoped to
    // anyway — a coalesced batch is a refetch hint, not a ledger.
    if (emission.projectRoot) queue.projectRoot = emission.projectRoot;
    pendingEntityChanges.set(event, queue);
    if (entityChangeTimer) return;
    entityChangeTimer = setTimeout(flushEntityChanges, PLUGIN_EVENT_COALESCE_MS);
    entityChangeTimer.unref?.();
  });

  const unsubscribePluginChanges = subscribeToPluginChanges((event) => {
    if (disposed) return;
    // A child that just (re)started has forgotten every listener it registered
    // and will register them again from `activate`. Dropping the host's copy
    // here is what keeps a crash-restart loop from leaving a plugin subscribed
    // to hooks its new process has no listener for — deliveries nobody reads,
    // charged to every turn on the machine.
    if (event.kind === "status" && event.pluginId && event.status !== "running") {
      hookSubscriptions.delete(event.pluginId);
      hookQueues.delete(event.pluginId);
      pushSubscriptions.delete(event.pluginId);
      return;
    }
    if (event.kind !== "installs") return;
    if (event.pluginId) pendingInstallIds.add(event.pluginId);
    if (installEventTimer) return;
    installEventTimer = setTimeout(flushInstallEvent, PLUGIN_EVENT_COALESCE_MS);
    installEventTimer.unref?.();
  });

  /**
   * Runtime hooks (`turn.start`, `turn.end`, `tool.before`), delivered to the
   * children that asked for them.
   *
   * Three properties, and every one of them is a requirement rather than a
   * tuning choice:
   *
   * 1. **Only to subscribers.** `tool.before` fires dozens of times in a single
   *    turn, and a machine can run several turns at once. Broadcasting them the
   *    way install events are broadcast would charge every running plugin one
   *    NDJSON line per tool call in every chat, to feed listeners that mostly
   *    do not exist. `events.subscribe` is what the child sends when
   *    `ade.events.on` registers the first listener for a kind, and a plugin
   *    that never asks is never written to.
   * 2. **Off the emitter's stack.** The bus is called from inside the chat
   *    service's commit path. Queueing here and writing on a later tick means
   *    the turn loop never pays for a `stdin.write`, however many children are
   *    running.
   * 3. **Drops, never backpressures.** A child that has stopped reading its
   *    stdin — wedged in a synchronous loop, stopped at a debugger — would
   *    otherwise grow the pipe's buffer without limit, because `write` keeps
   *    accepting data long after the far end stopped taking it. Past
   *    {@link PLUGIN_RUNTIME_HOOK_QUEUE_MAX} queued frames, or on the first
   *    `write` that reports the buffer full, this plugin's queue is discarded
   *    and the count logged. Losing a plugin's telemetry is the correct trade
   *    against holding the user's turns hostage to it, and observe-only is
   *    exactly the tier where that trade is safe to make.
   */
  const PLUGIN_RUNTIME_HOOK_QUEUE_MAX = 256;
  /** Per plugin: which hook kinds its current child registered a listener for. */
  /**
   * Which droppable event kinds each child registered a listener for.
   *
   * Holds the runtime hooks AND the two presence events, because they share one
   * queue and one delivery contract: fire-and-forget, filtered by subscription,
   * dropped rather than backpressured. The reliable chat events (`chat.turn`,
   * `chat.interrupt`) are NOT in here — they go out as `invoke` frames, and a
   * plugin that declared a chat runtime must answer them whether or not it also
   * asked to hear about presence.
   */
  const hookSubscriptions = new Map<string, Set<PluginRuntimeHookName | PluginChatRuntimeEventName>>();
  /** The same, for the push events. Cleared on a restart alongside the hooks. */
  const pushSubscriptions = new Map<string, Set<PluginPushEventName>>();
  const hookQueues = new Map<
    string,
    { frames: (PluginRuntimeHookPayload | PluginChatRuntimeEventPayload)[]; dropped: number }
  >();
  let hookFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Record what a child listens for.
   *
   * Handled in the host rather than in `pluginSdkServer` because the answer is
   * fan-out state — it belongs beside the queue that reads it, not beside the
   * collections and secrets the SDK server owns. An unknown event name is
   * refused rather than ignored: a plugin that typo'd a kind would otherwise
   * subscribe successfully and wait forever for an event that does not exist.
   */
  const applyEventSubscription = (pluginId: string, params: Record<string, unknown>): null => {
    const event = params.event;
    if (!isPluginEventName(event)) {
      throw new PluginSdkError("invalid_args", `Unknown event name: ${String(event)}`);
    }
    // Push events are filtered on the way out for the same reason the hooks
    // are, and for one more: a webhook delivery is only ACKED by a child that
    // listens, so writing one to a child with no listener would burn an
    // attempt against a plugin that could never have answered.
    if (isPluginPushEventName(event)) {
      const subscribed = params.subscribed !== false;
      const existing = pushSubscriptions.get(pluginId);
      if (subscribed) {
        if (existing) existing.add(event);
        else pushSubscriptions.set(pluginId, new Set<PluginPushEventName>([event]));
        return null;
      }
      if (!existing) return null;
      existing.delete(event);
      if (!existing.size) pushSubscriptions.delete(pluginId);
      return null;
    }
    // The change events are broadcast to every running child and always have
    // been; recording them costs nothing and keeps the child's `events.on` free
    // of a per-kind special case, but only the hooks are filtered on the way
    // out. Narrowing the change events to subscribers would be a behaviour
    // change for shipped plugins, and it is not this one.
    // The two presence events join the hooks in the same map: same queue, same
    // drop-rather-than-wait contract, same "nobody asked, nobody is written to"
    // rule. `chat.turn` and `chat.interrupt` fall through to the change-event
    // branch below and record nothing, because their delivery does not consult
    // this map at all.
    if (!isPluginRuntimeHookName(event) && event !== "chat.opened" && event !== "chat.closed") return null;
    const subscribed = params.subscribed !== false;
    const existing = hookSubscriptions.get(pluginId);
    if (subscribed) {
      if (existing) existing.add(event);
      else hookSubscriptions.set(pluginId, new Set<PluginRuntimeHookName | PluginChatRuntimeEventName>([event]));
      return null;
    }
    if (!existing) return null;
    existing.delete(event);
    if (!existing.size) hookSubscriptions.delete(pluginId);
    return null;
  };

  const flushRuntimeHooks = (): void => {
    hookFlushTimer = null;
    for (const [pluginId, queue] of [...hookQueues]) {
      hookQueues.delete(pluginId);
      const supervisor = supervisors.get(pluginId);
      // No child to tell. Not a drop worth logging: the plugin was not running,
      // so nothing it asked for was lost — it never saw the turn at all.
      if (!supervisor || supervisor.status() !== "running") continue;
      for (let index = 0; index < queue.frames.length; index += 1) {
        if (supervisor.send({ type: "event", payload: queue.frames[index]! })) continue;
        // `write` returned false: the child is not draining. Stop here rather
        // than queueing more into a buffer nobody is emptying. THIS frame was
        // accepted into that buffer and will arrive if the child ever reads
        // again, so the drop count starts after it — an over-reported count in
        // this log would send whoever reads it looking for a bug that is not
        // there.
        queue.dropped += queue.frames.length - index - 1;
        break;
      }
      if (queue.dropped > 0) {
        logger.warn("plugin.runtime_hooks_dropped", { pluginId, dropped: queue.dropped });
      }
    }
  };

  /**
   * Installed, ENABLED plugins that declare at least one webhook channel.
   *
   * Enabled matters: a disabled plugin has no child, so a drain that kept
   * polling for it would accumulate deliveries nobody can ack until they are
   * abandoned. Its relay registration is left alone — disabling a plugin is
   * not uninstalling it, and a user who re-enables it should not have to
   * re-paste the URL into the third party.
   */
  const listWebhookIngressPlugins = (): {
    pluginId: string;
    channels: PluginManifestWebhookIngressChannel[];
  }[] => {
    const rows: { pluginId: string; channels: PluginManifestWebhookIngressChannel[] }[] = [];
    for (const installed of installs.list()) {
      if (!installed.record.enabled) continue;
      const channels = installed.manifest?.webhookIngress ?? [];
      if (channels.length === 0) continue;
      rows.push({ pluginId: installed.record.pluginId, channels });
    }
    return rows;
  };

  /**
   * Write one webhook to a plugin's child.
   *
   * Synchronous and unqueued, unlike the runtime hooks: a webhook arrives at
   * most PLUGIN_WEBHOOK_DELIVERIES_PER_TICK times per plugin per 45 seconds, so
   * the batching that `tool.before` needs would only add a tick of latency to
   * the thing the whole feature exists to make fast. The `send` refusal that
   * matters — a child that has stopped draining its stdin — comes back as
   * `false` and the drain simply tries again next tick.
   */
  const deliverWebhookEvent = (pluginId: string, payload: PluginWebhookPayload): boolean => {
    if (!pushSubscriptions.get(pluginId)?.has(payload.event)) return false;
    const supervisor = supervisors.get(pluginId);
    if (!supervisor || supervisor.status() !== "running") return false;
    return supervisor.send({ type: "event", payload });
  };

  const queueRuntimeHook = (
    pluginId: string,
    payload: PluginRuntimeHookPayload | PluginChatRuntimeEventPayload,
  ): void => {
    let queue = hookQueues.get(pluginId);
    if (!queue) {
      queue = { frames: [], dropped: 0 };
      hookQueues.set(pluginId, queue);
    }
    if (queue.frames.length >= PLUGIN_RUNTIME_HOOK_QUEUE_MAX) {
      queue.dropped += 1;
      return;
    }
    queue.frames.push(payload);
    if (hookFlushTimer) return;
    hookFlushTimer = setTimeout(flushRuntimeHooks, 0);
    hookFlushTimer.unref?.();
  };

  /**
   * The turn's project, as the plugin surface spells it.
   *
   * Resolved from the checkout the chat service reported against this host's
   * own bindings, because those are the two ends of the same fact and only the
   * host holds both. A turn in a project nothing is bound to answers null
   * rather than borrowing whichever project the plugin happens to be scoped to
   * — a hook that named the wrong project would be worse than one that named
   * none.
   */
  const projectIdForRoot = (projectRoot: string | null): string | null => {
    if (!projectRoot) return null;
    for (const attached of projects.values()) {
      if (attached.binding.projectRoot === projectRoot) return attached.binding.projectId;
    }
    return null;
  };

  const toRuntimeHookPayload = (
    emission: PluginRuntimeHookEmission,
    projectId: string | null,
  ): PluginRuntimeHookPayload | null => {
    const base = { sessionId: emission.sessionId, projectId, runtime: emission.runtime };
    switch (emission.event) {
      case "turn.start":
        return { ...base, event: "turn.start", ...(emission.model ? { model: emission.model } : {}) };
      case "turn.end":
        return {
          ...base,
          event: "turn.end",
          outcome: emission.outcome ?? "completed",
          ...(emission.durationMs != null ? { durationMs: emission.durationMs } : {}),
        };
      case "tool.before":
        return emission.toolName
          ? { ...base, event: "tool.before", toolName: emission.toolName }
          : null;
    }
  };

  const unsubscribeRuntimeHooks = subscribeToPluginRuntimeHooks((emission) => {
    if (disposed || !hookSubscriptions.size) return;
    let payload: PluginRuntimeHookPayload | null = null;
    for (const [pluginId, kinds] of hookSubscriptions) {
      if (!kinds.has(emission.event)) continue;
      // Built once, on the first interested plugin, and never at all when none
      // is — the common case for `tool.before` on a machine whose plugins only
      // watch turn boundaries.
      payload ??= toRuntimeHookPayload(emission, projectIdForRoot(emission.projectRoot));
      if (!payload) return;
      queueRuntimeHook(pluginId, payload);
    }
  });

  /**
   * The plugin child a bound chat session belongs to, ready to be invoked.
   *
   * Every refusal here is a `PluginSdkError` the chat service turns into a
   * visibly failed turn, because every one of them means the user's message has
   * nowhere to go: the plugin was uninstalled, disabled, updated with that
   * runtime removed, or ships no code at all. A silent no-op would leave a
   * spinner running forever over a conversation nobody is listening to.
   */
  const requireChatRuntimeChild = (ref: AgentChatRuntimeRef): {
    supervisor: PluginChildSupervisor;
    runtime: PluginManifestChatRuntime;
  } => {
    const installed = installs.get(ref.pluginId);
    if (!installed || !installed.record.enabled) {
      throw new PluginSdkError(
        "plugin_not_found",
        `The plugin that runs this conversation ("${ref.pluginId}") is not installed.`,
      );
    }
    const runtime = findPluginChatRuntime(installed.manifest, ref.runtimeId);
    if (!runtime) {
      throw new PluginSdkError(
        "unsupported_method",
        `Plugin "${ref.pluginId}" no longer serves the "${ref.runtimeId}" conversation runtime.`,
      );
    }
    return { supervisor: ensureSupervisor(installed), runtime };
  };

  /**
   * How the chat service reaches a plugin. See `pluginChatRuntime.ts`.
   *
   * Turns and interrupts ride `invoke` — the request/response frame — so a
   * stopped child is STARTED for them and a failure is a rejection the user
   * sees. Presence rides the droppable queue beside the runtime hooks, which is
   * the right contract for a hint: missing one costs a poll interval, and a
   * plugin that has stopped draining its stdin must not be able to hold a
   * mounting chat pane open while the host waits on it.
   */
  const detachChatRuntimeDelivery = setPluginChatRuntimeDelivery({
    async deliverTurn(turn) {
      if (disposed) throw new PluginSdkError("plugin_crashed", "ADE is shutting down.");
      const { supervisor, runtime } = requireChatRuntimeChild(turn.ref);
      if (turn.followUp && !runtime.capabilities.followUp) {
        throw new PluginSdkError(
          "not_permitted",
          `"${runtime.displayName}" conversations do not take follow-up messages.`,
        );
      }
      await supervisor.invoke(pluginChatDeliveryAction("chat.turn"), {
        event: "chat.turn",
        sessionId: turn.sessionId,
        projectId: projectIdForRoot(turn.projectRoot),
        runtimeId: turn.ref.runtimeId,
        externalId: turn.ref.externalId,
        turnId: turn.turnId,
        message: turn.message,
        attachments: turn.attachments,
        followUp: turn.followUp,
      } satisfies Extract<PluginChatRuntimeEventPayload, { event: "chat.turn" }> & Record<string, unknown>, {
        // A conversation runtime is usually a network call to somebody else's
        // API, so the default action budget is too tight. The plugin is
        // expected to return as soon as it has DISPATCHED the turn and stream
        // the reply back through `ade.chat.appendAssistant`, not to hold this
        // open for the whole answer.
        timeoutMs: PLUGIN_CHAT_TURN_DISPATCH_TIMEOUT_MS,
      });
    },
    async deliverInterrupt(interrupt) {
      if (disposed) return;
      const { supervisor, runtime } = requireChatRuntimeChild(interrupt.ref);
      if (!runtime.capabilities.interrupt) {
        throw new PluginSdkError(
          "not_permitted",
          `"${runtime.displayName}" conversations cannot be stopped from ADE.`,
        );
      }
      await supervisor.invoke(pluginChatDeliveryAction("chat.interrupt"), {
        event: "chat.interrupt",
        sessionId: interrupt.sessionId,
        projectId: projectIdForRoot(interrupt.projectRoot),
        runtimeId: interrupt.ref.runtimeId,
        externalId: interrupt.ref.externalId,
        turnId: interrupt.turnId,
      } satisfies Extract<PluginChatRuntimeEventPayload, { event: "chat.interrupt" }> & Record<string, unknown>, {
        timeoutMs: PLUGIN_CHAT_INTERRUPT_TIMEOUT_MS,
      });
    },
    notifyPresence(presence) {
      if (disposed) return;
      const kinds = hookSubscriptions.get(presence.ref.pluginId);
      const event = presence.watching ? "chat.opened" : "chat.closed";
      // Same subscription rule the runtime hooks follow: a child that never
      // registered a listener is never written to. A plugin that polls on a
      // schedule instead of on presence costs the host nothing.
      if (!kinds?.has(event)) return;
      queueRuntimeHook(presence.ref.pluginId, {
        event,
        sessionId: presence.sessionId,
        projectId: projectIdForRoot(presence.projectRoot),
        runtimeId: presence.ref.runtimeId,
        externalId: presence.ref.externalId,
        watching: presence.watching,
      } as PluginChatRuntimeEventPayload);
    },
    describe(ref) {
      const installed = installs.get(ref.pluginId);
      if (!installed || !installed.record.enabled) return null;
      const runtime = findPluginChatRuntime(installed.manifest, ref.runtimeId);
      if (!runtime) return null;
      return {
        displayName: runtime.displayName,
        ...(runtime.icon ? { icon: runtime.icon } : {}),
        pluginDisplayName: installed.manifest?.displayName ?? ref.pluginId,
        capabilities: runtime.capabilities,
      };
    },
  });

  const storeFor = (binding: PluginProjectBinding): PluginDataStore => createPluginDataStore({
    db: binding.db,
    ...(binding.onPluginDataChanged ? { onCollectionChanged: binding.onPluginDataChanged } : {}),
  });

  return {
    setMachineContext(context) {
      machine = { ...machine, ...context };
    },

    attachProject(binding) {
      const existing = projects.get(binding.projectId);
      if (existing) {
        existing.attachCount += 1;
        // Rebind: a project reopened after a runtime restart carries a new db
        // handle, and holding the closed one would throw on the next write.
        existing.binding = binding;
        existing.data = storeFor(binding);
      } else {
        projects.set(binding.projectId, {
          binding,
          data: storeFor(binding),
          attachCount: 1,
        });
      }
      // The first project to bind is what makes plugin data writable at all, so
      // this is where enabled plugins start and declared panels materialize.
      // Both are idempotent, so a second project binding costs a no-op pass.
      reconcile();
      return { detach: () => detachProject(binding.projectId) };
    },
    listWebhookIngressPlugins,
    deliverWebhookEvent,
    secretsForWebhookIngress: () => ({
      get: (pluginId, name) => secrets.get(pluginId, name),
      set: (pluginId, name, value) => secrets.set(pluginId, name, value),
    }),
    completeAuthSessionCallback: (params) => authSessions.completeAppCallback({ params }),
    domainService,
    rootFor(pluginId) {
      const installed = installs.get(pluginId);
      if (!installed || !installed.record.enabled) return null;
      return installed.root;
    },
    writeCollection: writeCollectionForPage,
    writeConfig: writeConfigForPage,
    recordPageError: recordPageErrorForPlugin,
    listChildPids() {
      return [...supervisors.values()]
        .map((supervisor) => supervisor.pid())
        .filter((pid): pid is number => typeof pid === "number");
    },
    skillRoots() {
      return installs.skillRoots();
    },
    listPresenceRows() {
      return installs.list().map(toPluginPresenceRow);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribePluginChanges();
      unsubscribeEntityChanges();
      unsubscribeRuntimeHooks();
      detachChatRuntimeDelivery();
      if (installEventTimer) {
        clearTimeout(installEventTimer);
        installEventTimer = null;
      }
      if (entityChangeTimer) {
        clearTimeout(entityChangeTimer);
        entityChangeTimer = null;
      }
      pendingEntityChanges.clear();
      if (hookFlushTimer) {
        clearTimeout(hookFlushTimer);
        hookFlushTimer = null;
      }
      hookSubscriptions.clear();
      hookQueues.clear();
      setPluginInstallService(null);
      setPluginActionInvoker(null);
      setPluginAuthSessionCompleter(null);
      setPluginPageHostService(null);
      // Before the children go: a timer that fired during teardown would call
      // `invoke` on a supervisor map that is about to be cleared, and start a
      // child the host has no way left to stop.
      schedules.dispose();
      const running = [...supervisors.values()];
      supervisors.clear();
      projects.clear();
      activeProjectByPlugin.clear();
      await Promise.allSettled(running.map((supervisor) => supervisor.dispose()));
    },
  };

  /** Detaching one project never tears down the machine-scoped host. */
  function detachProject(projectId: string): void {
    const attached = projects.get(projectId);
    if (!attached) return;
    attached.attachCount -= 1;
    if (attached.attachCount > 0) return;
    projects.delete(projectId);
    for (const [pluginId, active] of [...activeProjectByPlugin]) {
      if (active === projectId) activeProjectByPlugin.delete(pluginId);
    }
  }
}

let sharedHost: PluginHostService | null = null;

/** Machine-scoped singleton, mirroring `getSharedProductAnalyticsService`. */
export function getSharedPluginHostService(args: PluginHostServiceArgs): PluginHostService {
  if (!sharedHost) sharedHost = createHost(args);
  return sharedHost;
}

/**
 * Tear the machine-scoped host down: every child is asked to stop (so a
 * plugin's `deactivate` actually runs) before the process goes away.
 *
 * The daemon's own shutdown path calls this alongside the other machine-scoped
 * singletons; tests call it between cases.
 */
export async function disposeSharedPluginHostService(): Promise<void> {
  const host = sharedHost;
  sharedHost = null;
  await host?.dispose();
}
