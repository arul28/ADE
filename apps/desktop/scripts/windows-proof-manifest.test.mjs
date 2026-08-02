import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_KINDS,
  createBuildManifest,
  sha256File,
  validateInventory,
  validateManifest,
  validateProvenance,
} from "./windows-proof-manifest.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const inventoryPath = path.join(repoRoot, "docs", "development", "windows-full-system-scenarios.json");
const provenancePath = path.join(repoRoot, "docs", "development", "windows-source-provenance.json");
const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
const targetSha = "0123456789abcdef0123456789abcdef01234567";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-windows-proof-"));
  const releaseDir = path.join(root, "release");
  const evidenceRoot = path.join(root, "evidence");
  fs.mkdirSync(releaseDir);
  fs.mkdirSync(evidenceRoot);
  fs.writeFileSync(path.join(releaseDir, "ADE-1.2.3-win-x64.exe"), "signed installer fixture");
  fs.writeFileSync(path.join(releaseDir, "ADE-1.2.3-win-x64.exe.blockmap"), "blockmap fixture");
  fs.writeFileSync(path.join(releaseDir, "latest.yml"), "version: 1.2.3\n");
  fs.writeFileSync(path.join(releaseDir, "ade-win32-x64.exe"), "standalone runtime fixture");
  fs.writeFileSync(path.join(releaseDir, "ade-win32-x64.native.tar.gz"), "standalone native archive fixture");
  fs.writeFileSync(path.join(releaseDir, "install.ps1"), "Write-Output 'install fixture'\n");
  const checksummedFiles = ["ade-win32-x64.exe", "ade-win32-x64.native.tar.gz", "install.ps1"];
  fs.writeFileSync(path.join(releaseDir, "SHA256SUMS"), checksummedFiles
    .map((file) => `${sha256File(path.join(releaseDir, file))}  ${file}`)
    .join("\n") + "\n");
  const manifest = createBuildManifest({
    releaseDir,
    targetSha,
    releaseTag: "v1.2.3",
    repository: "arul28/ADE",
    workflowName: "Prepare release",
    workflowRunId: "12345",
    workflowRunAttempt: "1",
    workflowUrl: "https://github.com/arul28/ADE/actions/runs/12345",
    inventoryPath,
    provenancePath,
    createdAt: "2026-08-01T12:00:00.000Z",
  });
  return { root, releaseDir, evidenceRoot, manifest };
}

function completeManifest(manifest, evidenceRoot) {
  manifest.approval = {
    state: "proof_complete",
    approvedTargetSha: null,
    approverRole: null,
    approvedAt: null,
  };
  let evidenceNumber = 0;
  const evidence = [];
  for (const result of manifest.scenarioResults) {
    const scenario = inventory.scenarios.find((candidate) => candidate.id === result.scenarioId);
    result.status = "pass";
    result.hostAliases = [...new Set(scenario.hosts.map((host) => (
      host.startsWith("windows-10") ? "win10-lab" : "win11-lab"
    )))];
    result.blockerCode = null;
    result.evidenceIds = [];
    for (const hostAlias of result.hostAliases) {
      for (const kind of scenario.requiredEvidenceKinds) {
        evidenceNumber += 1;
        const id = `proof-${String(evidenceNumber).padStart(4, "0")}`;
        const relativePath = `${String(evidenceNumber).padStart(4, "0")}-${scenario.id}-${hostAlias}-${kind}.${kind === "gui" ? "png" : "txt"}`;
        const absolutePath = path.join(evidenceRoot, ...relativePath.split("/"));
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, `${scenario.id} ${hostAlias} ${kind} redacted proof\n`);
        evidence.push({
          id,
          kind,
          collectionMethod: `${kind}-probe`,
          hostAlias,
          path: relativePath,
          sha256: sha256File(absolutePath),
          sizeBytes: fs.statSync(absolutePath).size,
          collectedAt: "2026-08-01T13:00:00.000Z",
          scenarioIds: [scenario.id],
          redaction: {
            status: "redacted",
            containsSecrets: false,
            containsPersonalIdentifiers: false,
          },
        });
        result.evidenceIds.push(id);
      }
    }
  }
  manifest.evidence = evidence;
  assert.deepEqual(new Set(evidence.map((entry) => entry.kind)), new Set(EVIDENCE_KINDS));
}

