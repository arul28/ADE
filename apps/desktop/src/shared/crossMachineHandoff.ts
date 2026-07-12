import type {
  AgentChatAcceptCrossMachineHandoffResult,
  AgentChatCrossMachineDestinationPreflightResult,
  AgentChatSession,
  RemoteRuntimeHandoffStoragePreflightResult,
  RemoteRuntimeRouteKind,
} from "./types";

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing from the response.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function normalizeGitRemoteIdentity(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  if (!trimmed.includes("://")) {
    const withoutSuffix = trimmed.replace(/[?#].*$/, "").replace(/\.git$/i, "");
    const scpLike = /^(?:[^@/:]+@)?([^:]+):(.+)$/.exec(withoutSuffix);
    if (scpLike?.[1] && scpLike[2]) {
      return `${scpLike[1].toLowerCase()}/${scpLike[2].replace(/^\/+/, "")}`.toLowerCase();
    }
    return withoutSuffix.toLowerCase();
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname.toLowerCase()}/${parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "")}`.toLowerCase();
  } catch {
    return trimmed.replace(/[?#].*$/, "").replace(/\.git$/i, "").toLowerCase();
  }
}

export function sanitizePortableGitRemote(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    // HTTP usernames are frequently tokens or other secret-bearing clone
    // credentials. SSH usernames (most commonly `git`) identify the transport
    // account and must survive so the destination can use its own SSH config.
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.username = "";
    }
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // A normal SCP-style remote may contain an SSH username. Query strings and
    // fragments are not meaningful there and can carry accidental credentials.
    return trimmed.replace(/[?#].*$/, "");
  }
}

export function decodeRemoteRuntimeHandoffStoragePreflightResult(
  value: unknown,
): RemoteRuntimeHandoffStoragePreflightResult {
  const record = requireRecord(value, "Destination storage preflight");
  return {
    parentDir: requireString(record.parentDir, "Destination parent folder"),
    targetPath: requireString(record.targetPath, "Destination repository path"),
    freeBytes: requireFiniteNumber(record.freeBytes, "Destination free space"),
    requiredBytes: requireFiniteNumber(record.requiredBytes, "Destination required space"),
    hasEnoughSpace: requireBoolean(record.hasEnoughSpace, "Destination space status"),
    targetExists: requireBoolean(record.targetExists, "Destination path status"),
    blockingErrors: requireStringList(record.blockingErrors, "Destination storage errors"),
    warnings: requireStringList(record.warnings, "Destination storage warnings"),
  };
}

export function decodeCrossMachineDestinationPreflightResult(
  value: unknown,
): AgentChatCrossMachineDestinationPreflightResult {
  const record = requireRecord(value, "Destination handoff preflight");
  // Older ADE destinations omit forkHandoffSupport; callers must treat the
  // absent field as fork-unsupported, so decode it only when present.
  let forkHandoffSupport: AgentChatCrossMachineDestinationPreflightResult["forkHandoffSupport"];
  if (record.forkHandoffSupport != null) {
    const support = requireRecord(record.forkHandoffSupport, "Destination fork handoff support");
    forkHandoffSupport = {
      supported: requireBoolean(support.supported, "Destination fork handoff supported flag"),
      ...(typeof support.reason === "string" && support.reason.trim().length
        ? { reason: support.reason }
        : {}),
    };
  }
  return {
    providerAuthorized: requireBoolean(record.providerAuthorized, "Destination provider authorization"),
    modelAvailable: requireBoolean(record.modelAvailable, "Destination model availability"),
    remoteBranchHeadSha: optionalString(record.remoteBranchHeadSha, "Destination branch commit"),
    existingLaneId: optionalString(record.existingLaneId, "Destination lane identifier"),
    blockingErrors: requireStringList(record.blockingErrors, "Destination handoff errors"),
    warnings: requireStringList(record.warnings, "Destination handoff warnings"),
    ...(forkHandoffSupport ? { forkHandoffSupport } : {}),
  };
}

export function decodeAcceptCrossMachineHandoffResult(
  value: unknown,
): AgentChatAcceptCrossMachineHandoffResult {
  const record = requireRecord(value, "Destination handoff");
  const sessionRecord = requireRecord(record.session, "Destination chat");
  requireString(sessionRecord.id, "Destination chat identifier");
  requireString(sessionRecord.laneId, "Destination chat lane");
  requireString(sessionRecord.provider, "Destination chat provider");
  requireString(sessionRecord.model, "Destination chat model");
  return {
    handoffId: requireString(record.handoffId, "Handoff identifier"),
    laneId: requireString(record.laneId, "Destination lane identifier"),
    session: sessionRecord as unknown as AgentChatSession,
    reusedLane: requireBoolean(record.reusedLane, "Destination lane reuse status"),
    reusedSession: requireBoolean(record.reusedSession, "Destination chat reuse status"),
  };
}

export function requireRemoteRuntimeRouteKind(value: unknown): RemoteRuntimeRouteKind {
  if (value === "lan" || value === "tailnet" || value === "relay" || value === "ssh") return value;
  throw new Error("ADE could not verify the active route to the destination machine. Reconnect and retry.");
}
