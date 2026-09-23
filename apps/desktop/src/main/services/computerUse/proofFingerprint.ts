import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ComputerUseArtifactOwner } from "../../../shared/types";
import { encodeCodedErrorMessage } from "../../../shared/codedError";
import { PROOF_DUPLICATE_CODE } from "../../../shared/proofProvenance";
import type { AppleRecordingFile } from "../ios/recording/appleRecordingsStore";
import { readAppleRecordingSidecar } from "../ios/recording/appleRecordingsStore";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { pathKey } from "../shared/pathCompare";
import { safeJsonParse, toOptionalString } from "../shared/utils";
import { isIsoMediaExtension, readMp4CreationTimeFromFile } from "./mediaCreationTime";

/**
 * How the broker judges an attached file: are these bytes already proof, and
 * was this video made before the request it is attached to.
 */

export type ContentFingerprint = { sha256: string; bytes: number };

/** A proof whose bytes match a file being attached. */
export type DuplicateProofMatch = {
  artifactId: string | null;
  title: string;
  createdAt: string;
};

/**
 * Refusal for an attach whose bytes are already proof.
 *
 * An agent that could not record once copied an old recording to a new name
 * and attached it as the thing it was asked for. Same bytes, new caption. The
 * code is in the message because the CLI only sees the message.
 */
export class ProofDuplicateError extends Error {
  readonly code = PROOF_DUPLICATE_CODE;
  readonly existing: DuplicateProofMatch;

  constructor(existing: DuplicateProofMatch) {
    super(encodeCodedErrorMessage(
      PROOF_DUPLICATE_CODE,
      `Same bytes as "${existing.title}" (filed ${formatLocalWhen(existing.createdAt)}). `
      + "This file is already proof. Record a new one, or report that recording failed.",
    ));
    this.name = "ProofDuplicateError";
    this.existing = existing;
  }
}

/** Files larger than this are not hashed outside a copy. Proof is never this big. */
const MAX_HASH_BYTES = 2 * 1024 * 1024 * 1024;
/** Older rows with no stored hash are hashed on demand, at most this many per attach. */
const MAX_LAZY_HASHES_PER_ATTACH = 8;
/** Clock slack between a recorder and the host before a video counts as older. */
const RECORDED_BEFORE_REQUEST_SLACK_MS = 60_000;
const HASH_CHUNK_BYTES = 1024 * 1024;

/** "5:19 AM" today, "Sep 22, 5:19 AM" on another day, in the host's local time. */
export function formatLocalWhen(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** SHA-256 of a file, read in chunks. Null when it cannot be read or is too big. */
export function hashFileSync(filePath: string): ContentFingerprint | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_HASH_BYTES) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { sha256: hash.digest("hex"), bytes: position };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The hash is already taken or abandoned.
      }
    }
  }
}

/** The same hash, streamed, so a long video does not hold the event loop. */
export async function hashFile(filePath: string): Promise<ContentFingerprint | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_HASH_BYTES) return null;
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of fs.createReadStream(filePath, { highWaterMark: HASH_CHUNK_BYTES })) {
      const buffer = chunk as Buffer;
      hash.update(buffer);
      bytes += buffer.length;
    }
    return { sha256: hash.digest("hex"), bytes };
  } catch {
    return null;
  }
}

/** Two spellings of one file compare equal: realpath'd, then case-folded where the OS folds. */
function fileKey(filePath: string): string {
  let real = filePath;
  try {
    real = fs.realpathSync(filePath);
  } catch {
    // A missing file keeps its given spelling.
  }
  return pathKey(real);
}

export type AttachPolicy = {
  refuseDuplicates: boolean;
  flagOlderMedia: boolean;
  /** When the owning chat's turn started, or null for no age check. */
  turnStartedAtMs: number | null;
  toolName: string | null;
};

export type AttachJudgement = {
  mediaCreatedAt: string | null;
  recordedBeforeRequest: boolean;
  warning: string | null;
};

