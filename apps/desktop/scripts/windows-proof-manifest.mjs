import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_KINDS,
  validateInventory,
  validateProvenance,
} from "./windows-proof-indexes.mjs";

export { EVIDENCE_KINDS, validateInventory, validateProvenance } from "./windows-proof-indexes.mjs";

export const MANIFEST_SCHEMA_VERSION = "ade.windows-proof/v1";
const RESULT_STATES = ["pending", "pass", "fail", "blocked"];
const APPROVAL_STATES = ["proof_pending", "proof_complete", "approved"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_HOST_ALIAS_PATTERN = /^win(?:10|11)-[a-z0-9][a-z0-9-]*$/;
const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
const GUI_EVIDENCE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp"]);
const STRUCTURED_EVIDENCE_EXTENSIONS = new Set([".csv", ".json", ".jsonl", ".log", ".txt"]);
const REDACTED_VALUE_PATTERNS = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i, label: "bearer credential" },
  { pattern: /\b(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-)[A-Za-z0-9_-]{8,}/i, label: "token-shaped value" },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/, label: "AWS access key" },
  { pattern: /[A-Z]:\\Users\\[^\\\s]+/i, label: "Windows user profile path" },
  { pattern: /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/, label: "email address" },
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/, label: "IP address" },
];
const FORBIDDEN_DATA_KEYS = new Set([
  "accountname",
  "authorization",
  "certificate",
  "certificatesubject",
  "credential",
  "email",
  "hostname",
  "ip",
  "ipaddress",
  "machinename",
  "password",
  "privatekey",
  "publisher",
  "publishersubject",
  "secret",
  "token",
  "username",
]);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, "..", "..", "..");
const defaultInventoryPath = path.join(
  defaultRepoRoot,
  "docs",
  "development",
  "windows-full-system-scenarios.json",
);
const defaultProvenancePath = path.join(
  defaultRepoRoot,
  "docs",
  "development",
  "windows-source-provenance.json",
);

