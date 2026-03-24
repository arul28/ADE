import { spawnSync } from "node:child_process";
import type {
  ComputerUseArtifactKind,
  ComputerUseArtifactOwner,
  ComputerUseActivityItem,
  ComputerUseArtifactView,
  ComputerUseBackendStatus,
  ExternalMcpUsageEvent,
  ExternalMcpServerSnapshot,
  ComputerUseOwnerSnapshot,
  ComputerUseOwnerSnapshotArgs,
  ComputerUsePolicy,
  ComputerUseSettingsSnapshot,
  PhaseCard,
} from "../../../shared/types";
import { createDefaultComputerUsePolicy, isComputerUseModeEnabled } from "../../../shared/types";
import type { ComputerUseArtifactBrokerService } from "./computerUseArtifactBrokerService";
import { commandExists } from "../ai/utils";
import { getGhostDoctorProcessHealth } from "./localComputerUse";

const COMPUTER_USE_KINDS: ComputerUseArtifactKind[] = [
  "screenshot",
  "video_recording",
  "browser_trace",
  "browser_verification",
  "console_logs",
];

export function getComputerUseArtifactKinds(): ComputerUseArtifactKind[] {
  return [...COMPUTER_USE_KINDS];
}

function isGhostOsServer(snapshot: ExternalMcpServerSnapshot): boolean {
  const command = snapshot.config.command?.trim().toLowerCase() ?? "";
  const args = Array.isArray(snapshot.config.args)
    ? snapshot.config.args.map((entry) => entry.trim().toLowerCase())
    : [];
  return command === "ghost" && args.includes("mcp");
}

function buildGhostOsCheck(args: {
  status: ComputerUseBackendStatus;
  snapshots: ExternalMcpServerSnapshot[];
}): ComputerUseSettingsSnapshot["ghostOsCheck"] {
  const repoUrl = "https://github.com/ghostwright/ghost-os";
  const cliInstalled = commandExists("ghost");
  const processHealth = getGhostDoctorProcessHealth();
  const matchingSnapshots = args.snapshots.filter(isGhostOsServer);
  const adeConfigured = matchingSnapshots.length > 0;
  const adeConnected = matchingSnapshots.some((snapshot) => snapshot.state === "connected");
  const backendEntry = args.status.backends.find((backend) => backend.name === "Ghost OS") ?? null;

  if (!cliInstalled) {
    return {
      repoUrl,
      cliInstalled: false,
      setupState: "not_installed",
      adeConfigured,
      adeConnected,
      summary: "Ghost OS is not installed on this Mac.",
      details: [
        "Install the Ghost OS CLI first.",
        "Then run `ghost setup` to grant permissions and install its local dependencies.",
        processHealth.detail,
        adeConfigured
          ? "ADE already has a Ghost OS MCP entry, but it cannot start until the `ghost` CLI exists."
          : "After setup, add `ghost mcp` in ADE External MCP so ADE-launched sessions can use it.",
      ],
      processHealth,
    };
  }

  const statusResult = spawnSync("ghost", ["status"], { encoding: "utf8", timeout: 5000 });
  const combinedOutput = `${statusResult.stdout ?? ""}\n${statusResult.stderr ?? ""}`.trim();
  const outputLines = combinedOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 4);
  const lower = combinedOutput.toLowerCase();
  const setupState: ComputerUseSettingsSnapshot["ghostOsCheck"]["setupState"] =
    /status:\s*ready/i.test(combinedOutput)
      ? "ready"
      : /ghost setup|run `ghost setup` first|not granted|not configured/i.test(lower)
        ? "needs_setup"
        : "unknown";

  if (setupState === "ready") {
    return {
      repoUrl,
      cliInstalled: true,
      setupState,
      adeConfigured,
      adeConnected,
      processHealth,
      summary:
        processHealth.state === "stale"
          ? `Ghost OS is ready, but ${processHealth.detail}`
          : adeConnected
            ? "Ghost OS is ready on this Mac and connected through ADE."
            : adeConfigured
              ? "Ghost OS is ready on this Mac. Connect the ADE MCP server to make it active."
              : "Ghost OS is ready on this Mac, but ADE is not configured to launch it yet.",
      details: [
        ...(outputLines.length > 0 ? outputLines : ["`ghost status` reports ready."]),
        processHealth.detail,
        ...(processHealth.state === "stale"
          ? ["Stop the stale `ghost mcp` processes, then rerun `ghost doctor`."]
          : []),
        adeConfigured
          ? adeConnected
            ? "ADE has a matching `ghost mcp` server and it is currently connected."
            : "ADE has a matching `ghost mcp` server but it is not currently connected."
          : "Add a stdio External MCP server in ADE with command `ghost` and args `mcp`.",
        backendEntry?.detail ?? "Ghost OS tools will appear to ADE as an external computer-use backend once connected.",
      ],
    };
  }

  return {
    repoUrl,
    cliInstalled: true,
    setupState,
    adeConfigured,
    adeConnected,
    processHealth,
    summary: setupState === "needs_setup"
      ? "Ghost OS is installed, but this Mac still needs `ghost setup`."
      : processHealth.state === "stale"
        ? `Ghost OS is installed, but ${processHealth.detail}`
        : "Ghost OS is installed, but ADE could not verify whether setup is complete.",
    details: [
      ...(outputLines.length > 0 ? outputLines : ["`ghost status` did not return a clear ready state."]),
      processHealth.detail,
      ...(processHealth.state === "stale"
        ? ["Stop the stale `ghost mcp` processes, then rerun `ghost doctor`."]
        : []),
      "Run `ghost setup` in Terminal on this Mac.",
      adeConfigured
        ? "After setup completes, reconnect the Ghost OS MCP entry in ADE."
        : "After setup completes, add `ghost mcp` in ADE External MCP.",
    ],
  };
}

