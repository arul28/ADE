// The release pipeline's own gates: what lets a tag build, which cached
// binaries a release may sign, which Mach-O files an x64 app may carry, and
// which Apple failures are worth a retry. `gh` is stubbed at the process
// boundary; everything else runs for real.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isAppleNetworkError, retryTransient } from "../apps/desktop/scripts/release-retry.mjs";
import { assertMachOArchitectures } from "../apps/desktop/scripts/validate-macho-arch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A `gh` on PATH that answers from files: `ci/<sha>` holds the ci-pass check
// run for a commit, `attest/<basename>` the `gh attestation verify --format
// json` output for a file (absent = verification fails).
function stubGh(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
data="${dir}"
if [ "$1" = api ]; then
  sha="$(printf '%s' "$2" | sed -E 's#.*/commits/([^/]+)/check-runs#\\1#')"
  [ -f "$data/ci/$sha" ] && cat "$data/ci/$sha"
  exit 0
fi
if [ "$1" = attestation ]; then
  name="$(basename "$3")"
  [ -f "$data/attest/$name" ] || { echo "HTTP 404: Not Found" >&2; exit 1; }
  cat "$data/attest/$name"
  exit 0
fi
exit 2
`,
    { mode: 0o755 },
  );
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}`, GH_TOKEN: "test", GH_REPO: "arul28/ADE", GITHUB_REPOSITORY: "arul28/ADE" };
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd, file, message) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.appendFileSync(path.join(cwd, file), `${message}\n`);
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
  return git(cwd, "rev-parse", "HEAD");
}

const CI = {
  green: { status: "completed", conclusion: "success", html_url: "u" },
  failed: { status: "completed", conclusion: "failure", html_url: "u" },
  cancelled: { status: "completed", conclusion: "cancelled", html_url: "u" },
  running: { status: "in_progress", conclusion: null, html_url: "u" },
};