function addError(errors, field, message) {
  errors.push(`${field}: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(errors, value, field) {
  if (!isPlainObject(value)) {
    addError(errors, field, "must be an object");
    return false;
  }
  return true;
}

function rejectUnknownKeys(errors, value, field, allowedKeys) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) addError(errors, `${field}.${key}`, "is not part of the schema");
  }
}

function requireString(errors, value, field, pattern = null) {
  if (typeof value !== "string" || value.length === 0) {
    addError(errors, field, "must be a non-empty string");
    return false;
  }
  if (pattern && !pattern.test(value)) {
    addError(errors, field, "has an invalid format");
    return false;
  }
  return true;
}

function requireBoolean(errors, value, field) {
  if (typeof value !== "boolean") {
    addError(errors, field, "must be a boolean");
    return false;
  }
  return true;
}

function requirePositiveInteger(errors, value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    addError(errors, field, "must be a positive integer");
    return false;
  }
  return true;
}

function requireIsoTimestamp(errors, value, field) {
  if (!requireString(errors, value, field)) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || Number.isNaN(Date.parse(value))) {
    addError(errors, field, "must be an ISO-8601 UTC timestamp");
    return false;
  }
  return true;
}

function requireStringArray(errors, value, field, { allowEmpty = false, pattern = null } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    addError(errors, field, `must be ${allowEmpty ? "an" : "a non-empty"} array`);
    return false;
  }
  const seen = new Set();
  value.forEach((item, index) => {
    if (!requireString(errors, item, `${field}[${index}]`, pattern)) return;
    if (seen.has(item)) addError(errors, `${field}[${index}]`, `duplicates ${JSON.stringify(item)}`);
    seen.add(item);
  });
  return true;
}

function isSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  if (value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(filePath) {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function sha256JsonFile(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function validateNoSensitiveData(value, errors, field = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateNoSensitiveData(item, errors, `${field}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_DATA_KEYS.has(key.toLowerCase())) {
        addError(errors, `${field}.${key}`, "raw secret or personal-identifier fields are forbidden");
      }
      validateNoSensitiveData(item, errors, `${field}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") return;
  for (const check of REDACTED_VALUE_PATTERNS) {
    if (check.pattern.test(value)) {
      addError(errors, field, `contains a ${check.label}; store a digest or redacted alias instead`);
    }
  }
}

function findReleaseArtifacts(releaseDir) {
  const entries = fs.readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const installers = entries.filter((name) => name.endsWith(".exe") && !name.endsWith(".exe.blockmap"));
  const blockmaps = entries.filter((name) => name.endsWith(".exe.blockmap"));
  const latest = entries.filter((name) => name === "latest.yml");
  if (installers.length !== 1 || blockmaps.length !== 1 || latest.length !== 1) {
    throw new Error("Expected exactly one Windows installer, one installer blockmap, and latest.yml.");
  }
  return [
    ["installer", installers[0]],
    ["blockmap", blockmaps[0]],
    ["update-manifest", latest[0]],
  ].map(([role, file]) => {
    const filePath = path.join(releaseDir, file);
    return {
      role,
      file,
      sha256: sha256File(filePath),
      sizeBytes: fs.statSync(filePath).size,
    };
  });
}

export function createBuildManifest({
  releaseDir,
  targetSha,
  releaseTag,
  repository,
  workflowName,
  workflowRunId,
  workflowRunAttempt,
  workflowUrl,
  inventoryPath = defaultInventoryPath,
  provenancePath = defaultProvenancePath,
  createdAt = new Date().toISOString(),
}) {
  const inventory = readJson(inventoryPath);
  const inventoryErrors = validateInventory(inventory);
  if (inventoryErrors.length > 0) {
    throw new Error(`Scenario inventory is invalid:\n${inventoryErrors.join("\n")}`);
  }
  const provenance = readJson(provenancePath);
  const provenanceErrors = validateProvenance(provenance);
  if (provenanceErrors.length > 0) {
    throw new Error(`Source provenance is invalid:\n${provenanceErrors.join("\n")}`);
  }
  const releaseMatch = releaseTag.match(RELEASE_TAG_PATTERN);
  if (!releaseMatch) throw new Error("releaseTag must look like v1.2.3.");
  if (!COMMIT_SHA_PATTERN.test(targetSha)) throw new Error("targetSha must be a lowercase 40-character commit SHA.");
  if (!SAFE_REPOSITORY_PATTERN.test(repository)) throw new Error("repository must look like owner/repo.");
  if (!/^\d+$/.test(String(workflowRunId)) || Number(workflowRunId) <= 0) {
    throw new Error("workflowRunId must be a positive integer.");
  }
  if (!Number.isSafeInteger(Number(workflowRunAttempt)) || Number(workflowRunAttempt) <= 0) {
    throw new Error("workflowRunAttempt must be a positive integer.");
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    createdAt,
    release: {
      repository,
      version: releaseMatch[1],
      tag: releaseTag,
      targetSha,
      architecture: "x64",
      workflow: {
        name: workflowName,
        event: "workflow_dispatch",
        runId: String(workflowRunId),
        runAttempt: Number(workflowRunAttempt),
        url: workflowUrl,
        publish: false,
      },
    },
    buildValidation: {
      signedBuild: true,
      validator: "apps/desktop/scripts/validate-win-artifacts.mjs",
      authenticode: "passed",
      rfc3161Timestamp: "passed",
      signerConsistency: "passed",
      publisherPin: "passed",
    },
    artifacts: findReleaseArtifacts(releaseDir),
    indexes: {
      scenarioInventory: {
        path: "docs/development/windows-full-system-scenarios.json",
        sha256: sha256JsonFile(inventoryPath),
      },
      sourceProvenance: {
        path: "docs/development/windows-source-provenance.json",
        sha256: sha256JsonFile(provenancePath),
      },
    },
    releaseGates: {
      signedBuildEnabled: true,
      nonPublishingWorkflow: true,
      githubReleaseCreated: false,
      publicReleaseEnabled: false,
      websiteReleaseReady: false,
    },
    approval: {
      state: "proof_pending",
      approvedTargetSha: null,
      approverRole: null,
      approvedAt: null,
    },
    scenarioResults: inventory.scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      status: "pending",
      hostAliases: [],
      evidenceIds: [],
      blockerCode: null,
    })),
    evidence: [],
  };
}

function validateArtifactEntries(errors, artifacts, version) {
  if (!Array.isArray(artifacts) || artifacts.length !== 3) {
    addError(errors, "artifacts", "must contain exactly installer, blockmap, and update-manifest entries");
    return;
  }
  const roles = new Set();
  artifacts.forEach((artifact, index) => {
    const field = `artifacts[${index}]`;
    if (!requireObject(errors, artifact, field)) return;
    rejectUnknownKeys(errors, artifact, field, ["role", "file", "sha256", "sizeBytes"]);
    if (requireString(errors, artifact.role, `${field}.role`, SAFE_ID_PATTERN)) roles.add(artifact.role);
    if (!requireString(errors, artifact.file, `${field}.file`) || !isSafeRelativePath(artifact.file) || artifact.file.includes("/")) {
      addError(errors, `${field}.file`, "must be a safe top-level relative file name");
    }
    requireString(errors, artifact.sha256, `${field}.sha256`, SHA256_PATTERN);
    requirePositiveInteger(errors, artifact.sizeBytes, `${field}.sizeBytes`);
  });
  for (const role of ["installer", "blockmap", "update-manifest"]) {
    if (!roles.has(role)) addError(errors, "artifacts", `is missing role ${role}`);
  }
  if (typeof version === "string" && version.length > 0) {
    const expectedFiles = {
      installer: `ADE-${version}-win-x64.exe`,
      blockmap: `ADE-${version}-win-x64.exe.blockmap`,
      "update-manifest": "latest.yml",
    };
    for (const artifact of artifacts) {
      if (expectedFiles[artifact.role] && artifact.file !== expectedFiles[artifact.role]) {
        addError(errors, `artifacts.${artifact.role}.file`, `must equal ${expectedFiles[artifact.role]}`);
      }
    }
  }
}

function verifyIndexedFile(errors, root, entry, field, { scanText = false } = {}) {
  if (!root || !entry || !isSafeRelativePath(entry.path)) return;
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, ...entry.path.split("/"));
  const relative = path.relative(absoluteRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    addError(errors, `${field}.path`, "escapes the supplied root");
    return;
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    addError(errors, `${field}.path`, `does not exist under ${absoluteRoot}`);
    return;
  }
  const stat = fs.statSync(absolutePath);
  if (entry.sizeBytes !== stat.size) addError(errors, `${field}.sizeBytes`, `expected ${stat.size}`);
  const digest = sha256File(absolutePath);
  if (entry.sha256 !== digest) addError(errors, `${field}.sha256`, `does not match ${entry.path}`);
  if (scanText && stat.size <= MAX_EVIDENCE_BYTES) {
    validateNoSensitiveData(fs.readFileSync(absolutePath, "utf8"), errors, `${field}.content`);
  }
}

export function validateManifest(manifest, {
  inventory,
  provenance,
  expectedSha,
  expectedTag = null,
  expectedWorkflowRunId = null,
  phase = "build",
  artifactRoot = null,
  evidenceRoot = null,
  inventoryPath = null,
  provenancePath = null,
} = {}) {
  const errors = [];
  if (!requireObject(errors, manifest, "manifest")) return errors;
  rejectUnknownKeys(errors, manifest, "manifest", [
    "schemaVersion",
    "createdAt",
    "release",
    "buildValidation",
    "artifacts",
    "indexes",
    "releaseGates",
    "approval",
    "scenarioResults",
    "evidence",
  ]);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    addError(errors, "schemaVersion", `must equal ${MANIFEST_SCHEMA_VERSION}`);
  }
  const expectedShaIsValid = requireString(errors, expectedSha, "expectedSha", COMMIT_SHA_PATTERN);
  requireIsoTimestamp(errors, manifest.createdAt, "createdAt");
  if (!["build", "complete", "publication-readiness", "draft-readiness"].includes(phase)) {
    addError(errors, "phase", "must be build, complete, publication-readiness, or draft-readiness");
  }
  const release = manifest.release;
  if (requireObject(errors, release, "release")) {
    rejectUnknownKeys(errors, release, "release", [
      "repository", "version", "tag", "targetSha", "architecture", "workflow",
    ]);
    requireString(errors, release.repository, "release.repository", SAFE_REPOSITORY_PATTERN);
    requireString(errors, release.version, "release.version");
    const tagValid = requireString(errors, release.tag, "release.tag", RELEASE_TAG_PATTERN);
    if (tagValid && release.tag !== `v${release.version}`) addError(errors, "release.tag", "must match release.version");
    if (expectedTag && release.tag !== expectedTag) {
      addError(errors, "release.tag", `must equal expected tag ${expectedTag}`);
    }
    requireString(errors, release.targetSha, "release.targetSha", COMMIT_SHA_PATTERN);
    if (expectedShaIsValid && release.targetSha !== expectedSha) {
      addError(errors, "release.targetSha", `must equal expected SHA ${expectedSha}`);
    }
    if (release.architecture !== "x64") addError(errors, "release.architecture", "must equal x64");
    const workflow = release.workflow;
    if (requireObject(errors, workflow, "release.workflow")) {
      rejectUnknownKeys(errors, workflow, "release.workflow", [
        "name", "event", "runId", "runAttempt", "url", "publish",
      ]);
      requireString(errors, workflow.name, "release.workflow.name");
      if (workflow.event !== "workflow_dispatch") addError(errors, "release.workflow.event", "must equal workflow_dispatch");
      requireString(errors, workflow.runId, "release.workflow.runId", /^\d+$/);
      if (expectedWorkflowRunId && workflow.runId !== expectedWorkflowRunId) {
        addError(errors, "release.workflow.runId", `must equal approved proof run ${expectedWorkflowRunId}`);
      }
      requirePositiveInteger(errors, workflow.runAttempt, "release.workflow.runAttempt");
      requireString(errors, workflow.url, "release.workflow.url", /^https:\/\/github\.com\//);
      if (typeof workflow.url === "string" && typeof workflow.runId === "string"
        && !workflow.url.endsWith(`/actions/runs/${workflow.runId}`)) {
        addError(errors, "release.workflow.url", "must end with the declared workflow run id");
      }
      if (workflow.publish !== false) addError(errors, "release.workflow.publish", "must be false");
    }
  }
  const buildValidation = manifest.buildValidation;
  if (requireObject(errors, buildValidation, "buildValidation")) {
    rejectUnknownKeys(errors, buildValidation, "buildValidation", [
      "signedBuild",
      "validator",
      "authenticode",
      "rfc3161Timestamp",
      "signerConsistency",
      "publisherPin",
    ]);
    if (buildValidation.signedBuild !== true) addError(errors, "buildValidation.signedBuild", "must be true");
    if (buildValidation.validator !== "apps/desktop/scripts/validate-win-artifacts.mjs") {
      addError(errors, "buildValidation.validator", "must name the canonical Windows artifact validator");
    }
    for (const gate of ["authenticode", "rfc3161Timestamp", "signerConsistency", "publisherPin"]) {
      if (buildValidation[gate] !== "passed") addError(errors, `buildValidation.${gate}`, "must equal passed");
    }
  }
  validateArtifactEntries(errors, manifest.artifacts, release?.version);
  if (artifactRoot && Array.isArray(manifest.artifacts)) {
    manifest.artifacts.forEach((artifact, index) => {
      verifyIndexedFile(errors, artifactRoot, { ...artifact, path: artifact.file }, `artifacts[${index}]`);
    });
  } else {
    addError(errors, "artifactRoot", "is required so release files are independently re-hashed");
  }

  const indexes = manifest.indexes;
  if (requireObject(errors, indexes, "indexes")) {
    rejectUnknownKeys(errors, indexes, "indexes", ["scenarioInventory", "sourceProvenance"]);
    for (const [name, expectedPath, suppliedPath] of [
      ["scenarioInventory", "docs/development/windows-full-system-scenarios.json", inventoryPath],
      ["sourceProvenance", "docs/development/windows-source-provenance.json", provenancePath],
    ]) {
      const entry = indexes[name];
      if (requireObject(errors, entry, `indexes.${name}`)) {
        rejectUnknownKeys(errors, entry, `indexes.${name}`, ["path", "sha256"]);
        if (entry.path !== expectedPath) addError(errors, `indexes.${name}.path`, `must equal ${expectedPath}`);
        requireString(errors, entry.sha256, `indexes.${name}.sha256`, SHA256_PATTERN);
        if (suppliedPath && fs.existsSync(suppliedPath) && entry.sha256 !== sha256JsonFile(suppliedPath)) {
          addError(errors, `indexes.${name}.sha256`, "does not match the supplied index file");
        }
      }
    }
  }
  const gates = manifest.releaseGates;
  if (requireObject(errors, gates, "releaseGates")) {
    rejectUnknownKeys(errors, gates, "releaseGates", [
      "signedBuildEnabled",
      "nonPublishingWorkflow",
      "githubReleaseCreated",
      "publicReleaseEnabled",
      "websiteReleaseReady",
    ]);
    if (gates.signedBuildEnabled !== true) addError(errors, "releaseGates.signedBuildEnabled", "must be true");
    if (gates.nonPublishingWorkflow !== true) addError(errors, "releaseGates.nonPublishingWorkflow", "must be true");
    for (const gate of ["githubReleaseCreated", "publicReleaseEnabled", "websiteReleaseReady"]) {
      if (gates[gate] !== false) addError(errors, `releaseGates.${gate}`, "must remain false during proof validation");
    }
  }
  const approval = manifest.approval;
  if (requireObject(errors, approval, "approval")) {
    rejectUnknownKeys(errors, approval, "approval", [
      "state", "approvedTargetSha", "approverRole", "approvedAt",
    ]);
    if (!APPROVAL_STATES.includes(approval.state)) addError(errors, "approval.state", "is unsupported");
    if (phase === "build" && approval.state !== "proof_pending") {
      addError(errors, "approval.state", "must be proof_pending during build validation");
    }
    if (phase === "complete" && approval.state !== "proof_complete") {
      addError(errors, "approval.state", "must equal proof_complete");
    }
    if (["build", "complete"].includes(phase)) {
      for (const field of ["approvedTargetSha", "approverRole", "approvedAt"]) {
        if (approval[field] !== null) addError(errors, `approval.${field}`, `must be null during ${phase} validation`);
      }
    }
    if (["publication-readiness", "draft-readiness"].includes(phase)) {
      if (approval.state !== "approved") addError(errors, "approval.state", "must equal approved");
      if (approval.approvedTargetSha !== release?.targetSha) {
        addError(errors, "approval.approvedTargetSha", "must equal release.targetSha");
      }
      if (approval.approverRole !== "windows-release-maintainer") {
        addError(errors, "approval.approverRole", "must equal windows-release-maintainer");
      }
      requireIsoTimestamp(errors, approval.approvedAt, "approval.approvedAt");
    }
  }

  const inventoryErrors = inventory ? validateInventory(inventory) : ["inventory: is required"];
  inventoryErrors.forEach((error) => errors.push(`inventory.${error}`));
  const provenanceErrors = provenance ? validateProvenance(provenance) : ["provenance: is required"];
  provenanceErrors.forEach((error) => errors.push(`provenance.${error}`));
  const inventoryScenarios = Array.isArray(inventory?.scenarios) ? inventory.scenarios : [];
  const scenariosById = new Map(inventoryScenarios.map((scenario) => [scenario?.id, scenario]));
  const postDraftGateIds = new Set(
    (Array.isArray(inventory?.acceptanceGates) ? inventory.acceptanceGates : [])
      .filter((gate) => gate?.stage === "post-draft" && typeof gate.id === "string")
      .map((gate) => gate.id),
  );
  const scenarioIsPostDraft = (scenario) => (
    Array.isArray(scenario?.acceptanceGateIds)
    && scenario.acceptanceGateIds.some((gateId) => postDraftGateIds.has(gateId))
  );
  const evidenceById = new Map();
  const evidencePaths = new Map();
  const evidenceDigests = new Map();
  const coveredEvidenceKinds = new Set();
  if (!Array.isArray(manifest.evidence)) {
    addError(errors, "evidence", "must be an array");
  } else {
    manifest.evidence.forEach((entry, index) => {
      const field = `evidence[${index}]`;
      if (!requireObject(errors, entry, field)) return;
      rejectUnknownKeys(errors, entry, field, [
        "id",
        "kind",
        "collectionMethod",
        "hostAlias",
        "path",
        "sha256",
        "sizeBytes",
        "collectedAt",
        "scenarioIds",
        "redaction",
      ]);
      if (requireString(errors, entry.id, `${field}.id`, SAFE_ID_PATTERN)) {
        if (evidenceById.has(entry.id)) addError(errors, `${field}.id`, "must be unique");
        evidenceById.set(entry.id, entry);
      }
      if (!EVIDENCE_KINDS.includes(entry.kind)) addError(errors, `${field}.kind`, "is unsupported");
      else coveredEvidenceKinds.add(entry.kind);
      requireString(errors, entry.collectionMethod, `${field}.collectionMethod`, SAFE_ID_PATTERN);
      requireString(errors, entry.hostAlias, `${field}.hostAlias`, SAFE_HOST_ALIAS_PATTERN);
      if (!requireString(errors, entry.path, `${field}.path`) || !isSafeRelativePath(entry.path)) {
        addError(errors, `${field}.path`, "must be a safe relative path using forward slashes");
      } else {
        if (evidencePaths.has(entry.path)) {
          addError(errors, `${field}.path`, `duplicates ${evidencePaths.get(entry.path)}; independent evidence must use a unique file`);
        } else {
          evidencePaths.set(entry.path, field);
        }
        const extension = path.posix.extname(entry.path).toLowerCase();
        const allowedExtensions = entry.kind === "gui"
          ? GUI_EVIDENCE_EXTENSIONS
          : STRUCTURED_EVIDENCE_EXTENSIONS;
        if (!allowedExtensions.has(extension)) {
          addError(errors, `${field}.path`, `${entry.kind} evidence uses a forbidden file type`);
        }
      }
      requireString(errors, entry.sha256, `${field}.sha256`, SHA256_PATTERN);
      if (typeof entry.sha256 === "string" && SHA256_PATTERN.test(entry.sha256)) {
        if (evidenceDigests.has(entry.sha256)) {
          addError(errors, `${field}.sha256`, `duplicates ${evidenceDigests.get(entry.sha256)}; independent evidence must have unique content`);
        } else {
          evidenceDigests.set(entry.sha256, field);
        }
      }
      requirePositiveInteger(errors, entry.sizeBytes, `${field}.sizeBytes`);
      if (Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes > MAX_EVIDENCE_BYTES) {
        addError(errors, `${field}.sizeBytes`, `must not exceed ${MAX_EVIDENCE_BYTES} bytes`);
      }
      requireIsoTimestamp(errors, entry.collectedAt, `${field}.collectedAt`);
      requireStringArray(errors, entry.scenarioIds, `${field}.scenarioIds`, { pattern: SAFE_ID_PATTERN });
      if (Array.isArray(entry.scenarioIds)) {
        entry.scenarioIds.forEach((id) => {
          if (!scenariosById.has(id)) addError(errors, `${field}.scenarioIds`, `${id} is not in the inventory`);
        });
      }
      if (requireObject(errors, entry.redaction, `${field}.redaction`)) {
        rejectUnknownKeys(errors, entry.redaction, `${field}.redaction`, [
          "status", "containsSecrets", "containsPersonalIdentifiers",
        ]);
        if (entry.redaction.status !== "redacted") addError(errors, `${field}.redaction.status`, "must equal redacted");
        if (entry.redaction.containsSecrets !== false) addError(errors, `${field}.redaction.containsSecrets`, "must be false");
        if (entry.redaction.containsPersonalIdentifiers !== false) {
          addError(errors, `${field}.redaction.containsPersonalIdentifiers`, "must be false");
        }
      }
      if (evidenceRoot) verifyIndexedFile(errors, evidenceRoot, entry, field, {
        scanText: entry.kind !== "gui",
      });
    });
  }
  if (phase !== "build" && !evidenceRoot) {
    addError(errors, "evidenceRoot", "is required after build validation");
  }

  if (!Array.isArray(manifest.scenarioResults)) {
    addError(errors, "scenarioResults", "must be an array");
  } else {
    const resultsById = new Map();
    manifest.scenarioResults.forEach((result, index) => {
      const field = `scenarioResults[${index}]`;
      if (!requireObject(errors, result, field)) return;
      rejectUnknownKeys(errors, result, field, [
        "scenarioId", "status", "hostAliases", "evidenceIds", "blockerCode",
      ]);
      if (requireString(errors, result.scenarioId, `${field}.scenarioId`, SAFE_ID_PATTERN)) {
        if (resultsById.has(result.scenarioId)) addError(errors, `${field}.scenarioId`, "must be unique");
        resultsById.set(result.scenarioId, result);
      }
      if (!RESULT_STATES.includes(result.status)) addError(errors, `${field}.status`, "is unsupported");
      const resultScenario = scenariosById.get(result.scenarioId);
      const requiresScenarioProof = phase === "draft-readiness"
        || (phase !== "build" && !scenarioIsPostDraft(resultScenario));
      requireStringArray(errors, result.hostAliases, `${field}.hostAliases`, {
        allowEmpty: !requiresScenarioProof,
        pattern: SAFE_HOST_ALIAS_PATTERN,
      });
      requireStringArray(errors, result.evidenceIds, `${field}.evidenceIds`, {
        allowEmpty: !requiresScenarioProof,
        pattern: SAFE_ID_PATTERN,
      });
      if (result.blockerCode !== null && !SAFE_ID_PATTERN.test(result.blockerCode ?? "")) {
        addError(errors, `${field}.blockerCode`, "must be null or a redacted code");
      }
      if (result.status === "blocked" && result.blockerCode === null) {
        addError(errors, `${field}.blockerCode`, "is required when status is blocked");
      } else if (result.status !== "blocked" && result.blockerCode !== null) {
        addError(errors, `${field}.blockerCode`, "must be null unless status is blocked");
      }
    });
    for (const [scenarioId, scenario] of scenariosById) {
      const result = resultsById.get(scenarioId);
      if (!result) {
        addError(errors, "scenarioResults", `is missing ${scenarioId}`);
        continue;
      }
      const requiresScenarioProof = phase === "draft-readiness"
        || (phase !== "build" && !scenarioIsPostDraft(scenario));
      if (requiresScenarioProof && result.status !== "pass") {
        addError(errors, `scenarioResults.${scenarioId}.status`, "must equal pass");
      }
      if (requiresScenarioProof) {
        const resultEvidenceIds = Array.isArray(result.evidenceIds) ? result.evidenceIds : [];
        const resultHostAliases = Array.isArray(result.hostAliases)
          ? result.hostAliases.filter((hostAlias) => typeof hostAlias === "string")
          : [];
        const scenarioHosts = Array.isArray(scenario?.hosts)
          ? scenario.hosts.filter((host) => typeof host === "string")
          : [];
        const allowedHostPrefixes = new Set(scenarioHosts.map((host) => (
          host.startsWith("windows-10") ? "win10-" : "win11-"
        )));
        for (const hostAlias of resultHostAliases) {
          if (![...allowedHostPrefixes].some((prefix) => hostAlias.startsWith(prefix))) {
            addError(errors, `scenarioResults.${scenarioId}.hostAliases`, `${hostAlias} does not match a declared scenario host`);
          }
        }
        for (const prefix of allowedHostPrefixes) {
          if (!resultHostAliases.some((hostAlias) => hostAlias.startsWith(prefix))) {
            addError(errors, `scenarioResults.${scenarioId}.hostAliases`, `is missing required ${prefix.slice(0, -1)} host evidence`);
          }
        }
        const linkedEvidence = resultEvidenceIds.map((id) => evidenceById.get(id)).filter(Boolean);
        const linkedKinds = new Set(linkedEvidence.map((entry) => entry.kind));
        for (const prefix of allowedHostPrefixes) {
          if (!linkedEvidence.some((entry) => (
            typeof entry.hostAlias === "string" && entry.hostAlias.startsWith(prefix)
          ))) {
            addError(errors, `scenarioResults.${scenarioId}.evidenceIds`, `is missing evidence collected on a required ${prefix.slice(0, -1)} host`);
          }
        }
        for (const evidenceId of resultEvidenceIds) {
          if (!evidenceById.has(evidenceId)) {
            addError(errors, `scenarioResults.${scenarioId}.evidenceIds`, `${evidenceId} is not indexed`);
          } else {
            const linkedEntry = evidenceById.get(evidenceId);
            if (!Array.isArray(linkedEntry.scenarioIds) || !linkedEntry.scenarioIds.includes(scenarioId)) {
              addError(errors, `scenarioResults.${scenarioId}.evidenceIds`, `${evidenceId} does not link back to the scenario`);
            }
            if (!resultHostAliases.includes(linkedEntry.hostAlias)) {
              addError(errors, `scenarioResults.${scenarioId}.hostAliases`, `does not include ${evidenceId}'s host alias`);
            }
          }
        }
        const requiredKinds = Array.isArray(scenario?.requiredEvidenceKinds)
          ? scenario.requiredEvidenceKinds
          : [];
        for (const kind of requiredKinds) {
          if (!linkedKinds.has(kind)) {
            addError(errors, `scenarioResults.${scenarioId}.evidenceIds`, `is missing required ${kind} evidence`);
          }
        }
      }
    }
    for (const scenarioId of resultsById.keys()) {
      if (!scenariosById.has(scenarioId)) addError(errors, "scenarioResults", `contains unknown ${scenarioId}`);
    }
    for (const entry of evidenceById.values()) {
      if (!Array.isArray(entry.scenarioIds)) continue;
      for (const scenarioId of entry.scenarioIds) {
        const result = resultsById.get(scenarioId);
        if (result && (!Array.isArray(result.evidenceIds) || !result.evidenceIds.includes(entry.id))) {
          addError(errors, `evidence.${entry.id}.scenarioIds`, `${scenarioId} does not link back to the evidence`);
        }
      }
    }
  }
  if (phase !== "build") {
    for (const kind of EVIDENCE_KINDS) {
      if (!coveredEvidenceKinds.has(kind)) addError(errors, "evidence", `is missing global ${kind} coverage`);
    }
  }
  validateNoSensitiveData(manifest, errors);
  return errors;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function throwValidation(label, errors) {
  if (errors.length > 0) throw new Error(`${label} failed:\n- ${errors.join("\n- ")}`);
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command === "create") {
    for (const required of [
      "output",
      "release-dir",
      "target-sha",
      "release-tag",
      "repository",
      "workflow-name",
      "workflow-run-id",
      "workflow-run-attempt",
      "workflow-url",
    ]) {
      if (!options[required]) throw new Error(`create requires --${required}`);
    }
    const manifest = createBuildManifest({
      releaseDir: options["release-dir"],
      targetSha: options["target-sha"].toLowerCase(),
      releaseTag: options["release-tag"],
      repository: options.repository,
      workflowName: options["workflow-name"],
      workflowRunId: options["workflow-run-id"],
      workflowRunAttempt: options["workflow-run-attempt"],
      workflowUrl: options["workflow-url"],
      inventoryPath: options.inventory ?? defaultInventoryPath,
      provenancePath: options.provenance ?? defaultProvenancePath,
    });
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`Created Windows proof manifest for ${manifest.release.targetSha}: ${options.output}\n`);
    return;
  }
  if (command === "validate-inventory") {
    const inventoryPath = options.inventory ?? defaultInventoryPath;
    throwValidation("Windows scenario inventory validation", validateInventory(readJson(inventoryPath)));
    process.stdout.write(`Validated Windows scenario inventory: ${inventoryPath}\n`);
    return;
  }
  if (command === "validate-provenance") {
    const provenancePath = options.provenance ?? defaultProvenancePath;
    throwValidation("Windows source provenance validation", validateProvenance(readJson(provenancePath)));
    process.stdout.write(`Validated Windows source provenance: ${provenancePath}\n`);
    return;
  }
  if (command === "validate") {
    if (!options.manifest) throw new Error("validate requires --manifest");
    const inventoryPath = options.inventory ?? defaultInventoryPath;
    const provenancePath = options.provenance ?? defaultProvenancePath;
    const phase = options.phase ?? "build";
    if (options["expected-sha"] && !COMMIT_SHA_PATTERN.test(options["expected-sha"])) {
      throw new Error("--expected-sha must be a lowercase 40-character commit SHA.");
    }
    if (options["expected-tag"] && !RELEASE_TAG_PATTERN.test(options["expected-tag"])) {
      throw new Error("--expected-tag must look like v1.2.3.");
    }
    if (options["expected-run-id"] && !/^\d+$/.test(options["expected-run-id"])) {
      throw new Error("--expected-run-id must contain only decimal digits.");
    }
    const errors = validateManifest(readJson(options.manifest), {
      inventory: readJson(inventoryPath),
      provenance: readJson(provenancePath),
      expectedSha: options["expected-sha"],
      expectedTag: options["expected-tag"] ?? null,
      expectedWorkflowRunId: options["expected-run-id"] ?? null,
      phase,
      artifactRoot: options["artifact-root"] ?? null,
      evidenceRoot: options["evidence-root"] ?? null,
      inventoryPath,
      provenancePath,
    });
    throwValidation(`Windows proof manifest ${phase} validation`, errors);
    process.stdout.write(`Validated Windows proof manifest (${phase}): ${options.manifest}\n`);
    return;
  }
  throw new Error(
    "Usage: windows-proof-manifest.mjs <create|validate|validate-inventory|validate-provenance> [options]",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
