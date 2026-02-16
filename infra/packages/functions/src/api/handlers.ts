import { randomUUID, createHash } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import { getUserIdFromEvent } from "../common/auth";
import { ddb, nowIso } from "../common/awsClients";
import { sharedEnv } from "../common/env";
import {
  ApiError,
  createOptionsResponse,
  json,
  parseJsonBody,
  parsePathParam,
  toApiResponse
} from "../common/http";
import { buildJobPayload, enqueueJob } from "../common/jobs";
import { enforceJobSubmissionLimits } from "../common/rateLimit";
import { getDefaultExcludePatterns, pathShouldBeExcluded, redactSecrets } from "../common/redaction";
import { deleteObjects, deletePrefix, getObjectText, listObjectsByPrefix, putObject, s3ObjectExists } from "../common/storage";
import { isRecord, optionalString, parseJobType, parseSha256, requireString } from "../common/validation";
import { planMirrorCleanup } from "../../../core/src/mirrorCleanup";
import type { HostedJobType } from "../../../core/src/types";

type ProjectItem = {
  userId: string;
  projectId: string;
  name: string;
  repoUrl?: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  blobCount: number;
  totalSize: number;
};

type LaneItem = {
  projectId: string;
  laneId: string;
  headSha?: string;
  branchRef?: string;
  manifestKey: string;
  lastSyncAt: string;
};

type JobItem = {
  projectId: string;
  jobId: string;
  userId: string;
  type: HostedJobType;
  status: "queued" | "processing" | "completed" | "failed";
  laneId: string;
  params: Record<string, unknown>;
  artifactId?: string;
  submittedAt: string;
  completedAt?: string;
  updatedAt: string;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  metrics?: Record<string, unknown>;
  expiresAt?: number;
};

type ArtifactItem = {
  projectId: string;
  artifactId: string;
  jobId: string;
  type: string;
  s3Key: string;
  contentHash: string;
  createdAt: string;
  expiresAt: number;
};

async function getProjectForUser(args: { userId: string; projectId: string }): Promise<ProjectItem> {
  const item = await ddb.send(
    new GetCommand({
      TableName: sharedEnv.projectsTableName,
      Key: {
        userId: args.userId,
        projectId: args.projectId
      }
    })
  );

  if (!item.Item) {
    throw new ApiError(404, {
      code: "NOT_FOUND",
      message: `Project '${args.projectId}' was not found`
    });
  }

  return item.Item as ProjectItem;
}

async function listProjectRows<T>(args: {
  tableName: string;
  partitionKeyName: string;
  partitionKeyValue: string;
}): Promise<T[]> {
  const out: T[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: args.tableName,
        KeyConditionExpression: `#pk = :pk`,
        ExpressionAttributeNames: {
          "#pk": args.partitionKeyName
        },
        ExpressionAttributeValues: {
          ":pk": args.partitionKeyValue
        },
        ExclusiveStartKey: lastEvaluatedKey
      })
    );

    out.push(...((response.Items ?? []) as T[]));
    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return out;
}

function collectSha256Digests(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(trimmed)) out.add(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectSha256Digests(entry, out);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "sha256" || key.endsWith("Sha256")) {
      if (typeof entry === "string") collectSha256Digests(entry, out);
      continue;
    }
    collectSha256Digests(entry, out);
  }
}

export async function options(): Promise<APIGatewayProxyStructuredResultV2> {
  return createOptionsResponse();
}

export async function health(): Promise<APIGatewayProxyStructuredResultV2> {
  return json(200, {
    ok: true,
    stage: sharedEnv.appStage,
    service: "ade-cloud-api"
  });
}

