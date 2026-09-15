import { describe, expect, it } from "vitest";
import type { OpenProjectBinding } from "../../../shared/types";
import { resolvePersonalChatsCatalogTargetKey } from "./PersonalChatsPage";

describe("resolvePersonalChatsCatalogTargetKey", () => {
  it("uses the hosted web machine catalog key when the web picker is active", () => {
    expect(resolvePersonalChatsCatalogTargetKey(null, {
      machineId: "machine-catalog-a",
      machineLabel: "Studio",
      options: [],
      select: async () => null,
    })).toBe("web:machine-catalog-a");
  });

  it("uses a pending web key before a machine is selected", () => {
    expect(resolvePersonalChatsCatalogTargetKey(null, {
      machineId: null,
      machineLabel: null,
      options: [],
      select: async () => null,
    })).toBe("web:pending");
  });

  it("uses the remote project binding key on desktop remote tabs", () => {
    const binding = {
      kind: "remote",
      key: "remote:studio:proj",
      targetId: "target-1",
      projectId: "proj",
      runtimeName: "Studio",
    } as OpenProjectBinding;
    expect(resolvePersonalChatsCatalogTargetKey(binding, null)).toBe("remote:studio:proj");
  });

  it("uses local-machine on desktop when not remote", () => {
    expect(resolvePersonalChatsCatalogTargetKey(null, null)).toBe("local-machine");
  });
});
