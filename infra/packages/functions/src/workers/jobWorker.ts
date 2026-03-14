import { randomUUID, createHash } from "node:crypto";
import type { SQSHandler } from "aws-lambda";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { resolveContextParams } from "../../../core/src/contextResolution";
import { buildPromptTemplate } from "../../../core/src/prompts";
import { runLlmGateway } from "../../../core/src/llmGateway";
import type { HostedJobType, JobArtifact, JobPayload, LlmGatewayConfig, LlmProvider } from "../../../core/src/types";
import { ddb, nowIso, secretsManager } from "../common/awsClients";
import { sharedEnv } from "../common/env";
import { parseJobMessage } from "../common/jobs";
import { getObjectText, putObject } from "../common/storage";

type LlmSecretPayload = {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  defaultProvider?: LlmProvider;
  defaultModel?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function resolveJobParams(job: JobPayload): Promise<{
  params: Record<string, unknown>;
  source: "inline" | "mirror" | "inline_fallback";
  warnings: string[];
}> {
  const raw = isRecord(job.params) ? (job.params as Record<string, unknown>) : {};
  const refRaw = raw.__adeContextRef;
  const sha256 = isRecord(refRaw) && typeof refRaw.sha256 === "string" ? refRaw.sha256.trim() : "";
  const resolved = await resolveContextParams({
    params: raw,
    fetchContextRef: async (hash) => {
      const text = await getObjectText({
        bucket: sharedEnv.blobsBucketName,
        key: `${job.projectId}/${hash}`
      });
      return JSON.parse(text) as unknown;
    }
  });
  const failedWarning = resolved.warnings.find((warning) => warning.startsWith("context_ref_fetch_failed:"));
  if (failedWarning && sha256) {
    console.warn(
      JSON.stringify({
        event: "job.context_ref_failed",
        projectId: job.projectId,
        jobId: job.jobId,
        sha256,
        error: failedWarning.slice("context_ref_fetch_failed:".length)
      })
    );
  }
  return resolved;
}

let cachedSecrets: LlmSecretPayload | null = null;
let cachedSecretsAt = 0;

function parseLlmSecret(raw: string): LlmSecretPayload {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      openaiApiKey: typeof parsed.openaiApiKey === "string" ? parsed.openaiApiKey : undefined,
      anthropicApiKey: typeof parsed.anthropicApiKey === "string" ? parsed.anthropicApiKey : undefined,
      geminiApiKey: typeof parsed.geminiApiKey === "string" ? parsed.geminiApiKey : undefined,
      defaultProvider: typeof parsed.defaultProvider === "string" ? parsed.defaultProvider as LlmProvider : undefined,
      defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : undefined
    };
  } catch {
    return {};
  }
}

async function getLlmSecrets(): Promise<LlmSecretPayload> {
  if (!sharedEnv.llmSecretArn) return {};

  const now = Date.now();
  if (cachedSecrets && now - cachedSecretsAt < 60_000) {
    return cachedSecrets;
  }

  const response = await secretsManager.send(
    new GetSecretValueCommand({
      SecretId: sharedEnv.llmSecretArn
    })
  );

  const payload = parseLlmSecret(response.SecretString ?? "{}");
  cachedSecrets = payload;
  cachedSecretsAt = now;
  return payload;
}

function parseConfidence(text: string): number | undefined {
  const match = text.match(/confidence\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)(%?)/i);
  if (!match) return undefined;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw)) return undefined;
  const isPercent = match[2] === "%";
  const confidence = isPercent ? raw / 100 : raw;
  if (confidence < 0 || confidence > 1) return undefined;
  return confidence;
}

function inferArtifactType(jobType: HostedJobType): JobArtifact["artifactType"] {
  if (jobType === "NarrativeGeneration") return "narrative";
  if (jobType === "DraftPrDescription") return "pr-description";
  return "diff";
}

function readConflictContext(params: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(params.conflictContext)) return params.conflictContext;
  return params;
}

