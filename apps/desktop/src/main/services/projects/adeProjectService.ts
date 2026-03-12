import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { AdeDb } from "../state/kvDb";
import type {
  AdeCleanupResult,
  AdeHealthIssue,
  AdePathEntry,
  AdeProjectSnapshot,
  AdeSyncAction,
} from "../../../shared/types";
import { buildAdeGitignore, ADE_LAYOUT_DEFINITIONS, resolveAdeLayout, type AdeLayoutPaths } from "../../../shared/adeLayout";
import type { Logger } from "../logging/logger";
import { createLogIntegrityService, type LogIntegrityService } from "./logIntegrityService";

type RepairOptions = {
  logger?: Logger | null;
};

type AdeProjectServiceArgs = {
  projectRoot: string;
  db: AdeDb;
  projectId: string;
  logger?: Logger | null;
  projectConfigService: {
    get: () => {
      validation: { ok: boolean; issues: { path: string; message: string }[] };
      trust?: {
        sharedHash: string;
        localHash: string;
        approvedSharedHash?: string | null;
        requiresSharedTrust: boolean;
      };
    };
  };
  ctoStateService?: { getSnapshot?: () => unknown } | null;
  workerAgentService?: { listAgents?: () => unknown[] } | null;
};

const SECRET_PATTERNS: Array<{ code: string; regex: RegExp; message: string }> = [
  { code: "openai-key", regex: /\bsk-[A-Za-z0-9]{20,}\b/, message: "Possible OpenAI-style API key found in a tracked file." },
  { code: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, message: "Possible GitHub token found in a tracked file." },
  { code: "bearer-token", regex: /Bearer\s+[A-Za-z0-9._-]{20,}/, message: "Possible bearer token found in a tracked file." },
];

function walkFiles(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) return [];
  const stat = fs.statSync(rootPath);
  if (stat.isFile()) return [rootPath];
  if (!stat.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    out.push(...walkFiles(path.join(rootPath, entry.name)));
  }
  return out;
}

function validateJsonDocument(filePath: string, requiredKeys: string[]): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "Expected a JSON object.";
    for (const key of requiredKeys) {
      if (!(key in parsed)) return `Missing required key '${key}'.`;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function validateYamlDocument(filePath: string, requiredKeys: string[]): string | null {
  try {
    const parsed = YAML.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "Expected a YAML object.";
    for (const key of requiredKeys) {
      if (!(key in parsed)) return `Missing required key '${key}'.`;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function scrubAdeExcludeRule(projectRoot: string): AdeSyncAction | null {
  const gitDir = path.join(projectRoot, ".git");
  const excludePath = path.join(gitDir, "info", "exclude");
  if (!fs.existsSync(excludePath)) return null;
  const raw = fs.readFileSync(excludePath, "utf8");
  const nextLines = raw
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== ".ade/" && trimmed !== ".ade";
    });
  while (nextLines.length > 0 && nextLines[nextLines.length - 1]?.trim() === "") {
    nextLines.pop();
  }
  const next = `${nextLines.join("\n")}\n`;
  if (next === raw) return null;
  fs.writeFileSync(excludePath, next, "utf8");
  return { kind: "scrub_exclude", relativePath: ".git/info/exclude", detail: "Removed stale .ade ignore rule." };
}

function ensureDir(dirPath: string, relativePath: string, actions: AdeSyncAction[]): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    actions.push({ kind: "create_dir", relativePath });
  }
}

function ensureFile(filePath: string, body: string, relativePath: string, actions: AdeSyncAction[]): void {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body, "utf8");
    actions.push({ kind: "create_file", relativePath });
    return;
  }
  const existing = fs.readFileSync(filePath, "utf8");
  if (existing !== body) {
    fs.writeFileSync(filePath, body, "utf8");
    actions.push({ kind: "rewrite", relativePath });
  }
}

