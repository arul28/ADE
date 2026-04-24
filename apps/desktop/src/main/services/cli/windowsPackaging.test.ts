import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(__dirname, "../../../../");
const repoRoot = path.resolve(desktopRoot, "..", "..");

describe("Windows packaging", () => {
  it("keeps the packaged Windows wrapper on a shared runtime-env path", () => {
    const wrapperPath = path.join(desktopRoot, "scripts", "ade-cli-windows-wrapper.cmd");
    const wrapper = fs.readFileSync(wrapperPath, "utf8");

    expect(wrapper).toContain('set "NODE_PATH_VALUE=%RESOURCES_DIR%\\app.asar.unpacked\\node_modules;%RESOURCES_DIR%\\app.asar\\node_modules"');
    expect(wrapper).toContain('call :run_with_runtime_env "%ADE_CLI_NODE%" "%CLI_JS%" %*');
    expect(wrapper).toContain('call :run_with_runtime_env "%APP_EXE%" "%CLI_JS%" %*');
    expect(wrapper).toContain('call :run_with_runtime_env node "%CLI_JS%" %*');
    expect(wrapper).toContain('if defined NODE_PATH_VALUE set "NODE_PATH=%NODE_PATH_VALUE%"');
  });

  it("keeps the Windows install-path shim callable and exit-code preserving", () => {
    const installerPath = path.join(desktopRoot, "scripts", "ade-cli-install-path.cmd");
    const installer = fs.readFileSync(installerPath, "utf8");

    expect(installer).toContain('echo call "%ADE_BIN%" %%*');
    expect(installer).toContain("echo exit /b %%ERRORLEVEL%%");
  });

  it("pins the Windows desktop build to x64 and unpacks sql.js for node fallback", () => {
    const packageJsonPath = path.join(desktopRoot, "package.json");
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

    expect(pkg.scripts["dist:win"]).toContain("validate:win:release");
    expect(pkg.build.asarUnpack).toContain("node_modules/sql.js/**/*");
    expect(pkg.build.win.icon).toBe("build/icon.ico");
    expect(pkg.build.win.target).toEqual([
      {
        target: "nsis",
        arch: ["x64"],
      },
    ]);
  });

  it("passes the Windows artifact preflight", () => {
    const validateScriptPath = path.join(desktopRoot, "scripts", "validate-win-artifacts.mjs");
    const result = spawnSync(process.execPath, [validateScriptPath, "--mode=preflight"], {
      cwd: desktopRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Windows package inputs are present.");
  });

  it("builds and publishes Windows release artifacts in release-core", () => {
    const workflowPath = path.join(repoRoot, ".github", "workflows", "release-core.yml");
    const workflow = parseYaml(fs.readFileSync(workflowPath, "utf8"));
    const winJob = workflow.jobs["build-win-release"];
    const publishJob = workflow.jobs["publish-release"];

    expect(winJob["runs-on"]).toBe("windows-latest");
    expect(winJob.steps.some((step: { run?: string }) => step.run?.includes("npm run dist:win"))).toBe(true);

    const winUploadStep = winJob.steps.find((step: { name?: string }) => step.name === "Upload validated Windows artifacts to workflow run");
    expect(winUploadStep.with.path).toContain("apps/desktop/release/latest.yml");

    expect(publishJob.needs).toEqual(expect.arrayContaining(["build-mac-release", "build-win-release"]));
    const publishStep = publishJob.steps.find((step: { name?: string }) => step.name === "Create or update draft GitHub release");
    expect(publishStep.run).toContain("release-assets/win/latest.yml");
    expect(publishStep.run).toContain("release-assets/win/*.exe.blockmap");
  });
});
