import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDesktopAdeMcpLaunch } from "./adeMcpLaunch";

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
});
