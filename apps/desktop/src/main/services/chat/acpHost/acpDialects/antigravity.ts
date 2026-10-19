/**
 * Antigravity dialect. Google's official ACP agent for Antigravity
 * (`agy_acp_server`, ACP registry id `antigravity-acp`), run from ADE's pinned
 * copy (tools cache `antigravity`, version in the manifest). The pin is a flat
 * zip: the server (`agy_acp_server.par`, `.exe` on Windows) and its native
 * harness (`localharness_external[.exe]`) must stay siblings.
 *
 * It has no terminal CLI and no terminal login. Sign-in is the ACP
 * `authenticate` request, which ADE runs from Settings on the machine that
 * owns the provider (`ai/antigravitySignIn.ts`). The agent saves the chosen
 * method to its own `settings.json`, so later chats need no `authenticate`.
 *
 * ## Spawn
 *
 * - `--uid=` on Linux, as the ACP registry launches it: started as root, the
 *   server's InitGoogle otherwise switches to user `nobody`.
 * - `ANTIGRAVITY_HARNESS_PATH` = the pin's `files.harness`.
 * - TMPDIR (TEMP and TMP on Windows) = an ADE-owned per-launch directory. The
 *   server unpacks itself there on every launch; ADE deletes it on exit and
 *   sweeps leftovers (`acpScratchDirs.ts`).
 * - GEMINI_HOME untouched: the default `~/.gemini` (or the user's own
 *   GEMINI_HOME) is the shared login. ADE never writes there.
 * - BROWSER = a command that exits 0 and opens nothing. The agent's Python
 *   `webbrowser` tries the next browser when a BROWSER entry fails, so a
 *   failing command (`false`) would still pop the OS browser on a headless
 *   machine. ADE reads the sign-in URL from stderr instead.
 * - Google credential variables are removed and only the recorded method's
 *   are put back (`antigravityCredentialEnv`).
 *
 * ## Verified (2026-10-18, agy_acp_server 1.4.1, macOS arm64)
 *
 * Handshake only, signed out (no Google sign-in on the probe machine).
 * `fixtures/antigravity.initialize.json` holds the captured `initialize`.
 *
 * 1. ACP v1: asked for 1, answers `protocolVersion: 1`.
 * 2. `authMethods`: oauth-personal, oauth-business, gemini-api-key,
 *    agent-platform, all agent-driven (no `type: "terminal"`).
 * 3. `agentCapabilities`: `loadSession: true`; `sessionCapabilities` list and
 *    resume, NO close; `auth.logout`; image, audio and embedded context in
 *    prompts; MCP http and sse. `_meta.antigravity {tier, systemPrompt.append}`.
 * 4. Unauthenticated `session/new` is -32000 "Authentication required" with
 *    `data.message` naming settings.json `auth.type`.
 * 5. `authenticate(oauth-personal)` prints "Open the following link to
 *    authenticate the ACP server: <accounts.google.com URL>" on stderr and
 *    blocks until Google redirects to its 127.0.0.1 listener. The `agy` CLI's
 *    own login is not reused.
 *
 * From the 1.4.1 sources (not exercised without a login): models are the
 * `model` (and `thinking_level`) session config options; `session/set_model`
 * still works but is logged as superseded; the agent has its own `/plan`,
 * `/usage` and `/logout` slash commands; no rewind of earlier turns.
 *
 * Unverified and left at the safe default: `session/cancel` as a request
 * (sent as the spec notification, which every agent accepts), usage events,
 * compaction. With no `session/close`, each chat owns its own process.
 */

import path from "node:path";
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
  standardLoad,
  standardResume,
  standardSetConfigOption,
  transportGatedMcpInjection,
} from "./shared";
import { allocateAcpScratchDir } from "../acpScratchDirs";
import { antigravityCredentialEnv, readAntigravitySettings } from "../../../ai/antigravityAuth";
import type { AgentChatUsageAccount } from "../../../../../shared/types";
import type { AntigravityAuthMethod } from "../../../../../shared/types/config";

