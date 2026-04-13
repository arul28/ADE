import path from "node:path";

export type AdePathEntryDefinition = {
  relativePath: string;
  kind: "tracked" | "ignored";
  pathType: "file" | "directory";
  notes?: string[];
};

export type AdeLayoutPaths = {
  projectRoot: string;
  adeDir: string;
  sharedConfigPath: string;
  localConfigPath: string;
  secretConfigPath: string;
  ctoDir: string;
  agentsDir: string;
  templatesDir: string;
  workflowsDir: string;
  linearWorkflowsDir: string;
  contextDir: string;
  memoryDir: string;
  historyDir: string;
  reflectionsDir: string;
  skillsDir: string;
  cacheDir: string;
  tmpDir: string;
  artifactsDir: string;
  transcriptsDir: string;
  worktreesDir: string;
  secretsDir: string;
  dbPath: string;
  embeddingsPath: string;
  socketPath: string;
  apiKeysPath: string;
  legacyApiKeysPath: string;
  logsDir: string;
  processLogsDir: string;
  testLogsDir: string;
  packsDir: string;
  logBundlesDir: string;
  chatSessionsDir: string;
  chatTranscriptsDir: string;
  orchestratorCacheDir: string;
  orchestratorContextsDir: string;
  mcpContextDir: string;
  mcpConfigsDir: string;
  workerPromptsDir: string;
  missionStateDir: string;
  githubSecretsDir: string;
};

export const ADE_LAYOUT_DEFINITIONS: AdePathEntryDefinition[] = [
  { relativePath: ".gitignore", kind: "tracked", pathType: "file" },
  { relativePath: "ade.yaml", kind: "tracked", pathType: "file" },
  { relativePath: "cto", kind: "tracked", pathType: "directory" },
  { relativePath: "templates", kind: "tracked", pathType: "directory" },
  { relativePath: "skills", kind: "tracked", pathType: "directory" },
  { relativePath: "workflows", kind: "tracked", pathType: "directory", notes: ["Repo-backed workflow/config files live here when present."] },
  { relativePath: "workflows/linear", kind: "tracked", pathType: "directory", notes: ["Stable Linear workflow definitions are tracked when authored."] },
  { relativePath: "agents", kind: "ignored", pathType: "directory" },
  { relativePath: "context", kind: "ignored", pathType: "directory" },
  { relativePath: "memory", kind: "ignored", pathType: "directory" },
  { relativePath: "history", kind: "ignored", pathType: "directory" },
  { relativePath: "reflections", kind: "ignored", pathType: "directory" },
  { relativePath: "local.yaml", kind: "ignored", pathType: "file" },
  { relativePath: "local.secret.yaml", kind: "ignored", pathType: "file" },
  { relativePath: "ade.db", kind: "ignored", pathType: "file" },
  { relativePath: "embeddings.db", kind: "ignored", pathType: "file" },
  { relativePath: "mcp.sock", kind: "ignored", pathType: "file" },
  { relativePath: "artifacts", kind: "ignored", pathType: "directory" },
  { relativePath: "transcripts", kind: "ignored", pathType: "directory" },
  { relativePath: "cache", kind: "ignored", pathType: "directory" },
  { relativePath: "worktrees", kind: "ignored", pathType: "directory" },
  { relativePath: "secrets", kind: "ignored", pathType: "directory" },
];

const _layoutCache = new Map<string, AdeLayoutPaths>();

export function resolveAdeLayout(projectRoot: string): AdeLayoutPaths {
  const cached = _layoutCache.get(projectRoot);
  if (cached) return cached;
  const adeDir = path.join(projectRoot, ".ade");
  const cacheDir = path.join(adeDir, "cache");
  const tmpDir = path.join(cacheDir, "tmp");
  const artifactsDir = path.join(adeDir, "artifacts");
  const transcriptsDir = path.join(adeDir, "transcripts");
  const worktreesDir = path.join(adeDir, "worktrees");
  const secretsDir = path.join(adeDir, "secrets");
  const logsDir = path.join(transcriptsDir, "logs");
  const orchestratorCacheDir = path.join(cacheDir, "orchestrator");
  const result: AdeLayoutPaths = {
    projectRoot,
    adeDir,
    sharedConfigPath: path.join(adeDir, "ade.yaml"),
    localConfigPath: path.join(adeDir, "local.yaml"),
    secretConfigPath: path.join(adeDir, "local.secret.yaml"),
    ctoDir: path.join(adeDir, "cto"),
    agentsDir: path.join(adeDir, "agents"),
    templatesDir: path.join(adeDir, "templates"),
    workflowsDir: path.join(adeDir, "workflows"),
    linearWorkflowsDir: path.join(adeDir, "workflows", "linear"),
    contextDir: path.join(adeDir, "context"),
    memoryDir: path.join(adeDir, "memory"),
    historyDir: path.join(adeDir, "history"),
    reflectionsDir: path.join(adeDir, "reflections"),
    skillsDir: path.join(adeDir, "skills"),
    cacheDir,
    tmpDir,
    artifactsDir,
    transcriptsDir,
    worktreesDir,
    secretsDir,
    dbPath: path.join(adeDir, "ade.db"),
    embeddingsPath: path.join(adeDir, "embeddings.db"),
    socketPath: path.join(adeDir, "mcp.sock"),
    apiKeysPath: path.join(secretsDir, "api-keys.v1.bin"),
    legacyApiKeysPath: path.join(secretsDir, "api-keys.json"),
    logsDir,
    processLogsDir: path.join(logsDir, "processes"),
    testLogsDir: path.join(logsDir, "tests"),
    packsDir: path.join(artifactsDir, "packs"),
    logBundlesDir: path.join(artifactsDir, "log-bundles"),
    chatSessionsDir: path.join(cacheDir, "chat-sessions"),
    chatTranscriptsDir: path.join(transcriptsDir, "chat"),
    orchestratorCacheDir,
    orchestratorContextsDir: path.join(orchestratorCacheDir, "contexts"),
    mcpContextDir: path.join(orchestratorCacheDir, "mcp-context"),
    mcpConfigsDir: path.join(orchestratorCacheDir, "mcp-configs"),
    workerPromptsDir: path.join(orchestratorCacheDir, "worker-prompts"),
    missionStateDir: path.join(cacheDir, "mission-state"),
    githubSecretsDir: path.join(secretsDir, "github"),
  };
  _layoutCache.set(projectRoot, result);
  return result;
}

export function buildAdeGitignore(): string {
  return [
    "# Machine-local ADE state",
    "local.yaml",
    "local.secret.yaml",
    "ade.db",
    "ade.db-*",
    "ade.db-wal",
    "embeddings.db",
    "mcp.sock",
    "artifacts/",
    "transcripts/",
    "cache/",
    "worktrees/",
    "secrets/",
    "",
    "# Local-only generated runtime docs/state",
    "agents/",
    "cto/CURRENT.md",
    "cto/MEMORY.md",
    "cto/core-memory.json",
    "cto/daily/",
    "cto/sessions.jsonl",
    "cto/subordinate-activity.jsonl",
    "cto/openclaw-history.json",
    "cto/openclaw-idempotency.json",
    "cto/openclaw-outbox.json",
    "cto/openclaw-routes.json",
    "cto/openclaw-device.json",
    "context/",
    "memory/",
    "history/",
    "reflections/",
    "context/*.ade.md",
    "",
  ].join("\n");
}
