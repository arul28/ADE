/**
 * The plain key table: one stored key handed to a harness in the shape that
 * harness reads it.
 *
 * Two callers use it. A bare provider-card key (`resolveCredentialForLaunch`)
 * is always the harness's own vendor's key, so no endpoint needs choosing; and
 * a preset key on a harness that takes no endpoint at all (Kimi, Copilot) or
 * on OpenCode (a provider block in OpenCode's config). Every other preset key
 * is a route — `harnessRouteLaunch.ts` — which picks the endpoint first.
 */

import path from "node:path";

import type { HarnessPresetBody } from "../../../shared/harnessPresets";
import { stripTrailingV1 } from "../../../shared/harnessRoutes";
import { isSafeIdentifier } from "../../../shared/safeIdentifier";
import {
  openCodeSubagentAgentBlock,
  type HarnessSubagentLaunch,
} from "../../../shared/harnessSubagentLaunch";
import type { ApiCredentialSummary } from "../../../shared/types/apiCredentials";
import {
  ensurePrivateDirectory,
  writePrivateFile,
  type PrivateFileSecurityOptions as HarnessPrivateFileSecurity,
} from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import {
  buildCodexPresetConfigToml,
  credentialConfigHome,
  type HarnessPresetOpenCodeProvider,
  presetConfigHome,
  writeDroidPresetSettings,
  writeOpenCodePresetConfig,
} from "./harnessPresetConfigHomes";
function isOpenRouterEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).host.toLowerCase().endsWith("openrouter.ai");
  } catch {
    return baseUrl.toLowerCase().includes("openrouter.ai");
  }
}

type KeySourceResult =
  | {
      status: "ready";
      env: Record<string, string>;
      codexConfigHome?: string;
      openCodeProvider?: HarnessPresetOpenCodeProvider;
      openCodeConfigPath?: string;
      notes?: string[];
    }
  | { status: "unsupported"; unsupported: string };

export type PrivateHomeWriteResult<T> =
  | { status: "ready"; value: T }
  | { status: "unsupported"; unsupported: string };

export function guardedPrivateHomeWrite<T>(write: () => T): PrivateHomeWriteResult<T> {
  try {
    return { status: "ready", value: write() };
  } catch (error) {
    return {
      status: "unsupported",
      unsupported: error instanceof Error
        ? error.message
        : "This launch could not prepare its private provider home on this machine.",
    };
  }
}

/**
 * The whole per-harness key table, in one place.
 *
 * `configHomeId` is what the preset-owned directory is named after — a preset
 * id for a preset launch, the credential id for a bare provider-card key. Both
 * want the same isolation; neither may write into the user's own home.
 */
export function buildKeySourceLaunch(args: {
  harness: HarnessPresetBody;
  credential: ApiCredentialSummary;
  key: string;
  adeHome: string;
  configHomeId: string;
  configHomeKind?: "preset" | "credential";
  configHomeProvider?: string;
  platform?: NodeJS.Platform;
  aclRunner?: HarnessPrivateFileSecurity["aclRunner"];
  currentWindowsUser?: string;
  writeConfig?: boolean;
  /** The preset's subagent model/effort, with the model ids unprefixed. */
  subagent?: HarnessSubagentLaunch;
}): KeySourceResult {
  const {
    harness,
    credential,
    key,
    adeHome,
    configHomeId,
    configHomeKind = "preset",
    configHomeProvider,
    platform,
    aclRunner,
    currentWindowsUser,
    writeConfig = true,
    subagent,
  } = args;
  const security: HarnessPrivateFileSecurity = {
    platform,
    aclRunner,
    currentUser: currentWindowsUser,
  };
  const baseUrl = credential.baseUrl?.trim() || undefined;

  // WHY the whole body is guarded: creating the private home and writing the
  // harness's config file are filesystem operations, and a read-only ADE home,
  // a locked Windows file, or a refused icacls used to escape as a throw. Chat
  // and resume caught it and fell back to the harness's native sign-in, while
  // the CLI and remote-sync launch paths hard-failed on the same disk — one
  // fault, two behaviours. Returning `unsupported` makes every caller degrade
  // the same way, which is rule 2 at the top of this file. Subscription-backed
  // config writes use this exact guard below.
  const build = (): KeySourceResult => {
    const configHome = configHomeKind === "credential"
      ? credentialConfigHome(adeHome, configHomeProvider ?? credential.provider, configHomeId)
      : presetConfigHome(adeHome, configHomeId);
    return buildKeySourceEnv({
      harness,
      credential,
      key,
      baseUrl,
      configHome,
      security,
      writeConfig,
      ...(subagent ? { subagent } : {}),
    });
  };
  if (!writeConfig) return build();
  const guarded = guardedPrivateHomeWrite(build);
  return guarded.status === "ready" ? guarded.value : guarded;
}

