/**
 * One row in Pi's provider catalog, and the questions both the tile and the
 * detail dialog ask of it.
 *
 * Its own module so neither of those two has to import from the other.
 */
import type { AiPiProviderStatus, AiRuntimeConnectionStatus, AiRuntimeConnections, PiLoginMethod, PiLoginProvider } from "../../../shared/types/config";

export type PiProviderRow = {
  id: string;
  name: string;
  status: AiPiProviderStatus | null;
  login: PiLoginProvider | null;
};

export function piProviderIsConnected(provider: PiProviderRow): boolean {
  return provider.status?.configured ?? provider.login?.configured ?? false;
}

export function piProviderModelCount(provider: PiProviderRow): number | null {
  const status = provider.status;
  if (!status) return null;
  return status.availableModelCount || status.modelCount;
}

/** Short description of how a provider authenticates. */
export function piProviderAuthSummary(provider: AiPiProviderStatus): string {
  if (provider.authType === "oauth") return provider.subscription ? "OAuth subscription" : "OAuth";
  if (provider.authType === "api-key") return "API key";
  if (provider.authType === "local") return "Local endpoint";
  return "Configured in Pi";
}

export function piLoginMethodLabel(provider: PiLoginProvider, method: PiLoginMethod): string {
  if (method === "api_key") return "Use an API key";
  return provider.loginLabel ?? (provider.isSubscription ? "Sign in with your subscription" : "Sign in");
}

/**
 * ADE's local-server probe for a Pi provider, or `null` when ADE has none.
 *
 * The probe map is keyed by ADE's own provider ids while the row carries Pi's,
 * and the two namespaces only happen to agree on `ollama` and `lmstudio`. A
 * named lookup keeps that assumption in one place instead of leaving a bare
 * index to degrade silently into "no detection" for anything else.
 */
export function runtimeConnectionForPiProvider(
  connections: AiRuntimeConnections,
  piProviderId: string,
): AiRuntimeConnectionStatus | null {
  return connections[piProviderId.trim().toLowerCase()] ?? null;
}