export function collectRequiredComputerUseKindsFromPhases(phases: PhaseCard[] | null | undefined): ComputerUseArtifactKind[] {
  if (!Array.isArray(phases) || phases.length === 0) return [];
  return uniqKinds(
    phases.flatMap((phase) => {
      if (!phase.validationGate.required) return [];
      return (phase.validationGate.evidenceRequirements ?? []).filter((kind): kind is ComputerUseArtifactKind =>
        COMPUTER_USE_KINDS.includes(kind as ComputerUseArtifactKind)
      );
    })
  );
}

function uniqKinds(values: ComputerUseArtifactKind[]): ComputerUseArtifactKind[] {
  return [...new Set(values)];
}

function summarizePolicy(policy: ComputerUsePolicy): string {
  if (policy.mode === "off") {
    return "Computer use is off for this scope. ADE will preserve existing evidence, but agents should not capture new computer-use proof here.";
  }
  if (policy.mode === "enabled") {
    return policy.allowLocalFallback
      ? "Computer use is explicitly enabled. ADE should prefer external backends, retain proof artifacts, and may fall back to ADE-local compatibility tools if needed."
      : "Computer use is explicitly enabled. ADE should prefer external backends, retain proof artifacts, and avoid ADE-local fallback tools.";
  }
  return policy.allowLocalFallback
    ? "Computer use is available on demand. ADE will prefer external backends first and may use ADE-local fallback compatibility tools if the operator allows it."
    : "Computer use is available on demand. ADE will prefer external backends first and keep local fallback disabled for this scope.";
}

function buildCapabilityMatrix(status: ComputerUseBackendStatus): ComputerUseSettingsSnapshot["capabilityMatrix"] {
  return COMPUTER_USE_KINDS.map((kind) => ({
    kind,
    externalBackends: status.backends
      .filter((backend) => backend.supportedKinds.includes(kind))
      .map((backend) => backend.name),
    localFallbackAvailable: status.localFallback.supportedKinds.includes(kind),
  }));
}

function selectPreferredBackend(status: ComputerUseBackendStatus): string | null {
  return status.backends.find((backend) => backend.available)?.name ?? null;
}

function usageEventMatchesOwner(
  usageEvent: ExternalMcpUsageEvent,
  owner: ComputerUseArtifactOwner,
): boolean {
  if (owner.kind === "chat_session") {
    return usageEvent.chatSessionId === owner.id || usageEvent.callerId === owner.id;
  }
  if (owner.kind === "mission") {
    return usageEvent.missionId === owner.id;
  }
  if (owner.kind === "orchestrator_run") {
    return usageEvent.runId === owner.id;
  }
  if (owner.kind === "orchestrator_step") {
    return usageEvent.stepId === owner.id;
  }
  if (owner.kind === "orchestrator_attempt") {
    return usageEvent.attemptId === owner.id;
  }
  return false;
}

