import path from "node:path";
import { ACP_PROVIDER_METADATA, type AcpProviderId } from "./acpProviderMetadata";

export type ProviderLoginIsolation = "isolated" | "shared";

/** True only for an embedded runtime whose host explicitly requested isolation. */
export function shouldIsolateEmbeddedProviderLogins(
  runtimeProfile: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const outerProfile = env.ADE_RUNTIME_PROFILE?.trim().toLowerCase();
  return runtimeProfile === "embedded"
    && (!outerProfile || outerProfile === "embedded")
    && env.ADE_EMBEDDED_PROVIDER_LOGINS?.trim().toLowerCase() === "isolated";
}

/**
 * Return the provider-specific config-home overrides ADE's launchers honor.
 * Every path is rooted at this machine's ADE_HOME, so inherited shell values
 * cannot redirect an isolated sign-in back into the user's normal account.
 */
export function embeddedProviderLoginEnv(
  provider: string,
  adeHome: string,
): NodeJS.ProcessEnv | null {
  const root = path.join(path.resolve(adeHome), "provider-homes", provider, "default");
  switch (provider) {
    case "claude": return { CLAUDE_CONFIG_DIR: root };
    case "codex": return { CODEX_HOME: root };
    // Droid appends `.factory` to this home override.
    case "droid": return { FACTORY_HOME_OVERRIDE: root };
    case "cursor": return { CURSOR_CONFIG_DIR: root };
    case "opencode": return { ADE_OPENCODE_XDG_ROOT: root };
    case "pi": return { PI_CODING_AGENT_DIR: root };
    case "muse": return {
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
    };
    default: {
      if (!Object.prototype.hasOwnProperty.call(ACP_PROVIDER_METADATA, provider)) return null;
      const envName = ACP_PROVIDER_METADATA[provider as AcpProviderId].configHomeEnv;
      return envName ? { [envName]: root } : null;
    }
  }
}

export function providerLoginIsolation(
  provider: string,
  runtimeProfile: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  adeHome = env.ADE_HOME?.trim() ?? "",
): ProviderLoginIsolation {
  return shouldIsolateEmbeddedProviderLogins(runtimeProfile, env)
    && Boolean(adeHome)
    && embeddedProviderLoginEnv(provider, adeHome) !== null
    ? "isolated"
    : "shared";
}
