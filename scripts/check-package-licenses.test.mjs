import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LICENSE_ERROR_CODES,
  checkPackageLicenses,
  checkPackedFiles,
  decideExit,
  extractJson,
  licenseSectionOf,
  quoteWindowsCmdArg,
  resolveRunInvocation,
} from "./check-package-licenses.mjs";

const AGPL = "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\n";
const MIT = "MIT License\n\nCopyright (c) 2025 Example\n";

/** Builds a throwaway `packages/` tree and returns its path. */
async function fixture(packages) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ade-license-"));
  const packagesDir = path.join(root, "packages");
  for (const [name, files] of Object.entries(packages)) {
    const dir = path.join(packagesDir, name);
    await fs.mkdir(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      await fs.writeFile(
        path.join(dir, file),
        typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
      );
    }
  }
  return packagesDir;
}

function goodPackage(name, spdx = "AGPL-3.0-only", licenseText = AGPL) {
  return {
    "package.json": { name, version: "1.0.0", license: spdx, files: ["dist", "README.md", "LICENSE"] },
    LICENSE: licenseText,
    "README.md": `# ${name}\n\n## License\n\n${spdx}. See [LICENSE](./LICENSE).\n`,
  };
}

test("passes a package with a matching license field, file, files entry, and README", async () => {
  const packagesDir = await fixture({
    sdk: goodPackage("@ade-dev/sdk"),
    "chat-ui": goodPackage("@ade-dev/chat-ui"),
  });
  const { errors, checked } = await checkPackageLicenses({ packagesDir });
  assert.deepEqual(errors, []);
  assert.deepEqual(checked, ["@ade-dev/chat-ui", "@ade-dev/sdk"]);
});

test("passes a permissive package too, so a relicense needs no script change", async () => {
  const packagesDir = await fixture({ sdk: goodPackage("@ade-dev/sdk", "MIT", MIT) });
  const { errors } = await checkPackageLicenses({ packagesDir });
  assert.deepEqual(errors, []);
});

test("skips private packages entirely", async () => {
  const packagesDir = await fixture({
    demo: { "package.json": { name: "@ade-dev/demo", version: "0.0.0", private: true } },
  });
  const { errors, checked, skipped } = await checkPackageLicenses({ packagesDir });
  assert.deepEqual(errors, []);
  assert.deepEqual(checked, []);
  assert.deepEqual(skipped, ["@ade-dev/demo"]);
});

test("reports a license field that disagrees with the LICENSE text", async () => {
  const files = goodPackage("@ade-dev/sdk", "MIT", AGPL);
  // The README follows the field, so only the file/field mismatch should fire.
  const packagesDir = await fixture({ sdk: files });
  const { errors } = await checkPackageLicenses({ packagesDir });
  assert.deepEqual(errors.map((error) => error.code), [
    LICENSE_ERROR_CODES.licenseTextMismatch,
    LICENSE_ERROR_CODES.licenseTextIsOtherId,
  ]);
  // The one place the rendered wording is pinned. Every other assertion in this
  // file reads `code`, so a rewrite of operator copy touches exactly this test.
  assert.equal(
    errors[0].message,
    '@ade-dev/sdk: package.json says "MIT" but packages/sdk/LICENSE does not contain "MIT License"',
  );
});

test("reports a missing LICENSE file", async () => {
  const files = goodPackage("@ade-dev/sdk");
  delete files.LICENSE;
  const packagesDir = await fixture({ sdk: files });
  const { errors } = await checkPackageLicenses({ packagesDir });
  assert.deepEqual(errors.map((error) => error.code), [LICENSE_ERROR_CODES.noLicenseFile]);
  assert.equal(errors[0].package, "@ade-dev/sdk");
});

