import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import type {
  ConfigProcessDefinition,
  ConfigProcessReadiness,
  ConfigStackButtonDefinition,
  ConfigTestSuiteDefinition,
  EffectiveProjectConfig,
  ProcessDefinition,
  ProcessReadinessConfig,
  ProjectConfigCandidate,
  ProjectConfigDiff,
  ProjectConfigFile,
  ProjectConfigSnapshot,
  ProjectConfigTrust,
  ProjectConfigValidationIssue,
  ProjectConfigValidationResult,
  StackButtonDefinition,
  TestSuiteDefinition,
  TestSuiteTag
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";

const TRUSTED_SHARED_HASH_KEY = "project_config:trusted_shared_hash";
const VERSION = 1;
const DEFAULT_GRACEFUL_MS = 7000;
const EMPTY_CONTENT_HASH = createHash("sha256").update("").digest("hex");

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
  return out;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function parseReadiness(value: unknown): ConfigProcessReadiness | undefined {
  if (!isRecord(value)) return undefined;
  const type = asString(value.type);
  if (type === "port") {
    return { type, port: asNumber(value.port) };
  }
  if (type === "logRegex") {
    return { type, pattern: asString(value.pattern) };
  }
  if (type === "none") {
    return { type };
  }
  return undefined;
}

function coerceProcessDef(value: unknown): ConfigProcessDefinition | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id)?.trim() ?? "";
  const out: ConfigProcessDefinition = { id };

  const name = asString(value.name);
  const command = asStringArray(value.command);
  const cwd = asString(value.cwd);
  const env = asStringMap(value.env);
  const autostart = asBool(value.autostart);
  const restart = asString(value.restart);
  const gracefulShutdownMs = asNumber(value.gracefulShutdownMs);
  const dependsOn = asStringArray(value.dependsOn);
  const readiness = parseReadiness(value.readiness);

  if (name != null) out.name = name;
  if (command != null) out.command = command;
  if (cwd != null) out.cwd = cwd;
  if (env != null) out.env = env;
  if (autostart != null) out.autostart = autostart;
  if (restart === "never" || restart === "on_crash") out.restart = restart;
  if (gracefulShutdownMs != null) out.gracefulShutdownMs = gracefulShutdownMs;
  if (dependsOn != null) out.dependsOn = dependsOn;
  if (readiness != null) out.readiness = readiness;

  return out;
}

function coerceStackButton(value: unknown): ConfigStackButtonDefinition | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id)?.trim() ?? "";
  const out: ConfigStackButtonDefinition = { id };

  const name = asString(value.name);
  const processIds = asStringArray(value.processIds);
  const startOrder = asString(value.startOrder);

  if (name != null) out.name = name;
  if (processIds != null) out.processIds = processIds;
  if (startOrder === "parallel" || startOrder === "dependency") out.startOrder = startOrder;

  return out;
}

function coerceTestSuite(value: unknown): ConfigTestSuiteDefinition | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id)?.trim() ?? "";
  const out: ConfigTestSuiteDefinition = { id };

  const name = asString(value.name);
  const command = asStringArray(value.command);
  const cwd = asString(value.cwd);
  const env = asStringMap(value.env);
  const timeoutMs = asNumber(value.timeoutMs);
  const tags = asStringArray(value.tags);

  if (name != null) out.name = name;
  if (command != null) out.command = command;
  if (cwd != null) out.cwd = cwd;
  if (env != null) out.env = env;
  if (timeoutMs != null) out.timeoutMs = timeoutMs;
  if (tags != null) {
    out.tags = tags.filter((tag): tag is TestSuiteTag =>
      tag === "unit" || tag === "lint" || tag === "integration" || tag === "e2e" || tag === "custom"
    );
  }

  return out;
}

function coerceConfigFile(value: unknown): ProjectConfigFile {
  if (!isRecord(value)) {
    return { version: VERSION, processes: [], stackButtons: [], testSuites: [] };
  }

  const version = asNumber(value.version) ?? VERSION;
  const processes = Array.isArray(value.processes)
    ? value.processes.map(coerceProcessDef).filter((x): x is ConfigProcessDefinition => x != null)
    : [];
  const stackButtons = Array.isArray(value.stackButtons)
    ? value.stackButtons.map(coerceStackButton).filter((x): x is ConfigStackButtonDefinition => x != null)
    : [];
  const testSuites = Array.isArray(value.testSuites)
    ? value.testSuites.map(coerceTestSuite).filter((x): x is ConfigTestSuiteDefinition => x != null)
    : [];

  return {
    version,
    processes,
    stackButtons,
    testSuites,
    ...(isRecord(value.providers) ? { providers: value.providers } : {})
  };
}

