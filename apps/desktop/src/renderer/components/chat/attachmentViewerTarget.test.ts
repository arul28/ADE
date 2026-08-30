import { describe, expect, it } from "vitest";
import type { FilesWorkspace } from "../../../shared/types";
import { resolveViewerKind } from "../files/v2/viewerRegistry";
import { resolveAttachmentWorkspaceTarget } from "./attachmentViewerTarget";

function workspace(overrides: Partial<FilesWorkspace> & { id: string; rootPath: string }): FilesWorkspace {
  return {
    kind: "primary",
    laneId: null,
    name: overrides.id,
    branchRef: null,
    isReadOnlyByDefault: false,
    mobileReadOnly: true,
    ...overrides,
  } as FilesWorkspace;
}

describe("resolveAttachmentWorkspaceTarget", () => {
  const primary = workspace({ id: "primary", rootPath: "/Users/a/Projects/ADE" });
  const lane = workspace({
    id: "lane-1",
    kind: "worktree",
    laneId: "lane-1",
    rootPath: "/Users/a/Projects/ADE/.ade/worktrees/lane-1",
  });

  it("maps a staged attachment to the project workspace", () => {
    expect(resolveAttachmentWorkspaceTarget(
      "/Users/a/Projects/ADE/.ade/attachments/9f3a.png",
      [primary],
    )).toEqual({
      workspaceId: "primary",
      rootPath: "/Users/a/Projects/ADE",
      relativePath: ".ade/attachments/9f3a.png",
    });
  });

  it("prefers the deepest containing workspace", () => {
    // Both roots contain the path; the lane worktree is the honest owner.
    expect(resolveAttachmentWorkspaceTarget(
      "/Users/a/Projects/ADE/.ade/worktrees/lane-1/.ade/attachments/9f3a.pdf",
      [primary, lane],
    )).toMatchObject({
      workspaceId: "lane-1",
      relativePath: ".ade/attachments/9f3a.pdf",
    });
  });

  it("resolves a Windows attachment path against a Windows root", () => {
    const win = workspace({ id: "win", rootPath: "C:\\Users\\a\\Projects\\ADE" });
    expect(resolveAttachmentWorkspaceTarget(
      "C:\\Users\\a\\Projects\\ADE\\.ade\\attachments\\9f3a.csv",
      [win],
    )).toMatchObject({ workspaceId: "win", relativePath: ".ade/attachments/9f3a.csv" });
  });

  it("returns null for an attachment outside every workspace", () => {
    // Staged into system temp because no project was open.
    expect(resolveAttachmentWorkspaceTarget(
      "/var/folders/tmp/ade-attachments/9f3a.png",
      [primary, lane],
    )).toBeNull();
  });

  it("returns null when the path IS the workspace root", () => {
    expect(resolveAttachmentWorkspaceTarget("/Users/a/Projects/ADE", [primary])).toBeNull();
  });

  it("does not match a sibling directory that merely shares a prefix", () => {
    expect(resolveAttachmentWorkspaceTarget(
      "/Users/a/Projects/ADE-backup/.ade/attachments/9f3a.png",
      [primary],
    )).toBeNull();
  });
});

describe("viewer kind resolution for staged attachments", () => {
  it("picks the right Files viewer for each attachment type", () => {
    const cases: Array<[string, string]> = [
      [".ade/attachments/a.pdf", "pdf"],
      [".ade/attachments/a.png", "image"],
      [".ade/attachments/a.svg", "image"],
      [".ade/attachments/a.mp3", "audio"],
      [".ade/attachments/a.mp4", "video"],
      [".ade/attachments/a.csv", "csv"],
      [".ade/attachments/a.xlsx", "document"],
      [".ade/attachments/a.html", "html"],
      [".ade/attachments/a.md", "markdown"],
      [".ade/attachments/a.ts", "code"],
    ];
    for (const [path, expected] of cases) {
      expect(resolveViewerKind({ path })).toBe(expected);
    }
  });

  it("falls back to the binary viewer for an unreadable payload", () => {
    expect(resolveViewerKind({ path: ".ade/attachments/a.bin", isBinary: true })).toBe("binary");
  });
});
