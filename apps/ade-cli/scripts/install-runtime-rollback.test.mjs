/**
 * Rollback contract for the POSIX runtime installer (scripts/install-runtime.sh).
 *
 * The script used to copy the freshly downloaded `ade` over the installed one
 * and only then run `ade --version`, so a bad download left a binary that could
 * not start where a working one had been. These tests pin the guarantee the
 * PowerShell installer already had: nothing is promoted until the staged binary
 * passes its own preflight, and a promoted binary that fails is rolled back to
 * the previous one.
 *
 * The script is driven end to end against a fake release: a `curl` earlier on
 * PATH serves files from a fixture directory, and the "runtime" is a shell
 * script whose `--version` behaviour is steered by environment variables.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "install-runtime.sh",
);

function releaseTarget() {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const cpu = process.arch === "arm64" ? "arm64" : "x64";
  return `${platform}-${cpu}`;
}

/**
 * `--version` fails for the staged copy when ADE_TEST_FAIL_STAGED is set, and
 * for the promoted copy (the one under the install dir) when
 * ADE_TEST_FAIL_INSTALLED is set. Every other subcommand -- `brain start`,
 * `setup` -- succeeds silently, because neither is what these tests are about.
 */
const FAKE_ADE = `#!/bin/sh
if [ "\$1" = "--version" ]; then
  # Records which file the installer actually executed for each version check,
  # so a test can prove the staged preflight does not run out of \$TMPDIR.
  if [ -n "\${ADE_TEST_VERSION_LOG:-}" ]; then
    echo "\$0" >>"\$ADE_TEST_VERSION_LOG"
  fi
  # Records the runtime env the installer handed this check, so a test can
  # prove the native modules are not \`dlopen\`ed out of \$TMPDIR either.
  if [ -n "\${ADE_TEST_ENV_LOG:-}" ]; then
    echo "\$0|\${ADE_RUNTIME_ROOT:-}|\${ADE_RUNTIME_NODE_MODULES:-}|\${NODE_PATH:-}" >>"\$ADE_TEST_ENV_LOG"
  fi
  case "\$0" in
    */bin/ade)
      # Stands in for the user hitting Ctrl-C while the promoted binary hangs
      # on its own \`--version\`: the installer shell gets the same SIGINT the
      # terminal would have delivered, and runs its signal handler.
      if [ -n "\${ADE_TEST_INTERRUPT_INSTALLED:-}" ]; then
        kill -INT "\$PPID" 2>/dev/null || true
        exit 130
      fi
      if [ -n "\${ADE_TEST_FAIL_INSTALLED:-}" ]; then
        echo "fake ade: installed copy cannot start" >&2
        exit 3
      fi
      ;;
    *)
      if [ -n "\${ADE_TEST_FAIL_STAGED:-}" ]; then
        echo "fake ade: staged copy cannot start" >&2
        exit 3
      fi
      ;;
  esac
  echo "9.9.9-fake"
  exit 0
fi
exit 0
`;

// A rename can fail for reasons the installer cannot control (a full disk, a
// permission change under it). What must not happen when the rollback's own
// `mv` fails is the cleanup then deleting the backup it just failed to put
// back. This shim fails exactly that one rename -- the previous runtime going
// back -- and is the real `mv` for everything else.
const FAKE_MV = `#!/bin/sh
case "\$1" in
  *.previous)
    if [ -n "\${ADE_TEST_FAIL_RUNTIME_RESTORE:-}" ]; then
      echo "fake mv: cannot restore \$1" >&2
      exit 1
    fi
    ;;
esac
if [ -x /bin/mv ]; then exec /bin/mv "\$@"; fi
exec /usr/bin/mv "\$@"
`;

const FAKE_CURL = `#!/bin/sh
# Serves \$ADE_TEST_ASSET_DIR/<basename of URL> instead of hitting the network.
url=""
out=""
while [ "\$#" -gt 0 ]; do
  case "\$1" in
    -o) out="\$2"; shift 2 ;;
    http*) url="\$1"; shift ;;
    *) shift ;;
  esac
done
[ -n "\$url" ] || exit 2
[ -n "\$out" ] || exit 2
cp "\$ADE_TEST_ASSET_DIR/\${url##*/}" "\$out"
`;

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function sha256(filePath) {
  const runner = spawnSync("shasum", ["-a", "256", filePath], { encoding: "utf8" });
  if (runner.status === 0) return runner.stdout.trim().split(/\s+/)[0];
  return execFileSync("sha256sum", [filePath], { encoding: "utf8" }).trim().split(/\s+/)[0];
}

