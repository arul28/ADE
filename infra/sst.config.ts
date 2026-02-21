/// <reference path="./.sst/platform/config.d.ts" />

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
    const defaultTags = enableAwsDefaultTags
      ? {
          tags: {
            project: "ade",
            environment: stage,
            "managed-by": "sst"
          }
        }
      : undefined;

    return {
      name: "ade",
      home: "aws",
      stage,
      removal: stage === "prod" ? "retain" : "remove",
      protect: stage === "prod",
      providers: {
        aws: {
          profile: resolveAwsProfile(),
          // Pulumi's Region type is a string union; env vars are untyped.
          region: region as any,
          ...(defaultTags ? { defaultTags } : {})
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

    // GitHub App secrets (used by Phase 7A GitHub integration).
    // These are passed into the API as plain env vars consumed by the Lambda runtime.
    const githubAppId = new sst.Secret("ADE_GITHUB_APP_ID");
    const githubAppSlug = new sst.Secret("ADE_GITHUB_APP_SLUG");
    const githubAppPrivateKeyBase64 = new sst.Secret("ADE_GITHUB_APP_PRIVATE_KEY_BASE64");
    const githubWebhookSecret = new sst.Secret("ADE_GITHUB_WEBHOOK_SECRET");

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
	      transform: {
	        bucket: (args: any) => {
	          args.bucket = $interpolate`ade-${stage}-artifacts-${caller.accountId}`;
	          args.lifecycleRules = [
	            {
	              id: "artifact-expiry-30d",
	              enabled: true,
	              expirations: [
	                {
	                  days: 30
	                }
	              ]
	            }
	          ];
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
      ttl: "expiresAt",
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

    const githubConnectStatesTable = new sst.aws.Dynamo("GitHubConnectStates", {
      fields: {
        state: "string"
      },
      primaryIndex: {
        hashKey: "state"
      },
      ttl: "expiresAt",
      transform: {
        table: (args: any) => {
          args.name = `ade-${stage}-github-connect-states`;
        }
      }
    });

    const githubInstallationsTable = new sst.aws.Dynamo("GitHubInstallations", {
      fields: {
        installationId: "string",
        projectId: "string"
      },
      primaryIndex: {
        hashKey: "installationId",
        rangeKey: "projectId"
      },
      transform: {
        table: (args: any) => {
          args.name = `ade-${stage}-github-installations`;
        }
      }
    });

    const githubEventsTable = new sst.aws.Dynamo("GitHubEvents", {
      fields: {
        projectId: "string",
        eventId: "string"
      },
      primaryIndex: {
        hashKey: "projectId",
        rangeKey: "eventId"
      },
      ttl: "expiresAt",
      transform: {
        table: (args: any) => {
          args.name = `ade-${stage}-github-events`;
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
      API_VERSION: process.env.ADE_API_VERSION ?? "0.1.0",
      PROJECTS_TABLE_NAME: projectsTable.name,
      LANES_TABLE_NAME: lanesTable.name,
      JOBS_TABLE_NAME: jobsTable.name,
      ARTIFACTS_TABLE_NAME: artifactsTable.name,
      BLOBS_BUCKET_NAME: blobsBucket.name,
      MANIFESTS_BUCKET_NAME: manifestsBucket.name,
      ARTIFACTS_BUCKET_NAME: artifactsBucket.name,
      JOBS_QUEUE_URL: jobsQueue.url,
      API_CORS_ORIGIN: apiCorsOrigin,
      LLM_PROVIDER: process.env.ADE_LLM_PROVIDER ?? "gemini",
      LLM_MODEL: process.env.ADE_LLM_MODEL ?? "gemini-3-flash-preview",
      LLM_MAX_INPUT_TOKENS: process.env.ADE_LLM_MAX_INPUT_TOKENS ?? "200000",
      LLM_MAX_OUTPUT_TOKENS: process.env.ADE_LLM_MAX_OUTPUT_TOKENS ?? "4000",
      LLM_SECRET_ARN: llmSecretName,
      RATE_LIMITS_TABLE_NAME: rateLimitsTable.name,
      RATE_LIMIT_JOBS_PER_MINUTE: process.env.ADE_RATE_LIMIT_JOBS_PER_MINUTE ?? "20",
      RATE_LIMIT_DAILY_JOBS: process.env.ADE_RATE_LIMIT_DAILY_JOBS ?? "500",
      RATE_LIMIT_DAILY_ESTIMATED_TOKENS: process.env.ADE_RATE_LIMIT_DAILY_ESTIMATED_TOKENS ?? "250000",
      GITHUB_CONNECT_STATES_TABLE_NAME: githubConnectStatesTable.name,
      GITHUB_INSTALLATIONS_TABLE_NAME: githubInstallationsTable.name,
      GITHUB_EVENTS_TABLE_NAME: githubEventsTable.name,
      GITHUB_APP_ID: githubAppId.value,
      GITHUB_APP_SLUG: githubAppSlug.value,
      GITHUB_APP_PRIVATE_KEY_BASE64: githubAppPrivateKeyBase64.value,
      GITHUB_WEBHOOK_SECRET: githubWebhookSecret.value
    };

    const apiLinkedResources = [
      projectsTable,
      lanesTable,
      jobsTable,
      artifactsTable,
      rateLimitsTable,
      githubConnectStatesTable,
      githubInstallationsTable,
      githubEventsTable,
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
        },
        route: {
          handler: {
            timeout: "30 seconds",
            memory: "1024 MB",
            architecture: "arm64" as const,
            environment: apiEnvironment,
            link: apiLinkedResources
          }
        }
      }
    });

    const clerkJwtAuthorizer = api.addAuthorizer({
      name: "clerkJwt",
      jwt: {
        issuer: clerkIssuer,
        audiences: [clerkOauthClientId.value]
      }
    });

    const protectedAuth = {
      jwt: {
        authorizer: clerkJwtAuthorizer.id
      }
    };

    api.route("OPTIONS /{proxy+}", "packages/functions/src/api/handlers.options");

    api.route("GET /api/health", "packages/functions/src/api/handlers.apiHealth");

    api.route("GET /health", "packages/functions/src/api/handlers.health");

    api.route("POST /projects", "packages/functions/src/api/handlers.createProject", {
      auth: protectedAuth
    });

    api.route("GET /projects/{id}", "packages/functions/src/api/handlers.getProject", {
      auth: protectedAuth
    });

    api.route("POST /projects/{id}/upload", "packages/functions/src/api/handlers.uploadBlobs", {
      auth: protectedAuth
    });

    api.route("POST /projects/{id}/jobs", "packages/functions/src/api/handlers.submitJob", {
      auth: protectedAuth
    });

    api.route("GET /projects/{id}/jobs/{jid}", "packages/functions/src/api/handlers.getJob", {
      auth: protectedAuth
    });

    api.route("GET /projects/{id}/artifacts/{aid}", "packages/functions/src/api/handlers.getArtifact", {
      auth: protectedAuth
    });

    api.route("DELETE /projects/{id}", "packages/functions/src/api/handlers.deleteProject", {
      auth: protectedAuth
    });

    api.route("POST /projects/{id}/github/connect/start", "packages/functions/src/api/github.connectStart", {
      auth: protectedAuth
    });

    api.route("GET /projects/{id}/github/status", "packages/functions/src/api/github.getStatus", {
      auth: protectedAuth
    });

    api.route("POST /projects/{id}/github/disconnect", "packages/functions/src/api/github.disconnect", {
      auth: protectedAuth
    });

    api.route("POST /projects/{id}/github/api", "packages/functions/src/api/github.proxy", {
      auth: protectedAuth
    });

    api.route("GET /projects/{id}/github/events", "packages/functions/src/api/github.listEvents", {
      auth: protectedAuth
    });

    // Webhooks + setup callbacks originate from GitHub, not the desktop client.
    api.route("GET /github/connect/callback", "packages/functions/src/api/github.connectCallback");
    api.route("POST /github/webhooks", "packages/functions/src/api/github.webhook");

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
          LLM_PROVIDER: process.env.ADE_LLM_PROVIDER ?? "gemini",
          LLM_MODEL: process.env.ADE_LLM_MODEL ?? "gemini-3-flash-preview",
          LLM_MAX_INPUT_TOKENS: process.env.ADE_LLM_MAX_INPUT_TOKENS ?? "200000",
          LLM_MAX_OUTPUT_TOKENS: process.env.ADE_LLM_MAX_OUTPUT_TOKENS ?? "4000",
          LLM_SECRET_ARN: llmSecretName,
          RATE_LIMITS_TABLE_NAME: rateLimitsTable.name,
          RATE_LIMIT_JOBS_PER_MINUTE: process.env.ADE_RATE_LIMIT_JOBS_PER_MINUTE ?? "20",
          RATE_LIMIT_DAILY_JOBS: process.env.ADE_RATE_LIMIT_DAILY_JOBS ?? "500",
          RATE_LIMIT_DAILY_ESTIMATED_TOKENS: process.env.ADE_RATE_LIMIT_DAILY_ESTIMATED_TOKENS ?? "250000",

          // Keep worker env aligned with shared env requirements (api + worker share env parsing).
          // Missing these can crash SST dev/deploy during cold start even if a given job type doesn't use GitHub features.
          GITHUB_CONNECT_STATES_TABLE_NAME: githubConnectStatesTable.name,
          GITHUB_INSTALLATIONS_TABLE_NAME: githubInstallationsTable.name,
          GITHUB_EVENTS_TABLE_NAME: githubEventsTable.name,
          GITHUB_APP_ID: githubAppId.value,
          GITHUB_APP_SLUG: githubAppSlug.value,
          GITHUB_APP_PRIVATE_KEY_BASE64: githubAppPrivateKeyBase64.value,
          GITHUB_WEBHOOK_SECRET: githubWebhookSecret.value
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

    const jobSweeper = new sst.aws.Cron("JobSweeper", {
      schedule: "rate(15 minutes)",
      job: {
        handler: "packages/functions/src/workers/jobSweeper.handler",
        timeout: "60 seconds",
        memory: "256 MB",
        architecture: "arm64",
        environment: {
          APP_STAGE: stage,
          JOBS_TABLE_NAME: jobsTable.name
        },
        link: [jobsTable]
      }
    });

	    const dlqAlarm = new aws.cloudwatch.MetricAlarm("JobsDlqVisibleAlarm", {
	      name: `ade-${stage}-jobs-dlq-visible`,
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
	        QueueName: jobsDlq.nodes.queue.name
	      }
	    });

	    const queueAgeAlarm = new aws.cloudwatch.MetricAlarm("JobsQueueAgeAlarm", {
	      name: `ade-${stage}-jobs-queue-age`,
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
	        QueueName: jobsQueue.nodes.queue.name
	      }
	    });

	    return {
      stage,
      region,
	      accountId: caller.accountId,
	      apiUrl: api.url,
	      apiId: api.nodes.api.id,
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
	        jobs: jobsQueue.nodes.queue.name,
	        jobsUrl: jobsQueue.url,
	        jobsDlq: jobsDlq.nodes.queue.name
	      },
      llmProviderSecretArn: llmSecretResourceArn,
      alarms: {
        jobsDlqVisible: dlqAlarm.arn,
        jobsQueueAge: queueAgeAlarm.arn
      },
      workers: {
        jobsWorker: worker.nodes.function.name,
        jobSweeper: jobSweeper.nodes.job.name
      }
    };
  }
});