/** The per-harness table itself. Throws are the caller's to convert. */
function buildKeySourceEnv(args: {
  harness: HarnessPresetBody;
  credential: ApiCredentialSummary;
  key: string;
  baseUrl: string | undefined;
  configHome: string;
  security: HarnessPrivateFileSecurity;
  writeConfig: boolean;
  /** The preset's subagent model/effort, resolved for this harness. */
  subagent?: HarnessSubagentLaunch;
}): KeySourceResult {
  const { harness, credential, key, baseUrl, configHome, security, writeConfig, subagent } = args;
  switch (harness) {
    case "claude": {
      if (writeConfig) ensurePrivateDirectory(configHome, security);
      const env: Record<string, string> = {
        CLAUDE_CONFIG_DIR: configHome,
        ANTHROPIC_AUTH_TOKEN: key,
      };
      if (baseUrl) env.ANTHROPIC_BASE_URL = stripTrailingV1(baseUrl);
      // OpenRouter rejects a request that carries both an `x-api-key` and a
      // bearer token, and Claude Code sends `x-api-key` whenever
      // ANTHROPIC_API_KEY is non-empty — including one inherited from the
      // user's shell. Emptying it is the documented way to suppress the header.
      if (isOpenRouterEndpoint(baseUrl)) env.ANTHROPIC_API_KEY = "";
      return { status: "ready", env };
    }
    case "codex": {
      if (writeConfig) {
        ensurePrivateDirectory(configHome, security);
        writePrivateFile(
          path.join(configHome, "config.toml"),
          buildCodexPresetConfigToml(baseUrl, subagent),
          security,
        );
      }
      return {
        status: "ready",
        env: { CODEX_HOME: configHome, ADE_PRESET_OPENAI_API_KEY: key },
        codexConfigHome: configHome,
      };
    }
    case "opencode": {
      if (!baseUrl) {
        return {
          status: "unsupported",
          unsupported: "This OpenCode key has no endpoint, and OpenCode needs one to route a custom provider.",
        };
      }
      const models = (credential.models ?? []).filter((model) => model.trim().length);
      const id = credential.provider;
      if (!isSafeIdentifier(id)) {
        return {
          status: "unsupported",
          unsupported: "This OpenCode provider id is unsafe; use only letters, digits, dot, underscore, and dash.",
        };
      }
      const openCodeProvider: HarnessPresetOpenCodeProvider = {
        id,
        block: {
          npm: "@ai-sdk/openai-compatible",
          name: credential.label?.trim() || id,
          options: { baseURL: baseUrl, apiKey: key },
          models: Object.fromEntries(models.map((model) => [model, {} as Record<string, never>])),
        },
      };
      const openCodeConfigPath = writeConfig
        ? writeOpenCodePresetConfig(
          configHome,
          openCodeProvider,
          security,
          // OpenCode addresses a model as `<provider>/<model>`, and this
          // provider's id is the credential's own.
          openCodeSubagentAgentBlock(harness, subagent, (model) => `${id}/${model}`),
        )
        : path.join(configHome, "opencode.json");
      return {
        status: "ready",
        env: { OPENCODE_CONFIG: openCodeConfigPath },
        openCodeProvider,
        openCodeConfigPath,
        ...(models.length ? {} : {
          notes: ["This OpenCode key declares no models, so only models OpenCode already knows are reachable."],
        }),
      };
    }
    case "droid": {
      if (writeConfig) {
        ensurePrivateDirectory(configHome, security);
        writeDroidPresetSettings(configHome, credential, key, security);
      }
      return {
        status: "ready",
        env: { FACTORY_HOME_OVERRIDE: configHome, FACTORY_API_KEY: key },
      };
    }
    case "qwen": {
      const env: Record<string, string> = { OPENAI_API_KEY: key };
      if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
      return { status: "ready", env };
    }
    case "kimi":
      return { status: "ready", env: { MOONSHOT_API_KEY: key } };
    case "grok":
      return { status: "ready", env: { XAI_API_KEY: key } };
    case "copilot":
      return { status: "ready", env: { GITHUB_TOKEN: key } };
    case "cursor":
      // Cursor's SDK signs in from its own single-slot credential, not from an
      // env var the launcher can set per chat. A per-preset key would have to
      // overwrite that slot, which changes every other Cursor chat on the
      // machine — a side effect no preset is allowed to have.
      return {
        status: "unsupported",
        unsupported:
          "Cursor signs in with one key at a time from its own store, so a preset cannot give it a different key.",
      };
    case "pi":
      // Pi reads endpoints and model ids out of its own models.json. There is
      // no env var, and rewriting that file would change every Pi chat.
      return {
        status: "unsupported",
        unsupported:
          "Pi reads its endpoints and model ids from its own models.json, so a preset key has nowhere to go. Add the provider in Pi instead.",
      };
  }
}

