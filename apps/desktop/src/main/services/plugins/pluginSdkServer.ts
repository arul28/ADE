import path from "node:path";

import type { Logger } from "../logging/logger";
import {
  isPluginProviderKeyId,
  pluginPanelShowsOnMobile,
  type PluginManifest,
  type PluginProviderKeyId,
} from "../../../shared/plugins/manifest";
import { isRecord } from "../../../shared/plugins/parse";
import {
  isPluginEntityKind,
  isPluginSocketKind,
  type PluginEntityKind,
  type PluginSocketKind,
} from "../../../shared/plugins/sockets";
import {
  assertPluginCollectionKey,
  assertPluginCollectionName,
  budgetExceeded,
  encodePluginJsonWithinBudget,
  isPluginCollectionIfFull,
  PluginSdkError,
  PLUGIN_COLLECTION_IF_FULL_MODES,
  PLUGIN_PANELS_MAX_PER_PLUGIN,
  PLUGIN_PANEL_SCHEMA_MAX_BYTES,
  isPluginAudioCaptureErrorCode,
  isReservedPluginSecretName,
  PLUGIN_WEBHOOK_DEFAULT_CHANNEL,
  isPluginNotificationTargetRequest,
  isReservedPluginCollection,
  PLUGIN_AUTOMATION_TRIGGER_BURST_WINDOW_MS,
  PLUGIN_AUTOMATION_TRIGGER_PAYLOAD_MAX_BYTES,
  PLUGIN_AUTOMATION_TRIGGERS_PER_BURST,
  isPluginChatStatusState,
  PLUGIN_CHAT_ARTIFACTS_MAX,
  PLUGIN_CHAT_HYDRATE_MAX_ENTRIES,
  PLUGIN_CHAT_PARTS_MAX,
  PLUGIN_CHAT_STATUS_STATES,
  PLUGIN_CHAT_TEXT_MAX_BYTES,
  PLUGIN_CHAT_WRITE_BURST_WINDOW_MS,
  PLUGIN_CHAT_WRITES_PER_SESSION_BURST,
  PLUGIN_CLIPBOARD_TEXT_MAX_BYTES,
  PLUGIN_MEMORY_COLLECTION,
  PLUGIN_NOTIFICATION_BODY_MAX_CHARS,
  PLUGIN_NOTIFICATION_TARGETS,
  PLUGIN_NOTIFICATION_TITLE_MAX_CHARS,
  pluginUtf8ByteLength,
  type PluginAudioClip,
  type PluginChatArtifact,
  type PluginChatAssistantChunk,
  type PluginChatPart,
  type PluginChatHydrateOptions,
  type PluginChatHydrateResult,
  type PluginChatSessionCreateInput,
  type PluginChatSessionRef,
  type PluginChatStatus,
  type PluginChatTranscriptEntry,
  type PluginChatUserAppend,
  type PluginCollectionPutOptions,
  type PluginFilePickerOptions,
  readPluginNotificationDeeplink,
  type PluginNotificationInput,
  type PluginNotificationResult,
  type PluginSchedule,
  type PluginSdkMethod,
} from "../../../shared/plugins/sdk";
import type { PluginDataStore } from "./pluginDataStore";
import type { PluginSecretStore } from "./pluginSecretStore";

function requireString(params: Record<string, unknown>, field: string): string {
  const value = params[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new PluginSdkError("invalid_args", `"${field}" must be a non-empty string.`);
  }
  return value;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new PluginSdkError("invalid_args", `"${field}" must be an object.`);
  return value;
}

/**
 * Read `collections.put`'s options frame.
 *
 * An absent frame returns `undefined` rather than `{}`, so the default path
 * reaches the store with the same argument list it had before the option
 * existed. An `ifFull` the host does not know is refused, never rounded down to
 * the default: a plugin that asked for eviction and got silent "fail" would
 * look correct until the day its collection filled, which is the exact failure
 * this option exists to remove.
 */
function readPutOptions(value: unknown): PluginCollectionPutOptions | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new PluginSdkError("invalid_args", '"options" must be an object.');
  const ifFull = value.ifFull;
  if (ifFull === undefined || ifFull === null) return undefined;
  if (!isPluginCollectionIfFull(ifFull)) {
    throw new PluginSdkError(
      "invalid_args",
      `"options.ifFull" must be one of ${PLUGIN_COLLECTION_IF_FULL_MODES.map((mode) => `"${mode}"`).join(", ")}.`,
    );
  }
  return { ifFull };
}

/**
 * The refusal a host answers `audio.captureClip` with when nothing on this
 * machine can record.
 *
 * One sentence, two callers: a host built without the capability at all (a
 * headless daemon, a CLI-only machine) and the daemon's own bridge, which
 * cannot know whether a desktop is attached until it tries. Both are the same
 * fact to the plugin — there is no microphone here — and it should not be able
 * to tell which layer said so.
 */
export function pluginAudioCaptureUnavailable(): PluginSdkError {
  return new PluginSdkError(
    "audio_capture_mic_unavailable",
    "This machine has no microphone ADE can record from.",
  );
}

/**
 * The refusal a host answers `notifications.post` with when it can reach
 * nobody.
 *
 * Same shape and same reasoning as {@link pluginAudioCaptureUnavailable}: a
 * host built without the capability (a headless daemon with no paired phone)
 * and a host whose every target turned out to be absent are the same fact to
 * the plugin — there is nowhere to show this — and it should not be able to
 * tell which layer said so.
 */
export function pluginNotificationUnavailable(): PluginSdkError {
  return new PluginSdkError(
    "notification_unavailable",
    "There is nowhere to show a notification on this machine right now.",
  );
}

/**
 * The refusal for the Electron-only verbs when no desktop is attached.
 *
 * `desktop_unavailable` rather than `unsupported_method`, because the method IS
 * supported — it is the desktop that is missing, and a plugin should retry when
 * one appears rather than conclude the host is too old to have the verb at all.
 */
export function pluginDesktopUnavailable(): PluginSdkError {
  return new PluginSdkError(
    "desktop_unavailable",
    "ADE Desktop is not running on this machine.",
  );
}

