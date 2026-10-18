import { describe, expect, it } from "vitest";
import type { OpenProjectBinding } from "../../../shared/types";
import { resolvePersonalChatsCatalogTargetKey } from "./PersonalChatsPage";

describe("resolvePersonalChatsCatalogTargetKey", () => {
  it("uses the remote project binding key on desktop remote tabs", () => {
    const binding = {
      kind: "remote",
      key: "remote:studio:proj",
      targetId: "target-1",
      projectId: "proj",
      runtimeName: "Studio",
    } as OpenProjectBinding;
    expect(resolvePersonalChatsCatalogTargetKey(binding)).toBe("remote:studio:proj");
  });

  it("uses local-machine on desktop when not remote", () => {
    expect(resolvePersonalChatsCatalogTargetKey(null)).toBe("local-machine");
  });
});
