import type {
  ComputerUseArtifactKind,
  ComputerUseArtifactOwner,
  ComputerUseActivityItem,
  ComputerUseArtifactView,
  ComputerUseBackendStatus,
  ComputerUseOwnerSnapshot,
} from "../../../shared/types";
import type { ComputerUseArtifactBrokerService } from "./computerUseArtifactBrokerService";

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

function buildActivity(
  artifacts: ComputerUseArtifactView[],
  backendStatus: ComputerUseBackendStatus,
) : ComputerUseActivityItem[] {
  const liveBackendActivity: ComputerUseActivityItem[] = [];
  for (const backend of backendStatus.backends.slice(0, 4)) {
    const at = new Date().toISOString();
    if (backend.available && backend.state === "installed") {
      liveBackendActivity.push({
        id: `backend:${backend.name}:available`,
        at,
        kind: "backend_available",
        title: `${backend.name} ready`,
        detail: backend.detail,
        backendName: backend.name,
        artifactId: null,
        severity: "success",
      });
      continue;
    }
    if (!backend.available || backend.state === "missing") {
      liveBackendActivity.push({
        id: `backend:${backend.name}:unavailable`,
        at,
        kind: "backend_unavailable",
        title: `${backend.name} unavailable`,
        detail: backend.detail,
        backendName: backend.name,
        artifactId: null,
        severity: "warning",
      });
      continue;
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

  return [...liveBackendActivity, ...artifactActivity]
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, 8);
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
    activity: buildActivity(artifacts, backendStatus),
  };
}
