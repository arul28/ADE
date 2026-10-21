import { PROOF_LISTING_ARTIFACT_FILTER } from "../../../shared/types";
import type {
  ComputerUseArtifactListArgs,
  ComputerUseArtifactView,
  ComputerUseOwnerSnapshot,
  ComputerUseOwnerSnapshotArgs,
} from "../../../shared/types";
import { requestDataUrl } from "./infra/fileBlob";
import { assertWebRuntimePinRoutable, type RuntimePinArg } from "./runtimePinGuard";
import type { AdapterInfra, AdeNamespace } from "./types";

/**
 * The `computerUse` namespace for the hosted web client: the proof reads a chat's
 * citations and scene stills need, and nothing else.
 *
 * Proof lives on the machine that owns the chat, so the record list goes to that
 * host as `computerUse.listArtifacts`, and the bytes come from the host's
 * `readArtifact` file request, which is jailed to `.ade/artifacts`. Recording, the
 * live Mac screen and the loopback media server need a local renderer, so they
 * stay unsupported here.
 *
 * A failed list rejects. It never resolves to `[]`: the citation UI reads an empty
 * answer as "this proof does not exist", and an offline or older host is not that.
 */
export function createComputerUseNamespace(infra: AdapterInfra): AdeNamespace<"computerUse"> {
  const { client, commands, state } = infra;
  const scope = { client, state };
  const unavailable = () => {
    throw new Error("The proof list needs the ADE machine that owns this chat, and it did not answer.");
  };

  const listArtifacts = (args: ComputerUseArtifactListArgs, pin?: RuntimePinArg): Promise<ComputerUseArtifactView[]> => {
    assertWebRuntimePinRoutable("computerUse.listArtifacts", pin, scope);
    return commands.call<ComputerUseArtifactView[]>("computerUse.listArtifacts", {
      artifactId: args.artifactId,
      ownerKind: args.ownerKind,
      ownerId: args.ownerId,
      kind: args.kind,
      metadataKind: args.metadataKind,
      excludeMetadataKind: args.excludeMetadataKind,
      limit: args.limit,
    }, { fallback: unavailable, idempotent: true, authoritative: true });
  };

  return {
    getStatus: async () => ({ supported: false, available: false, state: "unsupported" }),
    listDevices: async () => [],
    onEvent: () => () => {},
    listArtifacts: async (args: ComputerUseArtifactListArgs = {}, pin?: RuntimePinArg): Promise<ComputerUseArtifactView[]> =>
      listArtifacts(args, pin),
    // The host has no remote owner-snapshot command, so the chat's proof drawer
    // is built here from the same listing the desktop snapshot uses. The web
    // client captures nothing itself, so it reports no capture backend. Without
    // this the fallback proxy answered `null` and the chat pane crashed.
    getOwnerSnapshot: async (args: ComputerUseOwnerSnapshotArgs, pin?: RuntimePinArg): Promise<ComputerUseOwnerSnapshot> => {
      const artifacts = await listArtifacts({
        ownerKind: args.owner.kind,
        ownerId: args.owner.id,
        limit: args.limit ?? 50,
        ...PROOF_LISTING_ARTIFACT_FILTER,
      }, pin);
      const recentArtifacts = artifacts.slice(0, 5);
      const latest = recentArtifacts[0] ?? null;
      return {
        owner: args.owner,
        backendStatus: {
          backends: [],
          localFallback: { available: false, detail: "The web client does not capture proof.", supportedKinds: [] },
        },
        summary: recentArtifacts.length > 0
          ? `${recentArtifacts.length} computer-use artifact${recentArtifacts.length === 1 ? "" : "s"} retained for this scope.`
          : "No computer-use artifacts have been ingested for this scope yet.",
        activeBackend: latest
          ? {
              name: latest.backendName,
              detail: `${latest.backendName} produced the latest ingested proof for this scope.`,
              source: "artifact",
            }
          : null,
        artifacts,
        recentArtifacts,
        activity: artifacts.slice(0, 8).map((artifact) => ({
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
        })),
      };
    },
    readArtifactPreview: async (args: { uri: string }, pin?: RuntimePinArg): Promise<string | null> => {
      assertWebRuntimePinRoutable("computerUse.readArtifactPreview", pin, scope);
      return requestDataUrl(client, state, "readArtifact", { uri: args.uri });
    },
  } as unknown as AdeNamespace<"computerUse">;
}
