import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import packagedAdeCliResourcesModule from "./packaged-ade-cli-resources.cjs";

const {
  missingRequiredPackagedAdeCliPayloadPaths,
  packagedAdeCliPayloadFiles,
} = packagedAdeCliResourcesModule;

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-resources-"));
}

test("expands directory resources into concrete files without following symlink cycles", () => {
  const root = createTempRoot();
  try {
    const payloadRoot = path.join(root, "payload");
    fs.mkdirSync(path.join(payloadRoot, "nested"), { recursive: true });
    fs.writeFileSync(path.join(payloadRoot, "cli.cjs"), "");
    fs.writeFileSync(path.join(payloadRoot, "nested", "worker.cjs"), "");
    fs.symlinkSync(
      payloadRoot,
      path.join(payloadRoot, "nested", "loop"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const payloadFiles = packagedAdeCliPayloadFiles({
      desktopRoot: root,
      packageJson: {
        build: {
          extraResources: [{ from: "payload", to: "ade-cli" }],
        },
      },
    });

    assert.deepEqual(
      payloadFiles.map((resource) => resource.relativePath),
      ["cli.cjs", "nested/loop", "nested/worker.cjs"],
    );
    assert.deepEqual(
      payloadFiles.map((resource) => resource.to),
      ["ade-cli/cli.cjs", "ade-cli/nested/loop", "ade-cli/nested/worker.cjs"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reports every missing runtime-critical ADE CLI payload", () => {
  assert.deepEqual(
    missingRequiredPackagedAdeCliPayloadPaths([
      { relativePath: "cli.cjs" },
      { relativePath: "usageLedgerWorker.cjs" },
    ]),
    [
      "bootstrap.cjs",
      "ptyHostWorker.cjs",
      "cursorSdkWorker.cjs",
      "droidSdkWorker.cjs",
      "adeRpcServer.cjs",
      "tuiClient/cli.mjs",
      "bin/ade",
      "bin/ade.cmd",
      "install-path.sh",
      "install-path.cmd",
    ],
  );
});
