export const INVENTORY_SCHEMA_VERSION = "ade.windows-proof-scenarios/v1";
export const PROVENANCE_SCHEMA_VERSION = "ade.windows-source-provenance/v1";
export const EVIDENCE_KINDS = ["gui", "log", "db", "process", "ipc", "network"];

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PROVIDERS = ["claude", "codex", "cursor", "opencode", "droid"];
const PROVIDER_STATES = [
  "authenticated", "unauthenticated", "fresh", "resume", "recovery-metadata",
  "recovery-instructions", "redaction",
];
const REQUIRED_ACCEPTANCE_GATES = new Map([
  ["shell-conpty-matrix", [
    "powershell-5-1", "powershell-7", "cmd", "git-bash", "conpty-unicode",
    "conpty-metacharacters", "conpty-resize", "conpty-ctrl-c", "conpty-cancel",
    "descendant-cleanup", "crash-restore",
  ]],
  ["provider-lifecycle-matrix", PROVIDERS.flatMap((provider) => (
    PROVIDER_STATES.map((state) => `${provider}-${state}`)
  ))],
  ["standalone-cli-brain", [
    "ade-win32-x64", "install", "start", "status", "doctor", "update",
    "remote-bootstrap", "openssh-prerequisite", "damaged-install-recovery",
  ]],
  ["brain-host-lifecycle", [
    "desktop-closed", "brain-crash", "brain-restart", "login", "logout", "reboot",
    "repair", "reinstall", "uninstall",
  ]],
  ["account-oauth-directory", [
    "default-browser-callback", "encrypted-persistence", "reauthentication", "sign-out",
    "existing-machine-discovery",
  ]],
  ["cross-machine-directions", [
    "windows-session-to-macos", "windows-session-to-physical-ios",
    "windows-session-to-hosted-web", "macos-session-to-windows",
    "windows-client-to-macos-linux-runtime", "macos-linux-client-to-windows-runtime",
  ]],
  ["transport-streaming-reconnect", [
    "lan-firewall", "tailscale", "relay", "reconnect", "terminal-streaming",
    "chat-streaming", "remote-commands",
  ]],
  ["signed-updater-proof", [
    "signed-n-to-n-plus-one", "rfc3161-timestamp", "publisher-identity",
    "tamper-rejection", "relaunch", "brain-recovery", "data-preservation",
    "smartscreen-observation",
  ]],
  ["unchanged-release-paths", [
    "macos-desktop", "macos-runtime", "linux-runtime", "web", "relay", "ios",
  ]],
  ["draft-assets-and-website", [
    "installer", "blockmap", "latest-yml", "checksums", "update-metadata",
    "website-link-disabled", "website-link-correct",
  ]],
]);
const POST_DRAFT_GATE_IDS = new Set(["draft-assets-and-website"]);
const REQUIRED_GATE_SCENARIO_IDS = new Map([
  ["shell-conpty-matrix", "explicit-shell-conpty-matrix"],
  ["provider-lifecycle-matrix", "explicit-provider-lifecycle-matrix"],
  ["standalone-cli-brain", "standalone-cli-brain-lifecycle"],
  ["brain-host-lifecycle", "brain-host-lifecycle-explicit"],
  ["account-oauth-directory", "account-oauth-directory-explicit"],
  ["cross-machine-directions", "cross-machine-directions-explicit"],
  ["transport-streaming-reconnect", "transport-streaming-reconnect-explicit"],
  ["signed-updater-proof", "signed-updater-proof-explicit"],
  ["unchanged-release-paths", "unchanged-release-paths-explicit"],
  ["draft-assets-and-website", "draft-assets-website-explicit"],
]);
const SOURCE_999_COMMITS = [
  "9b1ffc367d71b387ba0d49850d37827a1703cfce",
  "236330ad9095d6e30f2068572faec5b53ae7c1b2",
  "615eda5ec4a8b81c1e99f02030817dad5880878d",
  "0eae1517c9b5caa67a6eb5a12ce9ddff5f50392a",
  "0cfcc1c2c0f9d1c7023c2a64052463647899ca6f",
  "de52986c188be8b6bc8f3f6de5c486fd53ada436",
  "fb3bfe95a9b008006e54ae97b8878e9dbb1c25e5",
  "7cc22ca5273f60857e1c91a6bed885e3123087d4",
  "24e47be41ad942f80f423eea9e67bab25218ac0d",
];
const REBASED_999_COMMITS = new Map([
  [SOURCE_999_COMMITS[0], "a97f9fc6e9ed0bad68428e24e8ca5126e0d46bf1"],
  [SOURCE_999_COMMITS[1], "cf9e8af77919ee5b78d3b62ccd2aec15c01d2ac8"],
  [SOURCE_999_COMMITS[2], "c3ab7394d275d8fcadbf2fd248cb6f39461fa553"],
  [SOURCE_999_COMMITS[3], "d924e34e05f7acd1bbe210ada735dc2b4027755e"],
  [SOURCE_999_COMMITS[4], "0ac7ce522fab0cba6737e76f4091ce9f4a97d064"],
  [SOURCE_999_COMMITS[5], "7f3fe926bfaf1a786aaa8aa044b0e9b6585b33b4"],
  [SOURCE_999_COMMITS[6], "2d6d161a7784954769c99b032cfe8a1bbabde9d0"],
  [SOURCE_999_COMMITS[7], "06591c12355d5d76a548be3a3ff6178a654910a9"],
  [SOURCE_999_COMMITS[8], "fc7764dd4ecf27f2c95218abf1ce0a78488812df"],
]);

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

