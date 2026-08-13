import type { Logger } from "../logging/logger";
import { pluginPanelShowsOnMobile, type PluginManifest } from "../../../shared/plugins/manifest";
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
  isPluginNotificationTargetRequest,
  isReservedPluginCollection,
  PLUGIN_AUTOMATION_TRIGGER_BURST_WINDOW_MS,
  PLUGIN_AUTOMATION_TRIGGER_PAYLOAD_MAX_BYTES,
  PLUGIN_AUTOMATION_TRIGGERS_PER_BURST,
  PLUGIN_CLIPBOARD_TEXT_MAX_BYTES,
  PLUGIN_MEMORY_COLLECTION,
  PLUGIN_NOTIFICATION_BODY_MAX_CHARS,
  PLUGIN_NOTIFICATION_TARGETS,
  PLUGIN_NOTIFICATION_TITLE_MAX_CHARS,
  pluginUtf8ByteLength,
  type PluginAudioClip,
  type PluginCollectionPutOptions,
  type PluginFilePickerOptions,
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

export function createPluginSdkServer(deps: {
  pluginId: string;
  manifest: PluginManifest;
  logger: Logger;
  data: PluginDataStore;
  secrets: PluginSecretStore;
  invokeAdeAction: (domain: string, action: string, args: Record<string, unknown>) => Promise<unknown>;
  readConfig: () => Record<string, string | number | boolean | null>;
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
  }) => Promise<PluginNotificationResult>;
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
          return await deps.secrets.get(pluginId, requireString(params, "name"));

        case "secrets.set": {
          const value = params.value;
          if (typeof value !== "string") throw new PluginSdkError("invalid_args", '"value" must be a string.');
          await deps.secrets.set(pluginId, requireString(params, "name"), value);
          return null;
        }

        case "secrets.delete": {
          await deps.secrets.delete(pluginId, requireString(params, "name"));
          return null;
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
            schema: params.schema,
            vocabVersion: manifest.vocabVersion,
          });
          return null;
        }

        case "config.get":
          return deps.readConfig();

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
          return await deps.postNotification({
            pluginId,
            label: manifest.displayName || pluginId,
            title,
            ...(body !== undefined ? { body } : {}),
            target: (input.target as PluginNotificationInput["target"]) ?? "both",
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
