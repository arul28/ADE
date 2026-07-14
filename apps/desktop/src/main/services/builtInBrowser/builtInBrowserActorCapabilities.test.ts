import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  issueBuiltInBrowserActorCapability,
  resetBuiltInBrowserActorCapabilitiesForTest,
  revokeBuiltInBrowserActorCapability,
  resolveBuiltInBrowserActorCapability,
} from "./builtInBrowserActorCapabilities";

describe("builtInBrowserActorCapabilities", () => {
  beforeEach(() => resetBuiltInBrowserActorCapabilitiesForTest());

  it("mints opaque chat-bound capabilities and ignores caller-supplied scope", () => {
    const token = issueBuiltInBrowserActorCapability({
      chatSessionId: "chat-1",
      laneId: "lane-1",
      projectRoot: "./project",
      tabCollection: null,
    });

    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(resolveBuiltInBrowserActorCapability(token)).toEqual({
      chatSessionId: "chat-1",
      laneId: "lane-1",
      projectRoot: path.resolve("./project"),
      tabCollection: null,
    });
    expect(resolveBuiltInBrowserActorCapability("not-issued")).toBeNull();
  });

  it("rotates a chat capability when its trusted collection scope changes", () => {
    const first = issueBuiltInBrowserActorCapability({
      chatSessionId: "chat-1",
      laneId: "lane-1",
      projectRoot: "/project",
      tabCollection: null,
    });
    const second = issueBuiltInBrowserActorCapability({
      chatSessionId: "chat-1",
      laneId: null,
      projectRoot: "/ignored",
      tabCollection: "personal",
    });

    expect(second).not.toBe(first);
    expect(resolveBuiltInBrowserActorCapability(first)).toBeNull();
    expect(resolveBuiltInBrowserActorCapability(second)).toEqual({
      chatSessionId: "chat-1",
      laneId: null,
      projectRoot: null,
      tabCollection: "personal",
    });
  });

  it("revokes a chat capability when its owning session closes", () => {
    const token = issueBuiltInBrowserActorCapability({
      chatSessionId: "chat-1",
      laneId: "lane-1",
      projectRoot: "/project",
      tabCollection: null,
    });

    revokeBuiltInBrowserActorCapability("chat-1");

    expect(resolveBuiltInBrowserActorCapability(token)).toBeNull();
  });
});