test("reports a files array that would drop LICENSE from the tarball", async () => {
  const files = goodPackage("@ade-dev/sdk");
  files["package.json"].files = ["dist", "README.md"];
  const packagesDir = await fixture({ sdk: files });
  const { errors } = await checkPackageLicenses({ packagesDir });
  assert.deepEqual(errors.map((error) => error.code), [LICENSE_ERROR_CODES.filesMissingLicense]);
});

test("reports a README with no License section", async () => {
  const files = goodPackage("@ade-dev/sdk");
  files["README.md"] = "# @ade-dev/sdk\n\nNo license section here.\n";
  const packagesDir = await fixture({ sdk: files });
  const { errors } = await checkPackageLicenses({ packagesDir });
  assert.deepEqual(errors.map((error) => error.code), [LICENSE_ERROR_CODES.readmeNoLicenseSection]);
});

test("reports a README License section naming a different SPDX id", async () => {
  const files = goodPackage("@ade-dev/sdk");
  files["README.md"] = "# sdk\n\n## License\n\nMIT. See [LICENSE](./LICENSE).\n";
  const packagesDir = await fixture({ sdk: files });
  const { errors } = await checkPackageLicenses({ packagesDir });
  assert.deepEqual(errors.map((error) => error.code), [LICENSE_ERROR_CODES.readmeWrongSpdx]);
});

test("reports an unrecognised SPDX identifier instead of passing it through", async () => {
  const files = goodPackage("@ade-dev/sdk");
  // "AGPL-3.0" is the deprecated spelling and must not be accepted silently.
  files["package.json"].license = "AGPL-3.0";
  const packagesDir = await fixture({ sdk: files });
  const { errors } = await checkPackageLicenses({ packagesDir });
  assert.deepEqual(errors.map((error) => error.code), [LICENSE_ERROR_CODES.unknownSpdx]);
});

test("leaves the tarball check off unless --pack asks for it", async () => {
  const packagesDir = await fixture({ sdk: goodPackage("@ade-dev/sdk") });
  const run = () => {
    throw new Error("npm must not run without --pack");
  };
  const { errors, packRan } = await checkPackageLicenses({ packagesDir, run });
  assert.deepEqual(errors, []);
  assert.equal(packRan, false);
});

test("skips the tarball check when npm is unavailable", async () => {
  const packagesDir = await fixture({ sdk: goodPackage("@ade-dev/sdk") });
  const run = () => {
    throw new Error("npm: command not found");
  };
  const { errors, packRan } = await checkPackageLicenses({ packagesDir, pack: true, run });
  assert.deepEqual(errors, []);
  assert.equal(packRan, false);
});

