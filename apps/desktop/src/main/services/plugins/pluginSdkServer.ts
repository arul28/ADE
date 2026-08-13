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

export function createPluginSdkServer(deps: {
  pluginId: string;
  manifest: PluginManifest;
  logger: Logger;
  data: PluginDataStore;
  secrets: PluginSecretStore;
  invokeAdeAction: (domain: string, action: string, args: Record<string, unknown>) => Promise<unknown>;
  readConfig: () => Record<string, string | number | boolean | null>;
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

        default:
          throw new PluginSdkError("unsupported_method", `Unsupported plugin SDK method: ${String(method)}`);
      }
    },
  };
}
