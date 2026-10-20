import { describe, expect, it } from "vitest";
import {
  BRAIN_INHERITED_CALLER_ENV_KEYS,
  describeBrainRoleCeiling,
  describeDroppedCallerIdentity,
  dropInheritedCallerIdentity,
  dropInheritedAgentLocation,
} from "./brainInheritedIdentity";

describe("dropInheritedCallerIdentity", () => {
  it("removes an agent shell's identity and keeps the brain's own settings", () => {
    const env: NodeJS.ProcessEnv = {
      ADE_CHAT_SESSION_ID: "43e71799-c4c1-4d55-aef5-2d14c8104cc9",
      ADE_RUN_ID: "run-1",
      ADE_LANE_ID: "lane-1",
      ADE_PROJECT_ROOT: "/work/.ade/worktrees/lane-1",
      ADE_WORKSPACE_ROOT: "/work/.ade/worktrees/lane-1",
      ADE_BROWSER_ACTOR_TOKEN: "browser-token",
      ADE_DEFAULT_ROLE: "cto",
      ADE_HOME: "/Users/me/.ade-alpha",
      PATH: "/usr/bin",
    };

    const dropped = dropInheritedCallerIdentity(env);
    const droppedLocation = dropInheritedAgentLocation(env, dropped);

    expect(dropped).toEqual(["ADE_CHAT_SESSION_ID", "ADE_RUN_ID"]);
    expect(droppedLocation).toEqual([
      "ADE_LANE_ID",
      "ADE_PROJECT_ROOT",
      "ADE_WORKSPACE_ROOT",
      "ADE_BROWSER_ACTOR_TOKEN",
    ]);
    for (const key of BRAIN_INHERITED_CALLER_ENV_KEYS) expect(env[key]).toBeUndefined();
    expect(env).toEqual({
      ADE_DEFAULT_ROLE: "cto",
      ADE_HOME: "/Users/me/.ade-alpha",
      PATH: "/usr/bin",
    });
  });

  it("removes a blank key without reporting it, and reports nothing for a clean env", () => {
    const env: NodeJS.ProcessEnv = {
      ADE_CHAT_SESSION_ID: "  ",
      ADE_PROJECT_ROOT: "/operator/selected/project",
    };
    expect(dropInheritedCallerIdentity(env)).toEqual([]);
    expect("ADE_CHAT_SESSION_ID" in env).toBe(false);
    expect(dropInheritedAgentLocation(env, [])).toEqual([]);
    expect(env.ADE_PROJECT_ROOT).toBe("/operator/selected/project");
    expect(dropInheritedCallerIdentity({ PATH: "/usr/bin" })).toEqual([]);
  });
});

describe("brain startup sentences", () => {
  it("names the dropped keys, and says nothing when none were dropped", () => {
    expect(describeDroppedCallerIdentity([])).toBeNull();
    expect(describeDroppedCallerIdentity(["ADE_CHAT_SESSION_ID"])).toContain("ADE_CHAT_SESSION_ID");
  });

  it("warns only for a ceiling that refuses cto clients, and never for an embedded runtime", () => {
    expect(describeBrainRoleCeiling("cto")).toBeNull();
    expect(describeBrainRoleCeiling("agent")).toContain("ade --role cto serve");

    // An embedded runtime is a guest inside one host's process. It serves that
    // host at `agent` on purpose, so the desktop, phone and web clients the
    // sentence warns about are not there to be refused, and the command it
    // recommends does not apply.
    expect(describeBrainRoleCeiling("agent", { embedded: true })).toBeNull();
    expect(describeBrainRoleCeiling("cto", { embedded: true })).toBeNull();
  });
});
