/**
 * Devin Cloud dialect. `devin acp --cloud` relays the same Agent Client
 * Protocol to Cognition's cloud ACP WebSocket, so every session this dialect
 * opens runs on a Devin VM, not on this machine. It rides the CLI's own
 * `devin auth login`; no API token is involved.
 *
 * What differs from the local dialect, all verified against the live relay:
 * - `session/new` mints a cloud session (`devin-<hex>`, the same entity the
 *   REST API and app.devin.ai call `<hex>`) and offers config options
 *   `repos`, `devin_version` (the model), `platform` and `persona_slug`.
 * - The model is the `devin_version` option. `--model` and `session/set_model`
 *   belong to the local agent and are ignored here.
 * - Only `session/load` rejoins, and it replays the full history, user
 *   messages included; messages sent from app.devin.ai arrive the same way.
 * - There is no branch option. The chat service pins a branch in the prompt.
 */

import {
  capability,
  capabilityAbsent,
  defineAcpDialect,
  type AcpSpawnContext,
  type AcpSpawnPlan,
} from "../acpHostTypes";
import {
  ADE_CLIENT_INFO,
  inlineImagePrompt,
  standardAcpUsage,
  standardClose,
  standardLoad,
  standardSetConfigOption,
} from "./shared";
import { readDevinAccount } from "./acpAccounts";

/** Config option ids the cloud relay offers on `session/new`. */
export const DEVIN_CLOUD_CONFIG_OPTION_IDS = ["repos", "devin_version", "platform"] as const;

/** The `devin-` prefix the relay puts on ids app.devin.ai shows bare. */
export function devinCloudAcpSessionId(bareId: string): string {
  const id = bareId.trim();
  return id.startsWith("devin-") ? id : `devin-${id}`;
}

export function devinCloudBareSessionId(acpId: string): string {
  return acpId.trim().replace(/^devin-/, "");
}

function buildSpawnPlan(context: AcpSpawnContext): AcpSpawnPlan {
  return {
    command: context.binaryPath,
    args: ["acp", "--cloud"],
    cwd: context.cwd,
    env: { ...context.baseEnv },
  };
}

export const devinCloudDialect = defineAcpDialect({
  providerId: "devin",
  displayName: "Devin Cloud",
  tier: "preview",
  binaryNames: ["devin"],
  buildSpawnPlan,

  cancelStyle: "request",
  poolEnvKeys: [],
  oneProcessPerSession: false,
  advertiseFsCapability: false,
  advertiseTerminalCapability: false,
  initializeMeta: null,
  clientInfo: ADE_CLIENT_INFO,
  postSessionNewNotifications: () => [],
  includeSlashCommand: () => true,

  sessionIdPersistence: {
    assignableAtLaunch: false,
    sessionsDirName: null,
    idShape: "opaque",
  },

  authProbe: {
    methodId: null,
    loginCommand: "devin auth login",
    apiKeyEnvVars: [],
  },

  degradationNotes: [],

  extensionNotifications: {},
  usage: capability(standardAcpUsage),
  localUsage: capabilityAbsent,
  readAccount: readDevinAccount,
  inferCompaction: false,
  usageUpdateAfterTurn: false,

  closeStyle: "close_request",
  closeSession: capability(standardClose),

  loadPolicy: "load_only",
  resumeSession: capabilityAbsent,
  loadSession: capability(standardLoad),

  sessionConfig: capability(standardSetConfigOption),
  modelSelection: capabilityAbsent,
  mcpInjection: capabilityAbsent,
  imagePrompts: capability(inlineImagePrompt),
  configOptionIds: [...DEVIN_CLOUD_CONFIG_OPTION_IDS],
  modelConfigOptionId: "devin_version",
  echoRemoteUserMessages: true,
});
