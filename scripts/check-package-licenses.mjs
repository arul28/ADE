import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Every published package directory must carry its own license, because npm
 * ships the package directory and the repository root `LICENSE` does not travel
 * with the tarball. This script asserts four things per published package:
 *
 *   a. a `LICENSE` file exists in the package directory;
 *   b. the SPDX `license` field agrees with the text of that file;
 *   c. `files` lists `LICENSE`, so the tarball actually carries it;
 *   d. the package `README.md` has a `## License` section naming the same id.
 *
 * With `--pack` it also runs `npm pack --dry-run --json` per package and
 * asserts `LICENSE` appears in the tarball listing. That step needs npm and a
 * few seconds per package, so the unit tests leave it off and CI turns it on.
 *
 * `@ade-dev/sdk` and `@ade-dev/chat-ui` are MIT; ADE itself stays
 * AGPL-3.0-only, and `RUNTIME-EMBEDDING-EXCEPTION.md` covers an unmodified
 * runtime binary inside a larger work. See `sdk/license.mdx`. This script takes
 * no position on which license is correct. It only enforces that whatever the
 * maintainer chooses is stated consistently in all four places.
 */

/**
 * SPDX id → a phrase that must appear in the `LICENSE` text of a package
 * declaring that id. Each phrase is absent from the other licenses' texts, so
 * presence of the declared phrase and absence of the others is a sound match.
 */
export const LICENSE_TEXT_MARKERS = {
  "AGPL-3.0-only": "GNU AFFERO GENERAL PUBLIC LICENSE",
  MIT: "MIT License",
  "Apache-2.0": "Apache License",
};

/** Compares license prose case-insensitively; license texts vary in casing. */
function textHasMarker(text, marker) {
  return text.toLowerCase().includes(marker.toLowerCase());
}

/**
 * Returns the body of the `## License` section of a README, or `null` when the
 * README has no such heading. The section ends at the next `##`-or-higher
 * heading, so a `### Third party` subsection still counts as part of it.
 */
export function licenseSectionOf(readme) {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+License\s*$/i.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s+\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Errors for one already-parsed package. Pure, so the unit tests can drive it. */
/**
 * Every way one package can fail this check, as a stable identifier.
 *
 * The `message` beside each one is operator-facing copy, and copy gets
 * reworded. A test matching a full sentence then fails on a rewrite that broke
 * nothing, and — worse — passes on a sentence that no longer says what it used
 * to. The code is the contract; one test pins the rendered wording.
 */
export const LICENSE_ERROR_CODES = {
  noLicenseField: "no_license_field",
  unknownSpdx: "unknown_spdx",
  noLicenseFile: "no_license_file",
  licenseTextMismatch: "license_text_mismatch",
  licenseTextIsOtherId: "license_text_is_other_id",
  filesMissingLicense: "files_missing_license",
  noReadme: "no_readme",
  readmeNoLicenseSection: "readme_no_license_section",
  readmeWrongSpdx: "readme_wrong_spdx",
  packOutputUnparseable: "pack_output_unparseable",
  packMissingLicense: "pack_missing_license",
  packFailed: "pack_failed",
  manifestUnparseable: "manifest_unparseable",
};

/**
 * One failure: which package, which rule, and the sentence an operator reads.
 *
 * `toString` is defined so a caller that interpolates the object still prints
 * the message rather than `[object Object]`.
 */
function licenseError(pkg, code, message) {
  return { package: pkg, code, message: `${pkg}: ${message}`, toString: () => `${pkg}: ${message}` };
}

export function checkPackageFields({ dir, manifest, licenseText, readme }) {
  const errors = [];
  const label = manifest.name ?? dir;
  const fail = (code, message) => errors.push(licenseError(label, code, message));
  const spdx = manifest.license;

  if (typeof spdx !== "string" || spdx.length === 0) {
    fail(LICENSE_ERROR_CODES.noLicenseField, 'package.json has no "license" field');
    return errors;
  }

  const marker = LICENSE_TEXT_MARKERS[spdx];
  if (!marker) {
    const known = Object.keys(LICENSE_TEXT_MARKERS).join(", ");
    fail(LICENSE_ERROR_CODES.unknownSpdx, `unknown SPDX license "${spdx}" (known ids: ${known})`);
    return errors;
  }

  if (licenseText === null) {
    fail(LICENSE_ERROR_CODES.noLicenseFile, `no LICENSE file in ${dir}`);
  } else {
    if (!textHasMarker(licenseText, marker)) {
      fail(
        LICENSE_ERROR_CODES.licenseTextMismatch,
        `package.json says "${spdx}" but ${dir}/LICENSE does not contain "${marker}"`,
      );
    }
    for (const [otherId, otherMarker] of Object.entries(LICENSE_TEXT_MARKERS)) {
      if (otherId === spdx) continue;
      if (textHasMarker(licenseText, otherMarker)) {
        fail(
          LICENSE_ERROR_CODES.licenseTextIsOtherId,
          `package.json says "${spdx}" but ${dir}/LICENSE reads as ${otherId} ("${otherMarker}")`,
        );
      }
    }
  }

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (!files.includes("LICENSE")) {
    fail(
      LICENSE_ERROR_CODES.filesMissingLicense,
      'package.json "files" must include "LICENSE" so the tarball ships it',
    );
  }

  if (readme === null) {
    fail(LICENSE_ERROR_CODES.noReadme, `no README.md in ${dir}`);
  } else {
    const section = licenseSectionOf(readme);
    if (section === null) {
      fail(LICENSE_ERROR_CODES.readmeNoLicenseSection, 'README.md has no "## License" section');
    } else if (!section.includes(spdx)) {
      fail(
        LICENSE_ERROR_CODES.readmeWrongSpdx,
        `README.md "## License" section does not name "${spdx}"`,
      );
    }
  }

  return errors;
}

async function readOrNull(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** True when an `npm` executable is on PATH. `--pack` is skipped when it is not. */
export function npmAvailable(run = defaultRun) {
  try {
    run("npm", ["--version"], process.cwd());
    return true;
  } catch {
    return false;
  }
}

/**
 * Quotes one argument for a `cmd.exe` command line.
 *
 * A local mirror of `quoteWindowsCmdArg` in
 * `apps/desktop/src/main/services/shared/processExecution.ts`, which is the
 * canonical helper. This script is standalone — it runs from the repo root with
 * no build step and cannot import from `apps/desktop` — so the rule is copied
 * rather than shared. Change one, change both.
 *
 * `%` is left alone on purpose: doubling is a batch-FILE rule that corrupts a
 * command line without preventing expansion, and caret escaping is inert inside
 * quotes. Nothing here carries `%VAR%`; the arguments are package directories
 * and literal npm flags.
 */
export function quoteWindowsCmdArg(value) {
  let quoted = "\"";
  let backslashes = 0;
  for (const char of value.replace(/[\r\n]/g, " ")) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === "\"") {
      quoted += "\\".repeat(backslashes * 2);
      quoted += "\"\"";
    } else {
      quoted += "\\".repeat(backslashes);
      quoted += char;
    }
    backslashes = 0;
  }
  quoted += "\\".repeat(backslashes * 2);
  quoted += "\"";
  return quoted;
}