test("committed Windows scenario inventory covers the full declared matrix", () => {
  assert.deepEqual(validateInventory(inventory), []);
  assert.deepEqual(inventory.dimensions.shells, ["powershell-5-1", "powershell-7", "cmd", "git-bash"]);
  const genericShell = clone(inventory);
  genericShell.dimensions.shells[0] = "powershell";
  assert.ok(validateInventory(genericShell).some((error) => error.includes("unknown shell")));
  const incomplete = clone(inventory);
  incomplete.acceptanceGates.find((gate) => gate.id === "shell-conpty-matrix").requirements.pop();
  assert.ok(validateInventory(incomplete).some((error) => error.includes("shell-conpty-matrix") || error.includes("crash-restore")));
  const weakened = clone(inventory);
  const shellScenario = weakened.scenarios.find((scenario) => scenario.id === "explicit-shell-conpty-matrix");
  shellScenario.acceptanceRequirementIds.pop();
  shellScenario.id = "generic-shell-check";
  const weakenedErrors = validateInventory(weakened);
  assert.ok(weakenedErrors.some((error) => error.includes("crash-restore")));
  assert.ok(weakenedErrors.some((error) => error.includes("explicit-shell-conpty-matrix")));
});

test("committed provenance maps every #999 source commit into stack layers", () => {
  assert.deepEqual(validateProvenance(provenance), []);
  assert.equal(provenance.sourcePullRequest.authorName, "David Whatley");
  assert.equal(provenance.commitMappings.length, 9);
  assert.deepEqual(new Set(provenance.sourceReviewDispositions.map(({ id }) => id)), new Set([
    "codex-p2-windows-desktop-app-channel",
    "codex-p2-windows-supervisor-registration",
  ]));

  const omittedDisposition = clone(provenance);
  omittedDisposition.sourceReviewDispositions.pop();
  assert.ok(validateProvenance(omittedDisposition).some((error) => error.includes("both original #999 Codex P2 dispositions")));

  const changedMapping = clone(provenance);
  changedMapping.commitMappings[0].rebasedSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.ok(validateProvenance(changedMapping).some((error) => error.includes("reviewed rebased commit")));
});

test("build manifest is exact-SHA, non-publishing, and artifact-bound", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.deepEqual(validateManifest(fixture.manifest, {
    inventory,
    provenance,
    expectedSha: targetSha,
    expectedTag: "v1.2.3",
    expectedWorkflowRunId: "12345",
    phase: "build",
    artifactRoot: fixture.releaseDir,
    inventoryPath,
    provenancePath,
  }), []);
  assert.equal(fixture.manifest.release.workflow.publish, false);
  assert.equal(fixture.manifest.releaseGates.publicReleaseEnabled, false);
  assert.equal(fixture.manifest.releaseGates.websiteReleaseReady, false);
  assert.deepEqual(fixture.manifest.artifacts.map(({ role }) => role), [
    "installer",
    "blockmap",
    "update-manifest",
    "standalone-runtime",
    "standalone-native-archive",
    "standalone-installer",
    "runtime-checksums",
  ]);

  const wrongBuildIdentity = validateManifest(fixture.manifest, {
    inventory,
    provenance,
    expectedSha: targetSha,
    expectedTag: "v1.2.4",
    expectedWorkflowRunId: "54321",
    phase: "build",
    artifactRoot: fixture.releaseDir,
    inventoryPath,
    provenancePath,
  });
  assert.ok(wrongBuildIdentity.some((error) => error.includes("expected tag v1.2.4")));
  assert.ok(wrongBuildIdentity.some((error) => error.includes("approved proof run 54321")));
});

test("build validation rejects a different approved SHA or changed artifact", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let errors = validateManifest(fixture.manifest, {
    inventory,
    provenance,
    expectedSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    phase: "build",
    artifactRoot: fixture.releaseDir,
    inventoryPath,
    provenancePath,
  });
  assert.ok(errors.some((error) => error.includes("must equal expected SHA")));
  fs.appendFileSync(path.join(fixture.releaseDir, "ADE-1.2.3-win-x64.exe"), "changed");
  errors = validateManifest(fixture.manifest, {
    inventory,
    provenance,
    expectedSha: targetSha,
    phase: "build",
    artifactRoot: fixture.releaseDir,
    inventoryPath,
    provenancePath,
  });
  assert.ok(errors.some((error) => error.includes("artifacts[0].sha256")));
});

test("build validation rejects a checksum manifest that does not bind standalone runtime bytes", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const checksumPath = path.join(fixture.releaseDir, "SHA256SUMS");
  const changedChecksums = fs.readFileSync(checksumPath, "utf8").replace(
    /^[0-9a-f]{64}(  ade-win32-x64\.exe)$/m,
    `${"a".repeat(64)}$1`,
  );
  fs.writeFileSync(checksumPath, changedChecksums);
  const checksumArtifact = fixture.manifest.artifacts.find(({ role }) => role === "runtime-checksums");
  checksumArtifact.sha256 = sha256File(checksumPath);
  checksumArtifact.sizeBytes = fs.statSync(checksumPath).size;

  const errors = validateManifest(fixture.manifest, {
    inventory,
    provenance,
    expectedSha: targetSha,
    phase: "build",
    artifactRoot: fixture.releaseDir,
    inventoryPath,
    provenancePath,
  });
  assert.ok(errors.some((error) => error.includes("does not bind the declared SHA-256 for ade-win32-x64.exe")));
});

