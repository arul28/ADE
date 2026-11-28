import { PROOF_LISTING_ARTIFACT_FILTER } from "../../../shared/types";
import { snapshotFromArtifacts } from "../../../shared/computerUseSnapshot";
import type {
  ComputerUseArtifactListArgs,
  ComputerUseArtifactView,
  ComputerUseOwnerSnapshot,
  ComputerUseOwnerSnapshotArgs,
} from "../../../shared/types";
import { inlineMediaMime } from "../../components/chat/chatInlineMediaUtils";
import { base64ToBytes } from "../../lib/base64";
import { playableVideoMime } from "../../lib/playableMedia";
import { requestArtifactRange, requestDataUrl } from "./infra/fileBlob";
import { assertWebRuntimePinRoutable, type RuntimePinArg } from "./runtimePinGuard";
import type { AdapterInfra, AdeNamespace } from "./types";
import { BRAND } from "../../../shared/brand";

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
    throw new Error(`The proof list needs the ${BRAND.NAME} machine that owns this chat, and it did not answer.`);
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
      // A path is only unique within one machine's project.
      const cacheKey = `${client.getStatus().selectedEnvId ?? ""}\u0000${state.getProjectId() ?? ""}\u0000${args.uri}`;
      const cached = largeMediaUrls.get(cacheKey);
      if (cached) return cached;
      try {
        return await requestDataUrl(client, state, "readArtifact", { uri: args.uri });
      } catch (error) {
        // A proof over the host's whole-file cap (8 MiB): pull it in slices,
        // the way the phone plays a long recording.
        if (!/too large/i.test(error instanceof Error ? error.message : String(error))) throw error;
        // Two tiles (or a tile and the drawer) asking at once share one pull.
        const pending = largeMediaLoads.get(cacheKey);
        if (pending) return pending;
        const load = readLargeArtifact(args.uri)
          .then((url) => {
            rememberLargeMediaUrl(cacheKey, url);
            return url;
          })
          .finally(() => largeMediaLoads.delete(cacheKey));
        largeMediaLoads.set(cacheKey, load);
        return load;
      }
    },
  } as unknown as AdeNamespace<"computerUse">;

  async function readLargeArtifact(uri: string): Promise<string> {
    const parts: Uint8Array[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const slice = await requestArtifactRange(client, state, { uri, offset });
      total = slice.totalSize;
      if (total > WEB_LARGE_MEDIA_MAX_BYTES) {
        throw new Error(`This proof is ${Math.round(total / (1024 * 1024))} MB, too large to play in the browser. Open it in the ${BRAND.NAME} app.`);
      }
      const bytes = base64ToBytes(slice.content);
      if (!bytes.length) {
        if (slice.eof) break;
        throw new Error("The machine sent an empty part of this proof. Try again.");
      }
      parts.push(bytes);
      offset += bytes.length;
      if (slice.eof) break;
    }
    // A QuickTime movie plays as MP4 in Chromium (see `playableMedia.ts`).
    return URL.createObjectURL(new Blob(parts as BlobPart[], { type: playableVideoMime(inlineMediaMime(uri.split(/[?#]/)[0] ?? uri)) }));
  }
}

/** The largest proof the browser pulls into memory to play. */
const WEB_LARGE_MEDIA_MAX_BYTES = 256 * 1024 * 1024;
/** Object URLs kept, so a scroll or a remount does not pull a long video again. */
const LARGE_MEDIA_URL_KEEP = 4;
const largeMediaUrls = new Map<string, string>();
const largeMediaLoads = new Map<string, Promise<string>>();

/** Evicted URLs a page element still showed, revoked once nothing shows them. */
const retiredLargeMediaUrls = new Set<string>();

function shownOnPage(url: string): boolean {
  if (typeof document === "undefined") return false;
  for (const element of Array.from(document.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video"))) {
    if (element.currentSrc === url || element.src === url) return true;
  }
  return false;
}

function rememberLargeMediaUrl(key: string, url: string): void {
  largeMediaUrls.set(key, url);
  while (largeMediaUrls.size > LARGE_MEDIA_URL_KEEP) {
    const [oldestKey, oldestUrl] = largeMediaUrls.entries().next().value as [string, string];
    largeMediaUrls.delete(oldestKey);
    retiredLargeMediaUrls.add(oldestUrl);
  }
  // A proof still on screen keeps its bytes; revoking it would blank the
  // video or the full-size view it opens.
  for (const retired of retiredLargeMediaUrls) {
    if (shownOnPage(retired)) continue;
    retiredLargeMediaUrls.delete(retired);
    URL.revokeObjectURL(retired);
  }
}
