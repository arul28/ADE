import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { chooseSuggestedCommand, computeCiScanDiff } from "./ciParsing";
import type {
  CiImportRequest,
  CiImportResult,
  CiImportSelection,
  CiImportState,
  CiJobCandidate,
  CiJobSafety,
  CiProvider,
  CiScanDiff,
  CiScanResult,
  ConfigProcessDefinition,
  ConfigTestSuiteDefinition,
  ProjectConfigFile
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createProjectConfigService } from "../config/projectConfigService";
import { isRecord, nowIso } from "../shared/utils";

const CI_STATE_KEY = "ci:import_state";
const MAX_BYTES = 280_000;

function fileExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

function dirExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function safeReadText(absPath: string, maxBytes = MAX_BYTES): string {
  try {
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.slice(0, Math.max(0, read)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function slugify(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s.length ? s : "ci";
}

function parseNameOnly(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
}

function jobId(provider: CiProvider, filePath: string, jobKey: string): string {
  const cleanKey = jobKey.trim() || "job";
  return `${provider}:${filePath}:${cleanKey}`;
}

function jobDigest(job: Pick<CiJobCandidate, "commands" | "suggestedCommandLine" | "provider" | "filePath" | "jobName">): string {
  return sha256(
    JSON.stringify({
      provider: job.provider,
      filePath: job.filePath,
      jobName: job.jobName,
      suggestedCommandLine: job.suggestedCommandLine,
      commands: job.commands
    })
  );
}

function classifyJobSafety(commands: string[]): { safety: CiJobSafety; warnings: string[] } {
  const joined = commands.join("\n").toLowerCase();
  const warnings: string[] = [];

  const ciOnlySignals = [
    "deploy",
    "release",
    "publish",
    "terraform apply",
    "kubectl ",
    "helm ",
    "aws ",
    "gcloud ",
    "az ",
    "docker push",
    "npm publish",
    "pnpm publish",
    "yarn publish"
  ];
  if (ciOnlySignals.some((sig) => joined.includes(sig))) {
    warnings.push("Looks like a deploy/release job. Treat as CI-only.");
    return { safety: "ci-only", warnings };
  }

  if (/(npm|pnpm|yarn)\s+(test|lint|typecheck|build)\b|go\s+test\b|cargo\s+test\b|pytest\b|make\s+test\b/i.test(joined)) {
    return { safety: "local-safe", warnings };
  }

  return { safety: "unknown", warnings };
}

function sanitizeImportState(value: unknown): CiImportState | null {
  if (!isRecord(value)) return null;
  const fingerprint = typeof value.fingerprint === "string" ? value.fingerprint : "";
  const importedAt = typeof value.importedAt === "string" ? value.importedAt : "";
  const jobDigests = isRecord(value.jobDigests) ? value.jobDigests : {};
  const importedJobs = Array.isArray(value.importedJobs) ? value.importedJobs : [];
  if (!fingerprint || !importedAt) return null;

  const safeDigests: Record<string, string> = {};
  for (const [k, v] of Object.entries(jobDigests)) {
    if (typeof v === "string" && k.trim()) safeDigests[k] = v;
  }

  const safeImportedJobs: CiImportState["importedJobs"] = [];
  for (const entry of importedJobs) {
    if (!isRecord(entry)) continue;
    const jobId = typeof entry.jobId === "string" ? entry.jobId.trim() : "";
    const kind = typeof entry.kind === "string" ? entry.kind.trim() : "";
    const targetId = typeof entry.targetId === "string" ? entry.targetId.trim() : "";
    if (!jobId || !targetId) continue;
    if (kind !== "process" && kind !== "testSuite") continue;
    safeImportedJobs.push({ jobId, kind: kind as "process" | "testSuite", targetId });
  }

  return {
    fingerprint,
    jobDigests: safeDigests,
    importedAt,
    importedJobs: safeImportedJobs
  };
}

function makeUniqueId(base: string, used: Set<string>): string {
  let id = base;
  if (!used.has(id)) return id;
  for (let i = 2; i < 200; i += 1) {
    const candidate = `${base}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
  // Last-resort: include a short hash.
  return `${base}_${sha256(base).slice(0, 6)}`;
}

function mergeImportState(prev: CiImportState | null, next: CiImportState): CiImportState {
  if (!prev) return next;
  // Preserve mappings for already-imported jobs when possible.
  const prevByKey = new Map<string, CiImportState["importedJobs"][number]>(
    prev.importedJobs.map((j) => [`${j.jobId}::${j.kind}`, j])
  );
  const nextJobs: CiImportState["importedJobs"] = [];
  for (const j of next.importedJobs) {
    const key = `${j.jobId}::${j.kind}`;
    nextJobs.push(prevByKey.get(key) ?? j);
  }
  return { ...next, importedJobs: nextJobs };
}

function parseGithubActionsJobs(absPath: string, relPath: string): CiJobCandidate[] {
  const raw = safeReadText(absPath);
  if (!raw.trim()) return [];
  let parsed: any;
  try {
    parsed = YAML.parse(raw);
  } catch {
    return [];
  }

  const jobs = parsed?.jobs;
  if (!jobs || typeof jobs !== "object") return [];

  const out: CiJobCandidate[] = [];
  for (const [jobKey, job] of Object.entries(jobs)) {
    const warnings: string[] = [];
    const jobObj = job as any;
    const jobName = typeof jobObj?.name === "string" ? String(jobObj.name).trim() : String(jobKey).trim();
    const steps = Array.isArray(jobObj?.steps) ? jobObj.steps : [];
    const commands: string[] = [];
    for (const step of steps) {
      const runRaw = (step as any)?.run;
      const run = typeof runRaw === "string" ? String(runRaw) : "";
      if (!run.trim()) continue;
      const lines = run
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length > 1) warnings.push(`Multiline run step detected; using the first line only (${lines.length} lines).`);
      if (lines[0]) commands.push(lines[0]);
    }

    const safety = classifyJobSafety(commands);
    warnings.push(...safety.warnings);
    const suggested = chooseSuggestedCommand({ commands, warnings });

    out.push({
      id: jobId("github-actions", relPath, String(jobKey)),
      provider: "github-actions",
      filePath: relPath,
      jobName,
      commands: parseNameOnly(commands.join("\n")),
      suggestedCommandLine: suggested.suggestedCommandLine,
      suggestedCommand: suggested.suggestedCommand,
      safety: safety.safety,
      warnings
    });
  }

  return out;
}

function parseGitlabCiJobs(absPath: string, relPath: string): CiJobCandidate[] {
  const raw = safeReadText(absPath);
  if (!raw.trim()) return [];
  let parsed: any;
  try {
    parsed = YAML.parse(raw);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object") return [];

  const reserved = new Set([
    "stages",
    "variables",
    "include",
    "workflow",
    "default",
    "image",
    "services",
    "before_script",
    "after_script",
    "cache"
  ]);

  const out: CiJobCandidate[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (reserved.has(key)) continue;
    if (!value || typeof value !== "object") continue;
    const jobObj = value as any;
    const script = jobObj.script;
    const warnings: string[] = [];

    const commands: string[] = [];
    if (typeof script === "string") {
      const lines = script
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      commands.push(...lines.slice(0, 30));
      if (lines.length > 30) warnings.push("Script truncated to first 30 lines.");
    } else if (Array.isArray(script)) {
      commands.push(...script.filter((x: unknown): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 30));
      if (script.length > 30) warnings.push("Script truncated to first 30 lines.");
    } else {
      continue;
    }

    const safety = classifyJobSafety(commands);
    warnings.push(...safety.warnings);
    const suggested = chooseSuggestedCommand({ commands, warnings });

    out.push({
      id: jobId("gitlab-ci", relPath, key),
      provider: "gitlab-ci",
      filePath: relPath,
      jobName: key,
      commands: parseNameOnly(commands.join("\n")),
      suggestedCommandLine: suggested.suggestedCommandLine,
      suggestedCommand: suggested.suggestedCommand,
      safety: safety.safety,
      warnings
    });
  }

  return out;
}

function parseCircleCiJobs(absPath: string, relPath: string): CiJobCandidate[] {
  const raw = safeReadText(absPath);
  if (!raw.trim()) return [];
  let parsed: any;
  try {
    parsed = YAML.parse(raw);
  } catch {
    return [];
  }

  const jobs = parsed?.jobs;
  if (!jobs || typeof jobs !== "object") return [];

  const out: CiJobCandidate[] = [];
  for (const [jobKey, job] of Object.entries(jobs)) {
    const warnings: string[] = [];
    const jobObj = job as any;
    const jobName = typeof jobObj?.name === "string" ? String(jobObj.name).trim() : String(jobKey).trim();
    const steps = Array.isArray(jobObj?.steps) ? jobObj.steps : [];
    const commands: string[] = [];

    for (const step of steps) {
      if (typeof step === "string") continue;
      if (!step || typeof step !== "object") continue;
      const run = (step as any).run;
      if (typeof run === "string") {
        const lines = run.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.length > 1) warnings.push(`Multiline run step detected; using the first line only (${lines.length} lines).`);
        if (lines[0]) commands.push(lines[0]);
        continue;
      }
      if (isRecord(run) && typeof run.command === "string") {
        const lines = String(run.command).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.length > 1) warnings.push(`Multiline run step detected; using the first line only (${lines.length} lines).`);
        if (lines[0]) commands.push(lines[0]);
        continue;
      }
    }

    const safety = classifyJobSafety(commands);
    warnings.push(...safety.warnings);
    const suggested = chooseSuggestedCommand({ commands, warnings });

    out.push({
      id: jobId("circleci", relPath, String(jobKey)),
      provider: "circleci",
      filePath: relPath,
      jobName,
      commands: parseNameOnly(commands.join("\n")),
      suggestedCommandLine: suggested.suggestedCommandLine,
      suggestedCommand: suggested.suggestedCommand,
      safety: safety.safety,
      warnings
    });
  }

  return out;
}

function parseJenkinsfile(absPath: string, relPath: string): CiJobCandidate[] {
  const raw = safeReadText(absPath);
  if (!raw.trim()) return [];

  const warnings: string[] = ["Best-effort parse of Jenkinsfile (Groovy)."];
  const commands: string[] = [];

  const re = /\b(sh|bat)\s+['"]([^'"]+)['"]/g;
  for (const match of raw.matchAll(re)) {
    const cmd = (match[2] ?? "").trim();
    if (cmd) commands.push(cmd);
    if (commands.length >= 40) break;
  }

  const safety = classifyJobSafety(commands);
  warnings.push(...safety.warnings);
  const suggested = chooseSuggestedCommand({ commands, warnings });

  return [
    {
      id: jobId("jenkins", relPath, "jenkinsfile"),
      provider: "jenkins",
      filePath: relPath,
      jobName: "Jenkinsfile",
      commands: parseNameOnly(commands.join("\n")),
      suggestedCommandLine: suggested.suggestedCommandLine,
      suggestedCommand: suggested.suggestedCommand,
      safety: safety.safety,
      warnings
    }
  ];
}

export function createCiService(args: {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
}) {
  const { db, logger, projectRoot, projectConfigService } = args;

  const scan = async (): Promise<CiScanResult> => {
    const jobs: CiJobCandidate[] = [];
    const providers = new Set<CiProvider>();

    const workflowsDir = path.join(projectRoot, ".github", "workflows");
    if (dirExists(workflowsDir)) {
      providers.add("github-actions");
      const entries = fs
        .readdirSync(workflowsDir)
        .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
        .slice(0, 60);
      for (const name of entries) {
        const abs = path.join(workflowsDir, name);
        const rel = path.relative(projectRoot, abs).replace(/\\/g, "/");
        jobs.push(...parseGithubActionsJobs(abs, rel));
      }
    }

    const gitlabPath = [".gitlab-ci.yml", ".gitlab-ci.yaml"]
      .map((p) => path.join(projectRoot, p))
      .find((abs) => fileExists(abs));
    if (gitlabPath) {
      providers.add("gitlab-ci");
      const rel = path.relative(projectRoot, gitlabPath).replace(/\\/g, "/");
      jobs.push(...parseGitlabCiJobs(gitlabPath, rel));
    }

    const circlePath = [path.join(projectRoot, ".circleci", "config.yml"), path.join(projectRoot, ".circleci", "config.yaml")].find((abs) =>
      fileExists(abs)
    );
    if (circlePath) {
      providers.add("circleci");
      const rel = path.relative(projectRoot, circlePath).replace(/\\/g, "/");
      jobs.push(...parseCircleCiJobs(circlePath, rel));
    }

    const jenkinsPath = path.join(projectRoot, "Jenkinsfile");
    if (fileExists(jenkinsPath)) {
      providers.add("jenkins");
      const rel = path.relative(projectRoot, jenkinsPath).replace(/\\/g, "/");
      jobs.push(...parseJenkinsfile(jenkinsPath, rel));
    }

    const deduped = new Map<string, CiJobCandidate>();
    for (const job of jobs) {
      deduped.set(job.id, job);
    }

    const sorted = Array.from(deduped.values()).sort((a, b) => {
      const p = a.provider.localeCompare(b.provider);
      if (p !== 0) return p;
      const f = a.filePath.localeCompare(b.filePath);
      if (f !== 0) return f;
      return a.jobName.localeCompare(b.jobName);
    });

    const jobDigests: Record<string, string> = {};
    for (const job of sorted) {
      jobDigests[job.id] = jobDigest(job);
    }

    const fingerprint = sha256(JSON.stringify(jobDigests));
    const scannedAt = nowIso();

    const lastImport = sanitizeImportState(db.getJson(CI_STATE_KEY));
    const diff: CiScanDiff | null = lastImport ? computeCiScanDiff(lastImport.jobDigests ?? {}, jobDigests) : null;

    logger.info("ci.scan", { providers: Array.from(providers), jobs: sorted.length });

    return {
      providers: Array.from(providers),
      jobs: sorted,
      fingerprint,
      scannedAt,
      lastImport,
      diff
    };
  };

  const importJobs = async (req: CiImportRequest): Promise<CiImportResult> => {
    const mode = req.mode ?? "import";
    const selections: CiImportSelection[] = Array.from(
      new Map(
        (req.selections ?? [])
          .map((s) => ({
            jobId: typeof s.jobId === "string" ? s.jobId.trim() : "",
            kind: s.kind
          }))
          .filter((s) => s.jobId.length && (s.kind === "process" || s.kind === "testSuite"))
          .map((s) => [`${s.jobId}::${s.kind}`, s] as const)
      ).values()
    );
    if (selections.length === 0) {
      throw new Error("Select at least 1 CI job to import.");
    }

    const scanResult = await scan();
    const jobsById = new Map(scanResult.jobs.map((j) => [j.id, j] as const));

    const prevState = sanitizeImportState(db.getJson(CI_STATE_KEY));
    const prevMapping = new Map<string, { targetId: string }>();
    for (const entry of prevState?.importedJobs ?? []) {
      prevMapping.set(`${entry.jobId}::${entry.kind}`, { targetId: entry.targetId });
    }

    const snapshot = projectConfigService.get();
    const shared = snapshot.shared;

    const usedProcessIds = new Set((shared.processes ?? []).map((p) => p.id));
    const usedSuiteIds = new Set((shared.testSuites ?? []).map((t) => t.id));

    const nextProcesses: ConfigProcessDefinition[] = [...(shared.processes ?? [])];
    const nextSuites: ConfigTestSuiteDefinition[] = [...(shared.testSuites ?? [])];

    const importedJobs: CiImportState["importedJobs"] = [];
    const createdAt = nowIso();

    for (const sel of selections) {
      const job = jobsById.get(sel.jobId);
      if (!job) {
        throw new Error(`CI job not found in latest scan: ${sel.jobId}`);
      }
      if (!job.suggestedCommand || !job.suggestedCommand.length) {
        throw new Error(
          `CI job '${job.jobName}' does not have an importable command (shell pipelines or multiline scripts).`
        );
      }

      if (sel.kind === "process") {
        const mappingKey = `${sel.jobId}::process`;
        const existingTargetId = mode === "sync" ? prevMapping.get(mappingKey)?.targetId ?? "" : "";
        const targetId = existingTargetId && usedProcessIds.has(existingTargetId)
          ? existingTargetId
          : makeUniqueId(`ci_${slugify(job.provider)}_${slugify(job.jobName)}`, usedProcessIds);

        usedProcessIds.add(targetId);
        importedJobs.push({ jobId: sel.jobId, kind: "process", targetId });

        const nextDef: ConfigProcessDefinition = {
          id: targetId,
          name: `CI: ${job.jobName}`,
          cwd: ".",
          command: job.suggestedCommand
        };

        const idx = nextProcesses.findIndex((p) => p.id === targetId);
        if (idx >= 0) nextProcesses[idx] = { ...nextProcesses[idx], ...nextDef };
        else nextProcesses.push(nextDef);

        continue;
      }

      const mappingKey = `${sel.jobId}::testSuite`;
      const existingTargetId = mode === "sync" ? prevMapping.get(mappingKey)?.targetId ?? "" : "";
      const targetId = existingTargetId && usedSuiteIds.has(existingTargetId)
        ? existingTargetId
        : makeUniqueId(`ci_${slugify(job.provider)}_${slugify(job.jobName)}`, usedSuiteIds);

      usedSuiteIds.add(targetId);
      importedJobs.push({ jobId: sel.jobId, kind: "testSuite", targetId });

      const nextDef: ConfigTestSuiteDefinition = {
        id: targetId,
        name: `CI: ${job.jobName}`,
        cwd: ".",
        command: job.suggestedCommand,
        tags: ["custom"]
      };

      const idx = nextSuites.findIndex((t) => t.id === targetId);
      if (idx >= 0) nextSuites[idx] = { ...nextSuites[idx], ...nextDef };
      else nextSuites.push(nextDef);
    }

    const nextShared: ProjectConfigFile = {
      ...shared,
      processes: nextProcesses,
      testSuites: nextSuites
    };

    const nextSnapshot = projectConfigService.save({
      shared: nextShared,
      local: snapshot.local
    });

    const nextState: CiImportState = mergeImportState(prevState, {
      fingerprint: scanResult.fingerprint,
      jobDigests: Object.fromEntries(scanResult.jobs.map((j) => [j.id, jobDigest(j)] as const)),
      importedAt: createdAt,
      importedJobs
    });

    db.setJson(CI_STATE_KEY, nextState);

    logger.info("ci.import", { mode, selections: selections.length, imported: importedJobs.length });

    return {
      snapshot: nextSnapshot,
      importState: nextState
    };
  };

  return {
    scan,
    import: importJobs
  };
}