function buildActivity(
  owner: ComputerUseArtifactOwner,
  artifacts: ComputerUseArtifactView[],
  missingKinds: ComputerUseArtifactKind[],
  backendStatus: ComputerUseBackendStatus,
  usageEvents: ExternalMcpUsageEvent[],
) : ComputerUseActivityItem[] {
  const liveUsageActivity = usageEvents
    .filter((usageEvent) => usageEventMatchesOwner(usageEvent, owner))
    .slice(0, 6)
    .map((usageEvent) => ({
      id: `usage:${usageEvent.id}`,
      at: usageEvent.occurredAt,
      kind: "backend_tool_used" as const,
      title: `${usageEvent.serverName} ran ${usageEvent.toolName}`,
      detail: `${usageEvent.namespacedToolName} was used for this scope.`,
      artifactId: null,
      backendName: usageEvent.serverName,
      severity: "info" as const,
    }));

  const liveBackendActivity: ComputerUseActivityItem[] = [];
  for (const backend of backendStatus.backends.slice(0, 4)) {
    const at = new Date().toISOString();
    if (backend.available && backend.state === "connected") {
      liveBackendActivity.push({
        id: `backend:${backend.name}:connected`,
        at,
        kind: "backend_connected",
        title: `${backend.name} connected`,
        detail: backend.detail,
        backendName: backend.name,
        artifactId: null,
        severity: "success",
      });
      continue;
    }
    if (backend.state === "disconnected" || backend.state === "reconnecting" || backend.state === "failed") {
      liveBackendActivity.push({
        id: `backend:${backend.name}:unavailable`,
        at,
        kind: "backend_unavailable",
        title: `${backend.name} not connected`,
        detail: backend.detail,
        backendName: backend.name,
        artifactId: null,
        severity: "warning",
      });
      continue;
    }
    if (backend.available || backend.state === "installed") {
      liveBackendActivity.push({
        id: `backend:${backend.name}:available`,
        at,
        kind: "backend_available",
        title: `${backend.name} ready`,
        detail: backend.detail,
        backendName: backend.name,
        artifactId: null,
        severity: "info",
      });
    }
  }

  const artifactActivity = artifacts.slice(0, 6).map((artifact) => ({
    id: `artifact:${artifact.id}`,
    at: artifact.createdAt,
    kind: "artifact_ingested" as const,
    title: `${artifact.kind.replace(/_/g, " ")} captured`,
    detail: `${artifact.backendName} produced ${artifact.title}.`,
    artifactId: artifact.id,
    backendName: artifact.backendName,
    severity: artifact.reviewState === "accepted" ? "success" as const : "info" as const,
  }));

  const missingActivity = missingKinds.slice(0, 3).map((kind) => ({
    id: `missing:${kind}`,
    at: new Date(0).toISOString(),
    kind: "proof_missing" as const,
    title: `${kind.replace(/_/g, " ")} still missing`,
    detail: `ADE has not ingested ${kind.replace(/_/g, " ")} for this scope yet.`,
    artifactId: null,
    backendName: null,
    severity: "warning" as const,
  }));

  return [...liveUsageActivity, ...liveBackendActivity, ...artifactActivity, ...missingActivity]
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, 8);
}

export function buildComputerUseSettingsSnapshot(args: {
  status: ComputerUseBackendStatus;
  snapshots?: ExternalMcpServerSnapshot[];
}): ComputerUseSettingsSnapshot {
  const ghostOsCheck = buildGhostOsCheck({ status: args.status, snapshots: args.snapshots ?? [] });
  return {
    backendStatus: args.status,
    preferredBackend: selectPreferredBackend(args.status),
    capabilityMatrix: buildCapabilityMatrix(args.status),
    ghostOsCheck,
    guidance: {
      overview: "External tools perform computer use. ADE discovers backends, ingests their artifacts, normalizes proof, links evidence to missions and chats, and helps operators decide what to do next.",
      ghostOs: "Ghost OS is a local stdio MCP server. Run `ghost setup` on this Mac first, then add `ghost mcp` in ADE External MCP so ADE-launched sessions can use it. If `ghost doctor` reports stale processes, stop them before launching a new session.",
      agentBrowser: "agent-browser is a CLI-native browser automation backend, not an MCP server. Install the CLI locally, run it externally, and ingest its manifests or artifacts into ADE for proof tracking.",
      fallback: "ADE-local computer-use remains fallback-only compatibility support. It should only be used when approved external backends are unavailable for the required proof kind.",
    },
  };
}

