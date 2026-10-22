import { PROOF_LISTING_ARTIFACT_FILTER } from "../../../shared/types";
import type {
  ComputerUseArtifactKind,
  ComputerUseArtifactOwner,
  ComputerUseOwnerSnapshot,
} from "../../../shared/types";
import { snapshotFromArtifacts } from "../../../shared/computerUseSnapshot";
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

export function buildComputerUseOwnerSnapshot(args: {
  broker: ComputerUseArtifactBrokerService;
  owner: ComputerUseArtifactOwner;
  limit?: number;
}): ComputerUseOwnerSnapshot {
  return snapshotFromArtifacts({
    owner: args.owner,
    backendStatus: args.broker.getBackendStatus(),
    artifacts: args.broker.listArtifacts({
      owner: args.owner,
      limit: args.limit ?? 50,
      // This snapshot IS the proof drawer — its rows, its counts, its activity
      // feed all come from this one list. A scene still is the picture a
      // generated view left behind, shown inline in the transcript; the broker
      // holds the record because it owns the bytes, not because anybody chose to
      // keep it as evidence. Every settled scene filing a drawer row buried real
      // proof under pictures nobody asked to save.
      ...PROOF_LISTING_ARTIFACT_FILTER,
    }),
  });
}
