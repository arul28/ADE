import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { proofCitationMarkdown } from "../../../shared/proofCitation";
import {
  PROOF_LISTING_ARTIFACT_FILTER,
  type ComputerUseArtifactIngestionRequest,
  type ComputerUseArtifactIngestionResult,
  type ComputerUseArtifactKind,
  type ComputerUseArtifactView,
} from "../../../shared/types";
import type { CtoMachineTarget, CtoRemoteActionCall } from "../ai/tools/ctoCrossMachine";
import { ensurePlayableVideo, isConvertibleVideoPath } from "../computerUse/proofPlayableVideo";
import type { Logger } from "../logging/logger";
import { getErrorMessage, isRecord } from "../shared/utils";

/**
 * How the CTO shows proof another chat filed: a child's screenshot, a
 * helper's recording. The CTO's answer cites `ade-proof://<id>`, and every
 * client resolves that id through the CTO's own chat on the CTO's home
 * machine, so the proof has to be there and owned by the CTO chat:
 *
 * - On the same machine it already is. One more owner link puts it in the
 *   CTO chat's proof list (the phone reads that list), with no copy.
 * - On another machine or an ADE Cloud lane, its bytes are pulled here in
 *   slices and filed as the CTO's, with where they came from. Pulled once:
 *   the copy outlives the other machine going to sleep.
 *
 * A video that is not an MP4 gets an MP4 copy, since a WebM never plays on
 * the phone and a MOV is a gamble in a browser.
 */

export type CtoShownProof = {
  artifactId: string;
  kind: ComputerUseArtifactKind;
  title: string;
  /** The markdown to put in the reply. */
  cite: string;
  /** The child's own record, when this is a copy (an MP4 or a pull from another machine). */
  sourceArtifactId?: string;
  note?: string;
};

export type CtoProofShareResult = {
  shown: CtoShownProof[];
  /** Proof that could not be shown, each with why. */
  skipped: Array<{ artifactId: string; title: string; reason: string }>;
  /** More proof the chat holds than this call showed. */
  more: number;
};

export type CtoProofBroker = {
  listArtifacts: (args?: any) => ComputerUseArtifactView[];
  linkArtifactsToChat: (args: { artifactIds: string[]; chatSessionId: string }) => ComputerUseArtifactView[];
  ingestAsync: (request: ComputerUseArtifactIngestionRequest) => Promise<ComputerUseArtifactIngestionResult>;
  resolveArtifactFilePath: (artifact: Pick<ComputerUseArtifactView, "storageKind" | "uri">) => string | null;
};

/** Which of a chat's proof to show. `latest`: the newest turn that filed any. */
export type CtoProofSelection = { turnId: string } | "latest" | "all";

export const CTO_PROOF_SHOW_LIMIT = 8;
/** A slice small enough that its base64 stays well under the bridge's 12 MiB result cap. */
const REMOTE_SLICE_BYTES = 4 * 1024 * 1024;
/** The most one pulled file may weigh. A longer recording should be trimmed where it was made. */
export const CTO_REMOTE_PROOF_MAX_BYTES = 512 * 1024 * 1024;
const REMOTE_SLICE_TIMEOUT_MS = 60_000;
const SHOWABLE_KINDS = new Set<ComputerUseArtifactKind>(["screenshot", "video_recording"]);