test("complete validation re-hashes indexed evidence and enforces independent signals", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  completeManifest(fixture.manifest, fixture.evidenceRoot);
  assert.deepEqual(validateManifest(fixture.manifest, {
    inventory,
    provenance,
    expectedSha: targetSha,
    phase: "complete",
    artifactRoot: fixture.releaseDir,
    evidenceRoot: fixture.evidenceRoot,
    inventoryPath,
    provenancePath,
  }), []);

  const firstResult = fixture.manifest.scenarioResults[0];
  const removedId = firstResult.evidenceIds.shift();
  const errors = validateManifest(fixture.manifest, {
    inventory,
    provenance,
    expectedSha: targetSha,
    phase: "complete",
    artifactRoot: fixture.releaseDir,
    evidenceRoot: fixture.evidenceRoot,
    inventoryPath,
    provenancePath,
  });
  const removedKind = fixture.manifest.evidence.find((entry) => entry.id === removedId).kind;
  assert.ok(errors.some((error) => error.includes(`missing required ${removedKind} evidence`)));
});

test("complete validation rejects duplicate, sensitive, or cross-host evidence", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  completeManifest(fixture.manifest, fixture.evidenceRoot);

  const duplicate = fixture.manifest.evidence[1];
  duplicate.path = fixture.manifest.evidence[0].path;
  duplicate.sha256 = fixture.manifest.evidence[0].sha256;
  duplicate.sizeBytes = fixture.manifest.evidence[0].sizeBytes;
  const sensitiveEntry = fixture.manifest.evidence.find((entry) => entry !== duplicate && entry.kind !== "gui");
  const sensitivePath = path.join(fixture.evidenceRoot, ...sensitiveEntry.path.split("/"));
  fs.writeFileSync(sensitivePath, "operator@example.com\n");
  sensitiveEntry.sha256 = sha256File(sensitivePath);
  sensitiveEntry.sizeBytes = fs.statSync(sensitivePath).size;
  const win11Result = fixture.manifest.scenarioResults.find((result) => {
    const scenario = inventory.scenarios.find((candidate) => candidate.id === result.scenarioId);
    return scenario.hosts.every((host) => host === "windows-11-x64");
  });
  win11Result.hostAliases = ["win10-lab"];

  const errors = validateManifest(fixture.manifest, {
    inventory,
    provenance,
    expectedSha: targetSha,
    phase: "complete",
    artifactRoot: fixture.releaseDir,
    evidenceRoot: fixture.evidenceRoot,
    inventoryPath,
    provenancePath,
  });
  assert.ok(errors.some((error) => error.includes("independent evidence must use a unique file")));
  assert.ok(errors.some((error) => error.includes("independent evidence must have unique content")));
  assert.ok(errors.some((error) => error.includes("email address")));
  assert.ok(errors.some((error) => error.includes("does not match a declared scenario host")));

  const bothHosts = fixture.manifest.scenarioResults.find((result) => {
    const scenario = inventory.scenarios.find((candidate) => candidate.id === result.scenarioId);
    return scenario.hosts.includes("windows-10-22h2-x64") && scenario.hosts.includes("windows-11-x64");
  });
  bothHosts.hostAliases = ["win10-lab"];
  const missingOsErrors = validateManifest(fixture.manifest, {
    inventory,
    provenance,
    expectedSha: targetSha,
    phase: "complete",
    artifactRoot: fixture.releaseDir,
    evidenceRoot: fixture.evidenceRoot,
    inventoryPath,
    provenancePath,
  });
  assert.ok(missingOsErrors.some((error) => error.includes("missing required win11 host evidence")));
});

