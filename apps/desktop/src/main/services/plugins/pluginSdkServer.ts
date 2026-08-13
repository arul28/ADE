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
  type PluginAudioClip,
  type PluginCollectionPutOptions,
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
}): { handle(method: PluginSdkMethod, params: Record<string, unknown>): Promise<unknown> } {
  const { pluginId, manifest } = deps;

  /**
   * The manifest is the plugin's declared data surface. A collection it never
   * declared is refused rather than created, so `plugin.json` stays an honest
   * description of what the plugin stores and the settings UI can enumerate it.
   */
  const requireDeclaredCollection = (params: Record<string, unknown>): string => {
    const collection = assertPluginCollectionName(requireString(params, "collection"));
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

        default:
          throw new PluginSdkError("unsupported_method", `Unsupported plugin SDK method: ${String(method)}`);
      }
    },
  };
}
