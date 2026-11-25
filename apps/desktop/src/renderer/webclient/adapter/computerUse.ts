import { PROOF_LISTING_ARTIFACT_FILTER } from "../../../shared/types";
import { snapshotFromArtifacts } from "../../../shared/computerUseSnapshot";
import type {
  ComputerUseArtifactListArgs,
  ComputerUseArtifactView,
  ComputerUseOwnerSnapshot,
  ComputerUseOwnerSnapshotArgs,
} from "../../../shared/types";
import type { SyncArtifactRange } from "../../../shared/types/sync";
import { requestDataUrl, requestFileBlob } from "./infra/fileBlob";
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
    // The host has no remote owner-snapshot command, so the chat's proof
    // drawer is built here from the same listing and builder the desktop uses.
    // The web client captures nothing itself, so it reports no capture backend.
    getOwnerSnapshot: async (args: ComputerUseOwnerSnapshotArgs, pin?: RuntimePinArg): Promise<ComputerUseOwnerSnapshot> =>
      snapshotFromArtifacts({
        owner: args.owner,
        backendStatus: {
          backends: [],
          localFallback: { available: false, detail: "The web client does not capture proof.", supportedKinds: [] },
        },
        artifacts: await listArtifacts({
          ownerKind: args.owner.kind,
          ownerId: args.owner.id,
          limit: args.limit ?? 50,
          ...PROOF_LISTING_ARTIFACT_FILTER,
        }, pin),
      }),
    readArtifactPreview: async (args: { uri: string }, pin?: RuntimePinArg): Promise<string | null> => {
      assertWebRuntimePinRoutable("computerUse.readArtifactPreview", pin, scope);
      const cached = largeMediaUrls.get(args.uri);
      if (cached) return cached;
      try {
        return await requestDataUrl(client, state, "readArtifact", { uri: args.uri });
      } catch (error) {
        // A proof over the host's whole-file cap (8 MiB): pull it in slices,
        // the way the phone plays a long recording.
        if (!/too large/i.test(error instanceof Error ? error.message : String(error))) throw error;
        const url = await readLargeArtifact(args.uri);
        rememberLargeMediaUrl(args.uri, url);
        return url;
      }
    },
  } as unknown as AdeNamespace<"computerUse">;

  async function readLargeArtifact(uri: string): Promise<string> {
    const parts: Uint8Array[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const slice = (await requestFileBlob(client, state, "readArtifactRange", { uri, offset })) as unknown as SyncArtifactRange;
      total = slice.totalSize;
      if (total > WEB_LARGE_MEDIA_MAX_BYTES) {
        throw new Error(`This proof is ${Math.round(total / (1024 * 1024))} MB, too large to play in the browser. Open it in the ADE app.`);
      }
      const bytes = base64ToBytes(slice.content);
      if (!bytes.length) break;
      parts.push(bytes);
      offset += bytes.length;
      if (slice.eof) break;
    }
    return URL.createObjectURL(new Blob(parts as BlobPart[], { type: mediaTypeForUri(uri) }));
  }
}

/** The largest proof the browser pulls into memory to play. */
const WEB_LARGE_MEDIA_MAX_BYTES = 256 * 1024 * 1024;
/** Object URLs kept, so a scroll or a remount does not pull a long video again. */
const LARGE_MEDIA_URL_KEEP = 4;
const largeMediaUrls = new Map<string, string>();

function rememberLargeMediaUrl(uri: string, url: string): void {
  largeMediaUrls.set(uri, url);
  while (largeMediaUrls.size > LARGE_MEDIA_URL_KEEP) {
    const [oldestUri, oldestUrl] = largeMediaUrls.entries().next().value as [string, string];
    largeMediaUrls.delete(oldestUri);
    URL.revokeObjectURL(oldestUrl);
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A QuickTime movie plays as MP4 in Chromium (see `playableMedia.ts`). */
function mediaTypeForUri(uri: string): string {
  const extension = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(uri)?.[1]?.toLowerCase() ?? "";
  switch (extension) {
    case "mp4": case "m4v": case "mov": return "video/mp4";
    case "webm": return "video/webm";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    default: return "application/octet-stream";
  }
}