export function buildComputerUseOwnerSnapshot(args: {
  broker: ComputerUseArtifactBrokerService;
  owner: ComputerUseArtifactOwner;
  policy?: ComputerUsePolicy | null;
  requiredKinds?: ComputerUseArtifactKind[];
  limit?: number;
  usageEvents?: ExternalMcpUsageEvent[];
}): ComputerUseOwnerSnapshot {
  const policy = args.policy ? createDefaultComputerUsePolicy(args.policy) : null;
  const backendStatus = args.broker.getBackendStatus();
  const artifacts = args.broker.listArtifacts({
    owner: args.owner,
    limit: args.limit ?? 50,
  });
  const recentArtifacts = artifacts.slice(0, 5);
  const presentKinds = uniqKinds(
    artifacts
      .map((artifact) => artifact.kind)
      .filter((kind): kind is ComputerUseArtifactKind => COMPUTER_USE_KINDS.includes(kind))
  );
  const requiredKinds = uniqKinds((args.requiredKinds ?? []).filter((kind) => COMPUTER_USE_KINDS.includes(kind)));
  const missingKinds = requiredKinds.filter((kind) => !presentKinds.includes(kind));
  const usageEvents = (args.usageEvents ?? []).filter((usageEvent) => usageEventMatchesOwner(usageEvent, args.owner));
  const latestUsageEvent = usageEvents[0] ?? null;
  const latestArtifact = recentArtifacts[0] ?? null;
  const connectedBackend = backendStatus.backends.find((backend) => backend.available && backend.state === "connected") ?? null;
  const readyBackend = backendStatus.backends.find((backend) => backend.available) ?? null;
  const preferredBackend = policy?.preferredBackend
    ? backendStatus.backends.find((backend) => backend.name === policy.preferredBackend) ?? null
    : null;
  const availableBackend = backendStatus.backends.find((backend) => backend.available) ?? null;
  const activeBackend = latestArtifact
    ? {
        name: latestArtifact.backendName,
        style: latestArtifact.backendStyle,
        detail: `${latestArtifact.backendName} produced the latest ingested proof for this scope.`,
        source: "artifact" as const,
      }
    : preferredBackend
      ? {
          name: preferredBackend.name,
          style: preferredBackend.style,
          detail: "This scope prefers an explicitly selected backend.",
          source: "policy" as const,
        }
      : availableBackend
        ? {
            name: availableBackend.name,
            style: availableBackend.style,
            detail: availableBackend.detail,
            source: "available" as const,
          }
        : null;

  const usingLocalFallback = recentArtifacts.some((artifact) => artifact.backendStyle === "local_fallback");
  const hasExternalCoverage = missingKinds.every((kind) =>
    backendStatus.backends.some((backend) => backend.available && backend.supportedKinds.includes(kind))
  );
  const summary = [
    policy ? summarizePolicy(policy) : "This scope inherits ADE's default computer-use behavior.",
    requiredKinds.length > 0
      ? missingKinds.length === 0
        ? `All required proof kinds are present: ${requiredKinds.join(", ")}.`
        : hasExternalCoverage
          ? `Missing proof can still be captured through approved external backends: ${missingKinds.join(", ")}.`
          : `Required proof is still missing: ${missingKinds.join(", ")}.`
      : recentArtifacts.length > 0
        ? `${recentArtifacts.length} computer-use artifact${recentArtifacts.length === 1 ? "" : "s"} retained for this scope.`
        : latestUsageEvent
          ? `${latestUsageEvent.serverName} is already active for this scope, but ADE has not ingested proof artifacts yet.`
        : connectedBackend
          ? `${connectedBackend.name} is connected and ready to capture proof for this scope.`
          : readyBackend
            ? `${readyBackend.name} is available and ready to capture proof for this scope.`
            : "No computer-use artifacts have been ingested for this scope yet.",
  ].join(" ");

  return {
    owner: args.owner,
    policy,
    backendStatus,
    summary,
    activeBackend,
    artifacts,
    recentArtifacts,
    activity: buildActivity(args.owner, artifacts, missingKinds, backendStatus, args.usageEvents ?? []),
    proofCoverage: {
      requiredKinds,
      presentKinds,
      missingKinds,
    },
    usingLocalFallback,
  };
}

export function isComputerUseBlockedForRequiredProof(args: {
  policy: ComputerUsePolicy;
  requiredKinds: ComputerUseArtifactKind[];
  backendStatus: ComputerUseBackendStatus;
}): boolean {
  if (args.requiredKinds.length === 0) return false;
  if (!isComputerUseModeEnabled(args.policy.mode)) return true;
  if (args.policy.allowLocalFallback) return false;
  return args.requiredKinds.some((kind) =>
    !args.backendStatus.backends.some((backend) => backend.available && backend.supportedKinds.includes(kind))
  );
}