/**
 * The refusal when this host runs no scheduler.
 *
 * `unsupported_method` here, unlike the two above: a host without a scheduler
 * cannot grow one by the user opening a window, so "try again later" would be
 * wrong advice. A plugin should degrade to doing the work when it is next
 * invoked instead.
 */
export function pluginSchedulesUnavailable(): PluginSdkError {
  return new PluginSdkError(
    "unsupported_method",
    "This copy of ADE cannot run plugin schedules.",
  );
}

/**
 * The refusal when this host serves no chat sessions.
 *
 * `unsupported_method` rather than `not_permitted`: nothing was withheld from
 * the plugin. A host with no project bound — a machine-scoped call, a headless
 * build with no chat service — has no transcript for anybody to write to, and a
 * plugin should stop trying rather than read a permission failure as "this
 * session belongs to someone else" and go looking for a different one.
 */
export function pluginChatUnavailable(): PluginSdkError {
  return new PluginSdkError(
    "unsupported_method",
    "This copy of ADE cannot host plugin chat runtimes.",
  );
}

/**
 * The refusal when nothing here runs automation rules.
 *
 * `unsupported_method` for the same reason schedules use it: a host with no
 * automation engine — a machine-scoped call with no project bound, a build
 * without the feature — does not grow one because the plugin waited. The plugin
 * should treat its trigger as unobserved rather than retry it.
 */
export function pluginAutomationsUnavailable(): PluginSdkError {
  return new PluginSdkError(
    "unsupported_method",
    "This copy of ADE cannot run plugin automation triggers.",
  );
}

/**
 * The refusal when nothing here drains plugin webhooks.
 *
 * `unsupported_method`, like schedules and automations: a host with no project
 * scope bound has no ledger to hold a delivery in and no relay cursor to
 * advance, and it will not grow either because the plugin asked twice.
 */
export function pluginWebhookIngressUnavailable(): PluginSdkError {
  return new PluginSdkError(
    "unsupported_method",
    "This copy of ADE cannot receive webhooks for plugins.",
  );
}

/**
 * Carry a capture refusal's `code` across the child boundary.
 *
 * Everything between the microphone and here rejects with its own error class
 * — the renderer's `AudioCaptureFailure`, the broker's `AudioCaptureRefused`,
 * whatever the daemon bridge throws — and none of them are `PluginSdkError`,
 * which is the only shape the supervisor preserves a code from. Rather than
 * make every layer import a plugin type it has no other use for, the codes are
 * a shared vocabulary and this reads whichever one arrived.
 *
 * An unrecognized error is passed through untouched: a genuine crash should
 * reach the plugin as `internal_error`, not be dressed up as a capture outcome
 * the user never caused.
 */
export function asPluginAudioCaptureError(error: unknown): unknown {
  if (error instanceof PluginSdkError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (!isPluginAudioCaptureErrorCode(code)) return error;
  const message = error instanceof Error && error.message
    ? error.message
    : "The recording could not be completed.";
  return new PluginSdkError(code, message);
}

/**
 * Read one text field against the per-call transcript ceiling.
 *
 * Measured in UTF-8 BYTES, not characters, because the ceiling exists to bound
 * a wire frame and a disk write, and both count bytes. A plugin whose reply is
 * genuinely longer streams it — that is what `appendAssistant` chunking is for
 * — so this refuses a frame, never a conversation.
 */
function requireChatText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new PluginSdkError("invalid_args", `"${field}" must be a string.`);
  const bytes = pluginUtf8ByteLength(value);
  if (bytes > PLUGIN_CHAT_TEXT_MAX_BYTES) {
    throw budgetExceeded("chat_text", PLUGIN_CHAT_TEXT_MAX_BYTES, bytes);
  }
  return value;
}

function readChatParts(value: unknown, field: string): PluginChatPart[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new PluginSdkError("invalid_args", `"${field}" must be an array.`);
  if (value.length > PLUGIN_CHAT_PARTS_MAX) {
    throw budgetExceeded("chat_parts", PLUGIN_CHAT_PARTS_MAX, value.length);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new PluginSdkError("invalid_args", `"${field}[${index}]" must be an object.`);
    if (entry.kind === "text" || entry.kind === "thinking") {
      return { kind: entry.kind, text: requireChatText(entry.text, `${field}[${index}].text`) };
    }
    if (entry.kind === "tool") {
      const detail = entry.detail === undefined || entry.detail === null
        ? undefined
        : requireChatText(entry.detail, `${field}[${index}].detail`);
      return {
        kind: "tool" as const,
        name: requireString(entry, "name"),
        ...(detail !== undefined ? { detail } : {}),
      };
    }
    throw new PluginSdkError("invalid_args", `"${field}[${index}].kind" must be "text", "thinking" or "tool".`);
  });
}

/**
 * Refuse an artifact path that leaves the lane.
 *
 * The plugin already has the filesystem, so this is not a containment boundary
 * — it is an honesty one. The proof-artifact card renders these as "files this
 * run produced in your lane", and a path that is absolute or climbs out of the
 * worktree would put a sentence on screen that is not true. A plugin that
 * genuinely wrote elsewhere should say so in its own card.
 */
function requireLaneRelativePath(value: unknown, field: string): string {
  const raw = value;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new PluginSdkError("invalid_args", `"${field}" must be a non-empty string.`);
  }
  if (raw.length > 1024) throw new PluginSdkError("invalid_args", `"${field}" is too long.`);
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new PluginSdkError("invalid_args", `"${field}" must be relative to the lane worktree.`);
  }
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new PluginSdkError("invalid_args", `"${field}" must not climb out of the lane worktree.`);
  }
  return normalized;
}

/**
 * A git branch name, checked here rather than at the git call.
 *
 * The branch reaches `git fetch` as an argv element, so the shell is not the
 * risk — an argument that git reads as a FLAG is. Refusing a leading dash and
 * the characters `check-ref-format` rejects anyway keeps a plugin from turning
 * a branch field into an option, and does it before the value has travelled
 * three layers to somewhere the refusal reads as a git error.
 */
