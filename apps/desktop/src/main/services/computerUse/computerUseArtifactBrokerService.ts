import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
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
  ComputerUseArtifactRouteArgs,
  ComputerUseArtifactView,
  ComputerUseBackendStatus,
  ComputerUseExternalBackendStatus,
  ComputerUseArtifactWorkflowState,
  ComputerUseEventPayload,
} from "../../../shared/types";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import {
  normalizeComputerUseArtifactKind,
  resolveReportArtifactKind,
} from "../../../shared/proofArtifacts";
import type { createMissionService } from "../missions/missionService";
import type { createOrchestratorService } from "../orchestrator/orchestratorService";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { SqlValue } from "../state/kvDb";
import {
  fileExists,
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
  created_at: string;
};

const DEFAULT_REVIEW_STATE: ComputerUseArtifactReviewState = "pending";
const DEFAULT_WORKFLOW_STATE: ComputerUseArtifactWorkflowState = "evidence_only";

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
  missionService: ReturnType<typeof createMissionService>;
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  logger?: Logger | null;
  onEvent?: (payload: ComputerUseEventPayload) => void;
}) {
  const { db, projectId, projectRoot, missionService, orchestratorService, onEvent } = args;
  const layout = resolveAdeLayout(projectRoot);
  const allowedImportRoots = Array.from(new Set([
    layout.artifactsDir,
    layout.tmpDir,
    os.tmpdir(),
    path.join(os.homedir(), ".agent-browser"),
  ]));

  const emit = (payload: ComputerUseEventPayload): void => {
    try {
      onEvent?.(payload);
    } catch {
      // Best-effort broadcast only.
    }
  };

  const materializeInlineContent = (input: ComputerUseArtifactInput, kind: ComputerUseArtifactKind, title: string): string => {
    const extension = inferArtifactExtension(input, kind);
    const artifactPath = createComputerUseArtifactPath(projectRoot, title, extension);
    if (input.json != null) {
      writeTextAtomic(artifactPath, `${JSON.stringify(input.json, null, 2)}\n`);
    } else {
      writeTextAtomic(artifactPath, input.text ?? "");
    }
    return toProjectArtifactUri(projectRoot, artifactPath);
  };

  const resolveStoredUri = (input: ComputerUseArtifactInput, kind: ComputerUseArtifactKind, title: string): { uri: string; storageKind: "file" | "url"; mimeType: string | null } => {
    const directUri = toOptionalString(input.uri);
    if (directUri && isHttpUrl(directUri)) {
      return { uri: directUri, storageKind: "url", mimeType: toOptionalString(input.mimeType) };
    }

    const pathLike = toOptionalString(input.path) ?? (directUri && !isHttpUrl(directUri) ? directUri : null);
    if (pathLike) {
      const absolutePath = path.isAbsolute(pathLike)
        ? pathLike
        : resolvePathWithinRoot(projectRoot, pathLike, { allowMissing: true });
      if (fileExists(absolutePath)) {
        try {
          const existingArtifactPath = resolvePathWithinRoot(layout.artifactsDir, absolutePath);
          return {
            uri: toProjectArtifactUri(projectRoot, existingArtifactPath),
            storageKind: "file",
            mimeType: toOptionalString(input.mimeType),
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
        };
      }
      return {
        uri: pathLike,
        storageKind: "file",
        mimeType: toOptionalString(input.mimeType),
      };
    }

    return {
      uri: materializeInlineContent(input, kind, title),
      storageKind: "file",
      mimeType: toOptionalString(input.mimeType),
    };
  };

  const insertArtifactRecord = (record: Omit<ComputerUseArtifactRecord, "id" | "createdAt">): ComputerUseArtifactRecord => {
    const next: ComputerUseArtifactRecord = {
      id: randomUUID(),
      ...record,
      createdAt: nowIso(),
    };
    db.run(
      `
        insert into computer_use_artifacts(
          id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
          original_type, title, description, uri, storage_kind, mime_type, metadata_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        next.id,
        projectId,
        next.kind,
        next.backendStyle,
        next.backendName,
        next.sourceToolName,
        next.originalType,
        next.title,
        next.description,
        next.uri,
        next.storageKind,
        next.mimeType,
        JSON.stringify(next.metadata ?? {}),
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
        select id, artifact_kind, backend_style, backend_name, source_tool_name,
               original_type, title, description, uri, storage_kind, mime_type,
               metadata_json, created_at
        from computer_use_artifacts
        where project_id = ?
          and id = ?
        limit 1
      `,
      [projectId, artifactId],
    )[0] ?? null;

  const toArtifactView = (record: ComputerUseArtifactRecord, links: ComputerUseArtifactLink[]): ComputerUseArtifactView => {
    const reviewState = toOptionalString(record.metadata.reviewState) as ComputerUseArtifactReviewState | null;
    const workflowState = toOptionalString(record.metadata.workflowState) as ComputerUseArtifactWorkflowState | null;
    return {
      ...record,
      links,
      reviewState: reviewState ?? DEFAULT_REVIEW_STATE,
      workflowState: workflowState ?? DEFAULT_WORKFLOW_STATE,
      reviewNote: toOptionalString(record.metadata.reviewNote),
    };
  };

  const getLink = (artifactId: string, owner: ComputerUseArtifactOwner): ComputerUseArtifactLink | null =>
    db.get<StoredLinkRow>(
      `
        select id, artifact_id, owner_kind, owner_id, relation, metadata_json, created_at
        from computer_use_artifact_links
        where artifact_id = ?
          and project_id = ?
          and owner_kind = ?
          and owner_id = ?
          and relation = ?
        limit 1
      `,
      [artifactId, projectId, owner.kind, owner.id.trim(), owner.relation ?? "attached_to"],
    )
      ? readLinkRows([artifactId]).find((link) =>
          link.ownerKind === owner.kind
          && link.ownerId === owner.id.trim()
          && link.relation === (owner.relation ?? "attached_to")
        ) ?? null
      : null;

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

  const projectArtifact = (record: ComputerUseArtifactRecord, owners: ComputerUseArtifactOwner[]): void => {
    const missionId = owners.find((owner) => owner.kind === "mission")?.id ?? null;
    const runId = owners.find((owner) => owner.kind === "orchestrator_run")?.id ?? null;
    const stepId = owners.find((owner) => owner.kind === "orchestrator_step")?.id ?? null;
    const attemptId = owners.find((owner) => owner.kind === "orchestrator_attempt")?.id ?? null;
    const laneId = owners.find((owner) => owner.kind === "lane")?.id ?? null;

    if (missionId) {
      missionService.addArtifact({
        missionId,
        artifactType: record.kind,
        title: record.title,
        description: record.description,
        uri: record.uri,
        laneId,
        metadata: {
          brokerArtifactId: record.id,
          backendStyle: record.backendStyle,
          backendName: record.backendName,
          sourceToolName: record.sourceToolName,
          originalType: record.originalType,
        },
        createdBy: "system",
        actor: "system",
      });
    }

    if (missionId && runId && stepId && attemptId) {
      orchestratorService.registerArtifact({
        missionId,
        runId,
        stepId,
        attemptId,
        artifactKey: record.kind,
        kind: resolveReportArtifactKind({
          type: record.kind,
          artifactKey: record.kind,
          uri: record.uri,
          metadata: record.metadata,
        }),
        value: record.uri,
        metadata: {
          brokerArtifactId: record.id,
          title: record.title,
          description: record.description,
          backendStyle: record.backendStyle,
          backendName: record.backendName,
          sourceToolName: record.sourceToolName,
          uri: record.uri,
          ...record.metadata,
        },
        declared: true,
      });
    }
  };

  const readArtifactRows = (query: string, params: SqlValue[]): ComputerUseArtifactRecord[] =>
    db.all<StoredArtifactRow>(query, params).map((row) => ({
      id: row.id,
      kind: row.artifact_kind as ComputerUseArtifactKind,
      backendStyle: row.backend_style as ComputerUseArtifactRecord["backendStyle"],
      backendName: row.backend_name,
      sourceToolName: row.source_tool_name,
      originalType: row.original_type,
      title: row.title,
      description: row.description,
      uri: row.uri,
      storageKind: row.storage_kind as ComputerUseArtifactRecord["storageKind"],
      mimeType: row.mime_type,
      metadata: safeJsonParse(row.metadata_json, {}),
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

    const backends: ComputerUseExternalBackendStatus[] = [];
    const ghostInstalled = commandExists("ghost");
    backends.push({
      name: "Ghost OS",
      style: "external_cli",
      available: ghostInstalled,
      state: ghostInstalled ? "installed" : "missing",
      detail: ghostInstalled
        ? "Ghost OS CLI is installed and can produce artifacts for ADE ingestion."
        : "Ghost OS CLI is not installed on this machine.",
      supportedKinds: [
        "screenshot",
        "video_recording",
        "browser_verification",
      ],
    });

    const agentBrowserInstalled = commandExists("agent-browser");
    backends.push({
      name: "agent-browser",
      style: "external_cli",
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
        detail: local.overallState === "present"
          ? "ADE local computer-use tools are available as a fallback."
          : `ADE local computer-use tools are fallback-only and currently ${local.overallState}.`,
        supportedKinds: localKinds,
      },
    };
  };

  return {
    ingest(request: ComputerUseArtifactIngestionRequest): ComputerUseArtifactIngestionResult {
      const owners = dedupeOwners(request.owners ?? []);
      const artifacts = request.inputs.map((input) => {
        const kind = normalizeInputKind(input);
        const title = toOptionalString(input.title) ?? defaultTitleForKind(kind);
        const { uri, storageKind, mimeType } = resolveStoredUri(input, kind, title);
        const metadata = {
          ...(isRecord(input.metadata) ? input.metadata : {}),
          sourcePath: toOptionalString(input.path),
          sourceUri: toOptionalString(input.uri),
          rawType: toOptionalString(input.rawType),
        };
        const record = insertArtifactRecord({
          kind,
          backendStyle: request.backend.style,
          backendName: request.backend.name,
          sourceToolName: toOptionalString(request.backend.toolName) ?? toOptionalString(request.backend.command),
          originalType: toOptionalString(input.rawType) ?? toOptionalString(input.kind),
          title,
          description: toOptionalString(input.description),
          uri,
          storageKind,
          mimeType,
          metadata,
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
        projectArtifact(record, owners);
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
      const limit = Math.max(1, Math.min(200, Math.floor(args.limit ?? 50)));
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
            select a.id, a.artifact_kind, a.backend_style, a.backend_name, a.source_tool_name,
                   a.original_type, a.title, a.description, a.uri, a.storage_kind, a.mime_type,
                   a.metadata_json, a.created_at
            from computer_use_artifacts a
            inner join computer_use_artifact_links l
              on l.artifact_id = a.id
            where a.project_id = ?
              and l.project_id = ?
              and l.owner_kind = ?
              and l.owner_id = ?
              ${args.kind ? "and a.artifact_kind = ?" : ""}
            order by a.created_at desc
            limit ?
          `,
          args.kind
            ? [projectId, projectId, ownerKind, ownerId, args.kind, limit]
            : [projectId, projectId, ownerKind, ownerId, limit],
        );
      } else {
        artifacts = readArtifactRows(
          `
            select id, artifact_kind, backend_style, backend_name, source_tool_name,
                   original_type, title, description, uri, storage_kind, mime_type,
                   metadata_json, created_at
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

    routeArtifact(args: ComputerUseArtifactRouteArgs): ComputerUseArtifactView {
      const artifactId = String(args.artifactId ?? "").trim();
      if (!artifactId.length) throw new Error("artifactId is required.");
      const owner = { ...args.owner, id: args.owner.id.trim() };
      if (!owner.id.length) throw new Error("owner.id is required.");
      const record = readArtifactById(artifactId);
      if (!record) throw new Error(`Computer-use artifact not found: ${artifactId}`);
      const existing = getLink(artifactId, owner);
      if (!existing) {
        insertLink(artifactId, owner);
        projectArtifact(record, [owner]);
        emit({
          type: "artifact-linked",
          artifactId,
          at: nowIso(),
          owner,
        });
      }
      return toArtifactView(record, readLinkRows([artifactId]));
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

    getBackendStatus,
  };
}

export type ComputerUseArtifactBrokerService = ReturnType<typeof createComputerUseArtifactBrokerService>;
