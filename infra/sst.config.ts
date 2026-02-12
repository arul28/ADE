
function sanitizeStage(stage: string): string {
  return stage.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function isTruthy(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeHttpOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    return parsed.origin.replace(/\/+$/g, "");
  } catch {
    return "";
  }
}

function normalizeHttpUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    const normalizedPath = parsed.pathname.replace(/\/+$/g, "");
    const path = normalizedPath.length ? normalizedPath : "";
    return `${parsed.origin}${path}`;
  } catch {
    return "";
  }
}

function decodeBase64Url(value: string): string {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function deriveClerkFrontendApiFromPublishableKey(publishableKey: string): string {
  const trimmed = String(publishableKey ?? "").trim();
  const suffix = trimmed.replace(/^pk_(?:test|live)_/, "");
  if (!suffix || suffix === trimmed) return "";

  const decoded = decodeBase64Url(suffix);
  const host = decoded.split("$")[0]?.trim() ?? "";
  if (!host) return "";
  return normalizeHttpOrigin(host);
}

function resolveAwsProfile(): string {
  const explicit = process.env.AWS_PROFILE?.trim() || process.env.AWS_DEFAULT_PROFILE?.trim();
  if (explicit) return explicit;
  if ((process.env.ADE_AWS_PROFILE_FALLBACK ?? "").trim()) {
    return (process.env.ADE_AWS_PROFILE_FALLBACK as string).trim();
  }
  return "default";
}

export default $config({
  app(input: any) {
    const stage = sanitizeStage(input.stage ?? "dev");
    const region = process.env.ADE_AWS_REGION ?? "us-east-1";
    const accountId = process.env.ADE_ALLOWED_AWS_ACCOUNT_ID ?? "695094375923";
    const enableAwsDefaultTags = isTruthy(process.env.ADE_ENABLE_AWS_DEFAULT_TAGS);

    return {
      name: "ade",
      home: "aws",
      stage,
      removal: stage === "prod" ? "retain" : "remove",
      protect: stage === "prod",
      providers: {
        aws: {
          profile: resolveAwsProfile(),
          region,
          allowedAccountIds: [accountId],
          defaultTags: enableAwsDefaultTags
            ? {
                tags: {
                  project: "ade",
                  environment: stage,
                  "managed-by": "sst"
                }
              }
            : {
                tags: {}
              }
        }
      }
    };
  },
  async run() {
    const stage = sanitizeStage($app.stage);
    const region = aws.getRegionOutput().name;
    const caller = aws.getCallerIdentityOutput({});
    const clerkPublishableKey = new sst.Secret("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
    const clerkOauthClientId = new sst.Secret("CLERK_OAUTH_CLIENT_ID");
    const clerkFrontendApiOverride = normalizeHttpOrigin(process.env.ADE_CLERK_FRONTEND_API_URL ?? "");
    const resolveDerivedFrontendApi = (raw: unknown): string => {
      const derived = deriveClerkFrontendApiFromPublishableKey(String(raw ?? ""));
      if (!derived) {
        throw new Error(
          "Unable to resolve Clerk frontend API URL. Set ADE_CLERK_FRONTEND_API_URL or use a valid NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY secret."
        );
      }
      return derived;
    };
    const clerkFrontendApi = clerkFrontendApiOverride
      ? clerkFrontendApiOverride
      : typeof (clerkPublishableKey.value as any)?.apply === "function"
        ? (clerkPublishableKey.value as any).apply((raw: unknown) => resolveDerivedFrontendApi(raw))
        : resolveDerivedFrontendApi(clerkPublishableKey.value);

    const clerkIssuerOverride = normalizeHttpOrigin(process.env.ADE_CLERK_ISSUER ?? "");
    const clerkIssuer = clerkIssuerOverride || clerkFrontendApi;

    const clerkOauthMetadataOverride = normalizeHttpUrl(process.env.ADE_CLERK_OAUTH_METADATA_URL ?? "");
    const clerkOauthMetadataUrl = clerkOauthMetadataOverride || $interpolate`${clerkFrontendApi}/.well-known/openid-configuration`;
    const clerkOauthAuthorizeUrl = $interpolate`${clerkFrontendApi}/oauth/authorize`;
    const clerkOauthTokenUrl = $interpolate`${clerkFrontendApi}/oauth/token`;
    const clerkOauthRevocationUrl = $interpolate`${clerkFrontendApi}/oauth/revoke`;
    const clerkOauthUserInfoUrl = $interpolate`${clerkFrontendApi}/oauth/userinfo`;
    const clerkOauthScopes = (process.env.ADE_CLERK_OAUTH_SCOPES ?? "openid profile email offline_access").trim();

    const llmSecretName = `ade-${stage}-llm-provider`;
    const llmSecretResourceArn = $interpolate`arn:aws:secretsmanager:${region}:${caller.accountId}:secret:${llmSecretName}*`;

    const blobsBucket = new sst.aws.Bucket("Blobs", {
      versioning: false,
      transform: {
        bucket: (args: any) => {
          args.bucket = $interpolate`ade-${stage}-blobs-${caller.accountId}`;
        }
      }
    });

    const manifestsBucket = new sst.aws.Bucket("Manifests", {
      versioning: false,
      transform: {
        bucket: (args: any) => {
          args.bucket = $interpolate`ade-${stage}-manifests-${caller.accountId}`;
        }
      }
    });

    const artifactsBucket = new sst.aws.Bucket("Artifacts", {
      versioning: false,
      lifecycleRules: [
        {
          id: "artifact-expiry-30d",
          enabled: true,
          expiration: {
            days: 30
          }
        }
      ],
      transform: {
        bucket: (args: any) => {
          args.bucket = $interpolate`ade-${stage}-artifacts-${caller.accountId}`;
        }
      }
    });

    const projectsTable = new sst.aws.Dynamo("Projects", {
      fields: {
        userId: "string",
        projectId: "string"
      },
      primaryIndex: {
        hashKey: "userId",
        rangeKey: "projectId"
      },
      transform: {
        table: (args: any) => {
          args.name = `ade-${stage}-projects`;
        }
      }
    });

    const lanesTable = new sst.aws.Dynamo("Lanes", {
      fields: {
        projectId: "string",
        laneId: "string"
      },
      primaryIndex: {
        hashKey: "projectId",
        rangeKey: "laneId"
      },
      transform: {
        table: (args: any) => {
          args.name = `ade-${stage}-lanes`;
        }
      }
    });

    const jobsTable = new sst.aws.Dynamo("Jobs", {
      fields: {
        projectId: "string",
        jobId: "string",
        status: "string",
        submittedAt: "string"
      },
      primaryIndex: {
        hashKey: "projectId",
        rangeKey: "jobId"
      },
      globalIndexes: {
        statusIndex: {
          hashKey: "status",
          rangeKey: "submittedAt"
        }
      },
      transform: {
        table: (args: any) => {
          args.name = `ade-${stage}-jobs`;
        }
      }
    });

    const artifactsTable = new sst.aws.Dynamo("ArtifactIndex", {
      fields: {
        projectId: "string",
        artifactId: "string"
      },
      primaryIndex: {
        hashKey: "projectId",
        rangeKey: "artifactId"
      },
      ttl: "expiresAt",
      transform: {
        table: (args: any) => {
          args.name = `ade-${stage}-artifacts`;
        }
      }
    });

    const rateLimitsTable = new sst.aws.Dynamo("RateLimits", {
      fields: {
        userId: "string",
        windowKey: "string"
      },
      primaryIndex: {
        hashKey: "userId",
        rangeKey: "windowKey"
      },
      ttl: "expiresAt",
      transform: {
        table: (args: any) => {
          args.name = `ade-${stage}-rate-limits`;
        }
      }
    });

    const jobsDlq = new sst.aws.Queue("JobsDlq", {
      visibilityTimeout: "5 minutes",
      transform: {
        queue: (args: any) => {
          args.name = `ade-${stage}-jobs-dlq`;
        }
      }
    });

    const jobsQueue = new sst.aws.Queue("JobsQueue", {
      visibilityTimeout: "15 minutes",
      dlq: {
        queue: jobsDlq.arn,
        retry: 3
      },
      transform: {
        queue: (args: any) => {
          args.name = `ade-${stage}-jobs`;
        }
      }
    });

    const apiCorsOrigin = process.env.ADE_API_CORS_ORIGIN ?? "http://localhost:5173";

    const apiEnvironment = {
      APP_STAGE: stage,
      PROJECTS_TABLE_NAME: projectsTable.name,
      LANES_TABLE_NAME: lanesTable.name,
      JOBS_TABLE_NAME: jobsTable.name,
      ARTIFACTS_TABLE_NAME: artifactsTable.name,
      BLOBS_BUCKET_NAME: blobsBucket.name,
      MANIFESTS_BUCKET_NAME: manifestsBucket.name,
      ARTIFACTS_BUCKET_NAME: artifactsBucket.name,
      JOBS_QUEUE_URL: jobsQueue.url,
      API_CORS_ORIGIN: apiCorsOrigin,
      LLM_PROVIDER: process.env.ADE_LLM_PROVIDER ?? "mock",
      LLM_MODEL: process.env.ADE_LLM_MODEL ?? "claude-3-5-sonnet-latest",
      LLM_MAX_INPUT_TOKENS: process.env.ADE_LLM_MAX_INPUT_TOKENS ?? "200000",
      LLM_MAX_OUTPUT_TOKENS: process.env.ADE_LLM_MAX_OUTPUT_TOKENS ?? "4000",
      LLM_SECRET_ARN: llmSecretName,
      RATE_LIMITS_TABLE_NAME: rateLimitsTable.name,
      RATE_LIMIT_JOBS_PER_MINUTE: process.env.ADE_RATE_LIMIT_JOBS_PER_MINUTE ?? "20",
      RATE_LIMIT_DAILY_JOBS: process.env.ADE_RATE_LIMIT_DAILY_JOBS ?? "500",
      RATE_LIMIT_DAILY_ESTIMATED_TOKENS: process.env.ADE_RATE_LIMIT_DAILY_ESTIMATED_TOKENS ?? "250000"
    };

    const apiLinkedResources = [
      projectsTable,
      lanesTable,
      jobsTable,
      artifactsTable,
      rateLimitsTable,
      blobsBucket,
      manifestsBucket,
      artifactsBucket,
      jobsQueue
    ];

    const api = new sst.aws.ApiGatewayV2("Api", {
      cors: {
        allowOrigins: [apiCorsOrigin],
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: ["authorization", "content-type"],
        maxAge: "1 day"
      },
      transform: {
        api: (args: any) => {
          args.name = `ade-${stage}-api`;
        }
      }
    });

    const handlerDefaults = {
      timeout: "30 seconds",
      memory: "1024 MB",
      architecture: "arm64" as const,
      environment: apiEnvironment,
      link: apiLinkedResources
    };

    const protectedAuth = {
      jwt: {
        issuer: clerkIssuer,
        audiences: [clerkOauthClientId.value]
      }
    };

    api.route("OPTIONS /{proxy+}", {
      handler: "packages/functions/src/api/handlers.options",
      ...handlerDefaults
    });

    api.route("GET /health", {
      handler: "packages/functions/src/api/handlers.health",
      ...handlerDefaults
    });

    api.route("POST /projects", {
      handler: "packages/functions/src/api/handlers.createProject",
      ...handlerDefaults,
      auth: protectedAuth
    });

    api.route("GET /projects/{id}", {
      handler: "packages/functions/src/api/handlers.getProject",
      ...handlerDefaults,
      auth: protectedAuth
    });

    api.route("POST /projects/{id}/upload", {
      handler: "packages/functions/src/api/handlers.uploadBlobs",
      ...handlerDefaults,
      auth: protectedAuth
    });

    api.route("POST /projects/{id}/lanes/{lid}/manifest", {
      handler: "packages/functions/src/api/handlers.updateLaneManifest",
      ...handlerDefaults,
      auth: protectedAuth
    });

    api.route("POST /projects/{id}/jobs", {
      handler: "packages/functions/src/api/handlers.submitJob",
      ...handlerDefaults,
      auth: protectedAuth
    });

    api.route("GET /projects/{id}/jobs/{jid}", {
      handler: "packages/functions/src/api/handlers.getJob",
      ...handlerDefaults,
      auth: protectedAuth
    });

    api.route("GET /projects/{id}/artifacts/{aid}", {
      handler: "packages/functions/src/api/handlers.getArtifact",
      ...handlerDefaults,
      auth: protectedAuth
    });

    api.route("DELETE /projects/{id}", {
      handler: "packages/functions/src/api/handlers.deleteProject",
      ...handlerDefaults,
      auth: protectedAuth
    });

    const worker = jobsQueue.subscribe(
      {
        handler: "packages/functions/src/workers/jobWorker.handler",
        timeout: "15 minutes",
        memory: "2048 MB",
        architecture: "arm64",
        environment: {
          APP_STAGE: stage,
          PROJECTS_TABLE_NAME: projectsTable.name,
          LANES_TABLE_NAME: lanesTable.name,
          JOBS_TABLE_NAME: jobsTable.name,
          ARTIFACTS_TABLE_NAME: artifactsTable.name,
          BLOBS_BUCKET_NAME: blobsBucket.name,
          MANIFESTS_BUCKET_NAME: manifestsBucket.name,
          ARTIFACTS_BUCKET_NAME: artifactsBucket.name,
          LLM_PROVIDER: process.env.ADE_LLM_PROVIDER ?? "mock",
          LLM_MODEL: process.env.ADE_LLM_MODEL ?? "claude-3-5-sonnet-latest",
          LLM_MAX_INPUT_TOKENS: process.env.ADE_LLM_MAX_INPUT_TOKENS ?? "200000",
          LLM_MAX_OUTPUT_TOKENS: process.env.ADE_LLM_MAX_OUTPUT_TOKENS ?? "4000",
          LLM_SECRET_ARN: llmSecretName,
          RATE_LIMITS_TABLE_NAME: rateLimitsTable.name,
          RATE_LIMIT_JOBS_PER_MINUTE: process.env.ADE_RATE_LIMIT_JOBS_PER_MINUTE ?? "20",
          RATE_LIMIT_DAILY_JOBS: process.env.ADE_RATE_LIMIT_DAILY_JOBS ?? "500",
          RATE_LIMIT_DAILY_ESTIMATED_TOKENS: process.env.ADE_RATE_LIMIT_DAILY_ESTIMATED_TOKENS ?? "250000"
        },
        link: [
          jobsTable,
          artifactsTable,
          artifactsBucket
        ],
        permissions: [
          {
            actions: ["secretsmanager:GetSecretValue"],
            resources: [llmSecretResourceArn]
          }
        ]
      },
      {
        batch: {
          size: 1,
          window: "0 seconds"
        }
      }
    );

    const dlqAlarm = new aws.cloudwatch.MetricAlarm("JobsDlqVisibleAlarm", {
      alarmName: `ade-${stage}-jobs-dlq-visible`,
      alarmDescription: "ADE jobs dead-letter queue has visible messages.",
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      statistic: "Average",
      period: 60,
      evaluationPeriods: 1,
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      dimensions: {
        QueueName: jobsDlq.name
      }
    });

    const queueAgeAlarm = new aws.cloudwatch.MetricAlarm("JobsQueueAgeAlarm", {
      alarmName: `ade-${stage}-jobs-queue-age`,
      alarmDescription: "ADE jobs queue oldest message age is above 5 minutes.",
      namespace: "AWS/SQS",
      metricName: "ApproximateAgeOfOldestMessage",
      statistic: "Maximum",
      period: 60,
      evaluationPeriods: 3,
      threshold: 300,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      treatMissingData: "notBreaching",
      dimensions: {
        QueueName: jobsQueue.name
      }
    });

    return {
      stage,
      region,
      accountId: caller.accountId,
      apiUrl: api.url,
      apiId: api.id,
      clerk: {
        publishableKey: clerkPublishableKey.value,
        oauthClientId: clerkOauthClientId.value,
        issuer: clerkIssuer,
        frontendApiUrl: clerkFrontendApi,
        oauthMetadataUrl: clerkOauthMetadataUrl,
        oauthAuthorizeUrl: clerkOauthAuthorizeUrl,
        oauthTokenUrl: clerkOauthTokenUrl,
        oauthRevocationUrl: clerkOauthRevocationUrl,
        oauthUserInfoUrl: clerkOauthUserInfoUrl,
        oauthScopes: clerkOauthScopes
      },
      buckets: {
        blobs: blobsBucket.name,
        manifests: manifestsBucket.name,
        artifacts: artifactsBucket.name
      },
      tables: {
        projects: projectsTable.name,
        lanes: lanesTable.name,
        jobs: jobsTable.name,
        artifacts: artifactsTable.name,
        rateLimits: rateLimitsTable.name
      },
      queues: {
        jobs: jobsQueue.name,
        jobsUrl: jobsQueue.url,
        jobsDlq: jobsDlq.name
      },
      llmProviderSecretArn: llmSecretResourceArn,
      alarms: {
        jobsDlqVisible: dlqAlarm.arn,
        jobsQueueAge: queueAgeAlarm.arn
      },
      workers: {
        jobsWorker: worker.nodes.function.name
      }
    };
  }
});
