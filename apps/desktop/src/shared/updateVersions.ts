// ---------------------------------------------------------------------------
// The one ADE version comparator, shared by main and renderer.
//
// Update prompts, "is this machine behind?", and the auto-update state machine
// all have to agree on what "newer" means, so semver ordering lives here rather
// than being re-derived per surface.
// ---------------------------------------------------------------------------

function parseVersion(version: string): {
  core: number[];
  prerelease: string[];
} {
  const withoutBuild = version.trim().replace(/^v/i, "").split("+")[0] ?? "";
  const [coreText = "", prereleaseText = ""] = withoutBuild.split("-", 2);
  return {
    core: coreText.split(".").map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }),
    prerelease: prereleaseText ? prereleaseText.split(".") : [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left.localeCompare(right);
}

/**
 * Semver-ish ordering: numeric core segments first (zero-padded to three), then
 * prerelease precedence, where a release outranks any prerelease of the same
 * core. Unparseable segments read as 0 rather than throwing.
 */
export function compareUpdateVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  const coreLength = Math.max(leftVersion.core.length, rightVersion.core.length, 3);
  for (let index = 0; index < coreLength; index += 1) {
    const delta = (leftVersion.core[index] ?? 0) - (rightVersion.core[index] ?? 0);
    if (delta !== 0) return delta;
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) return 1;
  if (leftVersion.prerelease.length > 0 && rightVersion.prerelease.length === 0) return -1;
  const prereleaseLength = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart == null && rightPart == null) return 0;
    if (leftPart == null) return -1;
    if (rightPart == null) return 1;
    const delta = comparePrereleaseIdentifier(leftPart, rightPart);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** "v1.2.3" for a version, however it was spelled; `fallback` when there is none. */
export function updateVersionLabel(version: string | null | undefined, fallback: string): string {
  const bare = version?.trim().replace(/^v/i, "");
  return bare ? `v${bare}` : fallback;
}

/**
 * ADE releases whose Windows app cannot install any update itself: before the
 * install they prove the running brain against the wrong command and refuse to
 * stop it, so every in-app install aborts. Another machine updates them by
 * running `ade brain update` in a terminal there, which installs through the
 * newer release's own code (`windowsDesktopRescue` in ade-cli).
 */
const WINDOWS_SELF_INSTALL_BLOCKED_VERSIONS = new Set(["1.2.112", "1.2.113"]);

/** Whether `version` on `arch` (a runtime target such as `win32-x64`) is one of those builds. */
export function isWindowsSelfInstallBlocked(
  version: string | null | undefined,
  arch: string | null | undefined,
): boolean {
  if (!/^win/i.test(arch?.trim() ?? "")) return false;
  const core = version?.trim().replace(/^v/i, "").split(/[-+]/)[0] ?? "";
  return WINDOWS_SELF_INSTALL_BLOCKED_VERSIONS.has(core);
}