export async function createProject(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const body = parseJsonBody<Record<string, unknown>>(event);

    const projectId = randomUUID();
    const createdAt = nowIso();

    const item: ProjectItem = {
      userId,
      projectId,
      name: requireString(body.name, "name"),
      rootPath: requireString(body.rootPath, "rootPath"),
      createdAt,
      updatedAt: createdAt,
      blobCount: 0,
      totalSize: 0,
      ...(optionalString(body.repoUrl) ? { repoUrl: optionalString(body.repoUrl) } : {})
    };

    await ddb.send(
      new PutCommand({
        TableName: sharedEnv.projectsTableName,
        Item: item
      })
    );

    return json(201, {
      projectId,
      createdAt
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function getProject(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");

    const project = await getProjectForUser({ userId, projectId });
    const lanes = await listProjectRows<LaneItem>({
      tableName: sharedEnv.lanesTableName,
      partitionKeyName: "projectId",
      partitionKeyValue: projectId
    });

    const jobs = await listProjectRows<JobItem>({
      tableName: sharedEnv.jobsTableName,
      partitionKeyName: "projectId",
      partitionKeyValue: projectId
    });

    jobs.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

    return json(200, {
      projectId: project.projectId,
      name: project.name,
      repoUrl: project.repoUrl,
      rootPath: project.rootPath,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      blobCount: project.blobCount,
      totalSize: project.totalSize,
      lanes,
      jobs: jobs.slice(0, 50)
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function uploadBlobs(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    await getProjectForUser({ userId, projectId });

    const body = parseJsonBody<Record<string, unknown>>(event);
    const blobs = Array.isArray(body.blobs) ? body.blobs : null;
    if (!blobs) {
      throw new ApiError(400, {
        code: "VALIDATION_ERROR",
        message: "blobs must be an array"
      });
    }

    const excludePatterns = [
      ...getDefaultExcludePatterns(),
      ...(Array.isArray(body.excludePatterns)
        ? body.excludePatterns.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : [])
    ];

    let uploaded = 0;
    let deduplicated = 0;
    let excluded = 0;
    let totalUploadedBytes = 0;

    for (const entry of blobs) {
      if (!isRecord(entry)) continue;
      const sha256 = parseSha256(entry.sha256, "blobs[].sha256");
      const relPath = optionalString(entry.path);
      if (relPath && pathShouldBeExcluded(relPath, excludePatterns)) {
        excluded += 1;
        continue;
      }

      const base64 = requireString(entry.contentBase64, "blobs[].contentBase64");
      const contentType = optionalString(entry.contentType) ?? "application/octet-stream";
      const key = `${projectId}/${sha256}`;

      if (await s3ObjectExists(sharedEnv.blobsBucketName, key)) {
        deduplicated += 1;
        continue;
      }

      const rawBytes = Buffer.from(base64, "base64");
      let finalBytes = rawBytes;
      if (contentType.startsWith("text/") || contentType === "application/json") {
        const redacted = redactSecrets(rawBytes.toString("utf8"));
        finalBytes = Buffer.from(redacted, "utf8");
      }

      const hash = createHash("sha256").update(finalBytes).digest("hex");
      if (hash !== sha256) {
        throw new ApiError(400, {
          code: "VALIDATION_ERROR",
          message: `sha256 mismatch for blob ${sha256}`
        });
      }

      await putObject({
        bucket: sharedEnv.blobsBucketName,
        key,
        body: finalBytes,
        contentType
      });

      uploaded += 1;
      totalUploadedBytes += finalBytes.length;
    }

    await ddb.send(
      new UpdateCommand({
        TableName: sharedEnv.projectsTableName,
        Key: {
          userId,
          projectId
        },
        UpdateExpression: "set updatedAt = :updatedAt, blobCount = if_not_exists(blobCount, :zero) + :blobCount, totalSize = if_not_exists(totalSize, :zero) + :totalSize",
        ExpressionAttributeValues: {
          ":updatedAt": nowIso(),
          ":blobCount": uploaded,
          ":totalSize": totalUploadedBytes,
          ":zero": 0
        }
      })
    );

    return json(200, {
      uploaded,
      deduplicated,
      excluded
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function updateLaneManifest(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    const laneId = parsePathParam(event, "lid");
    await getProjectForUser({ userId, projectId });

    const body = parseJsonBody<Record<string, unknown>>(event);
    const timestamp = nowIso();
    const manifestKey = `${projectId}/${laneId}/manifest.json`;

    const payload = {
      ...body,
      laneId,
      projectId,
      syncedAt: timestamp
    };

    await putObject({
      bucket: sharedEnv.manifestsBucketName,
      key: manifestKey,
      body: redactSecrets(JSON.stringify(payload, null, 2)),
      contentType: "application/json"
    });

    const laneItem: LaneItem = {
      projectId,
      laneId,
      manifestKey,
      lastSyncAt: timestamp,
      ...(optionalString(body.headSha) ? { headSha: optionalString(body.headSha) } : {}),
      ...(optionalString(body.branchRef) ? { branchRef: optionalString(body.branchRef) } : {})
    };

    await ddb.send(
      new PutCommand({
        TableName: sharedEnv.lanesTableName,
        Item: laneItem
      })
    );

    return json(200, {
      manifestId: randomUUID(),
      timestamp
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function updatePacksManifest(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    await getProjectForUser({ userId, projectId });

    const body = parseJsonBody<Record<string, unknown>>(event);
    const packs = Array.isArray(body.packs) ? body.packs : null;
    if (!packs) {
      throw new ApiError(400, {
        code: "VALIDATION_ERROR",
        message: "packs must be an array"
      });
    }

    const timestamp = nowIso();
    const manifestKey = `${projectId}/packs/manifest.json`;

    const normalized = packs
      .filter(isRecord)
      .map((entry) => {
        const relPath = requireString(entry.path, "packs[].path");
        const sha256 = parseSha256(entry.sha256, "packs[].sha256");
        const size = Number(entry.size ?? 0);
        const contentType = optionalString(entry.contentType) ?? "application/octet-stream";
        return {
          path: relPath,
          sha256,
          size: Number.isFinite(size) && size >= 0 ? size : 0,
          contentType
        };
      });

    const payload = {
      schema: optionalString(body.schema) || "ade.mirror.packs.v1",
      projectId,
      syncedAt: timestamp,
      generatedAt: optionalString(body.generatedAt) ?? timestamp,
      packCount: normalized.length,
      packs: normalized
    };

    await putObject({
      bucket: sharedEnv.manifestsBucketName,
      key: manifestKey,
      body: redactSecrets(JSON.stringify(payload, null, 2)),
      contentType: "application/json"
    });

    await ddb.send(
      new UpdateCommand({
        TableName: sharedEnv.projectsTableName,
        Key: {
          userId,
          projectId
        },
        UpdateExpression: "set updatedAt = :updatedAt, packsManifestKey = :manifestKey, packsLastSyncAt = :lastSyncAt, packsCount = :packsCount",
        ExpressionAttributeValues: {
          ":updatedAt": nowIso(),
          ":manifestKey": manifestKey,
          ":lastSyncAt": timestamp,
          ":packsCount": normalized.length
        }
      })
    );

    return json(200, {
      manifestKey,
      timestamp,
      packCount: normalized.length
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function updateTranscriptsManifest(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    await getProjectForUser({ userId, projectId });

    const body = parseJsonBody<Record<string, unknown>>(event);
    const transcripts = Array.isArray(body.transcripts) ? body.transcripts : null;
    if (!transcripts) {
      throw new ApiError(400, {
        code: "VALIDATION_ERROR",
        message: "transcripts must be an array"
      });
    }

    const timestamp = nowIso();
    const manifestKey = `${projectId}/transcripts/manifest.json`;

    const normalized = transcripts
      .filter(isRecord)
      .map((entry) => {
        const relPath = requireString(entry.path, "transcripts[].path");
        const sha256 = parseSha256(entry.sha256, "transcripts[].sha256");
        const size = Number(entry.size ?? 0);
        const contentType = optionalString(entry.contentType) ?? "application/octet-stream";
        return {
          path: relPath,
          sha256,
          size: Number.isFinite(size) && size >= 0 ? size : 0,
          contentType
        };
      });

    const payload = {
      schema: optionalString(body.schema) || "ade.mirror.transcripts.v1",
      projectId,
      syncedAt: timestamp,
      generatedAt: optionalString(body.generatedAt) ?? timestamp,
      transcriptCount: normalized.length,
      transcripts: normalized
    };

    await putObject({
      bucket: sharedEnv.manifestsBucketName,
      key: manifestKey,
      body: redactSecrets(JSON.stringify(payload, null, 2)),
      contentType: "application/json"
    });

    await ddb.send(
      new UpdateCommand({
        TableName: sharedEnv.projectsTableName,
        Key: {
          userId,
          projectId
        },
        UpdateExpression:
          "set updatedAt = :updatedAt, transcriptsManifestKey = :manifestKey, transcriptsLastSyncAt = :lastSyncAt, transcriptsCount = :count",
        ExpressionAttributeValues: {
          ":updatedAt": nowIso(),
          ":manifestKey": manifestKey,
          ":lastSyncAt": timestamp,
          ":count": normalized.length
        }
      })
    );

    return json(200, {
      manifestKey,
      timestamp,
      transcriptCount: normalized.length
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function cleanMirrorData(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    await getProjectForUser({ userId, projectId });

    const startedAt = nowIso();
    const warnings: string[] = [];
    const staleGraceMs = 10 * 60_000;
    const maxObjectsScanned = 5000;
    const maxDelete = 1000;
    const maxBytesScanned = 500 * 1024 * 1024;

    const laneRows = await listProjectRows<LaneItem>({
      tableName: sharedEnv.lanesTableName,
      partitionKeyName: "projectId",
      partitionKeyValue: projectId
    });
    const manifestKeys = new Set<string>([
      ...laneRows.map((row) => row.manifestKey).filter((value): value is string => typeof value === "string" && value.trim().length > 0),
      `${projectId}/packs/manifest.json`,
      `${projectId}/transcripts/manifest.json`,
      `${projectId}/project/manifest.json`
    ]);

    const reachableDigests = new Set<string>();
    for (const manifestKey of manifestKeys) {
      try {
        const raw = await getObjectText({ bucket: sharedEnv.manifestsBucketName, key: manifestKey });
        if (!raw.trim().length) continue;
        const parsed = JSON.parse(raw) as unknown;
        collectSha256Digests(parsed, reachableDigests);
      } catch (error) {
        warnings.push(`manifest_unreadable:${manifestKey}`);
        void error;
      }
    }

    const blobObjects = await listObjectsByPrefix({
      bucket: sharedEnv.blobsBucketName,
      prefix: `${projectId}/`,
      maxKeys: maxObjectsScanned
    });
    const cleanupPlan = planMirrorCleanup({
      projectId,
      reachableDigests,
      blobObjects,
      nowMs: Date.now(),
      staleGraceMs,
      maxDelete,
      maxBytesScanned
    });
    warnings.push(...cleanupPlan.warnings);
    const orphanCandidates = cleanupPlan.orphanCandidates;
    const deletionBatch = cleanupPlan.deletionBatch;
    const reachableBlobCount = cleanupPlan.reachableBlobCount;
    const deletedCount = await deleteObjects({
      bucket: sharedEnv.blobsBucketName,
      keys: deletionBatch.map((entry) => entry.key)
    });
    const reclaimedBytes = cleanupPlan.reclaimedBytes;

    await ddb.send(
      new UpdateCommand({
        TableName: sharedEnv.projectsTableName,
        Key: {
          userId,
          projectId
        },
        UpdateExpression:
          "set updatedAt = :updatedAt, blobCount = if_not_exists(blobCount, :zero) - :blobDelta, totalSize = if_not_exists(totalSize, :zero) - :sizeDelta",
        ExpressionAttributeValues: {
          ":updatedAt": nowIso(),
          ":blobDelta": deletedCount,
          ":sizeDelta": reclaimedBytes,
          ":zero": 0
        }
      })
    );

    const finishedAt = nowIso();
    return json(200, {
      remoteProjectId: projectId,
      cleanedAt: finishedAt,
      startedAt,
      finishedAt,
      reachableBlobs: reachableBlobCount,
      orphanedBlobs: orphanCandidates.length,
      deletedBlobs: deletedCount,
      reclaimedBytes,
      mirrorReachableBlobs: reachableBlobCount,
      mirrorOrphanedBlobs: orphanCandidates.length,
      mirrorDeleted: deletedCount,
      mirrorReclaimedBytes: reclaimedBytes,
      cleanupResult: "success",
      cleanupError: null,
      warnings
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(200, {
      remoteProjectId: parsePathParam(event, "id"),
      cleanedAt: nowIso(),
      reachableBlobs: 0,
      orphanedBlobs: 0,
      deletedBlobs: 0,
      reclaimedBytes: 0,
      mirrorReachableBlobs: 0,
      mirrorOrphanedBlobs: 0,
      mirrorDeleted: 0,
      mirrorReclaimedBytes: 0,
      cleanupResult: "failed",
      cleanupError: message,
      warnings: []
    });
  }
}

export async function submitJob(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    await getProjectForUser({ userId, projectId });

    const body = parseJsonBody<Record<string, unknown>>(event);
    const type = parseJobType(body.type);
    const laneId = requireString(body.laneId, "laneId");
    const params = isRecord(body.params) ? body.params : {};

    await enforceJobSubmissionLimits({
      userId,
      type
    });

    if (!sharedEnv.jobsQueueUrl) {
      throw new ApiError(500, {
        code: "CONFIG_ERROR",
        message: "JOBS_QUEUE_URL is not configured"
      });
    }

    const jobId = randomUUID();
    const submittedAt = nowIso();

    const item: JobItem = {
      projectId,
      jobId,
      userId,
      type,
      status: "queued",
      laneId,
      params,
      submittedAt,
      updatedAt: submittedAt,
      expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
    };

    await ddb.send(
      new PutCommand({
        TableName: sharedEnv.jobsTableName,
        Item: item
      })
    );

    const payload = buildJobPayload({
      projectId,
      userId,
      jobId,
      type,
      laneId,
      params,
      submittedAt
    });

    await enqueueJob(sharedEnv.jobsQueueUrl, payload);

    return json(202, {
      jobId,
      status: "queued"
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function getJob(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    const jobId = parsePathParam(event, "jid");

    await getProjectForUser({ userId, projectId });

    const response = await ddb.send(
      new GetCommand({
        TableName: sharedEnv.jobsTableName,
        Key: {
          projectId,
          jobId
        }
      })
    );

    const item = response.Item as JobItem | undefined;
    if (!item) {
      throw new ApiError(404, {
        code: "NOT_FOUND",
        message: `Job '${jobId}' was not found`
      });
    }

    if (item.userId !== userId) {
      throw new ApiError(403, {
        code: "FORBIDDEN",
        message: "Job does not belong to authenticated user"
      });
    }

    // Inline staleness check: mark stuck jobs as failed on read
    const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes
    if (
      (item.status === "queued" || item.status === "processing") &&
      Date.now() - new Date(item.submittedAt).getTime() > STALE_THRESHOLD_MS
    ) {
      const staleStatus = item.status;
      const staleError = { code: "STALE_JOB_SWEPT", message: `Job stuck in '${staleStatus}' for over 60 minutes` };
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: sharedEnv.jobsTableName,
            Key: { projectId, jobId },
            UpdateExpression: "set #status = :failed, updatedAt = :now, completedAt = :now, #error = :err",
            ConditionExpression: "#status = :currentStatus",
            ExpressionAttributeNames: { "#status": "status", "#error": "error" },
            ExpressionAttributeValues: {
              ":failed": "failed",
              ":now": nowIso(),
              ":currentStatus": staleStatus,
              ":err": staleError
            }
          })
        );
        item.status = "failed";
        item.error = staleError;
      } catch (condErr: unknown) {
        // ConditionalCheckFailedException means another process already updated it — re-fetch
        if ((condErr as { name?: string }).name === "ConditionalCheckFailedException") {
          const refreshed = await ddb.send(
            new GetCommand({ TableName: sharedEnv.jobsTableName, Key: { projectId, jobId } })
          );
          if (refreshed.Item) {
            Object.assign(item, refreshed.Item);
          }
        }
      }
    }

    return json(200, {
      jobId: item.jobId,
      type: item.type,
      status: item.status,
      laneId: item.laneId,
      artifactId: item.artifactId,
      submittedAt: item.submittedAt,
      completedAt: item.completedAt,
      error: item.error,
      metrics: item.metrics
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function getArtifact(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    const artifactId = parsePathParam(event, "aid");
    await getProjectForUser({ userId, projectId });

    const response = await ddb.send(
      new GetCommand({
        TableName: sharedEnv.artifactsTableName,
        Key: {
          projectId,
          artifactId
        }
      })
    );

    const item = response.Item as ArtifactItem | undefined;
    if (!item) {
      throw new ApiError(404, {
        code: "NOT_FOUND",
        message: `Artifact '${artifactId}' was not found`
      });
    }

    const contentRaw = await getObjectText({
      bucket: sharedEnv.artifactsBucketName,
      key: item.s3Key
    });

    let content: unknown = contentRaw;
    try {
      content = JSON.parse(contentRaw);
    } catch {
      // Keep raw content as text when not JSON.
    }

    return json(200, {
      artifactId: item.artifactId,
      type: item.type,
      createdAt: item.createdAt,
      jobId: item.jobId,
      contentHash: item.contentHash,
      content
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function deleteProject(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    await getProjectForUser({ userId, projectId });

    const [lanes, jobs, artifacts] = await Promise.all([
      listProjectRows<LaneItem>({
        tableName: sharedEnv.lanesTableName,
        partitionKeyName: "projectId",
        partitionKeyValue: projectId
      }),
      listProjectRows<JobItem>({
        tableName: sharedEnv.jobsTableName,
        partitionKeyName: "projectId",
        partitionKeyValue: projectId
      }),
      listProjectRows<ArtifactItem>({
        tableName: sharedEnv.artifactsTableName,
        partitionKeyName: "projectId",
        partitionKeyValue: projectId
      })
    ]);

    for (const lane of lanes) {
      await ddb.send(
        new DeleteCommand({
          TableName: sharedEnv.lanesTableName,
          Key: {
            projectId,
            laneId: lane.laneId
          }
        })
      );
    }

    for (const job of jobs) {
      await ddb.send(
        new DeleteCommand({
          TableName: sharedEnv.jobsTableName,
          Key: {
            projectId,
            jobId: job.jobId
          }
        })
      );
    }

    for (const artifact of artifacts) {
      await ddb.send(
        new DeleteCommand({
          TableName: sharedEnv.artifactsTableName,
          Key: {
            projectId,
            artifactId: artifact.artifactId
          }
        })
      );
    }

    await ddb.send(
      new DeleteCommand({
        TableName: sharedEnv.projectsTableName,
        Key: {
          userId,
          projectId
        }
      })
    );

    const [deletedBlobObjects, deletedManifestObjects, deletedArtifactObjects] = await Promise.all([
      deletePrefix({ bucket: sharedEnv.blobsBucketName, prefix: `${projectId}/` }),
      deletePrefix({ bucket: sharedEnv.manifestsBucketName, prefix: `${projectId}/` }),
      deletePrefix({ bucket: sharedEnv.artifactsBucketName, prefix: `${projectId}/` })
    ]);

    return json(200, {
      deleted: true,
      counts: {
        lanes: lanes.length,
        jobs: jobs.length,
        artifacts: artifacts.length,
        blobObjects: deletedBlobObjects,
        manifestObjects: deletedManifestObjects,
        artifactObjects: deletedArtifactObjects
      }
    });
  } catch (error) {
    return toApiResponse(error);
  }
}
