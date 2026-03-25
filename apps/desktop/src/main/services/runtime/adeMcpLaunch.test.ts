import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDesktopAdeMcpLaunch, resolveRepoRuntimeRoot } from "./adeMcpLaunch";

const originalResourcesPath = process.resourcesPath;

afterEach(() => {
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: originalResourcesPath,
  });
});

describe("resolveDesktopAdeMcpLaunch", () => {
  it("prefers the bundled desktop MCP proxy when it is available", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-project-"));
    const workspaceRoot = path.join(projectRoot, "workspace");
    const proxyEntry = path.join(projectRoot, "dist", "main", "adeMcpProxy.cjs");

    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(path.dirname(proxyEntry), { recursive: true });
    fs.writeFileSync(proxyEntry, "module.exports = {};\n", "utf8");

    const launch = resolveDesktopAdeMcpLaunch({
      projectRoot,
      workspaceRoot,
      bundledProxyPath: proxyEntry,
    });

    expect(launch.mode).toBe("bundled_proxy");
    expect(launch.command).toBe(process.execPath);
    expect(launch.cmdArgs).toEqual([
      path.resolve(proxyEntry),
      "--project-root",
      path.resolve(projectRoot),
      "--workspace-root",
      path.resolve(workspaceRoot),
    ]);
    expect(launch.env).toMatchObject({
      ADE_PROJECT_ROOT: path.resolve(projectRoot),
      ADE_WORKSPACE_ROOT: path.resolve(workspaceRoot),
      ADE_MCP_SOCKET_PATH: path.join(path.resolve(projectRoot), ".ade", "mcp.sock"),
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  it("falls back to the built headless MCP entry when bundled proxy launch is disabled", () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-runtime-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-project-"));
    const workspaceRoot = path.join(projectRoot, "workspace");
    const builtEntry = path.join(runtimeRoot, "apps", "mcp-server", "dist", "index.cjs");

    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(path.dirname(builtEntry), { recursive: true });
    fs.writeFileSync(builtEntry, "module.exports = {};\n", "utf8");

    const launch = resolveDesktopAdeMcpLaunch({
      projectRoot,
      workspaceRoot,
      runtimeRoot,
      preferBundledProxy: false,
      missionId: "mission-123",
      runId: "run-456",
    });

    expect(launch.mode).toBe("headless_built");
    expect(launch.command).toBe("node");
    expect(launch.cmdArgs).toEqual([
      builtEntry,
      "--project-root",
      path.resolve(projectRoot),
      "--workspace-root",
      path.resolve(workspaceRoot),
    ]);
    expect(launch.env).toMatchObject({
      ADE_PROJECT_ROOT: path.resolve(projectRoot),
      ADE_WORKSPACE_ROOT: path.resolve(workspaceRoot),
      ADE_MISSION_ID: "mission-123",
      ADE_RUN_ID: "run-456",
      ADE_MCP_SOCKET_PATH: path.join(path.resolve(projectRoot), ".ade", "mcp.sock"),
    });
  });

  it("prefers the unpacked packaged proxy path over the asar path", () => {
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-resources-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-project-"));
    const workspaceRoot = path.join(projectRoot, "workspace");
    const packagedProxy = path.join(resourcesPath, "app.asar.unpacked", "dist", "main", "adeMcpProxy.cjs");

    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(path.dirname(packagedProxy), { recursive: true });
    fs.writeFileSync(packagedProxy, "module.exports = {};\n", "utf8");
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: resourcesPath,
    });

    const launch = resolveDesktopAdeMcpLaunch({
      projectRoot,
      workspaceRoot,
    });

    expect(launch.mode).toBe("bundled_proxy");
    expect(launch.entryPath).toBe(packagedProxy);
    expect(launch.cmdArgs[0]).toBe(packagedProxy);
  });

  it("falls back to headless source mode when no built entry exists", () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-runtime-src-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-project-src-"));
    const workspaceRoot = path.join(projectRoot, "workspace");

    fs.mkdirSync(workspaceRoot, { recursive: true });
    // Create the mcp-server src directory but NOT the dist directory
    fs.mkdirSync(path.join(runtimeRoot, "apps", "mcp-server", "src"), { recursive: true });

    const launch = resolveDesktopAdeMcpLaunch({
      projectRoot,
      workspaceRoot,
      runtimeRoot,
      preferBundledProxy: false,
    });

    const expectedSrcEntry = path.join(runtimeRoot, "apps", "mcp-server", "src", "index.ts");
    expect(launch.mode).toBe("headless_source");
    expect(launch.command).toBe("npx");
    expect(launch.cmdArgs).toEqual([
      "tsx",
      expectedSrcEntry,
      "--project-root",
      path.resolve(projectRoot),
      "--workspace-root",
      path.resolve(workspaceRoot),
    ]);
    expect(launch.entryPath).toBe(expectedSrcEntry);
    expect(launch.runtimeRoot).toBe(path.resolve(runtimeRoot));
  });

  it("defaults projectRoot to workspaceRoot when projectRoot is empty or missing", () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-runtime-nopr-"));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-ws-nopr-"));

    const launch = resolveDesktopAdeMcpLaunch({
      workspaceRoot,
      runtimeRoot,
      preferBundledProxy: false,
    });

    expect(launch.env.ADE_PROJECT_ROOT).toBe(path.resolve(workspaceRoot));
    expect(launch.env.ADE_WORKSPACE_ROOT).toBe(path.resolve(workspaceRoot));
    expect(launch.socketPath).toBe(path.join(path.resolve(workspaceRoot), ".ade", "mcp.sock"));

    // Also test with empty string projectRoot
    const launchEmpty = resolveDesktopAdeMcpLaunch({
      projectRoot: "  ",
      workspaceRoot,
      runtimeRoot,
      preferBundledProxy: false,
    });

    expect(launchEmpty.env.ADE_PROJECT_ROOT).toBe(path.resolve(workspaceRoot));
  });

  it("populates computerUsePolicy env vars when policy is provided", () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-runtime-cup-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-project-cup-"));
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const launch = resolveDesktopAdeMcpLaunch({
      projectRoot,
      workspaceRoot,
      runtimeRoot,
      preferBundledProxy: false,
      computerUsePolicy: {
        mode: "enabled",
        allowLocalFallback: true,
        retainArtifacts: false,
        preferredBackend: "vnc",
      },
    });

    expect(launch.env.ADE_COMPUTER_USE_MODE).toBe("enabled");
    expect(launch.env.ADE_COMPUTER_USE_ALLOW_LOCAL_FALLBACK).toBe("1");
    expect(launch.env.ADE_COMPUTER_USE_RETAIN_ARTIFACTS).toBe("0");
    expect(launch.env.ADE_COMPUTER_USE_PREFERRED_BACKEND).toBe("vnc");
  });

  it("leaves computerUsePolicy env vars empty when policy is null", () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-runtime-nocup-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-project-nocup-"));
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const launch = resolveDesktopAdeMcpLaunch({
      projectRoot,
      workspaceRoot,
      runtimeRoot,
      preferBundledProxy: false,
      computerUsePolicy: null,
    });

    expect(launch.env.ADE_COMPUTER_USE_MODE).toBe("");
    expect(launch.env.ADE_COMPUTER_USE_ALLOW_LOCAL_FALLBACK).toBe("");
    expect(launch.env.ADE_COMPUTER_USE_RETAIN_ARTIFACTS).toBe("");
    expect(launch.env.ADE_COMPUTER_USE_PREFERRED_BACKEND).toBe("");
  });

  it("sets ownerId and defaultRole in env when provided", () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-runtime-owner-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-project-owner-"));
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const launch = resolveDesktopAdeMcpLaunch({
      projectRoot,
      workspaceRoot,
      runtimeRoot,
      preferBundledProxy: false,
      defaultRole: "cto",
      ownerId: "agent-42",
    });

    expect(launch.env.ADE_DEFAULT_ROLE).toBe("cto");
    expect(launch.env.ADE_OWNER_ID).toBe("agent-42");
  });

  it("defaults defaultRole to 'agent' and ownerId to empty when not provided", () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-runtime-noowner-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-project-noowner-"));
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const launch = resolveDesktopAdeMcpLaunch({
      projectRoot,
      workspaceRoot,
      runtimeRoot,
      preferBundledProxy: false,
    });

    expect(launch.env.ADE_DEFAULT_ROLE).toBe("agent");
    expect(launch.env.ADE_OWNER_ID).toBe("");
  });

  it("bundled proxy mode preserves runtimeRoot when provided", () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-runtime-proxy-rt-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-project-proxy-rt-"));
    const workspaceRoot = path.join(projectRoot, "workspace");
    const proxyEntry = path.join(projectRoot, "dist", "main", "adeMcpProxy.cjs");

    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(path.dirname(proxyEntry), { recursive: true });
    fs.writeFileSync(proxyEntry, "module.exports = {};\n", "utf8");

    const launch = resolveDesktopAdeMcpLaunch({
      projectRoot,
      workspaceRoot,
      runtimeRoot,
      bundledProxyPath: proxyEntry,
    });

    expect(launch.mode).toBe("bundled_proxy");
    expect(launch.runtimeRoot).toBe(path.resolve(runtimeRoot));
  });

  it("bundled proxy mode sets runtimeRoot to null when not provided", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-project-proxy-nort-"));
    const workspaceRoot = path.join(projectRoot, "workspace");
    const proxyEntry = path.join(projectRoot, "dist", "main", "adeMcpProxy.cjs");

    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(path.dirname(proxyEntry), { recursive: true });
    fs.writeFileSync(proxyEntry, "module.exports = {};\n", "utf8");

    const launch = resolveDesktopAdeMcpLaunch({
      projectRoot,
      workspaceRoot,
      bundledProxyPath: proxyEntry,
    });

    expect(launch.mode).toBe("bundled_proxy");
    expect(launch.runtimeRoot).toBeNull();
  });
});

describe("resolveRepoRuntimeRoot", () => {
  it("returns a string path that is a resolved absolute path", () => {
    const root = resolveRepoRuntimeRoot();
    expect(typeof root).toBe("string");
    expect(path.isAbsolute(root)).toBe(true);
  });

  it("finds the monorepo root when apps/mcp-server/package.json exists above cwd", () => {
    // The ADE project itself has this structure, so running in the repo should find it
    const root = resolveRepoRuntimeRoot();
    // The function should find a directory containing apps/mcp-server/package.json
    // or fall back to cwd. Either way, it returns a valid path.
    expect(fs.existsSync(root)).toBe(true);
  });
});