function validateDimensionCoverage(errors, inventory, dimensionName, requiredValues) {
  const covered = new Set();
  for (const scenario of inventory.scenarios ?? []) {
    const values = scenario?.coverage?.[dimensionName];
    if (Array.isArray(values)) values.forEach((value) => covered.add(value));
  }
  for (const value of requiredValues) {
    if (!covered.has(value)) {
      addError(errors, `dimensions.${dimensionName}`, `${JSON.stringify(value)} is not covered by any scenario`);
    }
  }
}

export function validateInventory(inventory) {
  const errors = [];
  if (!requireObject(errors, inventory, "inventory")) return errors;
  rejectUnknownKeys(errors, inventory, "inventory", [
    "schemaVersion", "dimensions", "requiredEvidenceKinds", "acceptanceGates", "scenarios",
  ]);
  if (inventory.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
    addError(errors, "schemaVersion", `must equal ${INVENTORY_SCHEMA_VERSION}`);
  }
  const dimensions = inventory.dimensions;
  const requiredDimensions = {
    operatingSystems: ["windows-10-22h2-x64", "windows-11-x64"],
    shells: ["powershell", "cmd"],
    providers: ["claude", "codex", "cursor", "droid", "opencode"],
    clients: ["windows-desktop", "ade-code", "hosted-web", "ios", "desktop-peer"],
    routes: ["lan", "tailscale", "relay"],
    journeys: ["account-oauth", "account-directory", "signed-n-to-n-plus-one-update", "windows-regressions"],
  };
  if (requireObject(errors, dimensions, "dimensions")) {
    rejectUnknownKeys(errors, dimensions, "dimensions", Object.keys(requiredDimensions));
    for (const [name, required] of Object.entries(requiredDimensions)) {
      const values = dimensions[name];
      requireStringArray(errors, values, `dimensions.${name}`, { pattern: SAFE_ID_PATTERN });
      if (!Array.isArray(values)) continue;
      for (const requiredValue of required) {
        if (!values.includes(requiredValue)) {
          addError(errors, `dimensions.${name}`, `must include ${JSON.stringify(requiredValue)}`);
        }
      }
      validateDimensionCoverage(errors, inventory, name, values);
    }
  }
  requireStringArray(errors, inventory.requiredEvidenceKinds, "requiredEvidenceKinds", {
    pattern: SAFE_ID_PATTERN,
  });
  if (Array.isArray(inventory.requiredEvidenceKinds)) {
    for (const kind of EVIDENCE_KINDS) {
      if (!inventory.requiredEvidenceKinds.includes(kind)) {
        addError(errors, "requiredEvidenceKinds", `must include ${kind}`);
      }
    }
  }
  const declaredGateIds = new Set();
  if (!Array.isArray(inventory.acceptanceGates)) {
    addError(errors, "acceptanceGates", "must be an array");
  } else {
    inventory.acceptanceGates.forEach((gate, index) => {
      const field = `acceptanceGates[${index}]`;
      if (!requireObject(errors, gate, field)) return;
      rejectUnknownKeys(errors, gate, field, ["id", "stage", "requirements"]);
      if (requireString(errors, gate.id, `${field}.id`, SAFE_ID_PATTERN)) {
        if (declaredGateIds.has(gate.id)) addError(errors, `${field}.id`, "must be unique");
        declaredGateIds.add(gate.id);
      }
      const expected = REQUIRED_ACCEPTANCE_GATES.get(gate.id);
      const expectedStage = POST_DRAFT_GATE_IDS.has(gate.id) ? "post-draft" : "pre-tag";
      if (gate.stage !== expectedStage) {
        addError(errors, `${field}.stage`, `must equal ${expectedStage}`);
      }
      requireStringArray(errors, gate.requirements, `${field}.requirements`, { pattern: SAFE_ID_PATTERN });
      if (!expected) {
        addError(errors, `${field}.id`, "is not a required Windows acceptance gate");
      } else if (Array.isArray(gate.requirements)) {
        for (const requirement of expected) {
          if (!gate.requirements.includes(requirement)) {
            addError(errors, `${field}.requirements`, `must include ${requirement}`);
          }
        }
        for (const requirement of gate.requirements) {
          if (!expected.includes(requirement)) {
            addError(errors, `${field}.requirements`, `contains unknown ${requirement}`);
          }
        }
      }
    });
  }
  for (const gateId of REQUIRED_ACCEPTANCE_GATES.keys()) {
    if (!declaredGateIds.has(gateId)) addError(errors, "acceptanceGates", `is missing ${gateId}`);
  }
  if (!Array.isArray(inventory.scenarios) || inventory.scenarios.length === 0) {
    addError(errors, "scenarios", "must be a non-empty array");
    return errors;
  }
  const scenarioIds = new Set();
  inventory.scenarios.forEach((scenario, index) => {
    const field = `scenarios[${index}]`;
    if (!requireObject(errors, scenario, field)) return;
    rejectUnknownKeys(errors, scenario, field, [
      "id", "title", "hosts", "coverage", "acceptanceGateIds", "requiredEvidenceKinds",
      "acceptanceRequirementIds", "passConditions", "dependencies",
    ]);
    if (requireString(errors, scenario.id, `${field}.id`, SAFE_ID_PATTERN)) {
      if (scenarioIds.has(scenario.id)) addError(errors, `${field}.id`, "must be unique");
      scenarioIds.add(scenario.id);
    }
    requireString(errors, scenario.title, `${field}.title`);
    if (scenario.acceptanceGateIds !== undefined) {
      if (requireStringArray(errors, scenario.acceptanceGateIds, `${field}.acceptanceGateIds`, {
        pattern: SAFE_ID_PATTERN,
      })) {
        for (const gateId of scenario.acceptanceGateIds) {
          if (!declaredGateIds.has(gateId)) {
            addError(errors, `${field}.acceptanceGateIds`, `${gateId} is not declared`);
          }
        }
        const allowedRequirements = new Set(scenario.acceptanceGateIds.flatMap((gateId) => (
          REQUIRED_ACCEPTANCE_GATES.get(gateId) ?? []
        )));
        if (requireStringArray(errors, scenario.acceptanceRequirementIds, `${field}.acceptanceRequirementIds`, {
          pattern: SAFE_ID_PATTERN,
        })) {
          for (const requirement of allowedRequirements) {
            if (!scenario.acceptanceRequirementIds.includes(requirement)) {
              addError(errors, `${field}.acceptanceRequirementIds`, `must include ${requirement}`);
            }
          }
          for (const requirement of scenario.acceptanceRequirementIds) {
            if (!allowedRequirements.has(requirement)) {
              addError(errors, `${field}.acceptanceRequirementIds`, `contains unknown ${requirement}`);
            }
          }
        }
      }
    } else if (scenario.acceptanceRequirementIds !== undefined) {
      addError(errors, `${field}.acceptanceRequirementIds`, "requires acceptanceGateIds");
    }
    requireStringArray(errors, scenario.hosts, `${field}.hosts`, { pattern: SAFE_ID_PATTERN });
    if (Array.isArray(scenario.hosts) && isPlainObject(dimensions)) {
      const operatingSystems = Array.isArray(dimensions.operatingSystems)
        ? dimensions.operatingSystems
        : [];
      for (const host of scenario.hosts) {
        if (!operatingSystems.includes(host)) {
          addError(errors, `${field}.hosts`, `${JSON.stringify(host)} is not a declared Windows host`);
        }
      }
    }
    if (requireObject(errors, scenario.coverage, `${field}.coverage`) && isPlainObject(dimensions)) {
      rejectUnknownKeys(errors, scenario.coverage, `${field}.coverage`, Object.keys(dimensions));
      for (const dimensionName of Object.keys(dimensions)) {
        const values = scenario.coverage[dimensionName] ?? [];
        requireStringArray(errors, values, `${field}.coverage.${dimensionName}`, {
          allowEmpty: true,
          pattern: SAFE_ID_PATTERN,
        });
        if (Array.isArray(values)) {
          const declaredValues = Array.isArray(dimensions[dimensionName])
            ? dimensions[dimensionName]
            : [];
          for (const value of values) {
            if (!declaredValues.includes(value)) {
              addError(errors, `${field}.coverage.${dimensionName}`, `${JSON.stringify(value)} is not declared`);
            }
          }
        }
      }
    }
    if (requireStringArray(errors, scenario.requiredEvidenceKinds, `${field}.requiredEvidenceKinds`, {
      pattern: SAFE_ID_PATTERN,
    })) {
      if (scenario.requiredEvidenceKinds.length < 2) {
        addError(errors, `${field}.requiredEvidenceKinds`, "must require at least two independent signal kinds");
      }
      for (const kind of scenario.requiredEvidenceKinds) {
        if (!EVIDENCE_KINDS.includes(kind)) {
          addError(errors, `${field}.requiredEvidenceKinds`, `${JSON.stringify(kind)} is not supported`);
        }
      }
    }
    requireStringArray(errors, scenario.passConditions, `${field}.passConditions`);
    requireStringArray(errors, scenario.dependencies, `${field}.dependencies`, { allowEmpty: true });
  });
  for (const gateId of REQUIRED_ACCEPTANCE_GATES.keys()) {
    const expectedScenarioId = REQUIRED_GATE_SCENARIO_IDS.get(gateId);
    const boundScenarios = inventory.scenarios.filter((scenario) => (
      Array.isArray(scenario?.acceptanceGateIds) && scenario.acceptanceGateIds.includes(gateId)
    ));
    if (!boundScenarios.some((scenario) => scenario.id === expectedScenarioId)) {
      addError(errors, "scenarios", `${gateId} must be bound by ${expectedScenarioId}`);
    }
    if (boundScenarios.some((scenario) => scenario.id !== expectedScenarioId)) {
      addError(errors, "scenarios", `${gateId} may only be bound by ${expectedScenarioId}`);
    }
  }
  return errors;
}

