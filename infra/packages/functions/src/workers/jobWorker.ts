import { randomUUID, createHash } from "node:crypto";
import type { SQSHandler } from "aws-lambda";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { buildPromptTemplate } from "../../../core/src/prompts";
import { runLlmGateway } from "../../../core/src/llmGateway";
import type { HostedJobType, JobArtifact, JobPayload, LlmGatewayConfig, LlmProvider } from "../../../core/src/types";
import { ddb, nowIso, secretsManager } from "../common/awsClients";
import { sharedEnv } from "../common/env";
import { parseJobMessage } from "../common/jobs";
import { putObject } from "../common/storage";

type LlmSecretPayload = {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  defaultProvider?: LlmProvider;
  defaultModel?: string;
};

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
      UpdateExpression: "set #status = :status, updatedAt = :updatedAt, completedAt = :completedAt, artifactId = :artifactId, #error = :error, metrics = :metrics",
      ExpressionAttributeNames: {
        "#status": "status",
        "#error": "error"
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
      const prompt = buildPromptTemplate(job);
      const gatewayConfig = buildGatewayConfig(job, secrets);
      const result = await runLlmGateway({
        job,
        prompt,
        config: gatewayConfig
      });

      const artifactType = inferArtifactType(job.type);
      const artifactId = randomUUID();
      const createdAt = nowIso();
      const expiresAt = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);

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
          generatedAt: createdAt
        }
      };

      const artifactBody = JSON.stringify(artifact, null, 2);
      const contentHash = createHash("sha256").update(artifactBody).digest("hex");
      const s3Key = `${job.projectId}/${artifactId}.json`;

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
            projectId: job.projectId,
            artifactId,
            jobId: job.jobId,
            type: artifactType,
            s3Key,
            contentHash,
            createdAt,
            expiresAt
          }
        })
      );

      await updateJob({
        projectId: job.projectId,
        jobId: job.jobId,
        status: "completed",
        updatedAt: nowIso(),
        completedAt: nowIso(),
        artifactId,
        metrics: {
          provider: result.provider,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          latencyMs: result.latencyMs,
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
          latencyMs: result.latencyMs
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