/**
 * The spawn arguments for one command, per platform.
 *
 * On Windows `npm` is a `.cmd` shim, which Node has refused to spawn bare since
 * CVE-2024-27980, so it has to go through `cmd.exe`. `shell: true` used to do
 * that by handing Node's own joined string to the shell; this builds the
 * command line explicitly with ComSpec + `/d /s /c` and
 * `windowsVerbatimArguments`, mirroring `resolveWindowsCmdLineInvocation` in
 * `apps/desktop/src/main/services/shared/processExecution.ts`. Structured argv
 * is never replaced by a shell string.
 */
export function resolveRunInvocation(command, args, platform = process.platform, env = process.env) {
  if (platform !== "win32") {
    return { command, args: [...args], windowsVerbatimArguments: false };
  }
  const cmdLine = [command, ...args].map(quoteWindowsCmdArg).join(" ");
  return {
    command: env.ComSpec?.trim() || "cmd.exe",
    args: ["/d", "/s", "/c", `"${cmdLine}"`],
    windowsVerbatimArguments: true,
  };
}

function defaultRun(command, args, cwd) {
  const invocation = resolveRunInvocation(command, args);
  return execFileSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

/**
 * npm prints lifecycle-script output and warnings on the same stream as the
 * `--json` document, so the JSON is not always the whole of stdout. Returns the
 * first `[`- or `{`-rooted suffix that parses, or `null` when none does.
 */
export function extractJson(text) {
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char !== "[" && char !== "{") continue;
    try {
      return JSON.parse(text.slice(i));
    } catch {
      // Not the start of the document; keep scanning.
    }
  }
  return null;
}

/**
 * Asserts the real tarball listing carries `LICENSE`. `files` can be right while
 * an `.npmignore` or a stale entry still drops it, so this checks the artifact
 * rather than the intent.
 */