export function validateProvenance(provenance) {
  const errors = [];
  if (!requireObject(errors, provenance, "provenance")) return errors;
  rejectUnknownKeys(errors, provenance, "provenance", [
    "schemaVersion", "sourcePullRequest", "commitMappings", "stackLayers",
    "sourceReviewDispositions", "requiredCommitTrailers",
  ]);
  if (provenance.schemaVersion !== PROVENANCE_SCHEMA_VERSION) {
    addError(errors, "schemaVersion", `must equal ${PROVENANCE_SCHEMA_VERSION}`);
  }
  const source = provenance.sourcePullRequest;
  if (requireObject(errors, source, "sourcePullRequest")) {
    rejectUnknownKeys(errors, source, "sourcePullRequest", [
      "baseRepository", "headRepository", "number", "url", "authorName", "authorLogin", "headSha",
    ]);
    if (source.number !== 999) addError(errors, "sourcePullRequest.number", "must equal 999");
    if (source.headRepository !== "nsxdavid/ADE") addError(errors, "sourcePullRequest.headRepository", "must credit nsxdavid/ADE");
    if (source.baseRepository !== "arul28/ADE") addError(errors, "sourcePullRequest.baseRepository", "must identify arul28/ADE");
    if (source.authorName !== "David Whatley" || source.authorLogin !== "nsxdavid") {
      addError(errors, "sourcePullRequest.author", "must credit David Whatley (nsxdavid)");
    }
    if (source.url !== "https://github.com/arul28/ADE/pull/999") {
      addError(errors, "sourcePullRequest.url", "must identify the canonical pull request");
    }
    requireString(errors, source.headSha, "sourcePullRequest.headSha", COMMIT_SHA_PATTERN);
    if (source.headSha !== SOURCE_999_COMMITS.at(-1)) {
      addError(errors, "sourcePullRequest.headSha", "must equal the reviewed #999 head commit");
    }
  }
  if (!Array.isArray(provenance.commitMappings) || provenance.commitMappings.length === 0) {
    addError(errors, "commitMappings", "must be a non-empty array");
    return errors;
  }
  const sourceShas = new Set();
  const rebasedShas = new Set();
  provenance.commitMappings.forEach((mapping, index) => {
    const field = `commitMappings[${index}]`;
    if (!requireObject(errors, mapping, field)) return;
    rejectUnknownKeys(errors, mapping, field, ["sourceSha", "rebasedSha", "subject"]);
    if (requireString(errors, mapping.sourceSha, `${field}.sourceSha`, COMMIT_SHA_PATTERN)) {
      if (sourceShas.has(mapping.sourceSha)) addError(errors, `${field}.sourceSha`, "must be unique");
      sourceShas.add(mapping.sourceSha);
    }
    if (requireString(errors, mapping.rebasedSha, `${field}.rebasedSha`, COMMIT_SHA_PATTERN)) {
      if (rebasedShas.has(mapping.rebasedSha)) addError(errors, `${field}.rebasedSha`, "must be unique");
      rebasedShas.add(mapping.rebasedSha);
      const expected = REBASED_999_COMMITS.get(mapping.sourceSha);
      if (expected && mapping.rebasedSha !== expected) {
        addError(errors, `${field}.rebasedSha`, `must equal the reviewed rebased commit ${expected}`);
      }
    }
    requireString(errors, mapping.subject, `${field}.subject`);
  });
  if (provenance.commitMappings.length !== SOURCE_999_COMMITS.length) {
    addError(errors, "commitMappings", `must contain all ${SOURCE_999_COMMITS.length} source commits from #999`);
  }
  for (const sourceSha of SOURCE_999_COMMITS) {
    if (!sourceShas.has(sourceSha)) addError(errors, "commitMappings", `is missing #999 source commit ${sourceSha}`);
  }
  if (source?.headSha && !sourceShas.has(source.headSha)) {
    addError(errors, "sourcePullRequest.headSha", "must appear in commitMappings");
  }
  if (!Array.isArray(provenance.stackLayers) || provenance.stackLayers.length === 0) {
    addError(errors, "stackLayers", "must be a non-empty array");
    return errors;
  }
  const coveredSourceShas = new Set();
  const layerIds = new Set();
  provenance.stackLayers.forEach((layer, index) => {
    const field = `stackLayers[${index}]`;
    if (!requireObject(errors, layer, field)) return;
    rejectUnknownKeys(errors, layer, field, ["id", "purpose", "sourceCommits"]);
    if (requireString(errors, layer.id, `${field}.id`, SAFE_ID_PATTERN)) {
      if (layerIds.has(layer.id)) addError(errors, `${field}.id`, "must be unique");
      layerIds.add(layer.id);
    }
    requireString(errors, layer.purpose, `${field}.purpose`);
    if (requireStringArray(errors, layer.sourceCommits, `${field}.sourceCommits`, {
      pattern: COMMIT_SHA_PATTERN,
    })) {
      layer.sourceCommits.forEach((sha) => {
        coveredSourceShas.add(sha);
        if (!sourceShas.has(sha)) addError(errors, `${field}.sourceCommits`, `${sha} has no commit mapping`);
      });
    }
  });
  for (const sourceSha of sourceShas) {
    if (!coveredSourceShas.has(sourceSha)) {
      addError(errors, "stackLayers", `source commit ${sourceSha} is not attributed to any layer`);
    }
  }
  const dispositions = provenance.sourceReviewDispositions;
  if (!Array.isArray(dispositions) || dispositions.length !== 1) {
    addError(errors, "sourceReviewDispositions", "must contain the original #999 Codex P2 disposition");
  } else {
    const disposition = dispositions[0];
    if (requireObject(errors, disposition, "sourceReviewDispositions[0]")) {
      rejectUnknownKeys(errors, disposition, "sourceReviewDispositions[0]", [
        "id", "source", "status", "finding", "disposition", "currentRegistration",
        "launcher", "pidRecord", "readinessRecord", "scheduledTasks", "stackLayers",
      ]);
      const exactFields = {
        id: "codex-p2-windows-supervisor-registration",
        source: "original-999-codex-inline-p2",
        status: "resolved",
        currentRegistration: "hkcu-run",
        launcher: "hidden-powershell-supervisor",
        pidRecord: "supervisor-runtime-pids",
        readinessRecord: "initialized-runtime-ipc",
        scheduledTasks: "legacy-cleanup-only",
      };
      for (const [field, expected] of Object.entries(exactFields)) {
        if (disposition[field] !== expected) {
          addError(errors, `sourceReviewDispositions[0].${field}`, `must equal ${expected}`);
        }
      }
      requireString(errors, disposition.finding, "sourceReviewDispositions[0].finding");
      requireString(errors, disposition.disposition, "sourceReviewDispositions[0].disposition");
      if (requireStringArray(errors, disposition.stackLayers, "sourceReviewDispositions[0].stackLayers", {
        pattern: SAFE_ID_PATTERN,
      })) {
        for (const requiredLayer of ["windows-runtime-and-ipc", "windows-proof-and-support"]) {
          if (!disposition.stackLayers.includes(requiredLayer)) {
            addError(errors, "sourceReviewDispositions[0].stackLayers", `must include ${requiredLayer}`);
          }
        }
      }
    }
  }
  if (requireObject(errors, provenance.requiredCommitTrailers, "requiredCommitTrailers")) {
    rejectUnknownKeys(errors, provenance.requiredCommitTrailers, "requiredCommitTrailers", ["coAuthor", "basedOn"]);
  }
  if (provenance.requiredCommitTrailers?.coAuthor !== "David Whatley <nsxdavid@gmail.com>") {
    addError(errors, "requiredCommitTrailers.coAuthor", "must preserve David Whatley's commit credit");
  }
  if (provenance.requiredCommitTrailers?.basedOn !== "nsxdavid/ADE#999") {
    addError(errors, "requiredCommitTrailers.basedOn", "must equal nsxdavid/ADE#999");
  }
  return errors;
}
