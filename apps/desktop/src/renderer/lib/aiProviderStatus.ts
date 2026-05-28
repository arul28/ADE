import type {
  AiDetectedAuth,
  AiProviderConnectionStatus,
  AiRuntimeConnectionStatus,
  AiSettingsStatus,
} from "../../shared/types";

function hasUsableDetectedAuth(entry: AiDetectedAuth): boolean {
  if (entry.type === "cli-subscription") {
    return entry.authenticated === true || entry.verified !== true;
  }
  return true;
}

function hasUsableProviderConnection(
  connection: AiProviderConnectionStatus | null | undefined,
): boolean {
  return Boolean(connection?.authAvailable || connection?.runtimeAvailable);
}

function hasUsableRuntimeConnection(
  connection: AiRuntimeConnectionStatus | null | undefined,
): boolean {
  return Boolean(
    connection?.authAvailable ||
    connection?.runtimeAvailable ||
    (connection?.loadedModelIds?.length ?? 0) > 0,
  );
}

export function hasConfiguredAiProvider(
  status: AiSettingsStatus | null | undefined,
): boolean {
  if (!status) return false;

  const providerConnections = status.providerConnections;
  if (
    hasUsableProviderConnection(providerConnections?.claude) ||
    hasUsableProviderConnection(providerConnections?.codex) ||
    hasUsableProviderConnection(providerConnections?.cursor) ||
    hasUsableProviderConnection(providerConnections?.droid)
  ) {
    return true;
  }

  const availableProviders = status.availableProviders;
  if (
    availableProviders?.claude?.auth?.ready === true ||
    availableProviders?.codex === true ||
    availableProviders?.cursor === true ||
    availableProviders?.droid === true
  ) {
    return true;
  }

  if (status.detectedAuth?.some(hasUsableDetectedAuth)) {
    return true;
  }

  if (status.availableModelIds?.some((id) => String(id ?? "").trim().length > 0)) {
    return true;
  }

  if (Object.values(status.runtimeConnections ?? {}).some(hasUsableRuntimeConnection)) {
    return true;
  }

  return Boolean(status.opencodeProviders?.some((provider) => provider.connected));
}
