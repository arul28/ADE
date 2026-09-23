/**
 * Devin dialect. `devin acp` — Cognition's Devin CLI speaking Agent Client
 * Protocol over stdio. Native Rust binary (brew `devin-cli`, install.sh);
 * Windows x86 and arm64 builds exist.
 *
 * Auth: `devin auth login` stores account credentials (browser OAuth, any
 * Devin account — no org required). `devin acp` also honours
 * `WINDSURF_API_KEY` and accepts the ACP `authenticate` request at runtime,
 * so ADE can drive sign-in in-process like the other providers.
 *
 * Session ids are the short opaque ids `devin list` shows (e.g. `abc12345`);
 * there is no flag to mint one at launch, and `devin -r <id>` /
 * `devin -c` cover CLI resume. The ACP server reports the id on the wire.
 *
 * Devin's `/handoff` escalates a local chat into a cloud session; ADE's own
 * cloud surface covers that path natively, so no dialect wiring is needed
 * for it here.
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
  standardResume,
  standardSetConfigOption,
  standardSetModel,
  transportGatedMcpInjection,
  withOptionalEnv,
} from "./shared";
import { readDevinAccount } from "./acpAccounts";

function buildSpawnPlan(context: AcpSpawnContext): AcpSpawnPlan {
  return {
    command: context.binaryPath,
    args: ["acp"],
    cwd: context.cwd,
    env: withOptionalEnv(context.baseEnv, {}),
  };
}

export const devinDialect = defineAcpDialect({
  providerId: "devin",
  displayName: "Devin",
  tier: "preview",
  binaryNames: ["devin"],
  buildSpawnPlan,

  cancelStyle: "request",
  poolEnvKeys: ["WINDSURF_API_KEY"],
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
    // `devin acp` advertises its own authenticate methods; defer to them.
    methodId: null,
    loginCommand: "devin auth login",
    apiKeyEnvVars: ["WINDSURF_API_KEY"],
  },

  degradationNotes: [
    "Devin CLI does not yet expose account Knowledge, Playbooks, or Secrets to local sessions.",
  ],

  extensionNotifications: {},
  usage: capability(standardAcpUsage),
  // Devin keeps no local usage ledger of its own.
  localUsage: capabilityAbsent,
  readAccount: readDevinAccount,
  // Devin reports context size via `usage_update` but never reports a
  // compaction itself, so the host infers one from a sharp drop in `used`.
  inferCompaction: true,
  usageUpdateAfterTurn: false,

  closeStyle: "close_request",
  closeSession: capability(standardClose),

  loadPolicy: "resume_preferred",
  resumeSession: capability(standardResume),
  loadSession: capability(standardLoad),

  sessionConfig: capability(standardSetConfigOption),
  modelSelection: capability(standardSetModel),
  mcpInjection: capability(transportGatedMcpInjection),
  imagePrompts: capability(inlineImagePrompt),
  configOptionIds: ["mode", "model"],
});
