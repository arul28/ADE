import type {
  ComputerUseArtifactKind,
  ComputerUseArtifactLink,
  ComputerUseArtifactOwner,
  ComputerUseOwnerSnapshot,
  ComputerUsePolicy,
} from "../../shared/types";

export function formatComputerUseKind(kind: ComputerUseArtifactKind | string): string {
  return kind.replace(/_/g, " ");
}

export function formatComputerUseMode(policy: ComputerUsePolicy | null | undefined): string {
  return policy?.mode === "enabled" ? "Enabled" : "Auto";
}

export function describeComputerUseOwner(owner: ComputerUseArtifactOwner | Pick<ComputerUseArtifactLink, "ownerKind" | "ownerId">): string {
  const kind = "ownerKind" in owner ? owner.ownerKind : owner.kind;
  const id = "ownerId" in owner ? owner.ownerId : owner.id;
  return `${kind.replace(/_/g, " ")}:${id}`;
}

export function describeComputerUseLinks(links: ComputerUseArtifactLink[]): string {
  if (!links.length) return "Unlinked";
  return links.map((link) => describeComputerUseOwner(link)).join(" • ");
}

export function buildComputerUseRoutePresets(args: {
  laneId?: string | null;
  missionId?: string | null;
  chatSessionId?: string | null;
}) {
  const presets: Array<{ label: string; owner: ComputerUseArtifactOwner }> = [];
  if (args.chatSessionId) {
    presets.push({
      label: "Keep in chat",
      owner: { kind: "chat_session", id: args.chatSessionId },
    });
  }
  if (args.missionId) {
    presets.push({
      label: "Attach to mission",
      owner: { kind: "mission", id: args.missionId },
    });
  }
  if (args.laneId) {
    presets.push({
      label: "Attach to lane",
      owner: { kind: "lane", id: args.laneId },
    });
  }
  return presets;
}

export function summarizeComputerUseProof(snapshot: ComputerUseOwnerSnapshot | null | undefined): string {
  if (!snapshot) return "Computer-use state unavailable.";
  const { requiredKinds, missingKinds, presentKinds } = snapshot.proofCoverage;
  if (requiredKinds.length === 0) {
    return snapshot.artifacts.length > 0
      ? `${snapshot.artifacts.length} retained artifact${snapshot.artifacts.length === 1 ? "" : "s"}`
      : "No proof required";
  }
  if (missingKinds.length === 0) {
    return `Proof satisfied: ${presentKinds.map(formatComputerUseKind).join(", ")}`;
  }
  return `Missing proof: ${missingKinds.map(formatComputerUseKind).join(", ")}`;
}