/** A fake release plus a machine that already has ADE installed on it. */
function makeInstall({ previousBinary = "#!/bin/sh\necho previous\n" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-install-rollback-"));
  const assets = path.join(root, "assets");
  const fakeBin = path.join(root, "fakebin");
  const adeHome = path.join(root, "home", ".ade");
  const installDir = path.join(adeHome, "bin");
  const target = releaseTarget();
  const runtimeDir = path.join(adeHome, "runtime", target);

  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  // The machine's existing install: a working binary and a runtime directory
  // with a file only this (older) install has.
  writeExecutable(path.join(installDir, "ade"), previousBinary);
  fs.writeFileSync(path.join(runtimeDir, "previous-runtime.txt"), "previous\n");

  // The release: binary + native archive + checksum manifest.
  const binaryAsset = `ade-${target}`;
  const archiveAsset = `${binaryAsset}.native.tar.gz`;
  writeExecutable(path.join(assets, binaryAsset), FAKE_ADE);
  const archiveStage = path.join(root, "archive-stage");
  fs.mkdirSync(path.join(archiveStage, "node_modules", "fake-dep"), { recursive: true });
  fs.writeFileSync(
    path.join(archiveStage, "node_modules", "fake-dep", "index.js"),
    "module.exports = 1;\n",
  );
  execFileSync("tar", ["-czf", path.join(assets, archiveAsset), "-C", archiveStage, "."]);
  fs.writeFileSync(
    path.join(assets, "SHA256SUMS"),
    [binaryAsset, archiveAsset]
      .map((name) => `${sha256(path.join(assets, name))}  ${name}\n`)
      .join(""),
  );

  writeExecutable(path.join(fakeBin, "curl"), FAKE_CURL);
  writeExecutable(path.join(fakeBin, "mv"), FAKE_MV);

  return { root, assets, fakeBin, adeHome, installDir, runtimeDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function runInstaller(fixture, extraEnv = {}) {
  return spawnSync("sh", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: path.join(fixture.root, "home"),
      ADE_TEST_ASSET_DIR: fixture.assets,
      ADE_HOME: fixture.adeHome,
      ADE_INSTALL_DIR: fixture.installDir,
      ADE_INSTALL_NO_PROMPT: "1",
      ADE_INSTALL_NO_PATH: "1",
      ...extraEnv,
    },
  });
}

test("a downloaded runtime that cannot start never replaces the installed one", () => {
  const fixture = makeInstall();
  try {
    const result = runInstaller(fixture, { ADE_TEST_FAIL_STAGED: "1" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not start/);
    // The failure has to name where the evidence is and what to do next.
    assert.match(result.stderr, /install-failure\.log/);
    assert.match(result.stderr, /run the installer again/);

    assert.equal(
      fs.readFileSync(path.join(fixture.installDir, "ade"), "utf8"),
      "#!/bin/sh\necho previous\n",
    );
    // Nothing was promoted, so the previous native runtime is untouched too.
    assert.ok(fs.existsSync(path.join(fixture.runtimeDir, "previous-runtime.txt")));
    assert.ok(!fs.existsSync(path.join(fixture.runtimeDir, "node_modules")));
    assert.ok(!fs.existsSync(path.join(fixture.installDir, "ade.new")));
    // The runtime now stages next to the real one; a failed install must not
    // leave either scratch directory under the ADE home.
    assert.ok(!fs.existsSync(`${fixture.runtimeDir}.new`));
    assert.ok(!fs.existsSync(`${fixture.runtimeDir}.previous`));
  } finally {
    fixture.cleanup();
  }
});

// A `noexec` /tmp is normal on hardened Linux hosts and in containers, and it
// cannot be simulated portably from a test. What is testable is the property
// that makes it irrelevant: the preflight executes the copy under the install
// directory, never the staged one in $TMPDIR.
test("the staged preflight runs the install-directory copy, not the one in TMPDIR", () => {
  const fixture = makeInstall();
  const versionLog = path.join(fixture.adeHome, "version-checks.log");
  try {
    const result = runInstaller(fixture, { ADE_TEST_VERSION_LOG: versionLog });

    assert.equal(result.status, 0, result.stderr);
    const executed = fs
      .readFileSync(versionLog, "utf8")
      .split("\n")
      .filter(Boolean);

    // Staged preflight first, then the promoted binary.
    assert.deepEqual(executed.slice(0, 2), [
      path.join(fixture.installDir, "ade.new"),
      path.join(fixture.installDir, "ade"),
    ]);
    // Nothing was ever executed out of the $TMPDIR staging directory.
    assert.ok(!executed.some((entry) => entry.includes("ade-install.")));
  } finally {
    fixture.cleanup();
  }
});

// The binary is not the only thing the preflight has to run from an
// executable filesystem: it `dlopen`s the .node modules NODE_PATH points at.
// Staging the runtime archive in $TMPDIR made the binary copy's relocation
// pointless on a `noexec` /tmp, because the native modules were still loaded
// from there.
test("the staged preflight loads native modules from the ADE home, not TMPDIR", () => {
  const fixture = makeInstall();
  const envLog = path.join(fixture.adeHome, "version-env.log");
  try {
    const result = runInstaller(fixture, { ADE_TEST_ENV_LOG: envLog });

    assert.equal(result.status, 0, result.stderr);
    const rows = fs.readFileSync(envLog, "utf8").split("\n").filter(Boolean);
    assert.ok(rows.length >= 2, `expected a staged and a promoted check, got ${rows.length}`);

    // Nothing the installer executed saw a TMPDIR staging path, as the binary
    // it ran or anywhere in its runtime env.
    for (const row of rows) {
      assert.ok(!row.includes("ade-install."), `TMPDIR staging path in: ${row}`);
    }

    // The staged preflight runs against the runtime staged under the ADE home,
    // one same-filesystem rename away from where it will be promoted; the
    // second check runs against the promoted one. NODE_PATH keeps whatever the
    // ambient environment had after the runtime entry, so only the first entry
    // is this script's.
    const parse = (row) => {
      const [binary, runtimeRoot, nodeModules, nodePath] = row.split("|");
      return { binary, runtimeRoot, nodeModules, firstNodePath: nodePath.split(":")[0] };
    };
    const staged = parse(rows[0]);
    assert.deepEqual(staged, {
      binary: path.join(fixture.installDir, "ade.new"),
      runtimeRoot: `${fixture.runtimeDir}.new`,
      nodeModules: path.join(`${fixture.runtimeDir}.new`, "node_modules"),
      firstNodePath: path.join(`${fixture.runtimeDir}.new`, "node_modules"),
    });
    const promoted = parse(rows[1]);
    assert.deepEqual(promoted, {
      binary: path.join(fixture.installDir, "ade"),
      runtimeRoot: fixture.runtimeDir,
      nodeModules: path.join(fixture.runtimeDir, "node_modules"),
      firstNodePath: path.join(fixture.runtimeDir, "node_modules"),
    });

    // Neither staging directory survives a successful install.
    assert.ok(!fs.existsSync(`${fixture.runtimeDir}.new`));
    assert.ok(!fs.existsSync(`${fixture.runtimeDir}.previous`));
  } finally {
    fixture.cleanup();
  }
});

test("a staged preflight failure says the existing install was not touched", () => {
  const fixture = makeInstall();
  const versionLog = path.join(fixture.adeHome, "version-checks.log");
  try {
    const result = runInstaller(fixture, {
      ADE_TEST_FAIL_STAGED: "1",
      ADE_TEST_VERSION_LOG: versionLog,
    });

    assert.notEqual(result.status, 0);
    // Nothing was promoted, so "nothing was left installed" would be wrong and
    // "was put back" would imply a rollback that never had to happen.
    assert.match(result.stderr, /was not touched/);
    assert.doesNotMatch(result.stderr, /nothing was left installed/);
    assert.doesNotMatch(result.stderr, /put back/);

    // The one thing it ran was the install-directory copy, and it is gone.
    assert.deepEqual(
      fs.readFileSync(versionLog, "utf8").split("\n").filter(Boolean),
      [path.join(fixture.installDir, "ade.new")],
    );
    assert.ok(!fs.existsSync(path.join(fixture.installDir, "ade.new")));
  } finally {
    fixture.cleanup();
  }
});

test("a promoted runtime that fails its version check is rolled back", () => {
  const fixture = makeInstall();
  try {
    const result = runInstaller(fixture, { ADE_TEST_FAIL_INSTALLED: "1" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not start/);
    assert.match(result.stderr, /put back/);

    assert.equal(
      fs.readFileSync(path.join(fixture.installDir, "ade"), "utf8"),
      "#!/bin/sh\necho previous\n",
    );
    assert.ok(fs.existsSync(path.join(fixture.runtimeDir, "previous-runtime.txt")));
    assert.ok(!fs.existsSync(path.join(fixture.runtimeDir, "node_modules")));
    // The rollback copies are scratch state, not something to leave behind.
    assert.ok(!fs.existsSync(path.join(fixture.installDir, "ade.bak")));
    assert.ok(!fs.existsSync(path.join(fixture.installDir, "ade.new")));
    assert.ok(!fs.existsSync(`${fixture.runtimeDir}.new`));
    assert.ok(!fs.existsSync(`${fixture.runtimeDir}.previous`));

    const log = fs.readFileSync(path.join(fixture.adeHome, "install-failure.log"), "utf8");
    assert.match(log, /installed copy cannot start/);
  } finally {
    fixture.cleanup();
  }
});

test("Ctrl-C while the promoted binary is being checked puts the old one back", () => {
  const fixture = makeInstall();
  try {
    const result = runInstaller(fixture, { ADE_TEST_INTERRUPT_INSTALLED: "1" });

    assert.notEqual(result.status, 0);
    // The interrupt lands after the new binary is already in place but before
    // it has proved it can start, so the machine must be left on the install
    // it had -- not on an unverified binary with its backup deleted.
    assert.equal(
      fs.readFileSync(path.join(fixture.installDir, "ade"), "utf8"),
      "#!/bin/sh\necho previous\n",
    );
    assert.ok(!fs.existsSync(path.join(fixture.installDir, "ade.bak")));
    assert.ok(!fs.existsSync(path.join(fixture.installDir, "ade.new")));
    // The runtime was already promoted when the interrupt landed, so putting
    // the old binary back is only half a rollback: an old `ade` against the new
    // native sidecar is an install that cannot start. The runtime has to go
    // back with it.
    assert.ok(fs.existsSync(path.join(fixture.runtimeDir, "previous-runtime.txt")));
    assert.ok(!fs.existsSync(path.join(fixture.runtimeDir, "node_modules")));
    assert.ok(!fs.existsSync(`${fixture.runtimeDir}.previous`));
    assert.ok(!fs.existsSync(`${fixture.runtimeDir}.new`));
  } finally {
    fixture.cleanup();
  }
});

// `restore_previous_install` removes the promoted runtime before moving the
// backup back, so a failure in that move leaves the machine with no runtime at
// all. The scratch cleanup that runs next must not then delete the backup --
// that backup is the only copy of the runtime left on the machine.
test("a failed runtime restore keeps the backup instead of deleting the last runtime", () => {
  const fixture = makeInstall();
  try {
    const result = runInstaller(fixture, {
      ADE_TEST_FAIL_INSTALLED: "1",
      ADE_TEST_FAIL_RUNTIME_RESTORE: "1",
    });

    assert.notEqual(result.status, 0);
    // The binary rolled back normally; only the runtime restore failed.
    assert.equal(
      fs.readFileSync(path.join(fixture.installDir, "ade"), "utf8"),
      "#!/bin/sh\necho previous\n",
    );
    // The runtime the machine had is still on disk, under the backup name a
    // re-run (or a human) can recover it from.
    assert.ok(
      fs.existsSync(path.join(`${fixture.runtimeDir}.previous`, "previous-runtime.txt")),
      "the only remaining runtime was deleted by the scratch cleanup",
    );
  } finally {
    fixture.cleanup();
  }
});

test("a healthy runtime is promoted and leaves no rollback state behind", () => {
  const fixture = makeInstall();
  try {
    const result = runInstaller(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(fixture.installDir, "ade"), "utf8"), FAKE_ADE);
    assert.ok(fs.existsSync(path.join(fixture.runtimeDir, "node_modules", "fake-dep")));
    assert.ok(!fs.existsSync(path.join(fixture.runtimeDir, "previous-runtime.txt")));
    assert.ok(!fs.existsSync(path.join(fixture.installDir, "ade.bak")));
    assert.ok(!fs.existsSync(path.join(fixture.installDir, "ade.new")));
  } finally {
    fixture.cleanup();
  }
});
