import type {
  ComputerUseArtifactKind,
  ComputerUseArtifactOwner,
  ComputerUseActivityItem,
  ComputerUseArtifactView,
  ComputerUseOwnerSnapshot,
} from "../../../shared/types";
import type { ComputerUseArtifactBrokerService } from "./computerUseArtifactBrokerService";

type ProofPhaseConfig = {
  validationGate: {
    required?: boolean;
    evidenceRequirements?: string[];
  };
};

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

export function collectRequiredComputerUseKindsFromPhases(
  phases: ProofPhaseConfig[],
): ComputerUseArtifactKind[] {
  const required = new Set<ComputerUseArtifactKind>();
  const supported = new Set<ComputerUseArtifactKind>(COMPUTER_USE_KINDS);
  for (const phase of phases) {
    if (!phase.validationGate.required) continue;
    for (const requirement of phase.validationGate.evidenceRequirements ?? []) {
      if (supported.has(requirement as ComputerUseArtifactKind)) {
        required.add(requirement as ComputerUseArtifactKind);
      }
    }
  }
  return Array.from(required);
}

/**
 * Activity is a record of things that happened, so every entry is derived from
 * a stored artifact and carries that artifact's real timestamp. Backend
 * readiness is a *current* condition, not an event — synthesizing feed rows for
 * it stamped with `Date.now()` put fabricated "just now" entries at the top of
 * every scope, which is why that half is gone.
 */
function buildActivity(artifacts: ComputerUseArtifactView[]): ComputerUseActivityItem[] {
  return artifacts.slice(0, 8).map((artifact) => ({
    id: `artifact:${artifact.id}`,
    at: artifact.createdAt,
    kind: "artifact_ingested" as const,
    title: `${artifact.kind.replace(/_/g, " ")} captured`,
    detail: `${artifact.backendName} produced ${artifact.title}.`,
    artifactId: artifact.id,
    backendName: artifact.backendName,
    severity: artifact.availability === "missing_file" || artifact.availability === "unimported"
      ? ("warning" as const)
      : ("success" as const),
  }));
}

export function buildComputerUseOwnerSnapshot(args: {
  broker: ComputerUseArtifactBrokerService;
  owner: ComputerUseArtifactOwner;
  limit?: number;
}): ComputerUseOwnerSnapshot {
  const backendStatus = args.broker.getBackendStatus();
  const artifacts = args.broker.listArtifacts({
    owner: args.owner,
    limit: args.limit ?? 50,
  });
  const recentArtifacts = artifacts.slice(0, 5);
  const latestArtifact = recentArtifacts[0] ?? null;
  const availableBackend = backendStatus.backends.find((backend) => backend.available) ?? null;
  let activeBackend: ComputerUseOwnerSnapshot["activeBackend"] = null;
  if (latestArtifact) {
    activeBackend = {
      name: latestArtifact.backendName,
      detail: `${latestArtifact.backendName} produced the latest ingested proof for this scope.`,
      source: "artifact",
    };
  } else if (availableBackend) {
    activeBackend = {
      name: availableBackend.name,
      detail: availableBackend.detail,
      source: "available",
    };
  }

  let proofSummary: string;
  if (recentArtifacts.length > 0) {
    proofSummary = `${recentArtifacts.length} computer-use artifact${recentArtifacts.length === 1 ? "" : "s"} retained for this scope.`;
  } else if (availableBackend) {
    proofSummary = `${availableBackend.name} is available and ready to capture proof for this scope.`;
  } else {
    proofSummary = "No computer-use artifacts have been ingested for this scope yet.";
  }

  return {
    owner: args.owner,
    backendStatus,
    summary: proofSummary,
    activeBackend,
    artifacts,
    recentArtifacts,
    activity: buildActivity(artifacts),
  };
}
