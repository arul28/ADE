import { describe, expect, it } from "vitest";

import {
  buildRemoteEditorUrl,
  canOfferOpenIn,
  encodeRemoteEditorPath,
  resolveOpenInTarget,
} from "./editorTargets";

describe("encodeRemoteEditorPath", () => {
  it("encodes posix paths with a leading slash", () => {
    expect(encodeRemoteEditorPath("/Users/admin/Projects/ade")).toBe("/Users/admin/Projects/ade");
  });

  it("lifts Windows drive paths to vscode/zed SSH form", () => {
    expect(encodeRemoteEditorPath(String.raw`C:\Users\admin\Projects\foo`)).toBe("/C:/Users/admin/Projects/foo");
  });
});

describe("buildRemoteEditorUrl", () => {
  it("emits OS-registered vscode:// vscode-remote SSH URLs", () => {
    expect(buildRemoteEditorUrl("vscode", "dev.example", "/home/ade/proj")).toBe(
      "vscode://vscode-remote/ssh-remote+dev.example/home/ade/proj",
    );
    expect(buildRemoteEditorUrl("vscode-insiders", "dev.example", "/home/ade/proj")).toBe(
      "vscode-insiders://vscode-remote/ssh-remote+dev.example/home/ade/proj",
    );
    expect(buildRemoteEditorUrl("vscodium", "dev.example", "/home/ade/proj")).toBe(
      "vscodium://vscode-remote/ssh-remote+dev.example/home/ade/proj",
    );
  });

  it("emits zed://ssh URLs", () => {
    expect(buildRemoteEditorUrl("zed", "dev.example", "/home/ade/proj")).toBe(
      "zed://ssh/dev.example/home/ade/proj",
    );
  });

  it("returns null for editors without remote SSH support", () => {
    expect(buildRemoteEditorUrl("cursor", "dev.example", "/home/ade/proj")).toBeNull();
  });
});

describe("resolveOpenInTarget", () => {
  it("returns rootPath when Open in is offered", () => {
    expect(resolveOpenInTarget({ worktreePath: "/tmp/lane" })).toEqual({
      rootPath: "/tmp/lane",
    });
    expect(resolveOpenInTarget({ worktreePath: "" })).toBeNull();
  });

  it("mints an SSH remote payload and hides paired remotes", () => {
    expect(resolveOpenInTarget({
      worktreePath: "/tmp/lane",
      binding: {
        kind: "remote",
        key: "r",
        targetId: "t",
        runtimeName: "box",
        transport: "ssh",
        hostname: "dev.example",
        projectId: "p",
        rootPath: "/tmp",
        displayName: "box",
      },
    })).toEqual({
      rootPath: "/tmp/lane",
      remote: { hostname: "dev.example", transport: "ssh" },
    });
    expect(resolveOpenInTarget({
      worktreePath: "/tmp/lane",
      binding: {
        kind: "remote",
        key: "r",
        targetId: "t",
        runtimeName: "box",
        transport: "paired",
        hostname: "dev.example",
        projectId: "p",
        rootPath: "/tmp",
        displayName: "box",
      },
    })).toBeNull();
  });
});

describe("canOfferOpenIn", () => {
  it("requires a worktree path", () => {
    expect(canOfferOpenIn({ worktreePath: "" })).toBe(false);
    expect(canOfferOpenIn({ worktreePath: "/tmp/lane" })).toBe(true);
  });

  it("hides paired remotes and requires a hostname for SSH remotes", () => {
    expect(canOfferOpenIn({
      worktreePath: "/tmp/lane",
      binding: { kind: "remote", key: "r", targetId: "t", runtimeName: "box", transport: "paired", projectId: "p", rootPath: "/tmp", displayName: "box" },
    })).toBe(false);
    expect(canOfferOpenIn({
      worktreePath: "/tmp/lane",
      binding: { kind: "remote", key: "r", targetId: "t", runtimeName: "box", transport: "ssh", projectId: "p", rootPath: "/tmp", displayName: "box" },
    })).toBe(false);
    expect(canOfferOpenIn({
      worktreePath: "/tmp/lane",
      binding: { kind: "remote", key: "r", targetId: "t", runtimeName: "box", transport: "ssh", hostname: "dev.example", projectId: "p", rootPath: "/tmp", displayName: "box" },
    })).toBe(true);
  });
});
