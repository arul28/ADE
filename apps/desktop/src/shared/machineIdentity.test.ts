import { describe, expect, it } from "vitest";
import {
  THIS_MACHINE_ID,
  THIS_MACHINE_NAME,
  machineIdForBinding,
  machineNameForBinding,
} from "./machineIdentity";

describe("machineIdForBinding", () => {
  it("returns This computer for a local or missing binding", () => {
    expect(machineIdForBinding(null)).toBe(THIS_MACHINE_ID);
    expect(machineIdForBinding(undefined)).toBe(THIS_MACHINE_ID);
    expect(machineIdForBinding({
      kind: "local",
      key: "local:/tmp/ade",
      rootPath: "/tmp/ade",
      displayName: "ade",
    })).toBe(THIS_MACHINE_ID);
  });

  it("returns the remote target id, never this-mac", () => {
    expect(machineIdForBinding({
      kind: "remote",
      key: "remote:studio:project-1",
      targetId: "studio",
      projectId: "project-1",
      runtimeName: "Mac Studio",
      displayName: "ADE",
      rootPath: "/Users/admin/ADE",
    })).toBe("studio");
  });
});

describe("machineNameForBinding", () => {
  it("names a local binding This computer", () => {
    expect(machineNameForBinding(null)).toBe(THIS_MACHINE_NAME);
  });
});