function moveIfExists(sourcePath: string, destinationPath: string, relativePath: string, actions: AdeSyncAction[]): void {
  if (!fs.existsSync(sourcePath) || sourcePath === destinationPath) return;
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.rmSync(destinationPath, { recursive: true, force: true });
  fs.renameSync(sourcePath, destinationPath);
  actions.push({ kind: "move", relativePath, detail: `${path.basename(sourcePath)} -> ${path.relative(path.dirname(destinationPath), destinationPath)}` });
}

function deleteIfExists(targetPath: string, relativePath: string, actions: AdeSyncAction[]): void {
  if (!fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
  actions.push({ kind: "delete", relativePath });
}

function repairLegacyPaths(paths: AdeLayoutPaths, actions: AdeSyncAction[]): void {
  moveIfExists(path.join(paths.adeDir, "logs"), paths.logsDir, "transcripts/logs", actions);
  moveIfExists(path.join(paths.adeDir, "chat-transcripts"), paths.chatTranscriptsDir, "transcripts/chat", actions);
  moveIfExists(path.join(paths.adeDir, "chat-sessions"), paths.chatSessionsDir, "cache/chat-sessions", actions);
  moveIfExists(path.join(paths.adeDir, "orchestrator"), paths.orchestratorCacheDir, "cache/orchestrator", actions);
  moveIfExists(path.join(paths.adeDir, "packs"), paths.packsDir, "artifacts/packs", actions);
  moveIfExists(path.join(paths.adeDir, "log-bundles"), paths.logBundlesDir, "artifacts/log-bundles", actions);
  moveIfExists(path.join(paths.adeDir, "github"), paths.githubSecretsDir, "secrets/github", actions);
  moveIfExists(path.join(paths.adeDir, "api-keys.json"), path.join(paths.secretsDir, "api-keys.json"), "secrets/api-keys.json", actions);

  const legacyFiles = fs.existsSync(paths.adeDir) ? fs.readdirSync(paths.adeDir) : [];
  for (const fileName of legacyFiles) {
    if (fileName.startsWith("mission-state-") && fileName.endsWith(".json")) {
      moveIfExists(
        path.join(paths.adeDir, fileName),
        path.join(paths.missionStateDir, fileName),
        path.join("cache/mission-state", fileName),
        actions
      );
    }
    if (fileName.startsWith("coordinator-checkpoint-") && fileName.endsWith(".json")) {
      moveIfExists(
        path.join(paths.adeDir, fileName),
        path.join(paths.missionStateDir, fileName),
        path.join("cache/mission-state", fileName),
        actions
      );
    }
  }

  deleteIfExists(path.join(paths.adeDir, "README.txt"), "README.txt", actions);
  deleteIfExists(path.join(paths.adeDir, ".DS_Store"), ".DS_Store", actions);
  deleteIfExists(path.join(paths.historyDir, ".DS_Store"), "history/.DS_Store", actions);
  deleteIfExists(path.join(paths.logsDir, ".DS_Store"), "transcripts/logs/.DS_Store", actions);
  deleteIfExists(path.join(paths.packsDir, ".DS_Store"), "artifacts/packs/.DS_Store", actions);
}

export function initializeOrRepairAdeProject(projectRoot: string, options: RepairOptions = {}): {
  paths: AdeLayoutPaths;
  cleanup: AdeCleanupResult;
} {
  const paths = resolveAdeLayout(projectRoot);
  const actions: AdeSyncAction[] = [];
  fs.mkdirSync(paths.adeDir, { recursive: true });

  const scrubAction = scrubAdeExcludeRule(projectRoot);
  if (scrubAction) actions.push(scrubAction);

  for (const entry of ADE_LAYOUT_DEFINITIONS) {
    const absolutePath = path.join(paths.adeDir, entry.relativePath);
    if (entry.pathType === "directory") {
      ensureDir(absolutePath, entry.relativePath, actions);
    }
  }

  ensureFile(path.join(paths.adeDir, ".gitignore"), buildAdeGitignore(), ".gitignore", actions);

  repairLegacyPaths(paths, actions);

  ensureDir(paths.logsDir, "transcripts/logs", actions);
  ensureDir(paths.processLogsDir, "transcripts/logs/processes", actions);
  ensureDir(paths.testLogsDir, "transcripts/logs/tests", actions);
  ensureDir(paths.chatSessionsDir, "cache/chat-sessions", actions);
  ensureDir(paths.chatTranscriptsDir, "transcripts/chat", actions);
  ensureDir(paths.orchestratorCacheDir, "cache/orchestrator", actions);
  ensureDir(paths.missionStateDir, "cache/mission-state", actions);
  ensureDir(paths.packsDir, "artifacts/packs", actions);
  ensureDir(paths.logBundlesDir, "artifacts/log-bundles", actions);
  ensureDir(paths.githubSecretsDir, "secrets/github", actions);

  options.logger?.info?.("ade.project.repaired", {
    projectRoot,
    actions: actions.length,
  });

  return {
    paths,
    cleanup: {
      changed: actions.length > 0,
      actions,
    },
  };
}

export function createAdeProjectService(args: AdeProjectServiceArgs) {
  const repair = initializeOrRepairAdeProject(args.projectRoot, { logger: args.logger });
  const logIntegrityService: LogIntegrityService = createLogIntegrityService({ logger: args.logger });

  const scanSecrets = (): AdeHealthIssue[] => {
    const issues: AdeHealthIssue[] = [];
    const trackedFiles = ADE_LAYOUT_DEFINITIONS
      .filter((candidate) => candidate.kind === "tracked")
      .flatMap((entry) => walkFiles(path.join(repair.paths.adeDir, entry.relativePath)));
    for (const absolutePath of trackedFiles) {
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
      const raw = fs.readFileSync(absolutePath, "utf8");
      const relativePath = path.relative(repair.paths.adeDir, absolutePath);
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.regex.test(raw)) {
          issues.push({
            code: pattern.code,
            severity: "warning",
            message: pattern.message,
            relativePath,
          });
        }
      }
    }
    return issues;
  };

  const validateIdentityFiles = (): AdeHealthIssue[] => {
    const issues: AdeHealthIssue[] = [];
    const ctoIdentityError = validateYamlDocument(path.join(repair.paths.ctoDir, "identity.yaml"), ["name", "updatedAt"]);
    if (ctoIdentityError) {
      issues.push({
        code: "cto-identity-invalid",
        severity: "warning",
        message: `cto/identity.yaml: ${ctoIdentityError}`,
        relativePath: "cto/identity.yaml",
      });
    }
    const ctoMemoryError = validateJsonDocument(path.join(repair.paths.ctoDir, "core-memory.json"), ["projectSummary", "updatedAt"]);
    if (ctoMemoryError) {
      issues.push({
        code: "cto-memory-invalid",
        severity: "warning",
        message: `cto/core-memory.json: ${ctoMemoryError}`,
        relativePath: "cto/core-memory.json",
      });
    }

    if (fs.existsSync(repair.paths.agentsDir)) {
      for (const slug of fs.readdirSync(repair.paths.agentsDir)) {
        const agentDir = path.join(repair.paths.agentsDir, slug);
        if (!fs.statSync(agentDir).isDirectory()) continue;
        const identityPath = path.join(agentDir, "identity.yaml");
        const coreMemoryPath = path.join(agentDir, "core-memory.json");
        const identityError = validateYamlDocument(identityPath, ["id", "slug", "name", "updatedAt"]);
        if (identityError) {
          issues.push({
            code: "worker-identity-invalid",
            severity: "warning",
            message: `agents/${slug}/identity.yaml: ${identityError}`,
            relativePath: path.join("agents", slug, "identity.yaml"),
          });
        }
        const memoryError = validateJsonDocument(coreMemoryPath, ["projectSummary", "updatedAt"]);
        if (memoryError) {
          issues.push({
            code: "worker-memory-invalid",
            severity: "warning",
            message: `agents/${slug}/core-memory.json: ${memoryError}`,
            relativePath: path.join("agents", slug, "core-memory.json"),
          });
        }
      }
    }
    return issues;
  };

  const validatePaths = (): AdePathEntry[] => {
    return ADE_LAYOUT_DEFINITIONS.map((entry) => {
      const absolutePath = path.join(repair.paths.adeDir, entry.relativePath);
      return {
        relativePath: entry.relativePath,
        absolutePath,
        kind: entry.kind,
        pathType: entry.pathType,
        exists: fs.existsSync(absolutePath),
        notes: entry.notes,
      };
    });
  };

  const runIntegrityCheck = (): AdeCleanupResult => {
    const actions: AdeSyncAction[] = [];
    args.ctoStateService?.getSnapshot?.();
    args.workerAgentService?.listAgents?.();
    const jsonlTargets = [
      path.join(repair.paths.historyDir, "missions.jsonl"),
      path.join(repair.paths.ctoDir, "sessions.jsonl"),
    ];
    if (fs.existsSync(repair.paths.agentsDir)) {
      for (const slug of fs.readdirSync(repair.paths.agentsDir)) {
        const sessionsPath = path.join(repair.paths.agentsDir, slug, "sessions.jsonl");
        if (fs.existsSync(sessionsPath)) jsonlTargets.push(sessionsPath);
      }
    }
    for (const filePath of jsonlTargets) {
      const result = logIntegrityService.normalizeJsonlFile(filePath);
      if (result.changed) {
        actions.push({
          kind: "truncate_jsonl",
          relativePath: path.relative(repair.paths.adeDir, filePath),
          detail: `Normalized ${result.count} JSONL entr${result.count === 1 ? "y" : "ies"}.`,
        });
      }
    }
    return { changed: actions.length > 0, actions };
  };

  const getSnapshot = (): AdeProjectSnapshot => {
    const configSnapshot = args.projectConfigService.get();
    const configValidation = configSnapshot.validation;
    const health: AdeHealthIssue[] = [];
    for (const issue of configValidation.issues) {
      health.push({
        code: "config-validation",
        severity: configValidation.ok ? "info" : "warning",
        message: `${issue.path}: ${issue.message}`,
        relativePath: issue.path,
      });
    }
    if (!fs.existsSync(repair.paths.secretConfigPath)) {
      const configBodies = [repair.paths.sharedConfigPath, repair.paths.localConfigPath]
        .filter((candidate) => fs.existsSync(candidate))
        .map((candidate) => fs.readFileSync(candidate, "utf8"));
      if (configBodies.some((body) => body.includes("secretRef:"))) {
        health.push({
          code: "missing-secret-config",
          severity: "warning",
          message: "Config references secret values, but .ade/local.secret.yaml is missing.",
          relativePath: "local.secret.yaml",
        });
      }
    }
    health.push(...scanSecrets());
    health.push(...validateIdentityFiles());
    return {
      rootPath: args.projectRoot,
      adeDir: repair.paths.adeDir,
      lastCheckedAt: new Date().toISOString(),
      entries: validatePaths(),
      health,
      cleanup: repair.cleanup,
      config: {
        sharedPath: repair.paths.sharedConfigPath,
        localPath: repair.paths.localConfigPath,
        secretPath: repair.paths.secretConfigPath,
        trust: {
          sharedHash: configSnapshot.trust?.sharedHash ?? "",
          localHash: configSnapshot.trust?.localHash ?? "",
          approvedSharedHash: configSnapshot.trust?.approvedSharedHash ?? null,
          requiresSharedTrust: configSnapshot.trust?.requiresSharedTrust ?? false,
        },
      },
    };
  };

  return {
    paths: repair.paths,
    getSnapshot,
    initializeOrRepair: () => initializeOrRepairAdeProject(args.projectRoot, { logger: args.logger }).cleanup,
    runIntegrityCheck,
    logIntegrityService,
  };
}

export type AdeProjectService = ReturnType<typeof createAdeProjectService>;