export function createProofFingerprintJudge(deps: {
  db: AdeDb;
  projectId: string;
  /** The on-disk path of a stored row, or null when it is not in the store. */
  resolveStoredFilePath: (row: { uri: string }) => string | null;
  listRecordings: () => AppleRecordingFile[];
  logger?: Logger | null;
}) {
  const { db, projectId } = deps;
  let resolveChatTurnStartedAt: ((sessionId: string) => string | null | undefined) | null = null;

  /**
   * The proof whose bytes match `fingerprint`, or null.
   *
   * Cheap on purpose, because it runs on every attach: rows that stored a byte
   * count are filtered by size in SQL, older rows are stat'ed, and only a row
   * with the same size and no stored hash is hashed, at most
   * {@link MAX_LAZY_HASHES_PER_ATTACH} of them. A hash taken here is written
   * back so the next attach reads it. Apple recordings that never made it into
   * the drawer are checked too, from their directory. `attachedPath` is the
   * file being attached; it is never its own duplicate.
   */
  const findDuplicateProof = (
    fingerprint: ContentFingerprint,
    attachedPath: string | null,
  ): DuplicateProofMatch | null => {
    const blob = "metadata_json";
    const valid = `json_valid(${blob})`;
    const storedBytes = `(case when ${valid} then json_extract(${blob}, '$.contentBytes') end)`;
    const tag = `(case when ${valid} then json_extract(${blob}, '$.kind') end)`;
    const rows = db.all<{ id: string; title: string; uri: string; created_at: string; metadata_json: string }>(
      `
        select id, title, uri, created_at, metadata_json
        from computer_use_artifacts
        where project_id = ?
          and storage_kind = 'file'
          and (${storedBytes} is null or ${storedBytes} = ?)
          and (${tag} is null or ${tag} != 'scene_still')
        order by created_at desc
      `,
      [projectId, fingerprint.bytes],
    );
    const attachedKey = attachedPath ? fileKey(attachedPath) : null;
    const checkedKeys = new Set<string>();
    let lazyHashes = 0;
    const lazyHash = (filePath: string): ContentFingerprint | null => {
      if (lazyHashes >= MAX_LAZY_HASHES_PER_ATTACH) return null;
      lazyHashes += 1;
      return hashFileSync(filePath);
    };

    for (const row of rows) {
      const metadata = safeJsonParse<Record<string, unknown>>(row.metadata_json, {});
      const rowBytes = typeof metadata.contentBytes === "number" ? metadata.contentBytes : null;
      const rowSha = toOptionalString(metadata.contentSha256);
      const filePath = deps.resolveStoredFilePath({ uri: row.uri });
      if (filePath) checkedKeys.add(fileKey(filePath));
      if (rowBytes !== null && rowSha) {
        if (rowBytes === fingerprint.bytes && rowSha === fingerprint.sha256) {
          return { artifactId: row.id, title: row.title, createdAt: row.created_at };
        }
        continue;
      }
      if (!filePath) continue;
      // A stored byte count already passed the size filter above.
      if (rowBytes === null) {
        let size: number;
        try {
          size = fs.statSync(filePath).size;
        } catch {
          continue;
        }
        if (size !== fingerprint.bytes) continue;
      }
      const hashed = rowSha ? { sha256: rowSha, bytes: fingerprint.bytes } : lazyHash(filePath);
      if (!hashed) continue;
      if (!rowSha) {
        try {
          db.run(
            "update computer_use_artifacts set metadata_json = ? where id = ? and project_id = ?",
            [JSON.stringify({ ...metadata, contentSha256: hashed.sha256, contentBytes: hashed.bytes }), row.id, projectId],
          );
        } catch {
          // The backfill only saves the next attach a read.
        }
      }
      if (hashed.sha256 === fingerprint.sha256) {
        return { artifactId: row.id, title: row.title, createdAt: row.created_at };
      }
    }

    // Recordings on disk. A recording normally has a drawer row and was
    // checked above; one whose filing failed only exists here.
    for (const recording of deps.listRecordings()) {
      const key = fileKey(recording.filePath);
      if (checkedKeys.has(key) || key === attachedKey) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(recording.filePath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size !== fingerprint.bytes) continue;
      const hashed = lazyHash(recording.filePath);
      if (!hashed || hashed.sha256 !== fingerprint.sha256) continue;
      const sidecar = readAppleRecordingSidecar(recording.sidecarPath);
      return {
        artifactId: toOptionalString(sidecar?.proofArtifactId),
        title: toOptionalString(sidecar?.label) ?? `Simulator recording ${recording.id}`,
        createdAt: toOptionalString(sidecar?.startedAt) ?? stat.mtime.toISOString(),
      };
    }
    return null;
  };

  return {
    findDuplicateProof,

    /** Late wiring for the chat service, which is built after the broker. */
    setChatTurnStartResolver(resolver: ((sessionId: string) => string | null | undefined) | null): void {
      resolveChatTurnStartedAt = resolver;
    },

    /** When the chat that owns this attach started its current or latest turn. */
    readOwnerTurnStartedAt(owners: ComputerUseArtifactOwner[]): number | null {
      const resolver = resolveChatTurnStartedAt;
      if (!resolver) return null;
      for (const owner of owners) {
        if (owner.kind !== "chat_session") continue;
        try {
          const value = resolver(owner.id);
          const ms = value ? Date.parse(value) : Number.NaN;
          if (Number.isFinite(ms)) return ms;
        } catch {
          // No turn time means no age flag, never a failed attach.
        }
      }
      return null;
    },

    /**
     * Judges one input. Throws {@link ProofDuplicateError} when a file the
     * caller named is already proof, or repeats an earlier input of the same
     * call. Otherwise says whether the video predates the request.
     */
    judgeInput(args: {
      storedFilePath: string | null;
      fromCallerFile: boolean;
      fingerprint: ContentFingerprint | null;
      earlier: ReadonlyArray<{ title: string; fingerprint: ContentFingerprint | null }>;
      policy: AttachPolicy;
    }): AttachJudgement {
      const { fingerprint, policy } = args;
      if (policy.refuseDuplicates && args.fromCallerFile && fingerprint) {
        const sameBatch = args.earlier.find((entry) =>
          entry.fingerprint?.sha256 === fingerprint.sha256 && entry.fingerprint.bytes === fingerprint.bytes);
        const duplicate = sameBatch
          ? { artifactId: null, title: sameBatch.title, createdAt: new Date().toISOString() }
          : findDuplicateProof(fingerprint, args.storedFilePath);
        if (duplicate) {
          deps.logger?.warn("computer_use.artifact_duplicate_refused", {
            existingArtifactId: duplicate.artifactId,
            bytes: fingerprint.bytes,
            toolName: policy.toolName,
          });
          throw new ProofDuplicateError(duplicate);
        }
      }
      // A video's own header says when it was made. Read for every video;
      // only an attach is judged by it.
      const mediaCreated = args.storedFilePath && isIsoMediaExtension(path.extname(args.storedFilePath))
        ? readMp4CreationTimeFromFile(args.storedFilePath)
        : null;
      const mediaCreatedAt = mediaCreated ? mediaCreated.toISOString() : null;
      const recordedBeforeRequest = Boolean(
        policy.flagOlderMedia
        && mediaCreated
        && policy.turnStartedAtMs !== null
        && mediaCreated.getTime() < policy.turnStartedAtMs - RECORDED_BEFORE_REQUEST_SLACK_MS,
      );
      const warning = recordedBeforeRequest && mediaCreatedAt
        ? `This video was recorded at ${formatLocalWhen(mediaCreatedAt)}, before this request. `
          + "It will be marked as older in the proof drawer."
        : null;
      return { mediaCreatedAt, recordedBeforeRequest, warning };
    },
  };
}

export type ProofFingerprintJudge = ReturnType<typeof createProofFingerprintJudge>;