/** Config option ids the 1.4.1 agent implements (`set_config_option`). */
export const ANTIGRAVITY_CONFIG_OPTION_IDS = ["mode", "model", "thinking_level"] as const;

/** The stderr line that carries Google's sign-in URL. */
export const ANTIGRAVITY_AUTH_URL_PREFIX = "Open the following link to authenticate the ACP server: ";
/** The stderr line that carries the Gemini Enterprise license page (loopback, that machine only). */
export const ANTIGRAVITY_LICENSE_URL_PREFIX = "Open the following link to choose your Gemini Enterprise license: ";

function harnessFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "localharness_external.exe" : "localharness_external";
}

/**
 * A BROWSER entry that succeeds and opens nothing. Python splits BROWSER on
 * the path separator and runs the entry with the URL only where `%s` appears,
 * so neither entry receives the URL.
 */
export function antigravityNoopBrowser(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "win32") {
    const systemRoot = (env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows").replace(/\\/g, "/");
    return `${systemRoot}/System32/cmd.exe /d /c exit 0`;
  }
  return "/usr/bin/true";
}

/** The agent's own environment for one launch. Exported for the sign-in runner. */
export function antigravitySpawnEnv(args: {
  baseEnv: NodeJS.ProcessEnv;
  harnessPath: string;
  scratchDir: string;
  method: AntigravityAuthMethod | null;
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const platform = args.platform ?? process.platform;
  const env = antigravityCredentialEnv(args.baseEnv, args.method);
  // An inherited harness path or browser from the parent must not win.
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper === "ANTIGRAVITY_HARNESS_PATH" || upper === "BROWSER") delete env[key];
    if (platform === "win32" && (upper === "TEMP" || upper === "TMP")) delete env[key];
    if (platform !== "win32" && upper === "TMPDIR") delete env[key];
  }
  return {
    ...env,
    ANTIGRAVITY_HARNESS_PATH: args.harnessPath,
    BROWSER: antigravityNoopBrowser(platform, args.baseEnv),
    // Line-buffered stderr, so the sign-in URL arrives when it is printed.
    PYTHONUNBUFFERED: "1",
    ...(platform === "win32" ? { TEMP: args.scratchDir, TMP: args.scratchDir } : { TMPDIR: args.scratchDir }),
  };
}

export function antigravityHarnessPath(context: Pick<AcpSpawnContext, "binaryPath" | "binaryFiles">, platform: NodeJS.Platform = process.platform): string {
  return context.binaryFiles?.harness ?? path.join(path.dirname(context.binaryPath), harnessFileName(platform));
}

/**
 * The spawn plan. `method` is the sign-in method whose credentials the agent
 * may see; a chat uses the one the agent recorded at its last `authenticate`,
 * and the sign-in runner passes the method the user is signing in with.
 */
export function buildAntigravitySpawnPlan(
  context: AcpSpawnContext,
  method: AntigravityAuthMethod | null = readAntigravitySettings(context.baseEnv).method,
): AcpSpawnPlan {
  const scratchDir = allocateAcpScratchDir("antigravity");
  return {
    command: context.binaryPath,
    args: [...(context.binaryArgs ?? []), ...(process.platform === "linux" ? ["--uid="] : [])],
    cwd: context.cwd,
    scratchDir,
    env: antigravitySpawnEnv({
      baseEnv: context.baseEnv,
      harnessPath: antigravityHarnessPath(context),
      scratchDir,
      method,
    }),
  };
}

function buildSpawnPlan(context: AcpSpawnContext): AcpSpawnPlan {
  return buildAntigravitySpawnPlan(context);
}

