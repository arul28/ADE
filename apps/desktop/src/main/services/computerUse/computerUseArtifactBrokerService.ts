import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ComputerUseArtifactAvailability,
  ComputerUseArtifactBrokenRecord,
  ComputerUseArtifactDeleteArgs,
  ComputerUseArtifactDeleteOutcome,
  ComputerUseArtifactDeleteResult,
  ComputerUseArtifactIngestionRequest,
  ComputerUseArtifactIngestionResult,
  ComputerUseArtifactInput,
  ComputerUseArtifactKind,
  ComputerUseArtifactLink,
  ComputerUseArtifactListArgs,
  ComputerUseArtifactOwner,
  ComputerUseArtifactRecord,
  ComputerUseArtifactReviewArgs,
  ComputerUseArtifactReviewState,
  ComputerUseArtifactView,
  ComputerUseBackendStyle,
  ComputerUseBackendStatus,
  ComputerUseExternalBackendStatus,
  ComputerUseArtifactWorkflowState,
  ComputerUseEventPayload,
} from "../../../shared/types";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { normalizeComputerUseArtifactKind } from "../../../shared/proofArtifacts";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { SqlValue } from "../state/kvDb";
import {
  fileExists,
  isEnoentError,
  isRecord,
  nowIso,
  resolvePathWithinRoot,
  safeJsonParse,
  toOptionalString,
  writeTextAtomic,
} from "../shared/utils";
import { commandExists } from "../ai/utils";
import { createComputerUseArtifactPath, getLocalComputerUseCapabilities, toProjectArtifactUri } from "./localComputerUse";

type StoredArtifactRow = {
  id: string;
  artifact_kind: string;
  backend_style: string;
  backend_name: string;
  source_tool_name: string | null;
  original_type: string | null;
  title: string;
  description: string | null;
  uri: string;
  storage_kind: string;
  mime_type: string | null;
  metadata_json: string;
  lane_id: string | null;
  created_at: string;
};

const ARTIFACT_SELECT_COLUMNS = `
  id, artifact_kind, backend_style, backend_name, source_tool_name,
  original_type, title, description, uri, storage_kind, mime_type,
  metadata_json, lane_id, created_at
`;

const DEFAULT_REVIEW_STATE: ComputerUseArtifactReviewState = "accepted";
const DEFAULT_WORKFLOW_STATE: ComputerUseArtifactWorkflowState = "evidence_only";
const ARTIFACT_PREVIEW_SIZE_CAP = 10 * 1024 * 1024;
const ARTIFACT_PREVIEW_MIME_BY_EXTENSION: Record<string, string> = {
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  mp4: "video/mp4",
  ogv: "video/ogg",
  webm: "video/webm",
};

type ComputerUseArtifactRecordInsert = Omit<ComputerUseArtifactRecord, "id" | "createdAt" | "backendStyle"> & {
  backendStyle?: ComputerUseBackendStyle | null;
};

type ResolvedStoredArtifact = {
  uri: string;
  storageKind: "file" | "url";
  mimeType: string | null;
  stagedFilePath: string | null;
};

type RecoverableSourceResolution =
  | { status: "found"; path: string }
  | { status: "missing" }
  | { status: "ambiguous"; paths: string[] };