function readConfigFile(filePath: string): { config: ProjectConfigFile; raw: string } {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim().length) {
      return { config: { version: VERSION, processes: [], stackButtons: [], testSuites: [] }, raw };
    }
    const parsed = YAML.parse(raw);
    return { config: coerceConfigFile(parsed), raw };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { config: { version: VERSION, processes: [], stackButtons: [], testSuites: [] }, raw: "" };
    }
    throw err;
  }
}

function toCanonicalYaml(config: ProjectConfigFile): string {
  const normalized: ProjectConfigFile = {
    version: VERSION,
    processes: config.processes ?? [],
    stackButtons: config.stackButtons ?? [],
    testSuites: config.testSuites ?? [],
    ...(config.providers ? { providers: config.providers } : {})
  };
  return YAML.stringify(normalized, { indent: 2 });
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function createDefId(projectId: string, key: string): string {
  return `${projectId}:${key}`;
}

function mergeById<T extends { id: string }>(base: T[] = [], local: T[] = [], merge: (a: T, b: T) => T): T[] {
  const out: T[] = [];
  const indexById = new Map<string, number>();

  for (const entry of base) {
    const id = (entry.id ?? "").trim();
    if (!id) continue;
    if (indexById.has(id)) continue;
    indexById.set(id, out.length);
    out.push(entry);
  }

  for (const entry of local) {
    const id = (entry.id ?? "").trim();
    if (!id) continue;
    const idx = indexById.get(id);
    if (idx == null) {
      indexById.set(id, out.length);
      out.push(entry);
      continue;
    }
    out[idx] = merge(out[idx]!, entry);
  }

  return out;
}

function resolveReadiness(readiness: ConfigProcessReadiness | undefined): ProcessReadinessConfig {
  if (!readiness) return { type: "none" };
  if (readiness.type === "port") return { type: "port", port: Number(readiness.port ?? 0) };
  if (readiness.type === "logRegex") return { type: "logRegex", pattern: readiness.pattern ?? "" };
  return { type: "none" };
}

function resolveEffectiveConfig(shared: ProjectConfigFile, local: ProjectConfigFile): EffectiveProjectConfig {
  const mergedProcesses = mergeById(shared.processes ?? [], local.processes ?? [], (base, over) => ({
    ...base,
    ...over,
    ...(base.env || over.env ? { env: { ...(base.env ?? {}), ...(over.env ?? {}) } } : {}),
    ...(over.readiness != null ? { readiness: over.readiness } : base.readiness != null ? { readiness: base.readiness } : {}),
    ...(over.dependsOn != null ? { dependsOn: over.dependsOn } : base.dependsOn != null ? { dependsOn: base.dependsOn } : {})
  }));

  const mergedStackButtons = mergeById(shared.stackButtons ?? [], local.stackButtons ?? [], (base, over) => ({
    ...base,
    ...over,
    ...(over.processIds != null ? { processIds: over.processIds } : base.processIds != null ? { processIds: base.processIds } : {})
  }));

  const mergedSuites = mergeById(shared.testSuites ?? [], local.testSuites ?? [], (base, over) => ({
    ...base,
    ...over,
    ...(base.env || over.env ? { env: { ...(base.env ?? {}), ...(over.env ?? {}) } } : {})
  }));

  const processes: ProcessDefinition[] = mergedProcesses.map((entry) => ({
    id: entry.id.trim(),
    name: entry.name?.trim() ?? "",
    command: (entry.command ?? []).map((c) => c.trim()).filter(Boolean),
    cwd: entry.cwd?.trim() ?? "",
    env: entry.env ?? {},
    autostart: entry.autostart ?? false,
    restart: entry.restart ?? "never",
    gracefulShutdownMs: entry.gracefulShutdownMs ?? DEFAULT_GRACEFUL_MS,
    dependsOn: (entry.dependsOn ?? []).map((d) => d.trim()).filter(Boolean),
    readiness: resolveReadiness(entry.readiness)
  }));

  const stackButtons: StackButtonDefinition[] = mergedStackButtons.map((entry) => ({
    id: entry.id.trim(),
    name: entry.name?.trim() ?? "",
    processIds: (entry.processIds ?? []).map((id) => id.trim()).filter(Boolean),
    startOrder: entry.startOrder ?? "parallel"
  }));

  const testSuites: TestSuiteDefinition[] = mergedSuites.map((entry) => ({
    id: entry.id.trim(),
    name: entry.name?.trim() ?? "",
    command: (entry.command ?? []).map((c) => c.trim()).filter(Boolean),
    cwd: entry.cwd?.trim() ?? "",
    env: entry.env ?? {},
    timeoutMs: entry.timeoutMs ?? null,
    tags: entry.tags ?? []
  }));

  return {
    version: VERSION,
    processes,
    stackButtons,
    testSuites,
    ...(shared.providers || local.providers
      ? {
          providers: {
            ...(shared.providers ?? {}),
            ...(local.providers ?? {})
          }
        }
      : {})
  };
}

function validateDuplicateIds(
  values: Array<{ id: string }>,
  sectionPath: string,
  issues: ProjectConfigValidationIssue[],
  fileLabel: "shared" | "local"
) {
  const seen = new Set<string>();
  for (let i = 0; i < values.length; i++) {
    const id = (values[i]?.id ?? "").trim();
    if (!id) continue;
    if (seen.has(id)) {
      issues.push({ path: `${fileLabel}.${sectionPath}[${i}].id`, message: `Duplicate id '${id}'` });
      continue;
    }
    seen.add(id);
  }
}

function isDirectory(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function validateProcessCycles(processes: ProcessDefinition[], issues: ProjectConfigValidationIssue[]) {
  const byId = new Map(processes.map((p) => [p.id, p] as const));
  const visited = new Set<string>();
  const inStack = new Set<string>();

  const dfs = (id: string): boolean => {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;

    visited.add(id);
    inStack.add(id);

    const proc = byId.get(id);
    if (proc) {
      for (const dep of proc.dependsOn) {
        if (!byId.has(dep)) continue;
        if (dfs(dep)) return true;
      }
    }

    inStack.delete(id);
    return false;
  };

  for (const id of byId.keys()) {
    if (dfs(id)) {
      issues.push({ path: "effective.processes", message: `Cyclic dependsOn graph detected around '${id}'` });
      return;
    }
  }
}

function validateEffectiveConfig(
  effective: EffectiveProjectConfig,
  projectRoot: string,
  shared: ProjectConfigFile,
  local: ProjectConfigFile
): ProjectConfigValidationResult {
  const issues: ProjectConfigValidationIssue[] = [];

  validateDuplicateIds(shared.processes ?? [], "processes", issues, "shared");
  validateDuplicateIds(local.processes ?? [], "processes", issues, "local");
  validateDuplicateIds(shared.stackButtons ?? [], "stackButtons", issues, "shared");
  validateDuplicateIds(local.stackButtons ?? [], "stackButtons", issues, "local");
  validateDuplicateIds(shared.testSuites ?? [], "testSuites", issues, "shared");
  validateDuplicateIds(local.testSuites ?? [], "testSuites", issues, "local");

  const processIds = new Set<string>();
  for (const [idx, proc] of effective.processes.entries()) {
    const p = `effective.processes[${idx}]`;

    if (!proc.id) {
      issues.push({ path: `${p}.id`, message: "Process id is required" });
    } else if (processIds.has(proc.id)) {
      issues.push({ path: `${p}.id`, message: `Duplicate process id '${proc.id}'` });
    } else {
      processIds.add(proc.id);
    }

    if (!proc.name) issues.push({ path: `${p}.name`, message: "Process name is required" });
    if (!proc.command.length) issues.push({ path: `${p}.command`, message: "Process command must be a non-empty argv array" });
    if (!proc.cwd) issues.push({ path: `${p}.cwd`, message: "Process cwd is required" });
    if (!Number.isFinite(proc.gracefulShutdownMs) || proc.gracefulShutdownMs <= 0) {
      issues.push({ path: `${p}.gracefulShutdownMs`, message: "gracefulShutdownMs must be > 0" });
    }

    const absCwd = path.isAbsolute(proc.cwd) ? proc.cwd : path.join(projectRoot, proc.cwd);
    if (proc.cwd && !isDirectory(absCwd)) {
      issues.push({ path: `${p}.cwd`, message: `cwd does not exist: ${proc.cwd}` });
    }

    if (proc.readiness.type === "port") {
      if (!Number.isInteger(proc.readiness.port) || proc.readiness.port < 1 || proc.readiness.port > 65535) {
        issues.push({ path: `${p}.readiness.port`, message: "Port readiness requires a valid port (1-65535)" });
      }
    }

    if (proc.readiness.type === "logRegex") {
      if (!proc.readiness.pattern) {
        issues.push({ path: `${p}.readiness.pattern`, message: "logRegex readiness requires a pattern" });
      } else {
        try {
          // Validate regex syntax once during config validation.
          new RegExp(proc.readiness.pattern);
        } catch {
          issues.push({ path: `${p}.readiness.pattern`, message: "Invalid readiness regex pattern" });
        }
      }
    }
  }

  for (const [idx, proc] of effective.processes.entries()) {
    const p = `effective.processes[${idx}]`;
    for (const dep of proc.dependsOn) {
      if (!processIds.has(dep)) {
        issues.push({ path: `${p}.dependsOn`, message: `Unknown dependency '${dep}'` });
      }
    }
  }

  validateProcessCycles(effective.processes, issues);

  const stackIds = new Set<string>();
  for (const [idx, stack] of effective.stackButtons.entries()) {
    const p = `effective.stackButtons[${idx}]`;

    if (!stack.id) {
      issues.push({ path: `${p}.id`, message: "Stack button id is required" });
    } else if (stackIds.has(stack.id)) {
      issues.push({ path: `${p}.id`, message: `Duplicate stack button id '${stack.id}'` });
    } else {
      stackIds.add(stack.id);
    }

    if (!stack.name) issues.push({ path: `${p}.name`, message: "Stack button name is required" });

    for (const processId of stack.processIds) {
      if (!processIds.has(processId)) {
        issues.push({ path: `${p}.processIds`, message: `Unknown process id '${processId}'` });
      }
    }
  }

  const suiteIds = new Set<string>();
  for (const [idx, suite] of effective.testSuites.entries()) {
    const p = `effective.testSuites[${idx}]`;

    if (!suite.id) {
      issues.push({ path: `${p}.id`, message: "Test suite id is required" });
    } else if (suiteIds.has(suite.id)) {
      issues.push({ path: `${p}.id`, message: `Duplicate test suite id '${suite.id}'` });
    } else {
      suiteIds.add(suite.id);
    }

    if (!suite.name) issues.push({ path: `${p}.name`, message: "Test suite name is required" });
    if (!suite.command.length) issues.push({ path: `${p}.command`, message: "Test suite command must be a non-empty argv array" });
    if (!suite.cwd) issues.push({ path: `${p}.cwd`, message: "Test suite cwd is required" });

    const absCwd = path.isAbsolute(suite.cwd) ? suite.cwd : path.join(projectRoot, suite.cwd);
    if (suite.cwd && !isDirectory(absCwd)) {
      issues.push({ path: `${p}.cwd`, message: `cwd does not exist: ${suite.cwd}` });
    }

    if (suite.timeoutMs != null && (!Number.isFinite(suite.timeoutMs) || suite.timeoutMs <= 0)) {
      issues.push({ path: `${p}.timeoutMs`, message: "timeoutMs must be > 0 when provided" });
    }
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

function trustError(sharedHash: string): Error {
  const err = new Error(
    `ADE_TRUST_REQUIRED: Shared config changed and must be confirmed before execution (sharedHash=${sharedHash})`
  );
  (err as Error & { code?: string }).code = "ADE_TRUST_REQUIRED";
  return err;
}

function invalidConfigError(validation: ProjectConfigValidationResult): Error {
  const first = validation.issues[0];
  const msg = first ? `${first.path}: ${first.message}` : "Unknown config validation failure";
  const err = new Error(`ADE_CONFIG_INVALID: ${msg}`);
  (err as Error & { code?: string }).code = "ADE_CONFIG_INVALID";
  return err;
}

export function createProjectConfigService({
  projectRoot,
  adeDir,
  projectId,
  db,
  logger
}: {
  projectRoot: string;
  adeDir: string;
  projectId: string;
  db: AdeDb;
  logger: Logger;
}) {
  const sharedPath = path.join(adeDir, "ade.yaml");
  const localPath = path.join(adeDir, "local.yaml");

  let lastSeenSharedHash: string | null = null;
  let lastSeenLocalHash: string | null = null;

  const getTrustedSharedHash = (): string | null => db.getJson<string>(TRUSTED_SHARED_HASH_KEY);

  const setTrustedSharedHash = (hash: string) => {
    db.setJson(TRUSTED_SHARED_HASH_KEY, hash);
  };

  const buildTrust = ({ sharedHash, localHash }: { sharedHash: string; localHash: string }): ProjectConfigTrust => {
    const approvedSharedHash = getTrustedSharedHash();
    return {
      sharedHash,
      localHash,
      approvedSharedHash,
      requiresSharedTrust: approvedSharedHash == null ? sharedHash !== EMPTY_CONTENT_HASH : approvedSharedHash !== sharedHash
    };
  };

  const syncSnapshots = (effective: EffectiveProjectConfig) => {
    const now = new Date().toISOString();

    db.run("delete from process_definitions where project_id = ?", [projectId]);
    db.run("delete from stack_buttons where project_id = ?", [projectId]);
    db.run("delete from test_suites where project_id = ?", [projectId]);

    for (const proc of effective.processes) {
      db.run(
        `
          insert into process_definitions(
            id, project_id, key, name, command_json, cwd, env_json, autostart,
            restart_policy, graceful_shutdown_ms, depends_on_json, readiness_json, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          createDefId(projectId, `proc:${proc.id}`),
          projectId,
          proc.id,
          proc.name,
          JSON.stringify(proc.command),
          proc.cwd,
          JSON.stringify(proc.env),
          proc.autostart ? 1 : 0,
          proc.restart,
          proc.gracefulShutdownMs,
          JSON.stringify(proc.dependsOn),
          JSON.stringify(proc.readiness),
          now
        ]
      );
    }

    for (const stack of effective.stackButtons) {
      db.run(
        `
          insert into stack_buttons(
            id, project_id, key, name, process_keys_json, start_order, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          createDefId(projectId, `stack:${stack.id}`),
          projectId,
          stack.id,
          stack.name,
          JSON.stringify(stack.processIds),
          stack.startOrder,
          now
        ]
      );
    }

    for (const suite of effective.testSuites) {
      db.run(
        `
          insert into test_suites(
            id, project_id, key, name, command_json, cwd, env_json, timeout_ms, tags_json, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          createDefId(projectId, `suite:${suite.id}`),
          projectId,
          suite.id,
          suite.name,
          JSON.stringify(suite.command),
          suite.cwd,
          JSON.stringify(suite.env),
          suite.timeoutMs,
          JSON.stringify(suite.tags),
          now
        ]
      );
    }
  };

  const buildSnapshotFromFiles = (
    shared: ProjectConfigFile,
    local: ProjectConfigFile,
    hashes: { sharedHash: string; localHash: string },
    options: { persistSnapshots: boolean }
  ): ProjectConfigSnapshot => {
    const effective = resolveEffectiveConfig(shared, local);
    const validation = validateEffectiveConfig(effective, projectRoot, shared, local);
    const trust = buildTrust(hashes);

    if (options.persistSnapshots && validation.ok) {
      syncSnapshots(effective);
    }

    return {
      shared,
      local,
      effective,
      validation,
      trust,
      paths: { sharedPath, localPath }
    };
  };

  const readSnapshotFromDisk = (): ProjectConfigSnapshot => {
    fs.mkdirSync(adeDir, { recursive: true });

    const sharedFile = readConfigFile(sharedPath);
    const localFile = readConfigFile(localPath);

    const sharedHash = hashContent(sharedFile.raw);
    const localHash = hashContent(localFile.raw);

    return buildSnapshotFromFiles(sharedFile.config, localFile.config, { sharedHash, localHash }, { persistSnapshots: true });
  };

  const validateCandidate = (shared: ProjectConfigFile, local: ProjectConfigFile): ProjectConfigValidationResult => {
    const sharedHash = hashContent(toCanonicalYaml(shared));
    const localHash = hashContent(toCanonicalYaml(local));
    const snapshot = buildSnapshotFromFiles(shared, local, { sharedHash, localHash }, { persistSnapshots: false });
    return snapshot.validation;
  };

  return {
    get(): ProjectConfigSnapshot {
      const snapshot = readSnapshotFromDisk();
      lastSeenSharedHash = snapshot.trust.sharedHash;
      lastSeenLocalHash = snapshot.trust.localHash;
      return snapshot;
    },

    validate(candidate: ProjectConfigCandidate): ProjectConfigValidationResult {
      const shared = coerceConfigFile(candidate.shared);
      const local = coerceConfigFile(candidate.local);
      return validateCandidate(shared, local);
    },

    save(candidate: ProjectConfigCandidate): ProjectConfigSnapshot {
      const shared = coerceConfigFile(candidate.shared);
      const local = coerceConfigFile(candidate.local);
      const validation = validateCandidate(shared, local);
      if (!validation.ok) {
        throw invalidConfigError(validation);
      }

      const sharedYaml = toCanonicalYaml(shared);
      const localYaml = toCanonicalYaml(local);

      fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
      fs.writeFileSync(sharedPath, sharedYaml, "utf8");
      fs.writeFileSync(localPath, localYaml, "utf8");

      const sharedHash = hashContent(sharedYaml);
      setTrustedSharedHash(sharedHash);

      logger.info("projectConfig.save", {
        sharedPath,
        localPath,
        sharedHash,
        sharedProcesses: shared.processes?.length ?? 0,
        localProcesses: local.processes?.length ?? 0
      });

      const snapshot = readSnapshotFromDisk();
      lastSeenSharedHash = snapshot.trust.sharedHash;
      lastSeenLocalHash = snapshot.trust.localHash;
      return snapshot;
    },

    diffAgainstDisk(): ProjectConfigDiff {
      const snapshot = readSnapshotFromDisk();
      const sharedChanged = lastSeenSharedHash != null ? snapshot.trust.sharedHash !== lastSeenSharedHash : false;
      const localChanged = lastSeenLocalHash != null ? snapshot.trust.localHash !== lastSeenLocalHash : false;
      return {
        sharedChanged,
        localChanged,
        sharedHash: snapshot.trust.sharedHash,
        localHash: snapshot.trust.localHash,
        approvedSharedHash: snapshot.trust.approvedSharedHash,
        requiresSharedTrust: snapshot.trust.requiresSharedTrust
      };
    },

    confirmTrust({ sharedHash }: { sharedHash?: string } = {}): ProjectConfigTrust {
      const snapshot = readSnapshotFromDisk();
      if (sharedHash && sharedHash !== snapshot.trust.sharedHash) {
        throw new Error("Shared hash mismatch while confirming trust");
      }

      setTrustedSharedHash(snapshot.trust.sharedHash);
      logger.info("projectConfig.confirmTrust", { sharedHash: snapshot.trust.sharedHash });
      return {
        ...snapshot.trust,
        approvedSharedHash: snapshot.trust.sharedHash,
        requiresSharedTrust: false
      };
    },

    getEffective(): EffectiveProjectConfig {
      const snapshot = readSnapshotFromDisk();
      lastSeenSharedHash = snapshot.trust.sharedHash;
      lastSeenLocalHash = snapshot.trust.localHash;
      if (!snapshot.validation.ok) {
        throw invalidConfigError(snapshot.validation);
      }
      return snapshot.effective;
    },

    getExecutableConfig(): EffectiveProjectConfig {
      const snapshot = readSnapshotFromDisk();
      lastSeenSharedHash = snapshot.trust.sharedHash;
      lastSeenLocalHash = snapshot.trust.localHash;
      if (!snapshot.validation.ok) {
        throw invalidConfigError(snapshot.validation);
      }
      if (snapshot.trust.requiresSharedTrust) {
        throw trustError(snapshot.trust.sharedHash);
      }
      return snapshot.effective;
    }
  };
}