export function checkPackedFiles({ dir, manifest, packJson }) {
  const label = manifest.name ?? dir;
  const parsed = extractJson(packJson);
  if (parsed === null) {
    return [licenseError(
      label,
      LICENSE_ERROR_CODES.packOutputUnparseable,
      'could not parse "npm pack --dry-run --json" output',
    )];
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = Array.isArray(entry?.files) ? entry.files : [];
  const paths = files.map((file) => file.path);
  if (!paths.includes("LICENSE")) {
    return [licenseError(
      label,
      LICENSE_ERROR_CODES.packMissingLicense,
      "the npm tarball file list does not include LICENSE",
    )];
  }
  return [];
}

/** Walks `packagesDir` and returns `{ errors, checked, skipped }`. */
export async function checkPackageLicenses({ packagesDir, pack = false, run = defaultRun }) {
  const errors = [];
  const checked = [];
  const skipped = [];

  let entries;
  try {
    entries = await fs.readdir(packagesDir, { withFileTypes: true });
  } catch (error) {
    // `packRan: false` explicitly, not omitted. A caller reading `packRan` off
    // this branch got `undefined`, which is falsy and so happened to be right,
    // and would silently stop being right the day this branch returned no
    // errors.
    if (error.code === "ENOENT") {
      return { errors: [`no packages directory at ${packagesDir}`], checked, skipped, packRan: false };
    }
    throw error;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const packEnabled = pack && npmAvailable(run);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    const manifestText = await readOrNull(path.join(dir, "package.json"));
    if (manifestText === null) continue;

    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      errors.push(licenseError(
        `packages/${entry.name}`,
        LICENSE_ERROR_CODES.manifestUnparseable,
        "package.json is not valid JSON",
      ));
      continue;
    }
    if (manifest.private === true) {
      skipped.push(manifest.name ?? entry.name);
      continue;
    }

    checked.push(manifest.name ?? entry.name);
    const licenseText = await readOrNull(path.join(dir, "LICENSE"));
    const readme = await readOrNull(path.join(dir, "README.md"));
    errors.push(
      ...checkPackageFields({ dir: `packages/${entry.name}`, manifest, licenseText, readme }),
    );

    if (!packEnabled) continue;
    let packJson;
    try {
      // `--ignore-scripts` keeps this off the `prepack` build path: LICENSE is a
      // static file, and a tarball listing must not cost a full package build.
      packJson = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], dir);
    } catch (error) {
      errors.push(licenseError(
        manifest.name ?? `packages/${entry.name}`,
        LICENSE_ERROR_CODES.packFailed,
        `"npm pack --dry-run --json" failed: ${error.message}`,
      ));
      continue;
    }
    errors.push(...checkPackedFiles({ dir: `packages/${entry.name}`, manifest, packJson }));
  }

  return { errors, checked, skipped, packRan: packEnabled };
}

/**
 * What the process should do with a finished check.
 *
 * A pure function, exported and tested, because this is the reason CI passes
 * `--require-pack`: `npmAvailable` swallows a spawn failure, so without this
 * branch a broken npm downgrades the tarball assertion to a log line and the
 * job still exits 0. Inlined in `main()` it had no test, and a refactor that
 * reordered the two branches, or dropped `packRan` from the return, reverted
 * the gate to fail-open with nothing to catch it.
 *
 * Returns the exit code and the lines to print, so `main()` only does I/O.
 */
export function decideExit({ errors, packRan, requirePack, pack }) {
  if (errors.length > 0) {
    return {
      code: 1,
      error: ["Package license validation failed:", ...errors.map((e) => `- ${e.message ?? e}`)].join("\n"),
    };
  }
  if (requirePack && !packRan) {
    return {
      code: 1,
      error:
        "Package license validation failed:\n"
        + "- --require-pack was given and npm could not be run, so the tarball file-list check "
        + "never ran. Install npm or drop --require-pack.",
    };
  }
  return { code: 0, ...(pack && !packRan ? { note: "npm is not available; skipped the tarball file-list check." } : {}) };
}

async function main() {
  const pack = process.argv.includes("--pack");
  // `--pack` alone fails open: `npmAvailable` swallows any throw from
  // `npm --version`, so a transient spawn failure downgrades the tarball
  // assertion to a log line and the run still exits 0. That is right for a
  // developer laptop and wrong for the CI job that enforces this gate, which
  // passes `--require-pack` and gets a hard failure instead.
  const requirePack = process.argv.includes("--require-pack");
  const packagesDir = path.join(process.cwd(), "packages");
  const { errors, checked, skipped, packRan } = await checkPackageLicenses({
    packagesDir,
    pack: pack || requirePack,
  });

  const decision = decideExit({ errors, packRan, requirePack, pack });
  if (decision.code !== 0) {
    console.error(decision.error);
    process.exit(decision.code);
  }
  if (decision.note) console.log(decision.note);
  const skipNote = skipped.length > 0 ? ` Skipped ${skipped.length} private package(s).` : "";
  console.log(`Package license validation passed for ${checked.length} published package(s).${skipNote}`);
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  await main();
}