test("reads LICENSE out of the npm pack file list when --pack is on", async () => {
  const packagesDir = await fixture({ sdk: goodPackage("@ade-dev/sdk") });
  const listing = (paths) => JSON.stringify([{ files: paths.map((p) => ({ path: p })) }]);
  const withLicense = () => listing(["dist/index.js", "README.md", "LICENSE", "package.json"]);
  const withoutLicense = () => listing(["dist/index.js", "README.md", "package.json"]);

  const ok = await checkPackageLicenses({
    packagesDir,
    pack: true,
    run: (command, args) => (args[0] === "pack" ? withLicense() : "10.0.0"),
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.packRan, true);

  const bad = await checkPackageLicenses({
    packagesDir,
    pack: true,
    run: (command, args) => (args[0] === "pack" ? withoutLicense() : "10.0.0"),
  });
  assert.deepEqual(bad.errors.map((error) => error.code), [LICENSE_ERROR_CODES.packMissingLicense]);
});

test("treats unparseable npm pack output as a failure, not a pass", () => {
  const errors = checkPackedFiles({
    dir: "packages/sdk",
    manifest: { name: "@ade-dev/sdk" },
    packJson: "not json",
  });
  assert.deepEqual(errors.map((error) => error.code), [LICENSE_ERROR_CODES.packOutputUnparseable]);
});

test("finds the JSON document under npm's lifecycle and warning output", () => {
  const noisy = '> build\n\nnpm warn something\n[\n  { "files": [{ "path": "LICENSE" }] }\n]\n';
  assert.deepEqual(extractJson(noisy), [{ files: [{ path: "LICENSE" }] }]);
  assert.equal(extractJson("no json at all"), null);
});

test("ends the README License section at the next heading", () => {
  const readme = "## License\n\nMIT.\n\n## Support\n\nAGPL-3.0-only elsewhere.\n";
  assert.equal(licenseSectionOf(readme).includes("AGPL-3.0-only"), false);
  assert.equal(licenseSectionOf("# Title\n\nno section"), null);
});

test("keeps structured argv on posix instead of handing a line to a shell", () => {
  const invocation = resolveRunInvocation("npm", ["pack", "--dry-run", "--json"], "linux");
  assert.deepEqual(invocation, {
    command: "npm",
    args: ["pack", "--dry-run", "--json"],
    windowsVerbatimArguments: false,
  });
});

test("routes a Windows spawn through ComSpec /d /s /c rather than shell: true", () => {
  // `shell: true` handed Node's own joined string to cmd.exe. The canonical
  // helper (resolveWindowsCmdLineInvocation) builds the line explicitly, quotes
  // each argument, and sets windowsVerbatimArguments; this mirror must match.
  const invocation = resolveRunInvocation(
    "npm",
    ["pack", "--dry-run"],
    "win32",
    { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  );
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(invocation.args[3], '"\"npm\" \"pack\" \"--dry-run\""');
  assert.equal(invocation.windowsVerbatimArguments, true);
});

test("falls back to cmd.exe when ComSpec is unset", () => {
  assert.equal(resolveRunInvocation("npm", [], "win32", {}).command, "cmd.exe");
});

test("quotes a Windows argument the way the canonical helper does", () => {
  // A path with spaces is the everyday case; the backslash-before-quote rule is
  // what the CRT argv parser requires.
  assert.equal(quoteWindowsCmdArg("C:\\Program Files\\pkg"), '"C:\\Program Files\\pkg"');
  assert.equal(quoteWindowsCmdArg('say "hi"'), '"say ""hi"""');
  // Percent is left alone on purpose: there is no correct escaping for it.
  assert.equal(quoteWindowsCmdArg("100% done"), '"100% done"');
});

test("decideExit pins the four --require-pack combinations", () => {
  // This is the branch CI relies on. `npmAvailable` swallows a spawn failure,
  // so without it a broken npm downgrades the tarball assertion to a log line
  // and the job still exits 0.
  assert.deepEqual(
    decideExit({ errors: [], packRan: true, requirePack: true, pack: true }),
    { code: 0 },
  );
  const missingPack = decideExit({ errors: [], packRan: false, requirePack: true, pack: true });
  assert.equal(missingPack.code, 1);
  assert.match(missingPack.error, /--require-pack was given and npm could not be run/);

  // Without `--require-pack`, a pack that did not run is a note, not a failure.
  assert.deepEqual(
    decideExit({ errors: [], packRan: false, requirePack: false, pack: true }),
    { code: 0, note: "npm is not available; skipped the tarball file-list check." },
  );
  assert.deepEqual(
    decideExit({ errors: [], packRan: true, requirePack: false, pack: true }),
    { code: 0 },
  );
});

test("decideExit reports license errors before the pack gate", () => {
  const decision = decideExit({
    errors: [new Error("packages/x: missing LICENSE")],
    packRan: false,
    requirePack: true,
    pack: true,
  });
  assert.equal(decision.code, 1);
  assert.match(decision.error, /missing LICENSE/);
});

test("the ENOENT early return states packRan rather than omitting it", async () => {
  const result = await checkPackageLicenses({
    packagesDir: path.join(os.tmpdir(), "ade-no-such-packages-dir-for-this-test"),
  });
  assert.equal(result.packRan, false);
  assert.equal(result.errors.length, 1);
});