type StoredLinkRow = {
  id: string;
  artifact_id: string;
  owner_kind: string;
  owner_id: string;
  relation: string;
  metadata_json: string | null;
  created_at: string;
};

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isAllowedExternalArtifactSource(
  absolutePath: string,
  roots: string[],
): boolean {
  return roots.some((root) => {
    try {
      resolvePathWithinRoot(root, absolutePath);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Paths an agent may read but must never be able to copy into the artifact
 * store — artifacts are previewed in the renderer and synced to paired phones,
 * so promoting a secrets blob into one is an exfiltration path.
 */
/**
 * Realpaths both sides before comparing. A lexical check is bypassable with one
 * `ln -s`: a directory symlink inside an allowed root that points at the secrets
 * dir would fail this test and then pass the allow-list, which realpaths. The
 * deny-list is the exfiltration barrier, so it has to be at least as strict as
 * the check it guards.
 */
function isDeniedArtifactSource(absolutePath: string, deniedRoots: string[]): boolean {
  const normalized = realpathOrSelf(path.resolve(absolutePath));
  return deniedRoots.some((root) => {
    const normalizedRoot = realpathOrSelf(path.resolve(root));
    return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + path.sep);
  });
}

/** Realpath when the path exists; the resolved input otherwise. */
function realpathOrSelf(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function resolveRendererArtifactPath(rawPath: string, projectRoot: string): string {
  let inputPath = rawPath;
  if (/^ade-artifact:\/\/project(?:\/|$)/i.test(inputPath)) {
    const parsed = new URL(inputPath);
    inputPath = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  }
  if (/^file:\/\//i.test(inputPath)) {
    try {
      inputPath = fileURLToPath(inputPath);
    } catch {
      inputPath = decodeURIComponent(inputPath.replace(/^file:\/\//i, ""));
    }
  }
  return path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(projectRoot, inputPath));
}

async function readArtifactPreviewDataUrl(args: {
  uri?: string;
  projectRoot: string;
  artifactsDir: string;
}): Promise<string | null> {
  const uri = typeof args.uri === "string" ? args.uri.trim() : "";
  if (!uri) return null;
  const filePath = resolveRendererArtifactPath(uri, args.projectRoot);
  const canonical = path.normalize(path.resolve(filePath));
  try {
    resolvePathWithinRoot(args.artifactsDir, canonical);
  } catch {
    return null;
  }

  try {
    const stat = await fs.promises.stat(canonical);
    if (!stat.isFile() || stat.size > ARTIFACT_PREVIEW_SIZE_CAP) return null;
    const ext = path.extname(canonical).replace(/^\./, "").toLowerCase();
    const mime = ARTIFACT_PREVIEW_MIME_BY_EXTENSION[ext];
    if (!mime) return null;
    const buf = await fs.promises.readFile(canonical);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function secureCopyFromDescriptor(sourcePath: string, targetPath: string): void {
  const sourceFlags = fs.constants.O_RDONLY | (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0);
  const sourceFd = fs.openSync(sourcePath, sourceFlags);
  const tempPath = `${targetPath}.tmp-${randomUUID()}`;
  let tempCreated = false;

  try {
    const sourceStat = fs.fstatSync(sourceFd);
    if (!sourceStat.isFile()) {
      throw new Error("Artifact source must be a regular file.");
    }

    const targetFd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, sourceStat.mode & 0o777);
    tempCreated = true;
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      for (;;) {
        const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;

        let offset = 0;
        while (offset < bytesRead) {
          offset += fs.writeSync(targetFd, buffer, offset, bytesRead - offset);
        }
        position += bytesRead;
      }
      fs.fsyncSync(targetFd);
    } finally {
      fs.closeSync(targetFd);
    }

    fs.renameSync(tempPath, targetPath);
    tempCreated = false;
  } finally {
    if (tempCreated) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
    fs.closeSync(sourceFd);
  }
}

function dedupeOwners(owners: ComputerUseArtifactOwner[]): ComputerUseArtifactOwner[] {
  const seen = new Set<string>();
  const result: ComputerUseArtifactOwner[] = [];
  for (const owner of owners) {
    const id = owner.id.trim();
    if (!id) continue;
    const key = `${owner.kind}:${id}:${owner.relation ?? "attached_to"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...owner, id });
  }
  return result;
}

/**
 * Extensions an on-disk file may be imported with.
 *
 * Proof is renderable evidence — images, video, browser traces, logs. The
 * import roots are deliberately wide (a lane worktree and the project root,
 * because agents capture next to the code they are changing), which puts
 * `.env.local`, `.ade/*.db` and any key material exactly one `ade proof attach`
 * away from an artifact store that syncs to paired phones and gets linked from
 * PRs. Denying roots alone cannot cover that: the sensitive files live in the
 * same directories as the legitimate ones. So the allow-list is on the artifact
 * itself, and anything that is not plausibly proof is refused outright.
 *
 * Inline text/JSON does not pass through here — {@link materializeInlineContent}
 * writes its own file inside the artifacts dir and never reads a user path.
 */
const IMPORTABLE_ARTIFACT_EXTENSIONS: ReadonlySet<string> = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "avif", "heic",
  "mp4", "webm", "mov", "avi", "mkv",
  "heif", "tif", "tiff",
  "m4v", "ogv",
  "zip", "har",
  "log", "txt", "md",
]);

/** Extension of an import candidate, lowercased and without the dot. */
function importExtension(absolutePath: string): string {
  return path.extname(absolutePath).replace(/^\./, "").trim().toLowerCase();
}

function isImportableArtifactFile(absolutePath: string): boolean {
  return IMPORTABLE_ARTIFACT_EXTENSIONS.has(importExtension(absolutePath));
}

function inferArtifactExtension(input: ComputerUseArtifactInput, kind: ComputerUseArtifactKind): string {
  const fromPath = toOptionalString(input.path) ?? toOptionalString(input.uri);
  if (fromPath) {
    const ext = path.extname(fromPath).replace(/^\./, "").trim();
    if (ext.length > 0) return ext;
  }
  if (kind === "screenshot") return "png";
  if (kind === "video_recording") return "mp4";
  if (kind === "browser_trace") return "zip";
  if (kind === "console_logs") return "log";
  return "txt";
}

function defaultTitleForKind(kind: ComputerUseArtifactKind): string {
  return kind.replace(/_/g, " ");
}

function normalizeBackendStyle(style: unknown): ComputerUseBackendStyle {
  return style === "manual" || style === "local_fallback" ? style : "external_cli";
}

function normalizeInputKind(input: ComputerUseArtifactInput): ComputerUseArtifactKind {
  const normalized = normalizeComputerUseArtifactKind(input.kind ?? input.rawType ?? input.title ?? null);
  if (normalized) return normalized;
  if (input.text) return "console_logs";
  return "browser_verification";
}

export function createComputerUseArtifactBrokerService(args: {
  db: AdeDb;
  projectId: string;
  projectRoot: string;
  additionalAllowedImportRoots?: readonly string[];
  logger?: Logger | null;
  onEvent?: (payload: ComputerUseEventPayload) => void;
}) {
  const { db, projectId, projectRoot, onEvent } = args;
  const layout = resolveAdeLayout(projectRoot);
  const allowedImportRoots = Array.from(new Set([
    layout.artifactsDir,
    layout.cacheDir,
    layout.tmpDir,
    // Agents run inside lane worktrees and capture next to the code they are
    // changing, so a lane worktree is as legitimate a capture source as the
    // project root itself. `worktreesDir` is listed explicitly because a lane
    // worktree can be relocated outside `projectRoot`.
    layout.worktreesDir,
    projectRoot,
    os.tmpdir(),
    path.join(os.homedir(), ".agent-browser"),
    ...(args.additionalAllowedImportRoots ?? [])
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root) => path.resolve(root)),
  ]));
  const deniedImportRoots = [layout.secretsDir];

  const emit = (payload: ComputerUseEventPayload): void => {
    try {
      onEvent?.(payload);
    } catch {
      // Best-effort broadcast only.
    }
  };

  const materializeInlineContent = (
    input: ComputerUseArtifactInput,
    kind: ComputerUseArtifactKind,
    title: string,
  ): { uri: string; stagedFilePath: string } => {
    const extension = inferArtifactExtension(input, kind);
    const artifactPath = createComputerUseArtifactPath(projectRoot, title, extension);
    if (input.json != null) {
      writeTextAtomic(artifactPath, `${JSON.stringify(input.json, null, 2)}\n`);
    } else {
      writeTextAtomic(artifactPath, input.text ?? "");
    }
    return {
      uri: toProjectArtifactUri(projectRoot, artifactPath),
      stagedFilePath: artifactPath,
    };
  };

  /**
   * Roots a caller-supplied *relative* path is tried against, in order.
   *
   * Agents run inside lane worktrees, so a relative path they hand us is
   * relative to the worktree, not to `projectRoot`. Resolving only against
   * `projectRoot` is what silently discarded every capture taken outside
   * `.ade/artifacts`.
   */
  const relativeResolutionRoots = (callerRoot: string | null): string[] => {
    return [path.resolve(callerRoot ?? projectRoot)];
  };

  const resolveStoredUri = (
    input: ComputerUseArtifactInput,
    kind: ComputerUseArtifactKind,
    title: string,
    callerRoot: string | null,
  ): ResolvedStoredArtifact => {
    const directUri = toOptionalString(input.uri);
    if (directUri && isHttpUrl(directUri)) {
      return {
        uri: directUri,
        storageKind: "url",
        mimeType: toOptionalString(input.mimeType),
        stagedFilePath: null,
      };
    }

    const pathLike = toOptionalString(input.path) ?? (directUri && !isHttpUrl(directUri) ? directUri : null);
    if (pathLike) {
      const attempted: string[] = [];
      let absolutePath: string | null = null;
      if (path.isAbsolute(pathLike)) {
        attempted.push(pathLike);
        if (fileExists(pathLike)) absolutePath = pathLike;
      } else {
        for (const root of relativeResolutionRoots(callerRoot)) {
          let candidate: string;
          try {
            candidate = resolvePathWithinRoot(root, pathLike, { allowMissing: true });
          } catch {
            attempted.push(path.join(root, pathLike));
            continue;
          }
          attempted.push(candidate);
          if (fileExists(candidate)) {
            absolutePath = candidate;
            break;
          }
        }
      }

      if (!absolutePath) {
        // Never persist a record for bytes we could not find. A row whose file
        // was never imported renders as a permanently broken tile and cannot be
        // recovered later, so failing loudly at capture time is the only honest
        // outcome.
        throw new Error(
          `Artifact file not found: ${pathLike}. Tried ${attempted.join(", ") || pathLike}. `
          + `Pass an absolute path, or a path relative to ${callerRoot ?? projectRoot}.`,
        );
      }

      if (isDeniedArtifactSource(absolutePath, deniedImportRoots)) {
        throw new Error(`Artifact path is not allowed as a proof source: ${absolutePath}`);
      }

      if (!isImportableArtifactFile(absolutePath)) {
        throw new Error(
          `Artifact file type is not importable as proof: ${absolutePath}. `
          + `Proof must be an image, video, browser trace, or log `
          + `(${[...IMPORTABLE_ARTIFACT_EXTENSIONS].join(", ")}).`,
        );
      }

      try {
        const existingArtifactPath = resolvePathWithinRoot(layout.artifactsDir, absolutePath);
        return {
          uri: toProjectArtifactUri(projectRoot, existingArtifactPath),
          storageKind: "file",
          mimeType: toOptionalString(input.mimeType),
          stagedFilePath: null,
        };
      } catch {
        // Fall through to external import handling.
      }
      if (!isAllowedExternalArtifactSource(absolutePath, allowedImportRoots)) {
        throw new Error(`Artifact path is outside allowed import roots: ${absolutePath}`);
      }
      const extension = inferArtifactExtension({ ...input, path: absolutePath }, kind);
      const targetPath = createComputerUseArtifactPath(projectRoot, title, extension);
      secureCopyFromDescriptor(absolutePath, targetPath);
      return {
        uri: toProjectArtifactUri(projectRoot, targetPath),
        storageKind: "file",
        mimeType: toOptionalString(input.mimeType),
        stagedFilePath: targetPath,
      };
    }

    const materialized = materializeInlineContent(input, kind, title);
    return {
      uri: materialized.uri,
      storageKind: "file",
      mimeType: toOptionalString(input.mimeType),
      stagedFilePath: materialized.stagedFilePath,
    };
  };

  /**
   * Lane an artifact belongs to, so deleting the lane deletes its captures.
   * Chat sessions are `terminal_sessions` rows and carry the lane binding; an
   * explicit `lane` owner wins when one was supplied.
   */
  const resolveLaneIdForOwners = (owners: ComputerUseArtifactOwner[]): string | null => {
    const explicitLane = owners.find((owner) => owner.kind === "lane")?.id;
    if (explicitLane) return explicitLane;
    for (const owner of owners) {
      if (owner.kind !== "chat_session") continue;
      try {
        const row = db.get<{ lane_id: string | null }>(
          "select lane_id from terminal_sessions where id = ? limit 1",
          [owner.id],
        );
        if (row?.lane_id) return row.lane_id;
      } catch {
        // The lane binding is a convenience for cleanup, never a hard
        // requirement for keeping the capture.
      }
    }
    return null;
  };

  const insertArtifactRecord = (record: ComputerUseArtifactRecordInsert): ComputerUseArtifactRecord => {
    const { backendStyle: rawBackendStyle, ...artifactRecord } = record;
    const backendStyle = normalizeBackendStyle(rawBackendStyle);
    const next: ComputerUseArtifactRecord = {
      id: randomUUID(),
      backendStyle,
      ...artifactRecord,
      createdAt: nowIso(),
    };
    db.run(
      `
        insert into computer_use_artifacts(
          id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
          original_type, title, description, uri, storage_kind, mime_type, metadata_json,
          lane_id, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        next.id,
        projectId,
        next.kind,
        backendStyle,
        next.backendName,
        next.sourceToolName,
        next.originalType,
        next.title,
        next.description,
        next.uri,
        next.storageKind,
        next.mimeType,
        JSON.stringify(next.metadata ?? {}),
        next.laneId ?? null,
        next.createdAt,
      ],
    );
    return next;
  };

  const insertLink = (artifactId: string, owner: ComputerUseArtifactOwner): ComputerUseArtifactLink => {
    const next: ComputerUseArtifactLink = {
      id: randomUUID(),
      artifactId,
      ownerKind: owner.kind,
      ownerId: owner.id.trim(),
      relation: owner.relation ?? "attached_to",
      metadata: isRecord(owner.metadata) ? owner.metadata : null,
      createdAt: nowIso(),
    };
    db.run(
      `
        insert into computer_use_artifact_links(
          id, artifact_id, project_id, owner_kind, owner_id, relation, metadata_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        next.id,
        next.artifactId,
        projectId,
        next.ownerKind,
        next.ownerId,
        next.relation,
        next.metadata ? JSON.stringify(next.metadata) : null,
        next.createdAt,
      ],
    );
    return next;
  };

  const readArtifactById = (artifactId: string): ComputerUseArtifactRecord | null =>
    readArtifactRows(
      `
        select ${ARTIFACT_SELECT_COLUMNS}
        from computer_use_artifacts
        where project_id = ?
          and id = ?
        limit 1
      `,
      [projectId, artifactId],
    )[0] ?? null;

  /**
   * Absolute on-disk location an artifact's bytes should live at, or null when
   * the record does not point inside the project artifact store. The read jail
   * is the same one `readArtifactPreview` and the `ade-artifact://` protocol
   * handler enforce — delete must never be able to unlink outside it.
   */
  const resolveArtifactFilePath = (record: ComputerUseArtifactRecord): string | null => {
    if (record.storageKind !== "file") return null;
    const uri = record.uri?.trim();
    if (!uri || isHttpUrl(uri)) return null;
    const candidate = resolveRendererArtifactPath(uri, projectRoot);
    try {
      return resolvePathWithinRoot(layout.artifactsDir, candidate, { allowMissing: true });
    } catch {
      return null;
    }
  };

  /**
   * Where a broken record's original bytes might still be. Ingest records the
   * caller's path and root in metadata, so a capture that was never imported
   * can be re-imported as long as its lane worktree still exists.
   */
  const resolveArtifactLaneRoots = (record: ComputerUseArtifactRecord): string[] => {
    const laneIds = new Set<string>();
    if (record.laneId) laneIds.add(record.laneId);
    for (const link of readLinkRows([record.id])) {
      if (link.ownerKind === "lane") {
        laneIds.add(link.ownerId);
        continue;
      }
      if (link.ownerKind !== "chat_session") continue;
      const session = db.get<{ lane_id: string | null }>(
        "select lane_id from terminal_sessions where id = ? limit 1",
        [link.ownerId],
      );
      if (session?.lane_id) laneIds.add(session.lane_id);
    }
    if (!laneIds.size) return [];

    const placeholders = [...laneIds].map(() => "?").join(", ");
    const rows = db.all<{ worktree_path: string; attached_root_path: string | null }>(
      `
        select worktree_path, attached_root_path
        from lanes
        where project_id = ?
          and id in (${placeholders})
      `,
      [projectId, ...[...laneIds].sort()],
    );
    return Array.from(new Set(
      rows
        .flatMap((row) => [row.attached_root_path, row.worktree_path])
        .filter((root): root is string => Boolean(root))
        .map((root) => path.resolve(root)),
    )).sort();
  };

  const resolveCandidateAcrossRoots = (
    candidate: string,
    roots: string[],
  ): RecoverableSourceResolution => {
    const matches = new Set<string>();
    for (const root of roots) {
      let resolved: string;
      try {
        resolved = resolvePathWithinRoot(root, candidate, { allowMissing: true });
      } catch {
        continue;
      }
      if (fileExists(resolved)) matches.add(realpathOrSelf(path.resolve(resolved)));
    }
    const paths = [...matches].sort();
    if (paths.length === 1) return { status: "found", path: paths[0]! };
    if (paths.length > 1) return { status: "ambiguous", paths };
    return { status: "missing" };
  };

  const resolveRecoverableSource = (record: ComputerUseArtifactRecord): RecoverableSourceResolution => {
    const candidates: string[] = [];
    const push = (value: string | null | undefined): void => {
      if (!value) return;
      const trimmed = value.trim();
      if (!trimmed || isHttpUrl(trimmed)) return;
      if (!candidates.includes(trimmed)) candidates.push(trimmed);
    };
    push(toOptionalString(record.metadata?.absolutePath));
    push(toOptionalString(record.metadata?.sourcePath));
    push(record.uri);

    const metadataCallerRoot = toOptionalString(record.metadata?.callerRoot);
    const laneRoots = resolveArtifactLaneRoots(record);
    const authoritativeRoots = metadataCallerRoot
      ? [path.resolve(metadataCallerRoot)]
      : laneRoots.length
        ? laneRoots
        : null;
    const fallbackRoots = [projectRoot, ...listLaneWorktreeRoots()];

    for (const candidate of candidates) {
      if (path.isAbsolute(candidate)) {
        if (fileExists(candidate)) return { status: "found", path: realpathOrSelf(path.resolve(candidate)) };
        continue;
      }
      const resolution = resolveCandidateAcrossRoots(
        candidate,
        authoritativeRoots ?? fallbackRoots,
      );
      if (resolution.status !== "missing") {
        return resolution;
      }
    }
    return { status: "missing" };
  };

  const listLaneWorktreeRoots = (): string[] => {
    try {
      return fs.readdirSync(layout.worktreesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(layout.worktreesDir, entry.name))
        .sort();
    } catch {
      return [];
    }
  };

  const findRecoverableSourcePath = (record: ComputerUseArtifactRecord): string | null => {
    const resolution = resolveRecoverableSource(record);
    return resolution.status === "found" ? resolution.path : null;
  };

  const resolveAvailability = (record: ComputerUseArtifactRecord): ComputerUseArtifactAvailability => {
    if (record.storageKind === "url" || isHttpUrl(record.uri ?? "")) return "available";
    const filePath = resolveArtifactFilePath(record);
    // A file-kind record whose URI does not land inside `.ade/artifacts` was
    // never imported — this is the shape the pre-fix silent fallback persisted.
    if (!filePath) return "unimported";
    return fileExists(filePath) ? "available" : "missing_file";
  };

  const toArtifactView = (record: ComputerUseArtifactRecord, links: ComputerUseArtifactLink[]): ComputerUseArtifactView => {
    const reviewState = toOptionalString(record.metadata.reviewState) as ComputerUseArtifactReviewState | null;
    const workflowState = toOptionalString(record.metadata.workflowState) as ComputerUseArtifactWorkflowState | null;
    return {
      ...record,
      links,
      reviewState: reviewState ?? DEFAULT_REVIEW_STATE,
      workflowState: workflowState ?? DEFAULT_WORKFLOW_STATE,
      reviewNote: toOptionalString(record.metadata.reviewNote),
      availability: resolveAvailability(record),
    };
  };

  const updateArtifactMetadata = (artifactId: string, updater: (current: Record<string, unknown>) => Record<string, unknown>): ComputerUseArtifactView => {
    const current = readArtifactById(artifactId);
    if (!current) {
      throw new Error(`Computer-use artifact not found: ${artifactId}`);
    }
    const nextMetadata = updater(current.metadata ?? {});
    db.run(
      `
        update computer_use_artifacts
        set metadata_json = ?
        where id = ?
          and project_id = ?
      `,
      [JSON.stringify(nextMetadata), artifactId, projectId],
    );
    const refreshed = readArtifactById(artifactId);
    if (!refreshed) {
      throw new Error(`Failed to refresh computer-use artifact: ${artifactId}`);
    }
    return toArtifactView(refreshed, readLinkRows([artifactId]));
  };

  const readArtifactRows = (query: string, params: SqlValue[]): ComputerUseArtifactRecord[] =>
    db.all<StoredArtifactRow>(query, params).map((row) => ({
      id: row.id,
      kind: row.artifact_kind as ComputerUseArtifactKind,
      backendStyle: normalizeBackendStyle(row.backend_style),
      backendName: row.backend_name,
      sourceToolName: row.source_tool_name,
      originalType: row.original_type,
      title: row.title,
      description: row.description,
      uri: row.uri,
      storageKind: row.storage_kind as ComputerUseArtifactRecord["storageKind"],
      mimeType: row.mime_type,
      metadata: safeJsonParse(row.metadata_json, {}),
      laneId: row.lane_id ?? null,
      createdAt: row.created_at,
    }));

  const readLinkRows = (artifactIds: string[]): ComputerUseArtifactLink[] => {
    if (artifactIds.length === 0) return [];
    const placeholders = artifactIds.map(() => "?").join(", ");
    return db.all<StoredLinkRow>(
      `
        select id, artifact_id, owner_kind, owner_id, relation, metadata_json, created_at
        from computer_use_artifact_links
        where artifact_id in (${placeholders})
        order by created_at asc
      `,
      artifactIds,
    ).map((row) => ({
      id: row.id,
      artifactId: row.artifact_id,
      ownerKind: row.owner_kind as ComputerUseArtifactLink["ownerKind"],
      ownerId: row.owner_id,
      relation: row.relation as ComputerUseArtifactLink["relation"],
      metadata: row.metadata_json ? safeJsonParse(row.metadata_json, {}) : null,
      createdAt: row.created_at,
    }));
  };

  const getBackendStatus = (): ComputerUseBackendStatus => {
    const local = getLocalComputerUseCapabilities();
    const localKinds: ComputerUseArtifactKind[] = [];
    if (local.proofRequirements.screenshot.available) localKinds.push("screenshot");
    if (local.proofRequirements.video_recording.available) localKinds.push("video_recording");
    if (local.proofRequirements.browser_trace.available) localKinds.push("browser_trace");
    if (local.proofRequirements.browser_verification.available) localKinds.push("browser_verification");
    if (local.proofRequirements.console_logs.available) localKinds.push("console_logs");

    // Only backends ADE can actually ingest from are listed. A permanently
    // `available: false` entry is decoration, not status.
    const backends: ComputerUseExternalBackendStatus[] = [];
    const agentBrowserInstalled = commandExists("agent-browser");
    backends.push({
      name: "agent-browser",
      available: agentBrowserInstalled,
      state: agentBrowserInstalled ? "installed" : "missing",
      detail: agentBrowserInstalled
        ? "agent-browser CLI is installed and can produce artifacts for ADE ingestion."
        : "agent-browser CLI is not installed on this machine.",
      supportedKinds: [
        "screenshot",
        "video_recording",
        "browser_trace",
        "browser_verification",
        "console_logs",
      ],
    });

    return {
      backends,
      localFallback: {
        available: local.overallState === "present",
        state: local.overallState,
        detail: local.overallState === "present"
          ? "ADE local computer-use tools are available as a fallback."
          : `ADE local computer-use tools are fallback-only and currently ${local.overallState}.`,
        supportedKinds: localKinds,
      },
    };
  };

  /**
   * Remove artifacts: rows (artifact + every link) and the stored file.
   *
   * Idempotent — an id with no row lands in `missing`, and a row whose file
   * is already gone still has its rows removed. File removal is jailed to
   * `.ade/artifacts`, so a record that points elsewhere (an http URL, or one
   * of the never-imported records the old silent fallback wrote) only ever
   * loses its rows.
   */
  const deleteArtifacts = (args: ComputerUseArtifactDeleteArgs): ComputerUseArtifactDeleteResult => {
    const ids = Array.from(new Set([
      ...(toOptionalString(args?.artifactId) ? [toOptionalString(args.artifactId)!] : []),
      ...((args?.artifactIds ?? []).map((id) => toOptionalString(id)).filter((id): id is string => Boolean(id))),
    ]));
    if (!ids.length) throw new Error("artifactId or artifactIds is required.");

    const deleted: ComputerUseArtifactDeleteOutcome[] = [];
    const missing: string[] = [];
    const failed: Array<{ artifactId: string; reason: string }> = [];

    for (const artifactId of ids) {
      const record = readArtifactById(artifactId);
      if (!record) {
        missing.push(artifactId);
        continue;
      }
      // Read the owners before the rows go, so the delete can be announced to
      // the same surfaces `artifact-linked` reached. An `owner: null` event is
      // silently dropped by every listener, which is why deletes made outside
      // the drawer used to leave it showing a row that no longer existed.
      const owners = readLinkRows([artifactId]).map((link) => ({
        kind: link.ownerKind,
        id: link.ownerId,
        relation: link.relation,
      }));
      try {
        const filePath = resolveArtifactFilePath(record);
        let fileRemoved = false;
        let freedBytes = 0;
        const sharedReference = filePath && record.storageKind === "file"
          ? readArtifactRows(
              `
                select ${ARTIFACT_SELECT_COLUMNS}
                from computer_use_artifacts
                where project_id = ?
                  and storage_kind = 'file'
                  and id <> ?
              `,
              [projectId, artifactId],
            ).some((candidate) => resolveArtifactFilePath(candidate) === filePath)
          : false;
        if (filePath && !sharedReference) {
          try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) {
              throw new Error(`Artifact storage path is not a regular file: ${filePath}`);
            }
            freedBytes = stat.size;
            fs.rmSync(filePath, { force: true });
            fileRemoved = true;
          } catch (error) {
            // Absence is idempotent. Permission, lock, I/O, and other failures
            // must retain both rows so the deletion can be retried rather than
            // orphaning bytes that ADE can no longer manage.
            if (!isEnoentError(error)) throw error;
          }
        }
        db.run("delete from computer_use_artifact_links where artifact_id = ?", [artifactId]);
        db.run("delete from computer_use_artifacts where id = ? and project_id = ?", [artifactId, projectId]);
        deleted.push({
          artifactId,
          title: record.title,
          fileRemoved,
          path: filePath,
          freedBytes,
        });
        const deletedAt = nowIso();
        if (owners.length) {
          for (const owner of owners) {
            emit({ type: "artifact-deleted", artifactId, at: deletedAt, owner });
          }
        } else {
          emit({ type: "artifact-deleted", artifactId, at: deletedAt, owner: null });
        }
      } catch (error) {
        failed.push({
          artifactId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      deleted,
      missing,
      failed,
      freedBytes: deleted.reduce((sum, entry) => sum + entry.freedBytes, 0),
    };
  };

  /**
   * Every record whose bytes cannot be served, with enough detail for the UI
   * to say what happened and offer recovery when the original file survives.
   */
  const collectBrokenArtifacts = (limit: number | null): ComputerUseArtifactBrokenRecord[] => {
    const pageSize = 500;
    const broken: ComputerUseArtifactBrokenRecord[] = [];
    let offset = 0;

    for (;;) {
      const records = readArtifactRows(
        `
          select ${ARTIFACT_SELECT_COLUMNS}
          from computer_use_artifacts
          where project_id = ?
            and storage_kind = 'file'
          order by created_at desc, id desc
          limit ? offset ?
        `,
        [projectId, pageSize, offset],
      );
      for (const record of records) {
        const availability = resolveAvailability(record);
        if (availability === "available") continue;
        broken.push({
          artifactId: record.id,
          title: record.title,
          kind: record.kind,
          uri: record.uri,
          createdAt: record.createdAt,
          reason: availability === "unimported" ? "outside_artifact_store" : "missing_file",
          laneId: record.laneId ?? null,
          recoverablePath: findRecoverableSourcePath(record),
        });
        if (limit != null && broken.length >= limit) return broken;
      }
      if (records.length < pageSize) return broken;
      offset += records.length;
    }
  };

  const listBrokenArtifacts = (args: { limit?: number } = {}): ComputerUseArtifactBrokenRecord[] => {
    const limit = Math.max(1, Math.min(2000, Math.floor(args.limit ?? 1000)));
    return collectBrokenArtifacts(limit);
  };

  return {
    ingest(request: ComputerUseArtifactIngestionRequest): ComputerUseArtifactIngestionResult {
      const owners = dedupeOwners(request.owners ?? []);
      const callerRoot = toOptionalString(request.callerRoot);
      const laneId = resolveLaneIdForOwners(owners);
      // Resolve every input before persisting any of them. `resolveStoredUri`
      // now throws (missing file, non-importable type, denied source), and a
      // half-committed batch would leave the agent's retry inserting the
      // already-stored inputs a second time.
      const resolved: Array<{
        input: ComputerUseArtifactInput;
        kind: ComputerUseArtifactKind;
        title: string;
        stored: ResolvedStoredArtifact;
      }> = [];
      const stagedFilePaths: string[] = [];
      try {
        for (const input of request.inputs) {
          const kind = normalizeInputKind(input);
          const title = toOptionalString(input.title) ?? defaultTitleForKind(kind);
          const stored = resolveStoredUri(input, kind, title, callerRoot);
          if (stored.stagedFilePath) stagedFilePaths.push(stored.stagedFilePath);
          resolved.push({ input, kind, title, stored });
        }
      } catch (error) {
        for (const stagedFilePath of stagedFilePaths) {
          try {
            fs.rmSync(stagedFilePath, { force: true });
          } catch {
            // Preserve the validation error; cleanup is best-effort.
          }
        }
        throw error;
      }
      const artifacts = resolved.map(({ input, kind, title, stored }) => {
        const { uri, storageKind, mimeType } = stored;
        const metadata = {
          ...(isRecord(input.metadata) ? input.metadata : {}),
          sourcePath: toOptionalString(input.path),
          sourceUri: toOptionalString(input.uri),
          rawType: toOptionalString(input.rawType),
          ...(callerRoot ? { callerRoot } : {}),
        };
        const record = insertArtifactRecord({
          kind,
          backendStyle: normalizeBackendStyle(request.backend.style),
          backendName: request.backend.name,
          sourceToolName: toOptionalString(request.backend.toolName) ?? toOptionalString(request.backend.command),
          originalType: toOptionalString(input.rawType) ?? toOptionalString(input.kind),
          title,
          description: toOptionalString(input.description),
          uri,
          storageKind,
          mimeType,
          metadata,
          laneId,
        });
        for (const owner of owners) {
          insertLink(record.id, owner);
          emit({
            type: "artifact-linked",
            artifactId: record.id,
            at: nowIso(),
            owner,
          });
        }
        emit({
          type: "artifact-ingested",
          artifactId: record.id,
          at: nowIso(),
          owner: owners[0] ?? null,
        });
        return record;
      });
      return {
        artifacts,
        links: readLinkRows(artifacts.map((artifact) => artifact.id)),
      };
    },

    listArtifacts(args: ComputerUseArtifactListArgs = {}): ComputerUseArtifactView[] {
      // Public callers cap ordinary list responses at 200. Internal proof
      // maintenance may request up to the broken-record audit ceiling so it
      // can authorize a bounded batch without one lookup per artifact.
      const limit = Math.max(1, Math.min(2000, Math.floor(args.limit ?? 50)));
      let artifacts: ComputerUseArtifactRecord[] = [];
      const artifactId = toOptionalString(args.artifactId);
      if (artifactId) {
        const record = readArtifactById(artifactId);
        artifacts = record ? [record] : [];
      } else {
      const ownerKind = args.owner?.kind ?? args.ownerKind ?? null;
      const ownerId = args.owner?.id ?? toOptionalString(args.ownerId);
      if (ownerKind && ownerId) {
        artifacts = readArtifactRows(
          `
            select distinct a.id, a.artifact_kind, a.backend_style, a.backend_name, a.source_tool_name,
                   a.original_type, a.title, a.description, a.uri, a.storage_kind, a.mime_type,
                   a.metadata_json, a.lane_id, a.created_at
            from computer_use_artifacts a
            left join computer_use_artifact_links l
              on l.artifact_id = a.id
             and l.project_id = ?
            where a.project_id = ?
              and (
                (l.owner_kind = ? and l.owner_id = ?)
                or (? = 'lane' and a.lane_id = ?)
              )
              ${args.kind ? "and a.artifact_kind = ?" : ""}
            order by a.created_at desc
            limit ?
          `,
          args.kind
            ? [projectId, projectId, ownerKind, ownerId, ownerKind, ownerId, args.kind, limit]
            : [projectId, projectId, ownerKind, ownerId, ownerKind, ownerId, limit],
        );
      } else {
        artifacts = readArtifactRows(
          `
            select ${ARTIFACT_SELECT_COLUMNS}
            from computer_use_artifacts
            where project_id = ?
              ${args.kind ? "and artifact_kind = ?" : ""}
            order by created_at desc
            limit ?
          `,
          args.kind ? [projectId, args.kind, limit] : [projectId, limit],
        );
      }
      }
      const links = readLinkRows(artifacts.map((artifact) => artifact.id));
      const linksByArtifact = new Map<string, ComputerUseArtifactLink[]>();
      for (const link of links) {
        const bucket = linksByArtifact.get(link.artifactId) ?? [];
        bucket.push(link);
        linksByArtifact.set(link.artifactId, bucket);
      }
      return artifacts.map((artifact) => toArtifactView(artifact, linksByArtifact.get(artifact.id) ?? []));
    },


    deleteArtifacts,
    listBrokenArtifacts,

    /** Drop every unrenderable record. Files were never there to remove. */
    pruneBrokenArtifacts(): ComputerUseArtifactDeleteResult {
      const broken = collectBrokenArtifacts(null);
      if (!broken.length) return { deleted: [], missing: [], failed: [], freedBytes: 0 };
      return deleteArtifacts({ artifactIds: broken.map((entry) => entry.artifactId) });
    },

    /**
     * Re-import a broken record's original file when it still exists on disk,
     * turning a dead row back into a viewable artifact.
     */
    recoverArtifact(args: { artifactId: string }): ComputerUseArtifactView {
      const artifactId = toOptionalString(args?.artifactId);
      if (!artifactId) throw new Error("artifactId is required.");
      const record = readArtifactById(artifactId);
      if (!record) throw new Error(`Computer-use artifact not found: ${artifactId}`);
      if (resolveAvailability(record) === "available") {
        return toArtifactView(record, readLinkRows([artifactId]));
      }
      const source = resolveRecoverableSource(record);
      if (source.status === "ambiguous") {
        throw new Error(
          `The original file for "${record.title}" matches multiple surviving roots and cannot be recovered safely: `
          + source.paths.join(", "),
        );
      }
      if (source.status === "missing") {
        throw new Error(
          `The original file for "${record.title}" no longer exists, so it cannot be recovered. Remove the record instead.`,
        );
      }
      const sourcePath = source.path;
      if (!isAllowedExternalArtifactSource(sourcePath, allowedImportRoots)
        || isDeniedArtifactSource(sourcePath, deniedImportRoots)) {
        throw new Error(`Artifact path is outside allowed import roots: ${sourcePath}`);
      }
      // Recovery re-imports bytes from a surviving lane worktree, so it is an
      // import like any other and gets the same file-type gate.
      if (!isImportableArtifactFile(sourcePath)) {
        throw new Error(`Artifact file type is not importable as proof: ${sourcePath}`);
      }
      const extension = inferArtifactExtension({ path: sourcePath }, record.kind);
      const targetPath = createComputerUseArtifactPath(projectRoot, record.title, extension);
      secureCopyFromDescriptor(sourcePath, targetPath);
      db.run(
        "update computer_use_artifacts set uri = ?, storage_kind = 'file' where id = ? and project_id = ?",
        [toProjectArtifactUri(projectRoot, targetPath), artifactId, projectId],
      );
      const refreshed = readArtifactById(artifactId);
      if (!refreshed) throw new Error(`Failed to refresh computer-use artifact: ${artifactId}`);
      return toArtifactView(refreshed, readLinkRows([artifactId]));
    },

    /**
     * Lane cascade. Deleting a lane deletes the captures taken in it — that is
     * the behaviour users expect from "delete the lane and its stuff".
     * Artifacts also linked to a chat outside the lane are kept so a shared
     * capture never disappears from a chat the user did not delete.
     */
    deleteArtifactsForLane(args: { laneId: string }): ComputerUseArtifactDeleteResult {
      const laneId = toOptionalString(args?.laneId);
      if (!laneId) throw new Error("laneId is required.");
      const rows = db.all<{ id: string }>(
        `
          select a.id
          from computer_use_artifacts a
          where a.project_id = ?
            and (
              a.lane_id = ?
              or exists (
                select 1 from computer_use_artifact_links l
                where l.artifact_id = a.id
                  and l.owner_kind = 'lane'
                  and l.owner_id = ?
              )
            )
            and not exists (
              select 1
              from computer_use_artifact_links l2
              join terminal_sessions s on s.id = l2.owner_id
              where l2.artifact_id = a.id
                and l2.owner_kind = 'chat_session'
                and s.lane_id is not null
                and s.lane_id <> ?
            )
        `,
        [projectId, laneId, laneId, laneId],
      );
      if (!rows.length) return { deleted: [], missing: [], failed: [], freedBytes: 0 };
      return deleteArtifacts({ artifactIds: rows.map((row) => row.id) });
    },

    /** Drop every artifact record for the project (used by "clear local data"). */
    deleteAllArtifacts(): ComputerUseArtifactDeleteResult {
      const rows = db.all<{ id: string }>(
        "select id from computer_use_artifacts where project_id = ?",
        [projectId],
      );
      if (!rows.length) return { deleted: [], missing: [], failed: [], freedBytes: 0 };
      return deleteArtifacts({ artifactIds: rows.map((row) => row.id) });
    },

    /**
     * Drop records whose stored file lived at or under `removedPath`. Called
     * after Settings → Storage removes proof files so the rows never outlive
     * the bytes.
     */
    purgeArtifactRecordsUnder(removedPath: string): ComputerUseArtifactDeleteResult {
      const root = path.resolve(removedPath);
      const rows = readArtifactRows(
        `
          select ${ARTIFACT_SELECT_COLUMNS}
          from computer_use_artifacts
          where project_id = ?
            and storage_kind = 'file'
        `,
        [projectId],
      );
      const ids = rows
        .filter((record) => {
          const filePath = resolveArtifactFilePath(record);
          if (!filePath) return false;
          return filePath === root || filePath.startsWith(root + path.sep);
        })
        .map((record) => record.id);
      if (!ids.length) return { deleted: [], missing: [], failed: [], freedBytes: 0 };
      return deleteArtifacts({ artifactIds: ids });
    },

    updateArtifactReview(args: ComputerUseArtifactReviewArgs): ComputerUseArtifactView {
      const artifactId = String(args.artifactId ?? "").trim();
      if (!artifactId.length) throw new Error("artifactId is required.");
      const updated = updateArtifactMetadata(artifactId, (current) => ({
        ...current,
        ...(args.reviewState ? { reviewState: args.reviewState } : {}),
        ...(args.workflowState ? { workflowState: args.workflowState } : {}),
        ...(args.reviewNote !== undefined ? { reviewNote: toOptionalString(args.reviewNote) } : {}),
      }));
      emit({
        type: "artifact-reviewed",
        artifactId,
        at: nowIso(),
        owner: updated.links[0]
          ? {
              kind: updated.links[0].ownerKind,
              id: updated.links[0].ownerId,
              relation: updated.links[0].relation,
              metadata: updated.links[0].metadata,
            }
          : null,
      });
      return updated;
    },

    readArtifactPreview(args: { uri?: string }): Promise<string | null> {
      return readArtifactPreviewDataUrl({
        uri: args?.uri,
        projectRoot,
        artifactsDir: layout.artifactsDir,
      });
    },

    getBackendStatus,
  };
}

export type ComputerUseArtifactBrokerService = ReturnType<typeof createComputerUseArtifactBrokerService>;
