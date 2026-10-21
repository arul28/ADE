import type {
  ComputerUseActivityItem,
  ComputerUseArtifactOwner,
  ComputerUseArtifactView,
  ComputerUseBackendStatus,
  ComputerUseOwnerSnapshot,
} from "./types";

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

/**
 * A scope's proof drawer from its artifact list (already filtered with
 * `PROOF_LISTING_ARTIFACT_FILTER`) and the capture backends. One builder for
 * the desktop main process and the hosted web client, so both drawers say the
 * same thing.
 */
export function snapshotFromArtifacts(args: {
  owner: ComputerUseArtifactOwner;
  artifacts: ComputerUseArtifactView[];
  backendStatus: ComputerUseBackendStatus;
}): ComputerUseOwnerSnapshot {
  const { artifacts, backendStatus } = args;
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