/** Who pays, from the recorded method only (no token read, no network). */
function readAntigravityAccount({ env }: { env: NodeJS.ProcessEnv }): AgentChatUsageAccount {
  const method = readAntigravitySettings(env).method;
  if (method === "gemini-api-key" || method === "agent-platform") return { provider: "antigravity", kind: "api_key" };
  if (method === "oauth-personal" || method === "oauth-business") return { provider: "antigravity", kind: "subscription" };
  return { provider: "antigravity", kind: "unknown" };
}

export const antigravityDialect = defineAcpDialect({
  providerId: "antigravity",
  displayName: "Antigravity",
  tier: "preview",
  binaryNames: ["agy_acp_server"],
  buildSpawnPlan,

  // The agent's session modes are `default`, `auto_edit` and `yolo` (1.4.1).
  // It has no read-only mode: planning is its own `/plan` command, so ADE's
  // Plan runs at Ask and says so once.
  nativeModeValue: (mode) => {
    switch (mode) {
      case "auto-edit":
      case "auto":
        return "auto_edit";
      case "yolo":
        return "yolo";
      default:
        return "default";
    }
  },
  degradationNoteForMode: (mode) =>
    mode === "plan"
      ? "Antigravity has no read-only Plan mode in ADE, so this chat asks before each edit or command. Use Antigravity's own /plan command to plan first."
      : null,

  cancelStyle: "notification",
  // The recorded method is read at spawn, so a pooled process keeps the
  // credentials it started with; one process per chat keeps that honest.
  poolEnvKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"],
  // No `session/close` in the handshake: a chat can only end its session by
  // ending the process.
  oneProcessPerSession: true,
  advertiseFsCapability: false,
  advertiseTerminalCapability: false,
  initializeMeta: null,
  clientInfo: ADE_CLIENT_INFO,
  postSessionNewNotifications: () => [],
  // `/logout` signs the shared login out for every client on the machine;
  // Settings owns sign-in and sign-out, so the chat picker does not offer it.
  includeSlashCommand: (command) => command.name !== "logout",

  sessionIdPersistence: {
    assignableAtLaunch: false,
    sessionsDirName: null,
    idShape: "opaque",
  },

  authProbe: {
    // Every advertised method is agent-driven, and `authenticate` would open a
    // Google sign-in. The probe must never do that: it only checks
    // `session/new` (see acpAuthProbe.ts), and sign-in is the Settings action.
    methodId: null,
    loginCommand: null,
    signInHint: "Sign in from Settings > Providers > Antigravity",
    probeMayAuthenticate: false,
    // Ambient keys are removed from the agent's environment (the recorded
    // method decides), so none is offered as a way to sign in.
    apiKeyEnvVars: [],
  },

  degradationNotes: [
    "Antigravity cannot rewind or edit earlier turns; continue with a follow-up or start a new chat.",
    "Plan mode is Antigravity's own /plan command.",
  ],

  extensionNotifications: {},
  usage: capability(standardAcpUsage),
  localUsage: capabilityAbsent,
  readAccount: readAntigravityAccount,
  inferCompaction: true,
  usageUpdateAfterTurn: false,

  closeStyle: "kill_process",
  closeSession: capabilityAbsent,

  // `sessionCapabilities.resume` and `loadSession` are both advertised.
  loadPolicy: "resume_preferred",
  resumeSession: capability(standardResume),
  loadSession: capability(standardLoad),

  sessionConfig: capability(standardSetConfigOption),
  // The model is the `model` config option; `session/set_model` is superseded.
  modelSelection: capabilityAbsent,
  mcpInjection: capability(transportGatedMcpInjection),
  imagePrompts: capability(inlineImagePrompt),
  configOptionIds: ANTIGRAVITY_CONFIG_OPTION_IDS,
  // `thinking_level` lists the model's sibling variants (minimal … max in
  // 1.4.1); setting it switches to that variant. Only a level the session
  // offers is sent; ADE's `none` has no equivalent.
  reasoningEffortOption: {
    configId: "thinking_level",
    toAgentValue: (effort) => (effort === "none" ? null : effort),
  },
});