function evaluateInsufficientConflictContext(job: JobPayload, params: Record<string, unknown>): {
  insufficient: boolean;
  reasons: string[];
} {
  if (job.type !== "ConflictResolution" && job.type !== "ProposeConflictResolution") {
    return { insufficient: false, reasons: [] };
  }

  const conflictContext = readConflictContext(params);
  const reasons: string[] = [];
  if (Boolean(conflictContext.insufficientContext)) {
    reasons.push("insufficient_context_flagged");
  }

  const relevantFiles = Array.isArray(conflictContext.relevantFilesForConflict)
    ? conflictContext.relevantFilesForConflict
    : [];
  const fileContexts = Array.isArray(conflictContext.fileContexts) ? conflictContext.fileContexts : [];
  if (relevantFiles.length === 0) reasons.push("relevant_files_missing");
  if (relevantFiles.length > 0 && fileContexts.length === 0) reasons.push("file_contexts_missing");
  if (relevantFiles.length > 0 && fileContexts.length < relevantFiles.length) reasons.push("file_contexts_incomplete");
  if (Boolean(conflictContext.fileContextsMissing)) reasons.push("file_contexts_missing_flag");

  const insufficient = reasons.length > 0;
  return {
    insufficient,
    reasons
  };
}

async function persistArtifact(args: {
  job: JobPayload;
  artifact: JobArtifact;
}): Promise<{ artifactId: string; contentHash: string }> {
  const artifactId = randomUUID();
  const createdAt = nowIso();
  const expiresAt = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
  const artifactBody = JSON.stringify(args.artifact, null, 2);
  const contentHash = createHash("sha256").update(artifactBody).digest("hex");
  const s3Key = `${args.job.projectId}/${artifactId}.json`;

  await putObject({
    bucket: sharedEnv.artifactsBucketName,
    key: s3Key,
    body: artifactBody,
    contentType: "application/json"
  });

  await ddb.send(
    new PutCommand({
      TableName: sharedEnv.artifactsTableName,
      Item: {
        projectId: args.job.projectId,
        artifactId,
        jobId: args.job.jobId,
        type: args.artifact.artifactType,
        s3Key,
        contentHash,
        createdAt,
        expiresAt
      }
    })
  );

  return { artifactId, contentHash };
}

async function updateJob(args: {
  projectId: string;
  jobId: string;
  status: "processing" | "completed" | "failed";
  updatedAt: string;
  completedAt?: string;
  artifactId?: string;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  metrics?: Record<string, unknown>;
}) {
  await ddb.send(
    new UpdateCommand({
      TableName: sharedEnv.jobsTableName,
      Key: {
        projectId: args.projectId,
        jobId: args.jobId
      },
      // DynamoDB reserves certain attribute names; alias anything that might collide.
      UpdateExpression:
        "set #status = :status, updatedAt = :updatedAt, completedAt = :completedAt, artifactId = :artifactId, #error = :error, #metrics = :metrics",
      ExpressionAttributeNames: {
        "#status": "status",
        "#error": "error",
        "#metrics": "metrics"
      },
      ExpressionAttributeValues: {
        ":status": args.status,
        ":updatedAt": args.updatedAt,
        ":completedAt": args.completedAt ?? null,
        ":artifactId": args.artifactId ?? null,
        ":error": args.error ?? null,
        ":metrics": args.metrics ?? null
      }
    })
  );
}