function requireBranchName(value: unknown, field: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new PluginSdkError("invalid_args", `"${field}" must be a non-empty string.`);
  if (raw.length > 255) throw new PluginSdkError("invalid_args", `"${field}" is too long.`);
  if (raw.startsWith("-") || /[\s~^:?*[\\]/.test(raw) || raw.includes("..") || raw.endsWith(".lock")) {
    throw new PluginSdkError("invalid_args", `"${field}" is not a valid branch name.`);
  }
  // eslint-disable-next-line no-control-regex -- a control character in a ref name is exactly what this rejects.
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new PluginSdkError("invalid_args", `"${field}" is not a valid branch name.`);
  }
  return raw;
}

export function createPluginSdkServer(deps: {
  pluginId: string;
  manifest: PluginManifest;
  logger: Logger;
  data: PluginDataStore;
  secrets: PluginSecretStore;
  invokeAdeAction: (domain: string, action: string, args: Record<string, unknown>) => Promise<unknown>;
  readConfig: () => Record<string, string | number | boolean | null>;
  /**
   * Write this plugin's own declared settings and answer with the new
   * effective config.
   *
   * Validated against the manifest by the host (undeclared key, wrong kind, a
   * `select` value off its option list and a `secret` setting are all refused)
   * and deliberately NOT a restart: a plugin calling this from inside an action
   * handler would otherwise kill itself mid-call. `readConfig` re-reads the
   * store, so the next `config.get` already sees the write.
   */
  writeConfig: (values: Record<string, unknown>) => Record<string, string | number | boolean | null>;
  /**
   * Record a clip through ADE's microphone, on this plugin's behalf.
   *
   * Optional because the microphone belongs to the desktop renderer and this
   * host may be running without one — a headless daemon, a CLI-only machine.
   * Absent reads as "no microphone here", which is a refusal the plugin can act
   * on, not a crash.
   */
  captureAudioClip?: (args: {
    pluginId: string;
    /** What the pill calls the requester. */
    label: string;
    maxDurationMs?: number;
  }) => Promise<PluginAudioClip>;
  /**
   * Show the user a notification on this plugin's behalf.
   *
   * `label` is resolved here from the manifest, never from the plugin's
   * arguments, and the implementation is required to render it — the whole
   * point of routing plugins through this verb rather than letting them borrow
   * `session.requestSessionAttention` is that the push says who sent it.
   *
   * Optional for the same reason `captureAudioClip` is: a host with neither a
   * desktop nor a paired phone cannot show anything, and absent reads as a
   * refusal the plugin can act on.
   */
  postNotification?: (args: {
    pluginId: string;
    label: string;
    title: string;
    body?: string;
    target: (typeof PLUGIN_NOTIFICATION_TARGETS)[number];
    /** Already validated as one of THIS plugin's own panel links, or absent. */
    deeplink?: string;
  }) => Promise<PluginNotificationResult>;
  /**
   * Read one provider API key out of ADE's own key store.
   *
   * The broker behind `ade.secrets.getProviderKey`. It is deliberately a
   * NARROW function rather than the store itself: this module decides which
   * provider a plugin may ask for, and handing it the store would put that
   * decision in two places.
   *
   * Returns null both for "no key stored" and for a store this host cannot
   * read (an uninitialized key store on a headless brain). Those are the same
   * fact to the plugin — there is no key here — and it should not be able to
   * tell which layer said so, exactly like {@link pluginAudioCaptureUnavailable}.
   *
   * The value returned here goes into ONE place: the SDK reply frame. It is
   * never logged, never written to the plugin secret store, and never put in a
   * collection or a panel schema.
   */
  readProviderKey?: (provider: PluginProviderKeyId) => string | null;
  /**
   * This plugin's own schedules. Absent on a host with no scheduler, which is
   * `unsupported_method` rather than a silent success — a plugin told its
   * schedule was created would go on to rely on it firing.
   */
  schedules?: {
    create: (pluginId: string, input: unknown) => PluginSchedule;
    list: (pluginId: string) => PluginSchedule[];
    delete: (pluginId: string, scheduleId: string) => void;
  };
  /**
   * Hand a fired trigger to the automation engine of whichever project this
   * plugin is bound to. Absent on a host with no engine — see
   * {@link pluginAutomationsUnavailable}.
   */
  emitAutomationTrigger?: (args: {
    pluginId: string;
    triggerId: string;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  /**
   * This project scope's webhook drain. Absent on a host that runs none, which
   * is `unsupported_method` for the same reason schedules are: no amount of
   * waiting grows one, and a plugin should stop expecting deliveries rather
   * than retry.
   */
  webhooks?: {
    url: (pluginId: string, channelId: string) => string | null;
    ack: (pluginId: string, deliveryId: string) => void;
  };
  /**
   * The chat sessions this plugin owns, for `ade.chat.*`.
   *
   * **Every method here is already ownership-checked by the supplier.** This
   * module validates SHAPES and applies BUDGETS; it does not decide whose
   * session is whose, because that answer lives with the chat service that
   * holds the sessions and a second copy of it here would be a second copy to
   * drift. `pluginId` rides along on every call so the supplier's check has the
   * host-derived identity and never a value the plugin passed in.
   *
   * Absent on a host with no chat service — see {@link pluginChatUnavailable}.
   */
  chat?: {
    createSession: (pluginId: string, input: PluginChatSessionCreateInput) => Promise<PluginChatSessionRef>;
    appendAssistant: (pluginId: string, sessionId: string, chunk: PluginChatAssistantChunk) => Promise<void>;
    appendUser: (pluginId: string, sessionId: string, input: PluginChatUserAppend) => Promise<void>;
    emitStatus: (pluginId: string, sessionId: string, status: PluginChatStatus) => Promise<void>;
    setArtifacts: (pluginId: string, sessionId: string, artifacts: PluginChatArtifact[]) => Promise<void>;
    attachBranch: (
      pluginId: string,
      sessionId: string,
      input: { branch: string; remote?: string },
    ) => Promise<void>;
    hydrate: (
      pluginId: string,
      sessionId: string,
      transcript: PluginChatTranscriptEntry[],
      options?: PluginChatHydrateOptions,
    ) => Promise<PluginChatHydrateResult>;
  };
  /** Electron-only verbs, served over the daemon→desktop bridge. */
  desktopHost?: {
    readClipboard: () => Promise<string>;
    writeClipboard: (text: string) => Promise<void>;
    pickFile: (options: PluginFilePickerOptions) => Promise<string>;
  };
}): { handle(method: PluginSdkMethod, params: Record<string, unknown>): Promise<unknown> } {
  const { pluginId, manifest } = deps;

  /**
   * One native file picker at a time, per plugin.
   *
   * `dialogs.pickFile` opens a window-modal sheet over the user's ADE window
   * and the dialog IS the consent, so a verb that can stack sheets makes that
   * consent defeatable by fatigue. It is also the ordinary failure, not just
   * the hostile one: the picker's own budget is ten minutes but the enclosing
   * plugin action times out at sixty seconds, so a plugin that retries after
   * the action fails opens a second sheet while the first is still up. The
   * audio broker refuses concurrency with `audio_capture_busy` for the same
   * reason; this is that guard for the other user-facing modal.
   */
  let filePickerInFlight = false;

  /** Emit timestamps inside the current automation-trigger burst window. */
  let triggerBurst: number[] = [];

  /**
   * Transcript-write timestamps in the current burst window, PER SESSION.
   *
   * Per session rather than per plugin, matching the ade-card limiter: a plugin
   * serving three busy conversations is doing three normal things, and a
   * plugin-wide ceiling would make its third chat stutter because the first two
   * are streaming. The map is pruned on every check, so a plugin that opened a
   * thousand conversations over a week holds only the live ones.
   */
  const chatWriteBursts = new Map<string, number[]>();

  const chargeChatWrite = (sessionId: string): void => {
    const since = Date.now() - PLUGIN_CHAT_WRITE_BURST_WINDOW_MS;
    const recent = (chatWriteBursts.get(sessionId) ?? []).filter((at) => at > since);
    if (recent.length >= PLUGIN_CHAT_WRITES_PER_SESSION_BURST) {
      chatWriteBursts.set(sessionId, recent);
      throw budgetExceeded(
        "chat_writes_per_minute",
        PLUGIN_CHAT_WRITES_PER_SESSION_BURST,
        recent.length + 1,
      );
    }
    recent.push(Date.now());
    chatWriteBursts.set(sessionId, recent);
    // Bounded bookkeeping: a window with nothing in it is a session that has
    // gone quiet, and holding its empty array forever would be a slow leak on a
    // long-lived host.
    if (chatWriteBursts.size > 256) {
      for (const [key, stamps] of [...chatWriteBursts]) {
        if (!stamps.some((at) => at > since)) chatWriteBursts.delete(key);
      }
    }
  };

  const requireChat = (): NonNullable<typeof deps.chat> => {
    if (!deps.chat) throw pluginChatUnavailable();
    return deps.chat;
  };

  /**
   * The manifest is the plugin's declared data surface. A collection it never
   * declared is refused rather than created, so `plugin.json` stays an honest
   * description of what the plugin stores and the settings UI can enumerate it.
   */
  const requireDeclaredCollection = (params: Record<string, unknown>): string => {
    const collection = assertPluginCollectionName(requireString(params, "collection"));
    // Checked BEFORE the declaration check, so declaring the reserved name in a
    // manifest does not open it. `ade.memory` has exactly one door — the
    // `memory` verbs — and a plugin that could also reach it as a collection
    // would make "what is in my memory" a question with two answers.
    if (isReservedPluginCollection(collection)) {
      throw new PluginSdkError(
        "not_permitted",
        `Collection "${collection}" is reserved. Use ade.memory.get/set/delete/list instead.`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(manifest.collections, collection)) {
      throw new PluginSdkError(
        "not_permitted",
        `Collection "${collection}" is not declared in ${pluginId}'s manifest.`,
      );
    }
    return collection;
  };

  /**
   * The provider this call may read, or a refusal.
   *
   * Two different refusals on purpose. A provider ADE does not store keys for
   * is `invalid_args` — the plugin asked for something that does not exist. A
   * real provider the manifest never declared is `not_permitted`, the same code
   * an undeclared collection or panel gets, because it is the same fact: the
   * manifest is the plugin's declared surface and the host does not widen it at
   * runtime. Keeping them apart matters to the author, who otherwise cannot
   * tell a typo from a missing declaration.
   */
  const requireDeclaredProvider = (params: Record<string, unknown>): PluginProviderKeyId => {
    const provider = requireString(params, "provider").trim().toLowerCase();
    if (!isPluginProviderKeyId(provider)) {
      throw new PluginSdkError("invalid_args", `ADE stores no API key for provider "${provider}".`);
    }
    if (!(manifest.providerKeys ?? []).includes(provider)) {
      throw new PluginSdkError(
        "not_permitted",
        `Provider key "${provider}" is not declared in ${pluginId}'s manifest.`
          + ` Add it to "providerKeys" and install the plugin again.`,
      );
    }
    return provider;
  };

  /**
   * A secret name the plugin owns.
   *
   * The relay registration secret is written by the host into the plugin's own
   * namespace, so it is reachable by name from every secret verb. Refused for
   * all three — read included — because a plugin that could read it could hand
   * its own ingress to anyone, and one that could write it would deauthorize
   * itself while the relay went on accepting posts nobody could drain.
   */
  const requireHostFreeSecretName = (params: Record<string, unknown>): string => {
    const name = requireString(params, "name");
    if (isReservedPluginSecretName(name)) {
      throw new PluginSdkError(
        "not_permitted",
        `Secret "${name}" belongs to ADE's webhook relay registration and is not readable or writable by a plugin.`,
      );
    }
    return name;
  };

  /**
   * A webhook channel this plugin's manifest declares.
   *
   * Same rule and same reasoning as `automations.emitTrigger`'s trigger check:
   * a URL for an undeclared channel would be a URL the relay accepts posts on
   * and the drain then throws away, which is worse than no URL at all.
   */
  const requireDeclaredChannel = (params: Record<string, unknown>): string => {
    const channelId = typeof params.channelId === "string" && params.channelId
      ? params.channelId
      : PLUGIN_WEBHOOK_DEFAULT_CHANNEL;
    if (!manifest.webhookIngress.some((channel) => channel.id === channelId)) {
      throw new PluginSdkError(
        "invalid_args",
        `"${channelId}" is not declared in ${pluginId}'s webhookIngress.`,
      );
    }
    return channelId;
  };

  const requireDeclaredPanel = (params: Record<string, unknown>): string => {
    const panelId = requireString(params, "panelId");
    if (!manifest.panels.some((panel) => panel.id === panelId)) {
      throw new PluginSdkError("not_permitted", `Panel "${panelId}" is not declared in ${pluginId}'s manifest.`);
    }
    return panelId;
  };

  const requireEntityKind = (params: Record<string, unknown>): PluginEntityKind => {
    if (!isPluginEntityKind(params.entityKind)) {
      throw new PluginSdkError("invalid_args", `Unknown contribution entity kind: ${String(params.entityKind)}`);
    }
    return params.entityKind;
  };

  const requireSocket = (params: Record<string, unknown>): PluginSocketKind => {
    if (!isPluginSocketKind(params.socket)) {
      throw new PluginSdkError("invalid_args", `Unknown socket kind: ${String(params.socket)}`);
    }
    return params.socket;
  };

  return {
    async handle(method, params) {
      switch (method) {
        case "actions.invoke": {
          // Pass-through by design: role, scope and allowlist policy live in the
          // action layer, and re-deriving them here would create a second,
          // drifting copy of the rules that actually gate the call.
          const domain = requireString(params, "domain");
          const action = requireString(params, "action");
          return await deps.invokeAdeAction(domain, action, optionalRecord(params.args, "args"));
        }

        case "collections.get":
          return deps.data.getCollection(
            pluginId,
            requireDeclaredCollection(params),
            assertPluginCollectionKey(requireString(params, "key")),
          );

        case "collections.put": {
          deps.data.putCollection(
            pluginId,
            requireDeclaredCollection(params),
            assertPluginCollectionKey(requireString(params, "key")),
            params.value,
            readPutOptions(params.options),
          );
          return null;
        }

        case "collections.delete": {
          deps.data.deleteCollection(
            pluginId,
            requireDeclaredCollection(params),
            assertPluginCollectionKey(requireString(params, "key")),
          );
          return null;
        }

        case "collections.list": {
          const options = optionalRecord(params.options, "options");
          return deps.data.listCollection(pluginId, requireDeclaredCollection(params), {
            ...(typeof options.keyPrefix === "string" ? { keyPrefix: options.keyPrefix } : {}),
            ...(typeof options.limit === "number" && Number.isFinite(options.limit)
              ? { limit: Math.trunc(options.limit) }
              : {}),
          });
        }

        case "secrets.get":
          return await deps.secrets.get(pluginId, requireHostFreeSecretName(params));

        case "secrets.set": {
          const value = params.value;
          if (typeof value !== "string") throw new PluginSdkError("invalid_args", '"value" must be a string.');
          await deps.secrets.set(pluginId, requireHostFreeSecretName(params), value);
          return null;
        }

        case "secrets.delete": {
          await deps.secrets.delete(pluginId, requireHostFreeSecretName(params));
          return null;
        }

        case "secrets.getProviderKey": {
          // Straight from the store to the reply frame. Nothing between the two
          // lines below may log, cache or copy the value — the plugin secret
          // store in particular, which is a DIFFERENT store and would leave the
          // user with two copies of one key that drift apart when they rotate
          // it in Settings.
          const provider = requireDeclaredProvider(params);
          return deps.readProviderKey?.(provider) ?? null;
        }

        case "secrets.hasProviderKey": {
          const provider = requireDeclaredProvider(params);
          return (deps.readProviderKey?.(provider) ?? null) !== null;
        }

        case "contributions.publish": {
          const payload = params.payload;
          if (payload !== null && !isRecord(payload)) {
            throw new PluginSdkError("invalid_args", '"payload" must be an object or null.');
          }
          deps.data.publishContribution(
            pluginId,
            requireEntityKind(params),
            requireString(params, "entityId"),
            requireSocket(params),
            payload,
          );
          return null;
        }

        case "panels.update": {
          const panelId = requireDeclaredPanel(params);
          if (manifest.panels.length > PLUGIN_PANELS_MAX_PER_PLUGIN) {
            throw budgetExceeded("panels", PLUGIN_PANELS_MAX_PER_PLUGIN, manifest.panels.length);
          }
          // The data store re-encodes and re-checks this ceiling — that check is
          // the guarantee. This one exists so the plugin gets its typed refusal
          // before anything touches the database.
          encodePluginJsonWithinBudget(params.schema, "panel_schema", PLUGIN_PANEL_SCHEMA_MAX_BYTES);
          const declared = manifest.panels.find((panel) => panel.id === panelId);
          const surface = manifest.surfaces.find((entry) => entry.panelId === panelId);
          deps.data.updatePanel(pluginId, panelId, {
            ...(declared?.title ? { title: declared.title } : {}),
            ...(declared?.icon ? { icon: declared.icon } : {}),
            ...(surface ? { surface: surface.id } : {}),
            ...(surface ? { mobile: pluginPanelShowsOnMobile(surface) } : {}),
            // Off the manifest, never off the payload: a plugin republishing a
            // panel cannot mint a refresh gesture for an action it did not
            // declare, and a panel that dropped the declaration loses it here.
            refreshAction: declared?.refreshAction ?? null,
            schema: params.schema,
            vocabVersion: manifest.vocabVersion,
          });
          return null;
        }

        case "config.get":
          return deps.readConfig();

        case "config.set": {
          // `{values}` rather than `{key, value}` on the wire so one write of
          // several settings is one call and one file write. The child SDK
          // accepts both spellings and normalizes to this one.
          const values = optionalRecord(params.values, "values");
          return deps.writeConfig(values);
        }

        case "audio.captureClip": {
          if (!deps.captureAudioClip) throw pluginAudioCaptureUnavailable();
          const options = optionalRecord(params.options, "options");
          const maxDurationMs = typeof options.maxDurationMs === "number"
            && Number.isFinite(options.maxDurationMs)
            && options.maxDurationMs > 0
            ? Math.trunc(options.maxDurationMs)
            : undefined;
          try {
            // The label is the manifest's display name, never something the
            // plugin passes in: the pill attributes the microphone, and a
            // requester that could name itself could name someone else.
            return await deps.captureAudioClip({
              pluginId,
              label: manifest.displayName || pluginId,
              ...(maxDurationMs != null ? { maxDurationMs } : {}),
            });
          } catch (error) {
            // Re-throw as a typed refusal, because `code` is the ONLY field
            // that survives the child boundary: `pluginChildSupervisor`
            // rebuilds a rejection from `PluginSdkError`'s code and flattens
            // everything else to `internal_error`. The layers below this one
            // reject with their own error classes carrying a `code` property —
            // the broker's cancel/busy, the bridge's no-desktop — and without
            // this they all arrive at the plugin indistinguishable from a
            // crash. Cancel is the common case, not an edge one: it fires
            // every time somebody dismisses the pill, and a plugin that reads
            // that as a failure would report an error for a deliberate act.
            throw asPluginAudioCaptureError(error);
          }
        }

        case "notifications.post": {
          if (!deps.postNotification) throw pluginNotificationUnavailable();
          const input = optionalRecord(params.input, "input");
          const title = requireString(input, "title");
          if (title.length > PLUGIN_NOTIFICATION_TITLE_MAX_CHARS) {
            throw new PluginSdkError(
              "invalid_args",
              `"title" is longer than ${PLUGIN_NOTIFICATION_TITLE_MAX_CHARS} characters.`,
            );
          }
          const body = input.body === undefined || input.body === null ? undefined : input.body;
          if (body !== undefined && typeof body !== "string") {
            throw new PluginSdkError("invalid_args", '"body" must be a string.');
          }
          if (body !== undefined && body.length > PLUGIN_NOTIFICATION_BODY_MAX_CHARS) {
            throw new PluginSdkError(
              "invalid_args",
              `"body" is longer than ${PLUGIN_NOTIFICATION_BODY_MAX_CHARS} characters.`,
            );
          }
          // An unknown target is refused, not rounded to the default: a plugin
          // that shipped a typo and got "both" would look correct while quietly
          // notifying somewhere it never meant to.
          if (input.target !== undefined && !isPluginNotificationTargetRequest(input.target)) {
            throw new PluginSdkError(
              "invalid_args",
              `"target" must be one of ${PLUGIN_NOTIFICATION_TARGETS.map((entry) => `"${entry}"`).join(", ")}.`,
            );
          }
          // The label is the manifest's display name, never something the
          // plugin passes in — the same rule the audio pill follows. A
          // notification that could name itself could name ADE.
          // A link that is not one of this plugin's own panels costs the
          // destination, not the notification: the post still goes, and tapping
          // it opens the plugin — the default every post had before the field
          // existed. Refusing the whole post would let one bad link silence the
          // news the user actually needed.
          const deeplink = readPluginNotificationDeeplink(input.deeplink, pluginId);
          if (input.deeplink !== undefined && !deeplink) {
            deps.logger.warn("plugin.notification_deeplink_refused", { pluginId });
          }
          return await deps.postNotification({
            pluginId,
            label: manifest.displayName || pluginId,
            title,
            ...(body !== undefined ? { body } : {}),
            target: (input.target as PluginNotificationInput["target"]) ?? "both",
            ...(deeplink ? { deeplink } : {}),
          });
        }

        case "schedules.create": {
          if (!deps.schedules) throw pluginSchedulesUnavailable();
          return deps.schedules.create(pluginId, optionalRecord(params.input, "input"));
        }

        case "schedules.list": {
          if (!deps.schedules) throw pluginSchedulesUnavailable();
          return deps.schedules.list(pluginId);
        }

        case "schedules.delete": {
          if (!deps.schedules) throw pluginSchedulesUnavailable();
          deps.schedules.delete(pluginId, requireString(params, "scheduleId"));
          return null;
        }

        case "webhooks.url": {
          if (!deps.webhooks) throw pluginWebhookIngressUnavailable();
          const channelId = requireDeclaredChannel(params);
          const url = deps.webhooks.url(pluginId, channelId);
          // Declared in the manifest and still unresolvable means the drain and
          // the manifest disagree — a reload mid-call, a plugin disabled under
          // it. Refused rather than answered with a guessed URL: a wrong
          // webhook URL is pasted into a third party and is then wrong forever.
          if (!url) throw pluginWebhookIngressUnavailable();
          return url;
        }

        case "webhooks.ack": {
          if (!deps.webhooks) throw pluginWebhookIngressUnavailable();
          deps.webhooks.ack(pluginId, requireString(params, "deliveryId"));
          return null;
        }

        case "automations.emitTrigger": {
          if (!deps.emitAutomationTrigger) throw pluginAutomationsUnavailable();
          const input = optionalRecord(params.input, "input");
          const triggerId = requireString(input, "triggerId");
          // Refused unless the manifest declares it. A plugin firing a trigger
          // it never declared is a firing no rule can exist for — the builder
          // draws its picker from the manifest — so this would be a silent
          // no-op forever rather than a mistake anyone could see. `invalid_args`
          // rather than `not_permitted`: nothing was withheld, the id is wrong.
          if (!manifest.automationTriggers.some((declared) => declared.id === triggerId)) {
            throw new PluginSdkError(
              "invalid_args",
              `"${triggerId}" is not declared in ${pluginId}'s automationTriggers.`,
            );
          }
          const payload = input.payload === undefined || input.payload === null
            ? undefined
            : optionalRecord(input.payload, "input.payload");
          // Encoded only to measure it — the budget helper throws on overflow
          // and the engine takes the object, not the string.
          if (payload !== undefined) {
            encodePluginJsonWithinBudget(
              payload,
              "automation_trigger_payload",
              PLUGIN_AUTOMATION_TRIGGER_PAYLOAD_MAX_BYTES,
            );
          }
          // The ceiling on how often, checked after the shape and before the
          // engine runs anything. Every emit runs the user's matching rules,
          // which can start lanes and paid agent turns, and the ingress key is
          // minted fresh per firing so dedupe never collapses two of them.
          const burstSince = Date.now() - PLUGIN_AUTOMATION_TRIGGER_BURST_WINDOW_MS;
          triggerBurst = triggerBurst.filter((at) => at > burstSince);
          if (triggerBurst.length >= PLUGIN_AUTOMATION_TRIGGERS_PER_BURST) {
            throw budgetExceeded(
              "automation_triggers_per_minute",
              PLUGIN_AUTOMATION_TRIGGERS_PER_BURST,
              triggerBurst.length + 1,
            );
          }
          triggerBurst.push(Date.now());
          await deps.emitAutomationTrigger({
            pluginId,
            triggerId,
            ...(payload !== undefined ? { payload } : {}),
          });
          return null;
        }

        case "chat.createSession": {
          const chat = requireChat();
          const input = optionalRecord(params.input, "input");
          const runtimeId = requireString(input, "runtimeId");
          // Refused unless the manifest declares it, for the same reason an
          // undeclared automation trigger is: the clients draw a chat's label
          // and icon from the manifest, so a session bound to a runtime nobody
          // declared would render as an unnamed provider forever. `invalid_args`
          // rather than `not_permitted` — nothing was withheld, the id is wrong.
          if (!(manifest.chatRuntimes ?? []).some((declared) => declared.id === runtimeId)) {
            throw new PluginSdkError(
              "invalid_args",
              `"${runtimeId}" is not declared in ${pluginId}'s chatRuntimes.`,
            );
          }
          const create: PluginChatSessionCreateInput = {
            runtimeId,
            externalId: requireString(input, "externalId"),
            laneId: requireString(input, "laneId"),
            ...(typeof input.sessionId === "string" && input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(typeof input.title === "string" ? { title: input.title.slice(0, 200) } : {}),
            ...(typeof input.modelLabel === "string" ? { modelLabel: input.modelLabel.slice(0, 80) } : {}),
          };
          return await chat.createSession(pluginId, create) satisfies PluginChatSessionRef;
        }

        case "chat.appendAssistant": {
          const chat = requireChat();
          const sessionId = requireString(params, "sessionId");
          const raw = optionalRecord(params.chunk, "chunk");
          const text = raw.text === undefined || raw.text === null
            ? undefined
            : requireChatText(raw.text, "chunk.text");
          const parts = readChatParts(raw.parts, "chunk.parts");
          // A chunk that says nothing and closes nothing is a wasted write, and
          // accepting it would let a loop burn the session's budget on silence.
          if (text === undefined && !parts?.length && raw.done !== true) {
            throw new PluginSdkError("invalid_args", '"chunk" must carry "text", "parts" or "done".');
          }
          chargeChatWrite(sessionId);
          const chunk: PluginChatAssistantChunk = {
            ...(text !== undefined ? { text } : {}),
            ...(parts?.length ? { parts } : {}),
            ...(typeof raw.turnId === "string" && raw.turnId ? { turnId: raw.turnId } : {}),
            ...(raw.done === true ? { done: true } : {}),
          };
          await chat.appendAssistant(pluginId, sessionId, chunk);
          return null;
        }

        case "chat.appendUser": {
          const chat = requireChat();
          const sessionId = requireString(params, "sessionId");
          const raw = optionalRecord(params.input, "input");
          chargeChatWrite(sessionId);
          const input: PluginChatUserAppend = {
            text: requireChatText(raw.text, "input.text"),
            ...(typeof raw.fingerprint === "string" && raw.fingerprint
              ? { fingerprint: raw.fingerprint.slice(0, 512) }
              : {}),
            ...(typeof raw.turnId === "string" && raw.turnId ? { turnId: raw.turnId } : {}),
          };
          await chat.appendUser(pluginId, sessionId, input);
          return null;
        }

        case "chat.emitStatus": {
          const chat = requireChat();
          const sessionId = requireString(params, "sessionId");
          const raw = optionalRecord(params.status, "status");
          // An unknown state is refused, never rounded to "idle": a plugin whose
          // typo settled every conversation would look correct right up to the
          // moment a user waits forever for a turn the host already closed.
          if (!isPluginChatStatusState(raw.state)) {
            throw new PluginSdkError(
              "invalid_args",
              `"status.state" must be one of ${PLUGIN_CHAT_STATUS_STATES.map((s) => `"${s}"`).join(", ")}.`,
            );
          }
          chargeChatWrite(sessionId);
          const status: PluginChatStatus = {
            state: raw.state,
            ...(typeof raw.detail === "string" && raw.detail ? { detail: raw.detail.slice(0, 240) } : {}),
            ...(typeof raw.turnId === "string" && raw.turnId ? { turnId: raw.turnId } : {}),
          };
          await chat.emitStatus(pluginId, sessionId, status);
          return null;
        }

        case "chat.setArtifacts": {
          const chat = requireChat();
          const sessionId = requireString(params, "sessionId");
          const raw = params.artifacts;
          if (!Array.isArray(raw)) throw new PluginSdkError("invalid_args", '"artifacts" must be an array.');
          if (raw.length > PLUGIN_CHAT_ARTIFACTS_MAX) {
            throw budgetExceeded("chat_artifacts", PLUGIN_CHAT_ARTIFACTS_MAX, raw.length);
          }
          const artifacts: PluginChatArtifact[] = raw.map((entry, index) => {
            if (!isRecord(entry)) {
              throw new PluginSdkError("invalid_args", `"artifacts[${index}]" must be an object.`);
            }
            const bytes = typeof entry.bytes === "number" && Number.isFinite(entry.bytes) && entry.bytes >= 0
              ? Math.trunc(entry.bytes)
              : undefined;
            return {
              path: requireLaneRelativePath(entry.path, `artifacts[${index}].path`),
              ...(typeof entry.label === "string" && entry.label ? { label: entry.label.slice(0, 120) } : {}),
              ...(bytes !== undefined ? { bytes } : {}),
            };
          });
          chargeChatWrite(sessionId);
          await chat.setArtifacts(pluginId, sessionId, artifacts);
          return null;
        }

        case "chat.attachBranch": {
          const chat = requireChat();
          const sessionId = requireString(params, "sessionId");
          const raw = optionalRecord(params.input, "input");
          const remote = raw.remote === undefined || raw.remote === null
            ? undefined
            : requireBranchName(raw.remote, "input.remote");
          chargeChatWrite(sessionId);
          await chat.attachBranch(pluginId, sessionId, {
            branch: requireBranchName(raw.branch, "input.branch"),
            ...(remote !== undefined ? { remote } : {}),
          });
          return null;
        }

        case "chat.hydrate": {
          const chat = requireChat();
          const sessionId = requireString(params, "sessionId");
          const raw = params.transcript;
          if (!Array.isArray(raw)) throw new PluginSdkError("invalid_args", '"transcript" must be an array.');
          if (raw.length > PLUGIN_CHAT_HYDRATE_MAX_ENTRIES) {
            throw budgetExceeded("chat_hydrate_entries", PLUGIN_CHAT_HYDRATE_MAX_ENTRIES, raw.length);
          }
          const transcript: PluginChatTranscriptEntry[] = raw.map((entry, index) => {
            if (!isRecord(entry)) {
              throw new PluginSdkError("invalid_args", `"transcript[${index}]" must be an object.`);
            }
            if (entry.role !== "user" && entry.role !== "assistant") {
              throw new PluginSdkError(
                "invalid_args",
                `"transcript[${index}].role" must be "user" or "assistant".`,
              );
            }
            const text = entry.text === undefined || entry.text === null
              ? undefined
              : requireChatText(entry.text, `transcript[${index}].text`);
            const parts = readChatParts(entry.parts, `transcript[${index}].parts`);
            if (text === undefined && !parts?.length) {
              throw new PluginSdkError(
                "invalid_args",
                `"transcript[${index}]" must carry "text" or "parts".`,
              );
            }
            const at = typeof entry.at === "number" && Number.isFinite(entry.at) ? Math.trunc(entry.at) : undefined;
            return {
              role: entry.role,
              ...(text !== undefined ? { text } : {}),
              ...(parts?.length ? { parts } : {}),
              ...(at !== undefined ? { at } : {}),
              ...(typeof entry.fingerprint === "string" && entry.fingerprint
                ? { fingerprint: entry.fingerprint.slice(0, 512) }
                : {}),
            };
          });
          // One charge for the whole page, not one per entry: hydration is a
          // bounded backfill already capped above, and charging it per turn
          // would let a legitimate reconnect exhaust the streaming budget the
          // conversation needs immediately afterwards.
          // `append` marks a continuation of one paged sweep. Read tolerantly:
          // getting it wrong costs a plugin nothing, because the fingerprint
          // dedupe still stops a page landing twice — it only decides which
          // running total the sweep ceiling is measured against.
          const options: PluginChatHydrateOptions | undefined = isRecord(params.options)
            ? { append: params.options.append === true }
            : undefined;
          chargeChatWrite(sessionId);
          return await chat.hydrate(pluginId, sessionId, transcript, options);
        }

        case "clipboard.read": {
          if (!deps.desktopHost) throw pluginDesktopUnavailable();
          return await deps.desktopHost.readClipboard();
        }

        case "clipboard.write": {
          if (!deps.desktopHost) throw pluginDesktopUnavailable();
          const text = params.text;
          if (typeof text !== "string") throw new PluginSdkError("invalid_args", '"text" must be a string.');
          // Checked here as well as at the bridge so the plugin gets its typed
          // refusal without an IPC round trip — the same two-layer convention
          // `panels.update` uses for its schema ceiling.
          if (pluginUtf8ByteLength(text) > PLUGIN_CLIPBOARD_TEXT_MAX_BYTES) {
            throw budgetExceeded(
              "clipboard_text",
              PLUGIN_CLIPBOARD_TEXT_MAX_BYTES,
              pluginUtf8ByteLength(text),
            );
          }
          await deps.desktopHost.writeClipboard(text);
          return null;
        }

        case "dialogs.pickFile": {
          if (!deps.desktopHost) throw pluginDesktopUnavailable();
          if (filePickerInFlight) {
            throw new PluginSdkError(
              "not_permitted",
              "A file picker from this plugin is already open. Wait for the user to answer it.",
            );
          }
          const options = optionalRecord(params.options, "options");
          filePickerInFlight = true;
          try {
            return await deps.desktopHost.pickFile({
              ...(typeof options.title === "string" ? { title: options.title } : {}),
              ...(typeof options.defaultPath === "string" ? { defaultPath: options.defaultPath } : {}),
              ...(options.directory === true ? { directory: true } : {}),
              ...(Array.isArray(options.filters)
                ? { filters: options.filters as PluginFilePickerOptions["filters"] }
                : {}),
            });
          } finally {
            // `finally`, so a cancel, a bridge timeout or a disconnected
            // desktop all release the slot — a guard that only cleared on
            // success would turn one refused pick into a permanent one.
            filePickerInFlight = false;
          }
        }

        // Memory is a reserved slice of this plugin's own collections, so these
        // four reuse the collections store rather than adding a second one. The
        // difference is the scoping: the collection name is supplied here and
        // never by the plugin, which is what makes it a namespace instead of a
        // naming convention.
        case "memory.get":
          return deps.data.getCollection(
            pluginId,
            PLUGIN_MEMORY_COLLECTION,
            assertPluginCollectionKey(requireString(params, "key")),
          );

        case "memory.set": {
          deps.data.putCollection(
            pluginId,
            PLUGIN_MEMORY_COLLECTION,
            assertPluginCollectionKey(requireString(params, "key")),
            params.value,
            // No `ifFull` — memory that silently dropped its oldest entries to
            // make room would be the one storage in ADE that forgets without
            // saying so, which is the opposite of what a plugin asks memory for.
          );
          return null;
        }

        case "memory.delete": {
          deps.data.deleteCollection(
            pluginId,
            PLUGIN_MEMORY_COLLECTION,
            assertPluginCollectionKey(requireString(params, "key")),
          );
          return null;
        }

        case "memory.list": {
          const options = optionalRecord(params.options, "options");
          return deps.data.listCollection(pluginId, PLUGIN_MEMORY_COLLECTION, {
            ...(typeof options.keyPrefix === "string" ? { keyPrefix: options.keyPrefix } : {}),
            ...(typeof options.limit === "number" && Number.isFinite(options.limit)
              ? { limit: Math.trunc(options.limit) }
              : {}),
          });
        }

        default:
          throw new PluginSdkError("unsupported_method", `Unsupported plugin SDK method: ${String(method)}`);
      }
    },
  };
}
