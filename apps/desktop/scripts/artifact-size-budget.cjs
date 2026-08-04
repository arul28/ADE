// Release artifact size budgets. Artifact size cannot be known before the build
// runs, so these are enforced as their own post-packaging step in every
// packaging job, ahead of upload and publish.

const MIB = 1024 * 1024;

// electron-updater's MacUpdater hands the downloaded zip to native Squirrel.Mac,
// which buffers the whole archive into a single contiguous CFData grown by
// doubling. A payload past 1 GiB therefore asks for a 2 GiB reallocation, which
// Chromium's PartitionAlloc refuses -- the app dies with EXC_BREAKPOINT about a
// minute after launch, before the user can even decline the update. v1.2.52
// shipped a 1054 MB arm64 zip and did exactly that. 800 MiB keeps a deliberate
// margin below the cliff so ordinary growth is caught here instead of on users'
// machines.
const MAC_UPDATE_ARCHIVE_MAX_BYTES = 800 * MIB;

// Windows has no equivalent hard cliff: the NSIS installer is streamed to disk
// and run as an external process, so nothing buffers it whole. The cap is a
// bloat tripwire rather than a crash guard, set proportionally to the macOS one
// because the installer is compressed to a similar degree and a Windows bundle
// that outgrows this has picked up payload it should not be carrying.
const WINDOWS_INSTALLER_MAX_BYTES = 900 * MIB;

const ARTIFACT_SIZE_BUDGETS = [
  {
    id: "mac-update-archive",
    label: "macOS update archive",
    maxBytes: MAC_UPDATE_ARCHIVE_MAX_BYTES,
    matches: (name) => name.endsWith(".zip"),
  },
  {
    id: "windows-installer",
    label: "Windows installer",
    maxBytes: WINDOWS_INSTALLER_MAX_BYTES,
    matches: (name) => name.endsWith(".exe"),
  },
];

function formatBytes(bytes) {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

function budgetForArtifact(name, budgets = ARTIFACT_SIZE_BUDGETS) {
  return budgets.find((budget) => budget.matches(name)) ?? null;
}

/**
 * @param {{name: string, size: number}[]} artifacts
 * @returns {{name: string, size: number, budget: object}[]} violations
 */
function findArtifactSizeViolations(artifacts, budgets = ARTIFACT_SIZE_BUDGETS) {
  const violations = [];
  for (const artifact of artifacts) {
    const budget = budgetForArtifact(artifact.name, budgets);
    if (budget && artifact.size > budget.maxBytes) {
      violations.push({ ...artifact, budget });
    }
  }
  return violations;
}

function formatArtifactSizeViolations(violations) {
  return violations
    .map((violation) => (
      `  ${violation.name}: ${formatBytes(violation.size)} exceeds the `
      + `${violation.budget.label} budget of ${formatBytes(violation.budget.maxBytes)}`
    ))
    .join("\n");
}

module.exports = {
  ARTIFACT_SIZE_BUDGETS,
  MAC_UPDATE_ARCHIVE_MAX_BYTES,
  WINDOWS_INSTALLER_MAX_BYTES,
  budgetForArtifact,
  findArtifactSizeViolations,
  formatArtifactSizeViolations,
  formatBytes,
};
