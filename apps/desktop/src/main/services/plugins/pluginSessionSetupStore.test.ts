import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAdeLayout } from "../../../shared/adeLayout";
import {
  PLUGIN_SESSION_CONTEXT_FILE_ENV,
  PLUGIN_SESSION_SOURCE_ENV,
} from "../../../shared/plugins/sessionSetup";
import {
  clearPluginSessionSetup,
  filterPluginSessionEnv,
  readPluginSessionSetupEnv,
  writePluginSessionSetup,
} from "./pluginSessionSetupStore";

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-session-setup-"));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function contextDirFor(sessionId: string): string {
  return path.join(resolveAdeLayout(projectRoot).contextDir, sessionId, "plugin");
}

describe("writePluginSessionSetup", () => {
  it("writes the context file, returns its host-named path, and names the plugin", () => {
    const env = writePluginSessionSetup({
      projectRoot,
      sessionId: "session-1",
      pluginId: "ade-jira",
      setup: {
        env: { ADE_PLUGIN_JIRA_ISSUE_KEYS: "ENG-1" },
        contextFile: { name: "jira-issues.json", content: '{"issues":[]}' },
      },
    });

    expect(env?.ADE_PLUGIN_JIRA_ISSUE_KEYS).toBe("ENG-1");
    expect(env?.[PLUGIN_SESSION_SOURCE_ENV]).toBe("ade-jira");

    const contextPath = env?.[PLUGIN_SESSION_CONTEXT_FILE_ENV];
    expect(contextPath).toBe(path.join(contextDirFor("session-1"), "context", "jira-issues.json"));
    expect(fs.readFileSync(contextPath as string, "utf8")).toBe('{"issues":[]}');
  });

  it("keeps the context file out of reach of the sidecar that records it", () => {
    // A plugin naming its file `setup.json` must not be able to overwrite the
    // record of its own injection.
    writePluginSessionSetup({
      projectRoot,
      sessionId: "session-1",
      setup: { contextFile: { name: "setup.json", content: "not the sidecar" } },
    });
    const sidecar = JSON.parse(fs.readFileSync(path.join(contextDirFor("session-1"), "setup.json"), "utf8"));
    expect(sidecar.contextFileName).toBe("setup.json");
  });

  it("returns null when the caller asked for nothing", () => {
    expect(writePluginSessionSetup({ projectRoot, sessionId: "session-1", setup: undefined })).toBeNull();
    expect(fs.existsSync(contextDirFor("session-1"))).toBe(false);
  });

  it("throws and writes nothing when a key would shadow a host variable", () => {
    expect(() => writePluginSessionSetup({
      projectRoot,
      sessionId: "session-1",
      setup: { env: { PATH: "/evil/bin" } },
    })).toThrow(/is not allowed/u);
    expect(fs.existsSync(contextDirFor("session-1"))).toBe(false);
  });

  it("refuses a key the live process env already sets", () => {
    process.env.ADE_PLUGIN_TEST_HOST_OWNED = "host";
    try {
      expect(() => writePluginSessionSetup({
        projectRoot,
        sessionId: "session-1",
        setup: { env: { ADE_PLUGIN_TEST_HOST_OWNED: "plugin" } },
      })).toThrow(/set by ADE and cannot be overridden/u);
    } finally {
      delete process.env.ADE_PLUGIN_TEST_HOST_OWNED;
    }
  });
});

describe("readPluginSessionSetupEnv", () => {
  it("re-injects the same variables a later process start asks for", () => {
    const written = writePluginSessionSetup({
      projectRoot,
      sessionId: "session-1",
      pluginId: "ade-jira",
      setup: {
        env: { ADE_PLUGIN_JIRA_ISSUE_KEYS: "ENG-1" },
        contextFile: { name: "jira.json", content: "{}" },
      },
    });
    expect(readPluginSessionSetupEnv({ projectRoot, sessionId: "session-1" })).toEqual(written);
  });

  it("is null for a session that never had a setup", () => {
    expect(readPluginSessionSetupEnv({ projectRoot, sessionId: "missing" })).toBeNull();
  });

  it("is null for a corrupt sidecar rather than throwing into a launch", () => {
    const dir = contextDirFor("session-1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "setup.json"), "{ not json");
    expect(readPluginSessionSetupEnv({ projectRoot, sessionId: "session-1" })).toBeNull();
  });

  it("drops a variable an edited sidecar added outside the policy", () => {
    const dir = contextDirFor("session-1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "setup.json"),
      JSON.stringify({ env: { PATH: "/evil/bin", ADE_PLUGIN_OK: "kept" }, contextFileName: null }),
    );
    // The whole env map is refused rather than partially honored: a sidecar that
    // fails validation is not a source ADE trusts to be half-right.
    expect(readPluginSessionSetupEnv({ projectRoot, sessionId: "session-1" })).toBeNull();
  });

  it("ignores a context file name that would escape the session directory", () => {
    const dir = contextDirFor("session-1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "setup.json"),
      JSON.stringify({ env: {}, contextFileName: "../../../../etc/passwd" }),
    );
    expect(readPluginSessionSetupEnv({ projectRoot, sessionId: "session-1" })).toBeNull();
  });

  it("omits the context file variable once the file is gone", () => {
    writePluginSessionSetup({
      projectRoot,
      sessionId: "session-1",
      setup: { env: { ADE_PLUGIN_X: "1" }, contextFile: { name: "a.json", content: "{}" } },
    });
    fs.rmSync(path.join(contextDirFor("session-1"), "context", "a.json"));
    expect(readPluginSessionSetupEnv({ projectRoot, sessionId: "session-1" }))
      .toEqual({ ADE_PLUGIN_X: "1" });
  });
});

describe("clearPluginSessionSetup", () => {
  it("removes the stored env and the context file with the session", () => {
    writePluginSessionSetup({
      projectRoot,
      sessionId: "session-1",
      setup: { env: { ADE_PLUGIN_X: "1" }, contextFile: { name: "a.json", content: "secret" } },
    });
    clearPluginSessionSetup({ projectRoot, sessionId: "session-1" });
    expect(fs.existsSync(contextDirFor("session-1"))).toBe(false);
    expect(readPluginSessionSetupEnv({ projectRoot, sessionId: "session-1" })).toBeNull();
  });

  it("is a no-op for a session that has nothing stored", () => {
    expect(() => clearPluginSessionSetup({ projectRoot, sessionId: "missing" })).not.toThrow();
  });

  it("leaves the built-in Linear context file alone", () => {
    const sessionDir = path.join(resolveAdeLayout(projectRoot).contextDir, "session-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "linear-issues.json"), "{}");
    writePluginSessionSetup({
      projectRoot,
      sessionId: "session-1",
      setup: { env: { ADE_PLUGIN_X: "1" } },
    });
    clearPluginSessionSetup({ projectRoot, sessionId: "session-1" });
    expect(fs.existsSync(path.join(sessionDir, "linear-issues.json"))).toBe(true);
  });
});

describe("filterPluginSessionEnv", () => {
  it("drops any key the host already occupies, case-insensitively", () => {
    expect(filterPluginSessionEnv(
      { ADE_PLUGIN_TAKEN: "host", PATH: "/usr/bin" },
      { ADE_PLUGIN_TAKEN: "plugin", ade_plugin_taken: "plugin", ADE_PLUGIN_FREE: "plugin" },
    )).toEqual({ ADE_PLUGIN_FREE: "plugin" });
  });

  it("is empty when there is nothing to merge", () => {
    expect(filterPluginSessionEnv({ PATH: "/usr/bin" }, null)).toEqual({});
  });
});
