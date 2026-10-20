import type { ComputerUseArtifactListArgs, ComputerUseArtifactView } from "../../../shared/types";
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

  return {
    getStatus: async () => ({ supported: false, available: false, state: "unsupported" }),
    listDevices: async () => [],
    onEvent: () => () => {},
    listArtifacts: async (args: ComputerUseArtifactListArgs = {}, pin?: RuntimePinArg): Promise<ComputerUseArtifactView[]> => {
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
    },
    readArtifactPreview: async (args: { uri: string }, pin?: RuntimePinArg): Promise<string | null> => {
      assertWebRuntimePinRoutable("computerUse.readArtifactPreview", pin, scope);
      return requestDataUrl(client, state, "readArtifact", { uri: args.uri });
    },
  } as unknown as AdeNamespace<"computerUse">;
}