test("malformed evidence links return validation errors instead of throwing", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  completeManifest(fixture.manifest, fixture.evidenceRoot);
  fixture.manifest.evidence[0].scenarioIds = "not-an-array";
  fixture.manifest.evidence[1].hostAlias = 7;
  fixture.manifest.scenarioResults[0].evidenceIds = "not-an-array";
  fixture.manifest.scenarioResults[1].hostAliases = [7];
  const malformedInventory = clone(inventory);
  malformedInventory.scenarios[0].hosts = [7];
  malformedInventory.dimensions.operatingSystems = {};
  const malformedProvenance = clone(provenance);
  const malformedDispositionIndex = malformedProvenance.sourceReviewDispositions.findIndex(
    ({ id }) => id === "codex-p2-windows-supervisor-registration",
  );
  malformedProvenance.sourceReviewDispositions[malformedDispositionIndex].disposition = 7;

  assert.doesNotThrow(() => validateManifest(fixture.manifest, {
    inventory: malformedInventory,
    provenance: malformedProvenance,
    expectedSha: targetSha,
    phase: "complete",
    artifactRoot: fixture.releaseDir,
    evidenceRoot: fixture.evidenceRoot,
    inventoryPath,
    provenancePath,
  }));
  const errors = validateManifest(fixture.manifest, {
    inventory: malformedInventory,
    provenance: malformedProvenance,
    expectedSha: targetSha,
    phase: "complete",
    artifactRoot: fixture.releaseDir,
    evidenceRoot: fixture.evidenceRoot,
    inventoryPath,
    provenancePath,
  });
  assert.ok(errors.some((error) => error.includes("evidence[0].scenarioIds")));
  assert.ok(errors.some((error) => error.includes("evidence[1].hostAlias")));
  assert.ok(errors.some((error) => error.includes("scenarioResults[0].evidenceIds")));
  assert.ok(errors.some((error) => error.includes("scenarioResults[1].hostAliases")));
  assert.ok(errors.some((error) => error.includes("scenarios[0].hosts[0]")));
  assert.ok(errors.some((error) => error.includes("dimensions.operatingSystems")));
  assert.ok(errors.some((error) => error.includes(`sourceReviewDispositions[${malformedDispositionIndex}].disposition`)));
});

test("manifest rejects unsafe evidence paths and obvious identifiers", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  completeManifest(fixture.manifest, fixture.evidenceRoot);
  fixture.manifest.evidence[0].path = "../outside.txt";
  fixture.manifest.operatorNote = "Captured under C:\\Users\\ExamplePerson";
  const errors = validateManifest(fixture.manifest, {
    inventory,
    provenance,
    expectedSha: targetSha,
    phase: "complete",
    artifactRoot: fixture.releaseDir,
    evidenceRoot: fixture.evidenceRoot,
    inventoryPath,
    provenancePath,
  });
  assert.ok(errors.some((error) => error.includes("safe relative path")));
  assert.ok(errors.some((error) => error.includes("Windows user profile path")));
});

test("publication readiness requires role-based exact-SHA approval while gates stay disabled", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  completeManifest(fixture.manifest, fixture.evidenceRoot);
  fixture.manifest.approval = {
    state: "approved",
    approvedTargetSha: targetSha,
    approverRole: "windows-release-maintainer",
    approvedAt: "2026-08-01T14:00:00.000Z",
  };
  const postDraftScenario = inventory.scenarios.find((scenario) => (
    scenario.acceptanceGateIds?.includes("draft-assets-and-website")
  ));
  const postDraftResult = fixture.manifest.scenarioResults.find((result) => (
    result.scenarioId === postDraftScenario.id
  ));
  const postDraftEvidenceIds = new Set(postDraftResult.evidenceIds);
  postDraftResult.status = "pending";
  postDraftResult.hostAliases = [];
  postDraftResult.evidenceIds = [];
  fixture.manifest.evidence = fixture.manifest.evidence.filter((entry) => !postDraftEvidenceIds.has(entry.id));
  assert.deepEqual(validateManifest(fixture.manifest, {
    inventory,
    provenance,
    expectedSha: targetSha,
    phase: "publication-readiness",
    artifactRoot: fixture.releaseDir,
    evidenceRoot: fixture.evidenceRoot,
    inventoryPath,
    provenancePath,
  }), []);

  const draftErrors = validateManifest(fixture.manifest, {
    inventory,
    provenance,
    expectedSha: targetSha,
    phase: "draft-readiness",
    artifactRoot: fixture.releaseDir,
    evidenceRoot: fixture.evidenceRoot,
    inventoryPath,
    provenancePath,
  });
  assert.ok(draftErrors.some((error) => error.includes(`${postDraftScenario.id}.status`)));

  const enabled = clone(fixture.manifest);
  enabled.releaseGates.websiteReleaseReady = true;
  const errors = validateManifest(enabled, {
    inventory,
    provenance,
    expectedSha: targetSha,
    phase: "publication-readiness",
    artifactRoot: fixture.releaseDir,
    evidenceRoot: fixture.evidenceRoot,
    inventoryPath,
    provenancePath,
  });
  assert.ok(errors.some((error) => error.includes("websiteReleaseReady")));
});