function buildGatewayConfig(job: JobPayload, secrets: LlmSecretPayload): LlmGatewayConfig {
  const paramsProvider = typeof job.params.provider === "string" ? job.params.provider as LlmProvider : undefined;
  const paramsModel = typeof job.params.model === "string" ? job.params.model : undefined;

  const provider = paramsProvider ?? secrets.defaultProvider ?? sharedEnv.llmProvider;
  const model = paramsModel ?? secrets.defaultModel ?? sharedEnv.llmModel;

  return {
    provider,
    model,
    maxInputTokens: sharedEnv.llmMaxInputTokens,
    maxOutputTokens: sharedEnv.llmMaxOutputTokens,
    openaiApiKey: secrets.openaiApiKey,
    anthropicApiKey: secrets.anthropicApiKey,
    geminiApiKey: secrets.geminiApiKey
  };
}

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const job = parseJobMessage(record.body);
    const startedAt = Date.now();
    const processingAt = nowIso();

    await updateJob({
      projectId: job.projectId,
      jobId: job.jobId,
      status: "processing",
      updatedAt: processingAt
    });

    try {
      const secrets = await getLlmSecrets();
      const resolved = await resolveJobParams(job);
      const insufficiency = evaluateInsufficientConflictContext(job, resolved.params);
      if (insufficiency.insufficient) {
        const insufficientContent = [
          "## ResolutionStrategy",
          "Cannot generate a safe conflict patch due to insufficient context.",
          "",
          "## RelevantEvidence",
          "- Context source: worker pre-check",
          `- Missing signals: ${insufficiency.reasons.join(", ") || "unknown"}`,
          "",
          "## Scope",
          "No safe patch scope could be validated.",
          "",
          "## Patch",
          "```diff",
          "",
          "```",
          "",
          "## Confidence",
          "low",
          "",
          "## Assumptions",
          "- A full base/left/right context is required for reliable patching.",
          "",
          "## Unknowns",
          ...insufficiency.reasons.map((reason) => `- ${reason}`),
          "",
          "## InsufficientContext",
          "true"
        ].join("\n");
        const artifact: JobArtifact = {
          artifactType: "diff",
          content: insufficientContent,
          confidence: 0,
          metadata: {
            provider: "system",
            model: "insufficient-context-guard",
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            generatedAt: nowIso()
          }
        };
        const persisted = await persistArtifact({ job, artifact });
        await updateJob({
          projectId: job.projectId,
          jobId: job.jobId,
          status: "completed",
          updatedAt: nowIso(),
          completedAt: nowIso(),
          artifactId: persisted.artifactId,
          metrics: {
            provider: "system",
            model: "insufficient-context-guard",
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            contextSource: resolved.source,
            contextWarnings: resolved.warnings,
            insufficientContext: true,
            insufficientReasons: insufficiency.reasons,
            totalLatencyMs: Date.now() - startedAt
          }
        });
        console.log(
          JSON.stringify({
            event: "job.completed.insufficient_context",
            stage: sharedEnv.appStage,
            projectId: job.projectId,
            jobId: job.jobId,
            type: job.type,
            contextSource: resolved.source,
            reasons: insufficiency.reasons
          })
        );
        continue;
      }

      const prompt = buildPromptTemplate({ ...job, params: resolved.params });
      const gatewayConfig = buildGatewayConfig(job, secrets);
      const result = await runLlmGateway({
        job,
        prompt,
        config: gatewayConfig
      });

      const artifactType = inferArtifactType(job.type);
      const artifact: JobArtifact = {
        artifactType,
        content: result.text,
        confidence: parseConfidence(result.text),
        metadata: {
          provider: result.provider,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          latencyMs: result.latencyMs,
          generatedAt: nowIso()
        }
      };

      const persisted = await persistArtifact({ job, artifact });

      await updateJob({
        projectId: job.projectId,
        jobId: job.jobId,
        status: "completed",
        updatedAt: nowIso(),
        completedAt: nowIso(),
        artifactId: persisted.artifactId,
        metrics: {
          provider: result.provider,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          latencyMs: result.latencyMs,
          contextSource: resolved.source,
          contextWarnings: resolved.warnings,
          totalLatencyMs: Date.now() - startedAt
        }
      });

      console.log(
        JSON.stringify({
          event: "job.completed",
          stage: sharedEnv.appStage,
          projectId: job.projectId,
          jobId: job.jobId,
          type: job.type,
          artifactType,
          provider: result.provider,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          latencyMs: result.latencyMs,
          contextSource: resolved.source,
          contextWarnings: resolved.warnings
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateJob({
        projectId: job.projectId,
        jobId: job.jobId,
        status: "failed",
        updatedAt: nowIso(),
        completedAt: nowIso(),
        error: {
          code: "WORKER_ERROR",
          message
        }
      });

      console.error(
        JSON.stringify({
          event: "job.failed",
          stage: sharedEnv.appStage,
          projectId: job.projectId,
          jobId: job.jobId,
          type: job.type,
          error: message
        })
      );

      throw error;
    }
  }
};