function turnIdOf(artifact: ComputerUseArtifactView): string | null {
  const value = artifact.metadata?.turnId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isShowable(artifact: ComputerUseArtifactView): boolean {
  return SHOWABLE_KINDS.has(artifact.kind)
    || Boolean(artifact.mimeType?.startsWith("image/") || artifact.mimeType?.startsWith("video/"));
}

/** Newest first, the way the broker lists. */
export function selectChatProof(
  artifacts: ComputerUseArtifactView[],
  selection: CtoProofSelection,
  limit = CTO_PROOF_SHOW_LIMIT,
): { picked: ComputerUseArtifactView[]; more: number } {
  const showable = artifacts.filter(isShowable);
  let pool: ComputerUseArtifactView[];
  if (selection === "all") {
    pool = showable;
  } else if (selection === "latest") {
    const newestTurn = showable.map(turnIdOf).find((id) => id != null) ?? null;
    pool = newestTurn ? showable.filter((artifact) => turnIdOf(artifact) === newestTurn) : showable;
  } else {
    pool = showable.filter((artifact) => turnIdOf(artifact) === selection.turnId);
  }
  // Shown in the order it was filed, so a reply reads like the work went.
  const picked = pool.slice(0, limit).reverse();
  return { picked, more: Math.max(0, pool.length - picked.length) };
}

function shown(artifact: Pick<ComputerUseArtifactView, "id" | "kind" | "title">, extra: Partial<CtoShownProof> = {}): CtoShownProof {
  return {
    artifactId: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    cite: proofCitationMarkdown(artifact.id, artifact.title),
    ...extra,
  };
}

function ownedCopyOf(
  broker: CtoProofBroker,
  ctoSessionId: string,
  matches: (metadata: Record<string, unknown>) => boolean,
): ComputerUseArtifactView | null {
  return broker.listArtifacts({
    ownerKind: "chat_session",
    ownerId: ctoSessionId,
    limit: 500,
    ...PROOF_LISTING_ARTIFACT_FILTER,
  }).find((row) => row.availability !== "missing_file" && matches(row.metadata ?? {})) ?? null;
}

async function fileAsCto(args: {
  broker: CtoProofBroker;
  ctoSessionId: string;
  filePath: string;
  kind: ComputerUseArtifactKind;
  title: string;
  description?: string | null;
  metadata: Record<string, unknown>;
  toolName: string;
}): Promise<ComputerUseArtifactView> {
  const result = await args.broker.ingestAsync({
    backend: { name: "cto", style: "manual", toolName: args.toolName },
    // A copy of proof that is already filed, so the duplicate check would
    // refuse the very bytes this exists to show.
    provenance: { source: "attached", refuseDuplicates: false, flagOlderMedia: false },
    inputs: [{
      kind: args.kind,
      title: args.title,
      path: args.filePath,
      ...(args.description?.trim() ? { description: args.description.trim() } : {}),
      metadata: args.metadata,
    }],
    owners: [{ kind: "chat_session", id: args.ctoSessionId, relation: "attached_to" }],
  });
  const record = result.artifacts[0];
  if (!record) throw new Error("ADE filed nothing.");
  const [view] = args.broker.listArtifacts({ artifactId: record.id, limit: 1 });
  return view ?? { ...record, links: result.links, reviewState: "pending", workflowState: "evidence_only", reviewNote: null };
}

/**
 * Files `sourcePath` (a picture or a video on this machine) as the CTO's
 * proof and returns the cite for its reply. A video that is not an MP4 is
 * converted first; when it cannot be, the original is filed with a note.
 */
export async function showFileAsCtoProof(args: {
  broker: CtoProofBroker;
  ctoSessionId: string;
  sourcePath: string;
  caption: string;
  scratchDir: string;
  logger?: Logger | null;
}): Promise<CtoShownProof> {
  const extension = path.extname(args.sourcePath).toLowerCase();
  const video = /^\.(mp4|m4v|mov|qt|webm|mkv|avi)$/.test(extension);
  const image = /^\.(png|jpe?g|gif|webp|heic|heif|tiff?)$/.test(extension);
  if (!video && !image) {
    throw new Error(`showMedia shows pictures and videos; ${path.basename(args.sourcePath)} is neither.`);
  }
  const stat = await fs.promises.stat(args.sourcePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`There is no file at ${args.sourcePath}.`);
  let filePath = args.sourcePath;
  let note: string | undefined;
  let converted = false;
  if (video && isConvertibleVideoPath(args.sourcePath)) {
    try {
      const playable = await ensurePlayableVideo({ sourcePath: args.sourcePath, outputDir: args.scratchDir, logger: args.logger ?? null });
      filePath = playable.path;
      converted = playable.converted;
    } catch (error) {
      note = getErrorMessage(error);
    }
  }
  try {
    const view = await fileAsCto({
      broker: args.broker,
      ctoSessionId: args.ctoSessionId,
      filePath,
      kind: video ? "video_recording" : "screenshot",
      title: args.caption,
      metadata: converted ? { convertedFromPath: args.sourcePath } : {},
      toolName: "showMedia",
    });
    return shown(view, note ? { note } : {});
  } finally {
    if (converted) await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
  }
}

/** An MP4 copy of a filed video, owned by the CTO; null when it already plays everywhere. */
async function playableCopyFor(args: {
  broker: CtoProofBroker;
  ctoSessionId: string;
  artifact: ComputerUseArtifactView;
  scratchDir: string;
  logger?: Logger | null;
}): Promise<CtoShownProof | null> {
  const sourcePath = args.broker.resolveArtifactFilePath(args.artifact);
  if (!sourcePath || !isConvertibleVideoPath(sourcePath)) return null;
  const existing = ownedCopyOf(args.broker, args.ctoSessionId, (metadata) => metadata.convertedFrom === args.artifact.id);
  if (existing) return shown(existing, { sourceArtifactId: args.artifact.id });
  const playable = await ensurePlayableVideo({ sourcePath, outputDir: args.scratchDir, logger: args.logger ?? null });
  if (!playable.converted) return null;
  try {
    const view = await fileAsCto({
      broker: args.broker,
      ctoSessionId: args.ctoSessionId,
      filePath: playable.path,
      kind: args.artifact.kind,
      title: args.artifact.title,
      description: args.artifact.description,
      metadata: { convertedFrom: args.artifact.id },
      toolName: "getChatProof",
    });
    return shown(view, { sourceArtifactId: args.artifact.id });
  } finally {
    await fs.promises.rm(playable.path, { force: true }).catch(() => undefined);
  }
}

/**
 * Shows a chat's proof in the CTO chat when both live in this project on
 * this machine. Links the records (no copy), and makes an MP4 copy of a video
 * that needs one. A record whose file is gone is skipped with that reason.
 */
export async function shareChatProofWithCto(args: {
  broker: CtoProofBroker;
  chatSessionId: string;
  ctoSessionId: string;
  selection: CtoProofSelection;
  scratchDir: string;
  limit?: number;
  /** Leave out proof the CTO chat already holds (linked, or an MP4 copy of it). */
  onlyUnshared?: boolean;
  logger?: Logger | null;
}): Promise<CtoProofShareResult> {
  let listed = args.broker.listArtifacts({
    ownerKind: "chat_session",
    ownerId: args.chatSessionId,
    limit: 200,
    ...PROOF_LISTING_ARTIFACT_FILTER,
  });
  if (args.onlyUnshared) {
    const copiedFrom = new Set(
      args.broker.listArtifacts({ ownerKind: "chat_session", ownerId: args.ctoSessionId, limit: 500, ...PROOF_LISTING_ARTIFACT_FILTER })
        .map((row) => row.metadata?.convertedFrom)
        .filter((id): id is string => typeof id === "string"),
    );
    listed = listed.filter((artifact) =>
      !copiedFrom.has(artifact.id)
      && !(artifact.links ?? []).some((link) => link.ownerKind === "chat_session" && link.ownerId === args.ctoSessionId));
  }
  const { picked, more } = selectChatProof(listed, args.selection, args.limit);
  const result: CtoProofShareResult = { shown: [], skipped: [], more };
  const available = picked.filter((artifact) => {
    if (artifact.availability && artifact.availability !== "available") {
      result.skipped.push({ artifactId: artifact.id, title: artifact.title, reason: "its file is gone (deleted, or never copied in)" });
      return false;
    }
    return true;
  });
  // The record itself, linked into the CTO chat; a video that got an MP4
  // copy is shown by the copy alone, so the CTO's drawer holds it once.
  const showOriginal = (artifact: ComputerUseArtifactView, note?: string): void => {
    if (args.chatSessionId !== args.ctoSessionId) {
      args.broker.linkArtifactsToChat({ artifactIds: [artifact.id], chatSessionId: args.ctoSessionId });
    }
    result.shown.push(shown(artifact, note ? { note } : {}));
  };
  for (const artifact of available) {
    let copy: CtoShownProof | null = null;
    try {
      copy = await playableCopyFor({ ...args, artifact });
    } catch (error) {
      showOriginal(artifact, getErrorMessage(error));
      continue;
    }
    if (copy) result.shown.push(copy);
    else showOriginal(artifact);
  }
  return result;
}

type RemoteRunAction = (target: CtoMachineTarget, call: CtoRemoteActionCall) => Promise<unknown>;

function asArtifactRows(raw: unknown): ComputerUseArtifactView[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is ComputerUseArtifactView =>
    isRecord(row) && typeof row.id === "string" && typeof row.uri === "string" && typeof row.kind === "string");
}