test("a tag builds only on green CI, borrowed across release-notes-only commits at most five deep", () => {
  const cases = [
    // [label, commits above a green code commit as [file, ci-state|null], expected pass]
    ["own green ci-pass", [["src/app.ts", "green"]], true],
    ["notes commit still running, parent green", [["CHANGELOG.md", "running"]], true],
    ["notes commit whose CI was cancelled walks on", [["changelog/v1.mdx", "cancelled"], ["docs.json", null]], true],
    ["notes commit whose CI failed", [["CHANGELOG.md", "failed"]], false],
    ["code commit still running", [["src/app.ts", "running"]], false],
    ["code commit with no CI at all", [["src/app.ts", null]], false],
    ["notes commit above an unfinished code commit", [["src/app.ts", "running"], ["CHANGELOG.md", null]], false],
    ["five notes-only commits above green", Array.from({ length: 5 }, (_, i) => [`changelog/v${i}.mdx`, null]), true],
    ["six notes-only commits above green", Array.from({ length: 6 }, (_, i) => [`changelog/v${i}.mdx`, null]), false],
  ];
  for (const [label, commits, expected] of cases) {
    const dir = tempDir("ade-ci-gate-");
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q");
    fs.mkdirSync(path.join(dir, "ci"));
    const base = commit(repo, "src/app.ts", "base");
    fs.writeFileSync(path.join(dir, "ci", base), JSON.stringify(CI.green));
    let head = base;
    for (const [file, state] of commits) {
      head = commit(repo, file, `${label} ${file}`);
      if (state) fs.writeFileSync(path.join(dir, "ci", head), JSON.stringify(CI[state]));
    }
    const result = spawnSync("bash", [path.join(repoRoot, "scripts/require-release-ci-pass.sh"), head], {
      cwd: repo,
      env: { ...process.env, ...stubGh(dir) },
      encoding: "utf8",
    });
    assert.equal(result.status === 0, expected, `${label}: ${result.stdout}${result.stderr}`);
    if (!expected) assert.match(result.stdout + result.stderr, /::error::/, `${label} names its reason`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a cached native build is kept only with a matching attestation from the warm workflow", () => {
  const attestationFor = (name) => JSON.stringify([{ verificationResult: { statement: { subject: [{ name }] } } }]);
  const cases = [
    // [label, files, attestations by basename, expect all kept + flag]
    ["every file attested under its own name", ["ade-media", "ade-sim-helper"], { "ade-media": "ade-media", "ade-sim-helper": "ade-sim-helper" }, true],
    ["no attestation", ["ade-media"], {}, false],
    ["attestation for a different file", ["ade-sim-helper"], { "ade-sim-helper": "ade-media" }, false],
    ["one of several unattested", ["ade-media", "ade-sim-helper"], { "ade-media": "ade-media" }, false],
  ];
  for (const [label, files, attestations, keep] of cases) {
    const dir = tempDir("ade-cache-verify-");
    fs.mkdirSync(path.join(dir, "attest"));
    for (const [file, subject] of Object.entries(attestations)) {
      fs.writeFileSync(path.join(dir, "attest", file), attestationFor(subject));
    }
    const paths = files.map((file) => {
      const target = path.join(dir, file);
      fs.writeFileSync(target, "binary");
      return target;
    });
    const envFile = path.join(dir, "github-env");
    fs.writeFileSync(envFile, "");
    const result = spawnSync("bash", [path.join(repoRoot, "scripts/verify-cached-release-builds.sh"), "CACHED", ...paths], {
      env: { ...process.env, ...stubGh(dir), GITHUB_ENV: envFile },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${label}: a failed check must fall back, not fail the job`);
    assert.deepEqual(paths.map((p) => fs.existsSync(p)), paths.map(() => keep), `${label}: kept files`);
    assert.equal(fs.readFileSync(envFile, "utf8").includes("CACHED=1"), keep, `${label}: cache flag`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function machO(cpus) {
  if (cpus.length === 1) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(0xcffaedfe, 0);
    header.writeUInt32LE(cpus[0], 4);
    return header;
  }
  const header = Buffer.alloc(8 + cpus.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(cpus.length, 4);
  cpus.forEach((cpu, index) => header.writeUInt32BE(cpu, 8 + index * 20));
  return header;
}

test("a per-arch app may carry another arch's Mach-O only when it is named and twinned", async () => {
  const X64 = 0x01000007;
  const ARM64 = 0x0100000c;
  const cases = [
    // [label, files as [relative path, cpus], expected arch, expected error file or null]
    ["thin x64 and a fat universal helper", [["Contents/MacOS/ADE", [X64]], ["Contents/Resources/native/helper", [X64, ARM64]]], "x64", null],
    ["an unnamed arm64-only addon in an x64 app", [["Contents/MacOS/ADE", [X64]], ["Contents/Resources/ssh2/build/Release/sshcrypto.node", [ARM64]]], "x64", "sshcrypto.node has no x64 code"],
    ["a named arm64 prebuild beside its x64 twin", [["prebuilds/darwin-arm64/pty.node", [ARM64]], ["prebuilds/darwin-x64/pty.node", [X64]]], "x64", null],
    ["a named arm64 prebuild with no x64 twin", [["prebuilds/darwin-arm64/pty.node", [ARM64]]], "x64", "has no x64 twin"],
    ["an x64 file inside an arm64 app", [["Contents/MacOS/ADE", [X64]]], "arm64", "has no arm64 code"],
  ];
  for (const [label, files, arch, expectedError] of cases) {
    const app = tempDir("ade-macho-");
    for (const [relative, cpus] of files) {
      fs.mkdirSync(path.dirname(path.join(app, relative)), { recursive: true });
      fs.writeFileSync(path.join(app, relative), machO(cpus));
    }
    fs.writeFileSync(path.join(app, "Info.plist"), "<plist/>");
    const run = assertMachOArchitectures(app, arch, label);
    if (expectedError) {
      await assert.rejects(run, (error) => error.message.includes(expectedError), label);
    } else {
      await assert.doesNotReject(run, label);
    }
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test("Apple network drops are retried; notarization verdicts and other failures are not", async () => {
  const classify = [
    ["dropped connection", 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."', true],
    ["notary timeout", "HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1001 \"The request timed out.\")", true],
    ["Invalid verdict whose log mentions a timeout", '{"status": "Invalid", "issues": [{"message": "timeout"}]}', false],
    ["rejected DMG whose submission id contains -1005", "DMG notarization failed with status Invalid for ADE.dmg (3f2a-1005-4b2c)", false],
    ["missing ticket", "does not have a ticket stapled to it. The validate action failed! Error 65.", false],
  ];
  for (const [label, text, expected] of classify) {
    assert.equal(isAppleNetworkError(text), expected, label);
  }

  const warn = console.warn;
  console.warn = () => {};
  try {
    let calls = 0;
    const value = await retryTransient("flaky", async () => {
      calls += 1;
      if (calls < 3) throw new Error("network connection was lost");
      return "done";
    }, { attempts: 5, delayMs: 0, isTransient: isAppleNetworkError });
    assert.equal(value, "done");
    assert.equal(calls, 3, "retried until it succeeded");

    calls = 0;
    await assert.rejects(retryTransient("verdict", async () => {
      calls += 1;
      throw new Error('{"status": "Invalid"} timed out');
    }, { attempts: 5, delayMs: 0, isTransient: isAppleNetworkError }), /Invalid/);
    assert.equal(calls, 1, "a verdict fails on the first attempt");

    calls = 0;
    await assert.rejects(retryTransient("always down", async () => {
      calls += 1;
      throw new Error("network connection was lost");
    }, { attempts: 3, delayMs: 0, isTransient: isAppleNetworkError }), /network connection was lost/);
    assert.equal(calls, 3, "gives up after the attempt budget");
  } finally {
    console.warn = warn;
  }
});
