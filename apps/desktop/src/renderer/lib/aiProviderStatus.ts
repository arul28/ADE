import type {
  AgentChatEventEnvelope,
  AiDetectedAuth,
  AiProviderConnectionStatus,
  AiRuntimeConnectionStatus,
  AiSettingsStatus,
} from "../../shared/types";

const AUTH_ERROR_SIGNALS = [
  "invalid authentication credentials",
  "authentication error",
  "authentication_error",
  "authentication failed",
  "not authenticated",
  "not logged in",
  "login required",
  "sign in",
  "invalid api key",
  "api error: 401",
  "status 401",
  "claude auth login",
  "codex login",
  "/login",
];

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

export function hasLocalProviderConnectionSignal(
  connection: AiProviderConnectionStatus | null | undefined,
): boolean {
  return Boolean(
    connection?.authAvailable ||
    connection?.usageAvailable ||
    connection?.runtimeDetected ||
    connection?.runtimeAvailable,
  );
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

export function isAuthRelatedChatMessage(message: string | null | undefined): boolean {
  const normalized = String(message ?? "").trim().toLowerCase();
  if (!normalized.length) return false;
  return AUTH_ERROR_SIGNALS.some((signal) => normalized.includes(signal));
}

export function shouldRefreshAiStatusForChatEvent(envelope: AgentChatEventEnvelope): boolean {
  const event = envelope.event;
  if (event.type === "system_notice" && event.noticeKind === "auth") return true;
  if (event.type === "error") return isAuthRelatedChatMessage(event.message);
  if (event.type === "status" && event.turnStatus === "failed") {
    return isAuthRelatedChatMessage(event.message);
  }
  return false;
}