function isRefusedAsSecret(error: unknown): boolean {
  return /returns secrets|policy|not exposed/i.test(getErrorMessage(error));
}

function extensionFor(artifact: ComputerUseArtifactView): string {
  const fromUri = path.extname(artifact.uri.split(/[?#]/)[0] ?? "").toLowerCase();
  if (/^\.[a-z0-9]{2,5}$/.test(fromUri)) return fromUri;
  const mime = artifact.mimeType ?? "";
  if (mime === "video/mp4") return ".mp4";
  if (mime === "video/quicktime") return ".mov";
  if (mime === "video/webm") return ".webm";
  if (mime === "image/jpeg") return ".jpg";
  return artifact.kind === "video_recording" ? ".mp4" : ".png";
}

/** Writes the remote file to `target` in slices; falls back to the whole-file preview on a machine that refuses slices. */
async function pullRemoteFile(args: {
  runAction: RemoteRunAction;
  machine: CtoMachineTarget;
  artifact: ComputerUseArtifactView;
  target: string;
}): Promise<void> {
  const handle = await fs.promises.open(args.target, "w");
  try {
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      let slice: unknown;
      try {
        slice = await args.runAction(args.machine, {
          domain: "computer_use_artifacts",
          action: "readArtifactRange",
          args: { uri: args.artifact.uri, offset, length: REMOTE_SLICE_BYTES },
          timeoutMs: REMOTE_SLICE_TIMEOUT_MS,
        });
      } catch (error) {
        if (offset === 0 && isRefusedAsSecret(error)) {
          await handle.close();
          await pullRemotePreview(args);
          return;
        }
        throw error;
      }
      if (!isRecord(slice) || typeof slice.data !== "string" || typeof slice.totalSize !== "number") {
        throw new Error(`${args.machine.name} answered the read without the file's bytes.`);
      }
      total = slice.totalSize;
      if (total > CTO_REMOTE_PROOF_MAX_BYTES) {
        throw new Error(`it is ${Math.round(total / (1024 * 1024))} MB, over the ${CTO_REMOTE_PROOF_MAX_BYTES / (1024 * 1024)} MB a copy may be; ask for a shorter recording`);
      }
      const bytes = Buffer.from(slice.data, "base64");
      if (!bytes.length && offset < total) throw new Error(`${args.machine.name} sent an empty slice.`);
      await handle.write(bytes, 0, bytes.length, offset);
      offset += bytes.length;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** An older machine's only read: the whole file as a data URL, up to its 10 MiB cap. */
async function pullRemotePreview(args: {
  runAction: RemoteRunAction;
  machine: CtoMachineTarget;
  artifact: ComputerUseArtifactView;
  target: string;
}): Promise<void> {
  const dataUrl = await args.runAction(args.machine, {
    domain: "computer_use_artifacts",
    action: "readArtifactPreview",
    args: { uri: args.artifact.uri },
    timeoutMs: REMOTE_SLICE_TIMEOUT_MS,
  });
  const match = typeof dataUrl === "string" ? /^data:[^;,]*;base64,(.*)$/s.exec(dataUrl) : null;
  if (!match) {
    throw new Error(`${args.machine.name} sent no bytes (an ADE there older than this one reads files up to 10 MB only; update it to show larger ones)`);
  }
  await fs.promises.writeFile(args.target, Buffer.from(match[1]!, "base64"));
}

/**
 * Brings a chat's proof from another machine (or an ADE Cloud lane's
 * computer) to the CTO's home and files it as the CTO's, once per record.
 */
export async function importRemoteChatProof(args: {
  broker: CtoProofBroker;
  runAction: RemoteRunAction;
  machine: CtoMachineTarget;
  chatSessionId: string;
  ctoSessionId: string;
  selection: CtoProofSelection;
  scratchDir: string;
  limit?: number;
  logger?: Logger | null;
}): Promise<CtoProofShareResult> {
  const listed = asArtifactRows(await args.runAction(args.machine, {
    domain: "computer_use_artifacts",
    action: "listArtifacts",
    args: { ownerKind: "chat_session", ownerId: args.chatSessionId, limit: 200, ...PROOF_LISTING_ARTIFACT_FILTER },
  }));
  const { picked, more } = selectChatProof(listed, args.selection, args.limit);
  const result: CtoProofShareResult = { shown: [], skipped: [], more };
  await fs.promises.mkdir(args.scratchDir, { recursive: true });
  for (const artifact of picked) {
    // A copy pulled before outlives the original: it shows even after the
    // file there is deleted or that machine goes to sleep.
    const existing = ownedCopyOf(args.broker, args.ctoSessionId, (metadata) => {
      const from = isRecord(metadata.importedFrom) ? metadata.importedFrom : null;
      return from?.artifactId === artifact.id && from?.machineId === args.machine.machineId;
    });
    if (existing) {
      result.shown.push(shown(existing, { sourceArtifactId: artifact.id }));
      continue;
    }
    if (artifact.availability && artifact.availability !== "available") {
      result.skipped.push({ artifactId: artifact.id, title: artifact.title, reason: `its file is gone on ${args.machine.name}` });
      continue;
    }
    const pulled = path.join(args.scratchDir, `${randomUUID()}${extensionFor(artifact)}`);
    let playablePath: string | null = null;
    try {
      await pullRemoteFile({ runAction: args.runAction, machine: args.machine, artifact, target: pulled });
      let filePath = pulled;
      let note: string | undefined;
      if (isConvertibleVideoPath(pulled)) {
        try {
          const playable = await ensurePlayableVideo({ sourcePath: pulled, outputDir: args.scratchDir, logger: args.logger ?? null });
          if (playable.converted) playablePath = playable.path;
          filePath = playable.path;
        } catch (error) {
          note = getErrorMessage(error);
        }
      }
      const view = await fileAsCto({
        broker: args.broker,
        ctoSessionId: args.ctoSessionId,
        filePath,
        kind: artifact.kind,
        title: artifact.title,
        description: artifact.description,
        metadata: {
          importedFrom: {
            machineId: args.machine.machineId,
            machineName: args.machine.name,
            artifactId: artifact.id,
            chatSessionId: args.chatSessionId,
          },
        },
        toolName: "getChatProof",
      });
      result.shown.push(shown(view, { sourceArtifactId: artifact.id, ...(note ? { note } : {}) }));
    } catch (error) {
      args.logger?.warn("cto.proof_import_failed", {
        machineId: args.machine.machineId,
        artifactId: artifact.id,
        error: getErrorMessage(error),
      });
      result.skipped.push({ artifactId: artifact.id, title: artifact.title, reason: getErrorMessage(error) });
    } finally {
      await fs.promises.rm(pulled, { force: true }).catch(() => undefined);
      if (playablePath) await fs.promises.rm(playablePath, { force: true }).catch(() => undefined);
    }
  }
  return result;
}

/** The lines a child report's wake carries, so the CTO can show the proof without asking for it. */
export function formatProofForWake(result: CtoProofShareResult): string | null {
  if (!result.shown.length && !result.skipped.length) return null;
  const lines: string[] = [];
  if (result.shown.length) {
    lines.push("Proof it filed. Reply (not noReply) with these lines where they back what you say; the person sees them only in your reply:");
    for (const item of result.shown) lines.push(item.note ? `${item.cite} (${item.note})` : item.cite);
  }
  if (result.more > 0) lines.push(`…and ${result.more} more: getChatProof with all: true lists them.`);
  for (const item of result.skipped) lines.push(`Could not show "${item.title}": ${item.reason}.`);
  return lines.join("\n");
}
