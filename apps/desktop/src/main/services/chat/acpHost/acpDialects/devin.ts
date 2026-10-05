/**
 * Devin dialect. `devin acp` — Cognition's Devin CLI speaking Agent Client
 * Protocol over stdio. Native Rust binary (brew `devin-cli`, install.sh);
 * Windows x86 and arm64 builds exist.
 *
 * Auth: `devin auth login` stores account credentials (browser OAuth, any
 * Devin account — no org required). The only auth method the 3000.11.3
 * handshake advertises is `devin-browser`, the browser OAuth flow. ADE still
 * exports the `WINDSURF_API_KEY` a user saved on the Devin provider page, and
 * `devin acp` accepts the ACP `authenticate` request at runtime, so an
 * in-process sign-in path exists — but neither was exercised here.
 *
 * Session ids are the short opaque ids `devin list` shows (e.g.
 * `cliff-watcher`); there is no flag to mint one at launch, and `devin -r <id>`
 * / `devin -c` cover CLI resume. The ACP server reports the id on the wire.
 *
 * Devin's `/handoff` escalates a local chat into a cloud session; ADE's own
 * cloud surface covers that path natively, so no dialect wiring is needed
 * for it here.
 *
 * ## Verified (2026-10-05, CLI 3000.11.3, macOS arm64)
 *
 * Handshake and unauthenticated methods only: this machine has no Devin login
 * and `authenticate` was not called. The binary reports
 * `devin 3000.11.3 (9c803229faa4)` from `--version`, while its `initialize`
 * `agentInfo` says name `affogato`, version `0.0.0-dev`.
 * `fixtures/devin.initialize.json` holds the captured handshake.
 *
 * 1. `session/cancel` as a REQUEST answers -32601. The notification form is
 *    the only one accepted, exactly like Copilot, Grok, Qwen, and Kimi.
 * 2. There is no `session/close`: the method answers -32601, and the handshake
 *    advertises only `list`, `delete`, and `additionalDirectories` under
 *    `sessionCapabilities`. A pooled process is released, not evicted.
 * 3. There is no `session/resume` (-32601). `session/load` exists and returns
 *    the session's modes and config options, and `loadSession` is true, so
 *    rejoin is `load_only`.
 * 4. There is no `session/set_model` (-32601). The model is the `model`
 *    session config option; `session/new` advertises it with a `currentValue`
 *    and, without a login, an empty choice list. ADE sets it through
 *    `session/set_config_option`, like Grok, Qwen, and Kimi.
 * 5. `session/new` succeeds with no login and advertises `mode` and `model`
 *    config options. `session/set_config_option` on `mode` works; an unknown
 *    config id is -32002 and an unknown value is -32602. `session/set_mode`
 *    exists and returns `{}`.
 * 6. An unauthenticated `session/prompt` is -32000 "Please log in to use
 *    Devin. Use `/login` to authenticate again." `isAcpAuthError` reads that
 *    as auth; the literal `notAuthErrorPatterns` regexes did not, so the
 *    registry carries a pattern for it and for `devin acp --cloud`'s
 *    "Not logged in. Please run `auth login` first.".
 * 7. Image prompts are advertised (`promptCapabilities.image: true`); audio is
 *    not. MCP http and sse are advertised, and the handshake's
 *    `_meta.mcpConfigPath` lands inside `$XDG_CONFIG_HOME/devin`.
 *
 * Unverified and left alone: `session/prompt` beyond the auth error, usage,
 * compaction, and `authenticate` all need a real login. `oneProcessPerSession`
 * stays false — no multi-session Devin process was exercised.
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
  standardLoad,
  standardSetConfigOption,
  transportGatedMcpInjection,
  withOptionalEnv,
} from "./shared";
import { readDevinAccount } from "./acpAccounts";
import { getApiCredentialKey } from "../../../ai/apiKeyStore";
import { resolveDevinCliModelForLaunch } from "../../../../../shared/cliLaunch";

/**
 * A Windsurf API key saved on the Devin provider page files under the
 * `devin-cli` credential id — the spawn has to export it or the key a user
 * saved never reaches the CLI. An explicit env var wins over the store.
 */
function storedDevinCliApiKey(baseEnv: NodeJS.ProcessEnv): string | null {
  if (baseEnv.WINDSURF_API_KEY?.trim()) return null;
  try {
    return getApiCredentialKey("devin-cli")?.trim() || null;
  } catch {
    // The store is Electron-main scoped; spawns elsewhere keep env-only auth.
    return null;
  }
}

function buildSpawnPlan(context: AcpSpawnContext): AcpSpawnPlan {
  // `devin acp --model <name>` sets the default model for every ACP session the
  // server opens; the per-session `model` config option still overrides it. The
  // CLI accepts the same fuzzy family names ADE's registry rows carry.
  const model = resolveDevinCliModelForLaunch(context.modelId);
  const args = ["acp", ...(model ? ["--model", model] : [])];
  return {
    command: context.binaryPath,
    args,
    cwd: context.cwd,
    env: withOptionalEnv(context.baseEnv, {
      WINDSURF_API_KEY: storedDevinCliApiKey(context.baseEnv),
    }),
  };
}

export const devinDialect = defineAcpDialect({
  providerId: "devin",
  displayName: "Devin",
  tier: "preview",
  binaryNames: ["devin"],
  buildSpawnPlan,

  // `session/cancel` as a request answers -32601; only the notification form
  // is accepted (verified 3000.11.3, like the other four CLIs).
  cancelStyle: "notification",
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
  // Unverified without a login: Devin is expected to report context size via
  // `usage_update` and never a compaction itself, so the host infers one from a
  // sharp drop in `used`.
  inferCompaction: true,
  usageUpdateAfterTurn: false,

  // No `session/close` on the wire (-32601). The handshake also omits `close`.
  // The host releases the pooled process; `oneProcessPerSession` stays false
  // because sessions were only ever exercised one at a time here.
  closeStyle: "kill_process",
  closeSession: capabilityAbsent,

  // `session/resume` is -32601 and absent from the handshake; `session/load`
  // works and `loadSession` is true.
  loadPolicy: "load_only",
  resumeSession: capabilityAbsent,
  loadSession: capability(standardLoad),

  sessionConfig: capability(standardSetConfigOption),
  // The model is the `model` config option; `session/set_model` is -32601.
  modelSelection: capabilityAbsent,
  mcpInjection: capability(transportGatedMcpInjection),
  imagePrompts: capability(inlineImagePrompt),
  configOptionIds: ["mode", "model"],
});
