import { describe, expect, it } from "vitest";
import {
  BRAIN_INHERITED_CALLER_ENV_KEYS,
  describeBrainRoleCeiling,
  describeDroppedCallerIdentity,
  dropInheritedCallerIdentity,
} from "./brainInheritedIdentity";

describe("dropInheritedCallerIdentity", () => {
  it("removes an agent shell's identity and keeps the brain's own settings", () => {
    const env: NodeJS.ProcessEnv = {
      ADE_CHAT_SESSION_ID: "43e71799-c4c1-4d55-aef5-2d14c8104cc9",
      ADE_RUN_ID: "run-1",
      ADE_BROWSER_ACTOR_TOKEN: "token",
      ADE_DEFAULT_ROLE: "cto",
      ADE_HOME: "/Users/me/.ade-alpha",
      PATH: "/usr/bin",
    };

    const dropped = dropInheritedCallerIdentity(env);

    expect(dropped).toEqual(["ADE_CHAT_SESSION_ID", "ADE_BROWSER_ACTOR_TOKEN", "ADE_RUN_ID"]);
    for (const key of BRAIN_INHERITED_CALLER_ENV_KEYS) expect(env[key]).toBeUndefined();
    expect(env).toEqual({
      ADE_DEFAULT_ROLE: "cto",
      ADE_HOME: "/Users/me/.ade-alpha",
      PATH: "/usr/bin",
    });
  });

  it("removes a blank key without reporting it, and reports nothing for a clean env", () => {
    const env: NodeJS.ProcessEnv = { ADE_CHAT_SESSION_ID: "  " };
    expect(dropInheritedCallerIdentity(env)).toEqual([]);
    expect("ADE_CHAT_SESSION_ID" in env).toBe(false);
    expect(dropInheritedCallerIdentity({ PATH: "/usr/bin" })).toEqual([]);
  });
});

describe("brain startup sentences", () => {
  it("names the dropped keys, and says nothing when none were dropped", () => {
    expect(describeDroppedCallerIdentity([])).toBeNull();
    expect(describeDroppedCallerIdentity(["ADE_CHAT_SESSION_ID"])).toContain("ADE_CHAT_SESSION_ID");
  });

  it("warns only for a ceiling that refuses cto clients", () => {
    expect(describeBrainRoleCeiling("cto")).toBeNull();
    expect(describeBrainRoleCeiling("agent")).toContain("ade --role cto serve");
  });
});
